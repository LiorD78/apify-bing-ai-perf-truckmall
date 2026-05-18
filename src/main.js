// Apify Actor: Bing AI Performance — TRUCKMALL group
// Scope: truckmall.cz, truckmall.sk, tdt.cz, tdt.sk, tagra.eu
//
// Co dělá:
//   1) Přihlásí se do Bing Webmaster Tools (storage state reuse → MFA jen 1×)
//   2) Pro každý web extrahuje CSRF token z UI a zavolá 3 interní API endpointy:
//      - citationstats (totals + timeseries)
//      - pages/stats (top citované URL)
//      - searchqueries/stats (grounding queries; často prázdné = 404)
//   3) Výsledky pošle na Make webhook (jeden router payload pro celý TRUCKMALL projekt)
//   4) Uloží také do Apify Dataset pro historii
//
// Auth: persistence skrz Apify Key-Value Store → "bing-session" → storageState

import { Actor, log } from 'apify';
import { chromium } from 'playwright';

await Actor.init();

// ─── INPUT ────────────────────────────────────────────────────────────────
const input = (await Actor.getInput()) ?? {};
const {
    msEmail = process.env.MS_EMAIL,
    msPassword = process.env.MS_PASSWORD,
    makeWebhookUrl = process.env.MAKE_WEBHOOK_URL,
    sites = [
        'https://www.truckmall.cz/',
        'https://www.truckmall.sk/',
        'https://www.tdt.cz/',
        'https://www.tdt.sk/',   // Pozn.: musí být přidán do Bing WMT — aktuálně chybí
        'https://tagra.eu/',     // Pozn.: musí být přidán do Bing WMT — aktuálně chybí
    ],
    daysBack = 90,
    dryRun = false,
} = input;

if (!msEmail || !msPassword) {
    throw new Error('Missing MS_EMAIL or MS_PASSWORD. Set them as Apify Secrets.');
}

log.info(`Run started: ${sites.length} sites, last ${daysBack} days, dryRun=${dryRun}`);

// ─── BROWSER + SESSION ────────────────────────────────────────────────────
const sessionStore = await Actor.openKeyValueStore('bing-session');
const savedState = await sessionStore.getValue('storageState');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
    storageState: savedState || undefined,
    userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
    viewport: { width: 1400, height: 900 },
    locale: 'en-US',
});

// Patch fetch BEFORE any page loads, ať zachytíme CSRF z prvního UI volání
await context.addInitScript(() => {
    window.__capturedHeaders = null;
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('aiperformance') && init && init.headers) {
            const h = {};
            if (init.headers instanceof Headers) init.headers.forEach((v, k) => (h[k] = v));
            else Object.assign(h, init.headers);
            if (h['X-CSRF-Token'] || h['x-csrf-token']) {
                window.__capturedHeaders = h;
            }
        }
        return origFetch.apply(this, arguments);
    };
});

const page = await context.newPage();

// ─── LOGIN ────────────────────────────────────────────────────────────────
async function ensureLoggedIn() {
    log.info('Verifying Bing WMT session…');
    await page.goto('https://www.bing.com/webmasters/home', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const url = page.url();
    if (!url.includes('login') && !url.includes('signin') && !url.includes('account.live')) {
        log.info('✓ Session valid, skipping login');
        return;
    }

    log.warning('Session expired — performing fresh login');
    // Microsoft email step
    await page.fill('input[type="email"]', msEmail);
    await Promise.all([
        page.click('input[type="submit"]'),
        page.waitForLoadState('networkidle'),
    ]);

    // Password step
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await page.fill('input[type="password"]', msPassword);
    await page.click('input[type="submit"]');

    // MFA may be required here — see runtime logs
    log.info('Submitted password. Waiting for MFA / next step (up to 90s)…');

    try {
        await page.waitForURL(/webmasters/, { timeout: 90000 });
    } catch (err) {
        const screenshotBuf = await page.screenshot({ fullPage: true });
        await Actor.setValue('mfa-blocker.png', screenshotBuf, { contentType: 'image/png' });
        throw new Error(
            'Login did not reach Webmaster Tools within 90s. ' +
            'Probably MFA challenge waiting. Open mfa-blocker.png in KV Store to investigate. ' +
            'Solution: run actor interactively via Apify Console "Resurrect run" with Live View, complete MFA manually.',
        );
    }

    // "Stay signed in?" prompt
    const staySignedIn = page.locator('input[value="Yes"]');
    if (await staySignedIn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await staySignedIn.click();
    }

    log.info('✓ Login successful');
    const fresh = await context.storageState();
    await sessionStore.setValue('storageState', fresh);
}

// ─── API HELPERS ──────────────────────────────────────────────────────────
function formatRFC1123(date) {
    // Bing UI sends: "Mon, 11 May 2026 00:00:00 GMT"
    return date.toUTCString();
}

async function getCSRFForSite(siteUrl) {
    const url = `https://www.bing.com/webmasters/aiperformance?siteUrl=${encodeURIComponent(siteUrl)}`;
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000); // give UI time to make the first XHR

    const headers = await page.evaluate(() => window.__capturedHeaders);
    if (!headers) {
        throw new Error(`No CSRF token captured for ${siteUrl}. UI may not have loaded.`);
    }
    return headers['X-CSRF-Token'] || headers['x-csrf-token'];
}

async function callApi(endpoint, csrf, body) {
    return page.evaluate(
        async ({ endpoint, csrf, body }) => {
            const r = await fetch(`/webmasters/api/aiperformance/${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/plain, */*',
                    'X-CSRF-Token': csrf,
                },
                body: JSON.stringify(body),
                credentials: 'include',
            });
            const text = await r.text();
            return { status: r.status, body: text };
        },
        { endpoint, csrf, body },
    );
}

function safeJSON(s) {
    try { return JSON.parse(s); } catch { return null; }
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────
const today = new Date();
const startDate = new Date(today.getTime() - daysBack * 24 * 60 * 60 * 1000);

await ensureLoggedIn();

const allData = {
    runDate: today.toISOString(),
    daysBack,
    rangeStart: formatRFC1123(startDate),
    rangeEnd: formatRFC1123(today),
    sites: {},
    errors: [],
};

for (const siteUrl of sites) {
    log.info(`─── ${siteUrl} ───`);
    try {
        const csrf = await getCSRFForSite(siteUrl);
        const baseBody = {
            SiteUrl: siteUrl,
            DateRange: {
                BeginTimeStamp: formatRFC1123(startDate),
                EndTimeStamp: formatRFC1123(today),
            },
        };

        const [citResp, pagesResp, queriesResp] = await Promise.all([
            callApi('citationstats', csrf, baseBody),
            callApi('pages/stats', csrf, {
                ...baseBody,
                Pagination: { PageNum: 1, PageSize: 100 },
                SortParam: { SortBy: 'Citations', SortOrder: 'Descending' },
            }),
            callApi('searchqueries/stats', csrf, {
                ...baseBody,
                Pagination: { PageNum: 1, PageSize: 100 },
                SortParam: { SortBy: 'Citations', SortOrder: 'Descending' },
            }),
        ]);

        const citData = safeJSON(citResp.body);
        const pagesData = safeJSON(pagesResp.body);
        const queriesData = safeJSON(queriesResp.body);

        allData.sites[siteUrl] = {
            totalCitations: citData?.TotalCitations ?? 0,
            totalUniquePages: citData?.TotalUniqueCitedPages ?? 0,
            avgUniquePages: citData?.AverageUniqueCitedPages ?? 0,
            timeseries: citData?.CitationStats ?? [],
            topPages: (pagesData?.Pages ?? []).map((p) => ({
                url: p.PageUrl,
                citations: p.Citations,
            })),
            groundingQueries: queriesResp.status === 200
                ? (queriesData?.Queries ?? [])
                : { status: queriesResp.status, note: 'No data available' },
        };

        log.info(
            `✓ ${siteUrl}: ${allData.sites[siteUrl].totalCitations} citations / ` +
            `${allData.sites[siteUrl].topPages.length} cited pages`,
        );
    } catch (err) {
        log.error(`✗ ${siteUrl}: ${err.message}`);
        allData.errors.push({ siteUrl, error: err.message });
    }
}

// ─── OUTPUT ───────────────────────────────────────────────────────────────
// 1. Apify Dataset (historický log, queryable)
await Actor.pushData(allData);

// 2. Apify Key-Value Store (latest snapshot)
await Actor.setValue('latest', allData);

// 3. Make webhook
if (makeWebhookUrl && !dryRun) {
    log.info(`Posting results to Make webhook…`);
    const r = await fetch(makeWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(allData),
    });
    if (!r.ok) {
        log.error(`Webhook failed: ${r.status} ${await r.text()}`);
    } else {
        log.info(`✓ Webhook delivered: ${r.status}`);
    }
} else if (dryRun) {
    log.info('DRY RUN — skipping Make webhook');
}

// Cleanup
await browser.close();
await Actor.exit();
