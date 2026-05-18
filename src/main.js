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

const page = await context.newPage();

// ─── LOGIN ────────────────────────────────────────────────────────────────
async function isSessionValid() {
    // Check actual API auth by calling profile endpoint, which requires login
    await page.goto('https://www.bing.com/webmasters/home', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const profileCheck = await page.evaluate(async () => {
        try {
            const r = await fetch('/webmasters/api/globalelements/profile', {
                credentials: 'include',
                headers: { 'Accept': 'application/json' },
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

    log.info(`Profile check: status=${profileCheck.status}, hasUser=${profileCheck.hasUserData}`);
    return profileCheck.status === 200 && profileCheck.hasUserData;
}

async function ensureLoggedIn() {
    log.info('Verifying Bing WMT session…');

    if (await isSessionValid()) {
        log.info('✓ Session valid, skipping login');
        return;
    }

    log.warning('Session invalid or expired — performing fresh login');

    // Direct sign-in URL: Bing WMT's protected dashboard, will 302 to login.live.com if not authed
    log.info('Navigating to sign-in entrypoint …');
    await page.goto('https://www.bing.com/webmasters/dashboard', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
    });
    await page.waitForTimeout(3000);

    // Debug screenshot — see what we got
    const debugBuf1 = await page.screenshot({ fullPage: true });
    await Actor.setValue('debug-1-after-dashboard-nav.png', debugBuf1, { contentType: 'image/png' });
    log.info(`After dashboard nav, URL = ${page.url()}`);

    // If we're not on a Microsoft login page yet, try clicking any "Sign in" element on the homepage
    if (!page.url().includes('login.') && !page.url().includes('account.')) {
        log.info('Not on login page yet, trying to click sign-in elements …');
        // Bing WMT homepage anonymous variants — try multiple selector patterns
        const signInSelectors = [
            'a[href*="login.live"]',
            'a[href*="signin"]',
            'a[href*="login.microsoft"]',
            'a:has-text("Sign in")',
            'button:has-text("Sign in")',
            'a:has-text("Get started")',
            '[data-testid*="signin" i]',
            '[aria-label*="sign in" i]',
        ];
        let clicked = false;
        for (const sel of signInSelectors) {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
                log.info(`  Clicking selector: ${sel}`);
                await el.click().catch(() => {});
                await page.waitForLoadState('domcontentloaded').catch(() => {});
                await page.waitForTimeout(2000);
                clicked = true;
                break;
            }
        }
        if (!clicked) {
            const debugBuf2 = await page.screenshot({ fullPage: true });
            await Actor.setValue('debug-2-no-signin-button.png', debugBuf2, { contentType: 'image/png' });
            log.warning('No Sign In selector found — Bing UI may have changed. See debug-2-no-signin-button.png');
        }
    }

    // We should now be on Microsoft login (login.live.com or login.microsoftonline.com)
    log.info(`Pre-email URL = ${page.url()}`);
    const debugBuf3 = await page.screenshot({ fullPage: true });
    await Actor.setValue('debug-3-before-email.png', debugBuf3, { contentType: 'image/png' });

    // Microsoft email step — broader selectors to handle live.com vs microsoftonline.com
    await page.waitForSelector('input[type="email"], input[name="loginfmt"]', { timeout: 30000 });
    await page.fill('input[type="email"], input[name="loginfmt"]', msEmail);
    await page.click('input[type="submit"], button[type="submit"]');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    log.info(`After email URL = ${page.url()}`);

    // Password step
    await page.waitForSelector('input[type="password"], input[name="passwd"]', { timeout: 15000 });
    await page.fill('input[type="password"], input[name="passwd"]', msPassword);
    await page.click('input[type="submit"], button[type="submit"]');

    // MFA may be required here — see runtime logs
    log.info('Submitted password. Waiting for MFA approval on phone (up to 120s)…');
    const debugBuf4 = await page.screenshot({ fullPage: true });
    await Actor.setValue('debug-4-after-password.png', debugBuf4, { contentType: 'image/png' });

    try {
        await page.waitForURL(/bing\.com\/webmasters/, { timeout: 120000 });
    } catch (err) {
        const screenshotBuf = await page.screenshot({ fullPage: true });
        await Actor.setValue('mfa-blocker.png', screenshotBuf, { contentType: 'image/png' });
        throw new Error(
            'Login did not reach Webmaster Tools within 120s. ' +
            'Probably MFA challenge waiting on phone. Open mfa-blocker.png in KV Store. ' +
            'Solution: ensure Authenticator app is in hand when starting the actor.',
        );
    }

    // "Stay signed in?" prompt
    const staySignedIn = page.locator('input[value="Yes"], button:has-text("Yes")').first();
    if (await staySignedIn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await staySignedIn.click();
        await page.waitForLoadState('networkidle').catch(() => {});
    }

    // Verify the session is actually working
    if (!(await isSessionValid())) {
        const screenshotBuf = await page.screenshot({ fullPage: true });
        await Actor.setValue('post-login-failed.png', screenshotBuf, { contentType: 'image/png' });
        throw new Error('Login flow completed but profile API still returns invalid. Session not established.');
    }

    log.info('✓ Login successful, persisting session to KV Store');
    const fresh = await context.storageState();
    await sessionStore.setValue('storageState', fresh);
}

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

await ensureLoggedIn();

// Get CSRF token once — valid for entire session (not per-site)
log.info('Fetching CSRF token from /webmasters/auth/token …');
await page.goto('https://www.bing.com/webmasters/home', { waitUntil: 'domcontentloaded' });
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
