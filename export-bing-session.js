#!/usr/bin/env node
/**
 * EXPORT BING WMT SESSION FOR APIFY ACTOR
 * =========================================
 *
 * Otevře viditelné Chrome okno, ty se přihlásíš přes "Sign in with Google"
 * v Bing Webmaster Tools, script uloží storageState.json na disk.
 *
 * Poté ten JSON pošleš Claude (nebo uploadne přes Apify API) do KV Store
 * 'bing-session' jako key 'storageState'. Apify actor pak při startu session
 * načte a běží denně bez nutnosti loginu (~30 dní platí).
 *
 * USAGE:
 *   1) cd ~/Downloads  (nebo kamkoli)
 *   2) mkdir bing-session-export && cd bing-session-export
 *   3) npm init -y
 *   4) npm install playwright
 *   5) npx playwright install chromium
 *   6) node export-bing-session.js
 *   7) Otevře se Chrome → klikni "Sign In" → Google → tvůj účet → schval permission
 *   8) Až vidíš dashboard truckmall.cz, stiskni ENTER v terminálu
 *   9) Soubor bing-storage-state.json se uloží do aktuální složky
 *  10) Pošli mi ten JSON tady do chatu
 */

const { chromium } = require('playwright');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(process.cwd(), 'bing-storage-state.json');

(async () => {
    console.log('🚀 Spouštím Chromium (viditelné okno) ...');
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

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(state, null, 2));
    console.log('');
    console.log(`✅ Hotovo! Session uložena do: ${OUTPUT_FILE}`);
    console.log('');
    console.log('━'.repeat(70));
    console.log('   DALŠÍ KROK:');
    console.log('   Otevři soubor bing-storage-state.json a celý obsah');
    console.log('   pošli Claude do chatu (nebo upload do Apify KV Store ručně).');
    console.log('━'.repeat(70));

    // Necháme browser otevřený pro vizuální verifikaci
    console.log('');
    console.log('Browser zůstává otevřený. Zavři ho ručně až budeš hotov.');
    // Don't close — let user inspect

})().catch((err) => {
    console.error('❌ Chyba:', err);
    process.exit(1);
});
