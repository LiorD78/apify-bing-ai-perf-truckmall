// Apify Actor: Bing AI Performance — TRUCKMALL group
// Scope: truckmall.cz, truckmall.sk, tdt.cz, tdt.sk, tagra.eu
//
// Co dělá:
//   1) Načte session storageState z Apify KV Store 'bing-session' (key 'storageState')
//   2) Validuje session GET /webmasters/api/globalelements/profile (HTTP 200 + user data)
//   3) Pro každý web extrahuje CSRF token z UI a zavolá 3 interní API endpointy:
//      - citationstats (totals + timeseries)
//      - pages/stats (top citované URL)
//      - searchqueries/stats (grounding queries; často prázdné = 404)
//   4) Výsledky pošle na Make webhook (jeden router payload pro celý TRUCKMALL projekt)
//   5) Uloží také do Apify Dataset pro historii
//
// Auth: NENÍ interaktivní login. Session musí být uploadnutá v KV Store 'bing-session'
// (key 'storageState') předem pomocí export-bing-session.js skriptu lokálně.
// Důvod: Bing WMT účet je registrovaný přes Google OAuth (libor.dospel@gmail.com),
// ne Microsoft. Google OAuth login v headless Chromium není spolehlivý (CAPTCHA, 2FA).
// Session typicky platí ~30 dní, pak je nutné spustit export skript znovu.

import { Actor, log } from 'apify';
import { chromium } from 'playwright';

await Actor.init();

// ─── INPUT ────────────────────────────────────────────────────────────────
const input = (await Actor.getInput()) ?? {};
const {
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

log.info(`Run started: ${sites.length} sites, last ${daysBack} days, dryRun=${dryRun}`);

// ─── SESSION LOAD ─────────────────────────────────────────────────────────
const sessionStore = await Actor.openKeyValueStore('bing-session');
const savedState = await sessionStore.getValue('storageState');

if (!savedState) {
    throw new Error(
        'No session found in KV Store "bing-session" (key "storageState"). ' +
        'Run export-bing-session.js locally to create one. ' +
        'See README.md → "Initial Setup" section for instructions.',
    );
}

log.info(`✓ Session loaded from KV Store (${savedState.cookies?.length ?? 0} cookies)`);

// ─── BROWSER ──────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
    storageState: savedState,
    userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
    viewport: { width: 1400, height: 900 },
    locale: 'en-US',
});
const page = await context.newPage();

// ─── SESSION VALIDATION ───────────────────────────────────────────────────
async function validateSession() {
    log.info('Validating session …');
    await page.goto('https://www.bing.com/webmasters/home', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const result = await page.evaluate(async () => {
        try {
            const r = await fetch('/webmasters/api/globalelements/profile', {
                credentials: 'include',
                headers: { Accept: 'application/json' },
            });
            const text = await r.text();
            return {
                status: r.status,
                hasUserData: text.includes('UserId') || text.includes('user') || text.includes('email'),
                bodyPreview: text.substring(0, 200),
            };
        } catch (err) {
            return { error: err.message };
        }
    });

    log.info(`Profile check: status=${result.status}, hasUser=${result.hasUserData}`);

    if (result.status !== 200 || !result.hasUserData) {
        const screenshotBuf = await page.screenshot({ fullPage: true });
        await Actor.setValue('session-expired.png', screenshotBuf, { contentType: 'image/png' });
        throw new Error(
            'Session expired or invalid. ' +
            `Profile API returned status=${result.status}. ` +
            'Run export-bing-session.js locally to refresh the session ' +
            '(typically lasts ~30 days). See README.md.',
        );
    }

    log.info('✓ Session valid');
}

await validateSession();

// ─── API HELPERS ──────────────────────────────────────────────────────────
function formatRFC1123(date) {
    // Bing UI sends: "Mon, 11 May 2026 00:00:00 GMT"
    return date.toUTCString();
}

async function getCSRF() {
    // Bing WMT vrací CSRF token jako plain text z GET /webmasters/auth/token.
    // Token je validní pro celou session (nepatří k jednomu site URL).
    const result = await page.evaluate(async () => {
        const r = await fetch('/webmasters/auth/token', { credentials: 'include' });
        return { status: r.status, body: (await r.text()).trim() };
    });
    if (result.status !== 200 || !result.body) {
        throw new Error(`Failed to fetch CSRF token: HTTP ${result.status}`);
    }
    if (!/^[a-f0-9]{32}$/i.test(result.body)) {
        throw new Error(`Unexpected CSRF token format: "${result.body.substring(0, 50)}"`);
    }
    return result.body;
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

// Get CSRF token once — valid for entire session (not per-site)
log.info('Fetching CSRF token from /webmasters/auth/token …');
const csrf = await getCSRF();
log.info(`✓ CSRF token obtained (${csrf.substring(0, 8)}…)`);

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

// ─── PERSIST REFRESHED SESSION ────────────────────────────────────────────
// Bing may rotate cookies during the run — save the latest state back.
try {
    const fresh = await context.storageState();
    await sessionStore.setValue('storageState', fresh);
    log.info('✓ Session state refreshed in KV Store');
} catch (err) {
    log.warning(`Could not persist refreshed session: ${err.message}`);
}

// ─── OUTPUT ───────────────────────────────────────────────────────────────
// 1. Apify Dataset (historický log, queryable)
await Actor.pushData(allData);

// 2. Apify Key-Value Store (latest snapshot)
await Actor.setValue('latest', allData);

// 3. Make webhook
if (makeWebhookUrl && !dryRun) {
    log.info('Posting results to Make webhook…');
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
