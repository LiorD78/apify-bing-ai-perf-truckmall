#!/usr/bin/env node
/**
 * EXPORT BING WMT SESSION FOR APIFY ACTOR
 * =========================================
 *
 * Otevře viditelné Chrome okno, ty se přihlásíš přes "Sign in with Google"
 * v Bing Webmaster Tools, script uloží storageState.json a uploadne přímo
 * do Apify KV Store 'bing-session' (key 'storageState').
 *
 * Apify actor pak při startu session načte a běží denně bez nutnosti loginu
 * (~30 dní platí, pak je nutné spustit tento skript znovu).
 *
 * KDY SPUSTIT:
 *   - Poprvé před prvním Apify runem
 *   - Když Apify run failuje s "Session expired" (typicky po ~30 dnech)
 *
 * USAGE:
 *   1) cd ~/path/to/apify-bing-ai-perf-truckmall
 *   2) npm install (jen poprvé)
 *   3) npx playwright install chromium (jen poprvé)
 *   4) export APIFY_TOKEN="apify_api_..."           (z Apify Console → Settings → API)
 *   5) export APIFY_KV_STORE_ID="pbSattQT3QKR63WIv" (z Apify Storage → bing-session)
 *      (nebo nech default — viz konstanta níže)
 *   6) node export-bing-session.js
 *   7) Otevře se Chrome → klikni "Sign In" → Google → tvůj účet → schval permission
 *   8) Až vidíš Bing WMT dashboard, vrať se do terminálu a stiskni ENTER
 *   9) Skript uloží storageState lokálně AND nahraje do Apify KV Store
 *
 * ENV VARS:
 *   APIFY_TOKEN          (required pro upload)  — Apify API token
 *   APIFY_KV_STORE_ID    (optional)             — KV store ID, default: pbSattQT3QKR63WIv
 *   SKIP_UPLOAD          (optional, "1")        — uloží jen lokálně, neuploadne
 */

import { chromium } from 'playwright';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import https from 'https';

const OUTPUT_FILE = path.join(process.cwd(), 'bing-storage-state.json');
const DEFAULT_KV_STORE_ID = 'pbSattQT3QKR63WIv';

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_KV_STORE_ID = process.env.APIFY_KV_STORE_ID || DEFAULT_KV_STORE_ID;
const SKIP_UPLOAD = process.env.SKIP_UPLOAD === '1';

function uploadToApify(storeId, key, data) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(data);
        const req = https.request({
            method: 'PUT',
            hostname: 'api.apify.com',
            path: `/v2/key-value-stores/${storeId}/records/${key}`,
            headers: {
                'Authorization': `Bearer ${APIFY_TOKEN}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            let chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const responseBody = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ status: res.statusCode, body: responseBody });
                } else {
                    reject(new Error(`Apify API HTTP ${res.statusCode}: ${responseBody}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

(async () => {
    // Pre-flight checks
    if (!SKIP_UPLOAD && !APIFY_TOKEN) {
        console.error('');
        console.error('❌ APIFY_TOKEN env var není nastaven.');
        console.error('');
        console.error('Buď ho nastav:');
        console.error('   export APIFY_TOKEN="apify_api_..."');
        console.error('   (najdeš v Apify Console → Settings → API & Integrations → Default API token)');
        console.error('');
        console.error('Nebo přeskoč upload a uploadni JSON ručně:');
        console.error('   SKIP_UPLOAD=1 node export-bing-session.js');
        console.error('');
        process.exit(1);
    }

    console.log('🚀 Spouštím Chromium (viditelné okno) …');
    const browser = await chromium.launch({
        headless: false,
        args: ['--start-maximized'],
    });

    const context = await browser.newContext({
        viewport: null, // use full window
        userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
        locale: 'en-US',
    });

    const page = await context.newPage();

    console.log('🌐 Otevírám Bing Webmaster Tools …');
    await page.goto('https://www.bing.com/webmasters/about');

    console.log('');
    console.log('━'.repeat(70));
    console.log('   PŘIHLÁŠ SE V CHROME OKNĚ:');
    console.log('   1) Klikni "Sign In" vpravo nahoře');
    console.log('   2) V modálu vyber "Google"');
    console.log('   3) Vyber účet libor.dospel@gmail.com');
    console.log('   4) Pokud Google chce potvrzení permission, klikni Allow');
    console.log('   5) Až uvidíš Bing WMT dashboard (truckmall.cz Total Clicks atd),');
    console.log('      vrať se sem do terminálu a stiskni ENTER');
    console.log('━'.repeat(70));
    console.log('');

    // Čekej na ENTER
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => rl.question('Po dokončení loginu stiskni ENTER … ', () => { rl.close(); resolve(); }));

    console.log('');
    console.log('💾 Ukládám storageState …');

    const state = await context.storageState();

    // Sanity check
    const bingCookies = state.cookies.filter((c) => c.domain.includes('bing.com') || c.domain.includes('live.com'));
    const googleCookies = state.cookies.filter((c) => c.domain.includes('google.com') || c.domain.includes('googleusercontent.com'));

    console.log(`   - ${state.cookies.length} cookies total`);
    console.log(`   - ${bingCookies.length} Bing/Microsoft cookies`);
    console.log(`   - ${googleCookies.length} Google cookies`);
    console.log(`   - ${state.origins.length} localStorage origins`);

    if (bingCookies.length === 0) {
        console.warn('');
        console.warn('⚠️  ŽÁDNÉ Bing cookies — pravděpodobně jsi nebyl přihlášen do Bing WMT.');
        console.warn('   Zavři tento skript (Ctrl+C), zkontroluj že vidíš dashboard, spusť znovu.');
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(state, null, 2));
    console.log(`✅ Lokální záloha: ${OUTPUT_FILE}`);

    // Upload to Apify
    if (SKIP_UPLOAD) {
        console.log('');
        console.log('⏭️  SKIP_UPLOAD=1 — neuploaduji do Apify.');
        console.log('   Pošli soubor Claudovi do chatu nebo uploadni ručně přes Apify Console.');
    } else {
        console.log('');
        console.log(`☁️  Uploaduji do Apify KV Store ${APIFY_KV_STORE_ID} (key: storageState) …`);
        try {
            await uploadToApify(APIFY_KV_STORE_ID, 'storageState', state);
            console.log('✅ Session úspěšně nahrána do Apify!');
            console.log('');
            console.log('   Apify actor teď můžeš spustit kdykoli:');
            console.log('   https://console.apify.com/actors/TDxaZ9eaJabUpXBdX/source');
        } catch (err) {
            console.error('');
            console.error('❌ Upload selhal:', err.message);
            console.error('');
            console.error('Lokální záloha je v', OUTPUT_FILE);
            console.error('Můžeš ji uploadnout ručně přes Apify Console → Storage → bing-session.');
        }
    }

    console.log('');
    console.log('━'.repeat(70));
    console.log('   Browser zůstává otevřený. Zavři ho ručně až budeš hotov.');
    console.log('━'.repeat(70));

})().catch((err) => {
    console.error('❌ Chyba:', err);
    process.exit(1);
});
