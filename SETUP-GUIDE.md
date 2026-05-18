# 🚀 Bing AI Performance Automation — Setup Guide

**Cíl:** Denně tahat AI citation data z Bing WMT pro 5 TRUCKMALL webů, ukládat do Make Data Store, posílat Slack alert na změny.

**Hotovo přes Make MCP automaticky:**
- ✅ Data Structure `bing_ai_perf_snapshot_structure` (ID 421591)
- ✅ Data Store `bing_ai_perf_snapshots` (ID **125404**, 2 MB, ~200 dní historie)
- ✅ Webhook `bing_ai_perf_webhook` (ID 3059855)
  - **URL:** `https://hook.eu1.make.com/fnfrxt2cmm2y414reo10bfcrtzdtemlg`

**Co musíš ručně udělat:**

---

## 1️⃣ Vytvořit Apify účet (5 minut)

1. https://console.apify.com/sign-up — žádná kreditka
2. Verify email
3. Free tier: $5 credit/měsíc, resetuje se měsíčně

## 2️⃣ Vytvořit Actor v Apify Console (10 minut)

### A) Přes Web IDE (jednodušší)

1. **Actors → Development → Create new** → název `bing-ai-perf-truckmall`
2. Vyber template **"Empty Playwright project (JavaScript)"**
3. Smaž defaultní obsah, nakopíruj soubory z této složky:
   - `package.json`
   - `src/main.js`
   - `.actor/INPUT_SCHEMA.json`
   - `.actor/actor.json`
   - `Dockerfile`
4. Klikni **Build** (~3 minuty)

### B) Přes GitHub (čistší, doporučuju do budoucna)

1. Pushni složku `apify-bing-ai-perf` do nového GitHub repo (např. `LiorD78/apify-bing-ai-perf`)
2. V Apify Console: Actors → Create → Source: **Git repository** → vlož URL repa
3. Apify automaticky pull-uje a builduje při push do main

## 3️⃣ Nastavit Secrets v Apify

V **Apify Console → Settings → Integrations → Secrets** přidat:

| Secret name | Value |
|---|---|
| `MS_EMAIL` | `libor.dospel@gmail.com` |
| `MS_PASSWORD` | (tvoje Microsoft heslo) |

⚠️ Pokud máš na Microsoft 2FA, hesло stejně funguje — MFA challenge řešíme v kroku 5.

## 4️⃣ Konfigurovat Input

Actor → **Input** → klikni tlačítka 🔒 vedle msEmail/msPassword a vyber přidělené secrets. Pak vyplň:

```json
{
  "msEmail": "{{secrets.MS_EMAIL}}",
  "msPassword": "{{secrets.MS_PASSWORD}}",
  "makeWebhookUrl": "https://hook.eu1.make.com/fnfrxt2cmm2y414reo10bfcrtzdtemlg",
  "sites": [
    "https://www.truckmall.cz/",
    "https://www.truckmall.sk/",
    "https://www.tdt.cz/",
    "https://www.tdt.sk/",
    "https://tagra.eu/"
  ],
  "daysBack": 90,
  "dryRun": false
}
```

## 5️⃣ První interaktivní run (kvůli MFA) — 5-10 minut

1. **Start** s defaultním inputem
2. Hned klikni **Live View** v pravém horním rohu run details
3. Sleduj browser — když narazí na **MFA challenge** (Authenticator code / SMS / passkey):
   - Klikni do live view (převezmeš ovládání)
   - Dokonči MFA ručně (otevři Authenticator, opiš kód, atd.)
4. Actor pokračuje, dostane se do WMT, uloží session do `bing-session/storageState` v KV Store
5. Run by měl skončit zelený do 5 minut

**Tip:** Pokud MFA selhává, otevři `mfa-blocker.png` v actor run **Storage → Key-value store → Files** — uvidíš co Bing zobrazil.

## 6️⃣ Ověřit že webhook prošel

V Make → **Webhooks → bing_ai_perf_webhook** → klikni **"Determine data structure"** → mělo by se objevit "Data structure detected" s payloadem od Apify. Klikni Save.

## 7️⃣ Postavit Make scenario "bing_ai_perf_processor" (10 minut)

V Make → **Scenarios → Create new**:

### Moduly v pořadí:

1. **Webhook (Custom webhook)**
   - Vybrat existující `bing_ai_perf_webhook`

2. **Iterator** (Tools → Iterator)
   - Array: `{{1.sites}}` (Make zobrazí jako objekt — použij funkci `toCollection` nebo iteruj přes `Object.entries`)
   - **Alternativa pokud Iterator nezvládá objekty:** vlož **Set multiple variables** s pevně danými 5 cestami:
     - `truckmall_cz` = `{{1.sites.https://www.truckmall.cz/}}`
     - `truckmall_sk` = `{{1.sites.https://www.truckmall.sk/}}`
     - atd. (5×)
     - Pak 5× Data Store Add Record (jeden per site) — jednodušší než iterator

3. **Data store → Add a record** (pro každý site)
   - Data store: `bing_ai_perf_snapshots`
   - Key: `{{formatDate(1.runDate; "YYYY-MM-DD")}}-truckmall-cz` (pro každou variantu)
   - Data:
     - `snapshot_date`: `{{1.runDate}}`
     - `site_url`: `https://www.truckmall.cz/`
     - `days_back`: `{{1.daysBack}}`
     - `total_citations`: `{{1.sites.https://www.truckmall.cz/.totalCitations}}`
     - `total_unique_pages`: `{{1.sites.https://www.truckmall.cz/.totalUniquePages}}`
     - `avg_unique_pages`: `{{1.sites.https://www.truckmall.cz/.avgUniquePages}}`
     - `top_pages_json`: `{{toString(1.sites.https://www.truckmall.cz/.topPages)}}`
     - `timeseries_json`: `{{toString(1.sites.https://www.truckmall.cz/.timeseries)}}`

4. **(Optional) Slack notifikace** na změny:
   - **Data store → Search records**: najdi včerejší snapshot
   - **Compare**: `totalCitations` dnešní vs včerejší
   - **Slack → Send message** pokud delta != 0:
     - Text: `📈 truckmall.cz: +2 nové AI citations dnes (10 → 12). Top stránka: a51 (pravidla 561/AETR)`

## 8️⃣ Naplánovat Apify schedule

Apify Console → **Schedules → Create new schedule**:

- Name: `bing-ai-perf-daily`
- Cron: `0 7 * * *` (každý den 7:00 UTC = 8:00 CET / 9:00 CEST)
- Actor: `bing-ai-perf-truckmall`
- Use latest run's input

## 9️⃣ Přidat chybějící weby do Bing WMT

Aktuálně v Bing WMT jen 5 webů, ale chybí 2 z TRUCKMALL scope:

- ❌ **tdt.sk** — přidat: Bing WMT → Add a site → `https://www.tdt.sk/` → verify via DNS CNAME nebo BSADMIN meta tag
- ❌ **tagra.eu** — přidat: Bing WMT → Add a site → `https://tagra.eu/` → verify via GitHub BingSiteAuth.xml (už existuje v repo!)

Bez tohoto kroku actor pro tyto domény vrátí "no data" / chybu při scrapingu.

---

## Cena & monitoring

| Položka | Cena |
|---|---|
| Apify run × 30 dnů × $0.03 | **~$0.90/měsíc** |
| Make webhook + Data Store | $0 (Core plan limity) |
| Slack notifikace | $0 |
| **Total** | **<$1/měsíc** |

Sleduj náklady v Apify Console → Billing → Usage Chart.

## Troubleshooting

| Problém | Řešení |
|---|---|
| `Login did not reach Webmaster Tools within 90s` | MFA expirovala. Spustit znovu interaktivně přes Live View. |
| `No CSRF token captured` | Bing UI se změnilo. Zkontroluj `mfa-blocker.png` v KV Store. |
| `404 / empty data pro tdt.sk nebo tagra.eu` | Nejsou verified v Bing WMT — viz krok 9. |
| Apify run > $5/měsíc | Sníž frekvenci na týdně (`0 7 * * 1`). |

---

## Co bude reportováno do Slacku (až nasadíš scenario)

```
🟢 Bing AI Performance daily snapshot — 2026-05-18

truckmall.cz: 10 citations (+0 vs včera)
  ├ /zakladni-pravidla-jizdy-...-a51/ → 4×
  ├ /protiskluzova-podlozka-...p185478/ → 4×
  └ /napinaci-prezka-...p212163/ → 2×

truckmall.sk: 2 citations (+0)
  ├ /program-tagra-...-c5720/ → 1×
  └ /lehoty-stahovania-...-a145/ → 1×

tdt.cz: 0 citations (–)
tdt.sk: ⚠️ není v Bing WMT
tagra.eu: ⚠️ není v Bing WMT
```
