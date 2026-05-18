# Bing AI Performance — TRUCKMALL Apify Actor

Stahuje AI citation data z Bing Webmaster Tools (BETA, neoficiální API) pro celou TRUCKMALL skupinu webů (truckmall.cz/.sk, tdt.cz/.sk, tagra.eu) a posílá výsledky do Make webhooku.

## Co dělá

Každý den (nebo jak často naplánuješ):

1. Načte uloženou session z Apify KV Store `bing-session` (key `storageState`)
2. Ověří že session ještě platí (volá `/webmasters/api/globalelements/profile`)
3. Pro každý web extrahuje CSRF token z UI a zavolá interní API:
   - `citationstats` — kolik citation celkem + denní timeseries
   - `pages/stats` — top citované URL s počty
   - `searchqueries/stats` — grounding queries (často prázdné u malých webů)
4. Pošle kompletní JSON na Make webhook
5. Uloží snapshot do Apify Dataset + Key-Value Store
6. Refresh session cookies (Bing je v průběhu runu rotuje)

## Auth model

**Důležité:** Actor **nemá interaktivní login**. Místo toho používá **session storageState** uložený v Apify KV Store `bing-session` (key `storageState`). Tuto session musíš jednou za ~30 dní obnovit pomocí lokálního skriptu `export-bing-session.js`.

**Proč:** Bing WMT účet je registrovaný přes **Google OAuth** (`libor.dospel@gmail.com`), ne přes Microsoft. Google OAuth login v headless Chromium není spolehlivý kvůli CAPTCHA a 2FA.

## Initial Setup (jednorázový)

### Krok 1: Vyexportovat Bing WMT session lokálně

Tento krok dělej **na svém Macu** (ne v Apify — vyžaduje viditelný browser):

```bash
# Klonuj repo
git clone https://github.com/LiorD78/apify-bing-ai-perf-truckmall.git
cd apify-bing-ai-perf-truckmall

# Install deps (jen poprvé)
npm install
npx playwright install chromium

# Nastavit Apify API token z Apify Console → Settings → API & Integrations
export APIFY_TOKEN="apify_api_..."

# Spustit export
node export-bing-session.js
```

Skript otevře viditelné Chrome okno. V něm:
1. Klikni **"Sign In"** vpravo nahoře
2. V modálu vyber **Google**
3. Přihlas se účtem `libor.dospel@gmail.com`
4. Až uvidíš Bing WMT dashboard, vrať se do terminálu a stiskni **ENTER**

Skript uloží session lokálně do `bing-storage-state.json` a **automaticky nahraje do Apify KV Store**.

### Krok 2: První Apify run

V Apify Console:

1. Otevři actor: https://console.apify.com/actors/TDxaZ9eaJabUpXBdX/source
2. Klik **Start**
3. Sleduj log:
   - `✓ Session loaded from KV Store`
   - `✓ Session valid`
   - `✓ CSRF token obtained`
   - `✓ https://www.truckmall.cz/: 12 citations / 4 cited pages`
   - `✓ Webhook delivered: 200`

### Krok 3: Daily Schedule

V Apify Console → **Schedules → Create new schedule**:
- Cron expression: `0 7 * * *` (každý den 7:00 UTC = 8:00 CET / 9:00 CEST)
- Actor: tento
- Memory: 2048 MB
- Timeout: 600 s

## Webhook payload (Make dostává tohle)

```json
{
  "runDate": "2026-05-18T07:00:00.000Z",
  "daysBack": 90,
  "rangeStart": "Mon, 17 Feb 2026 00:00:00 GMT",
  "rangeEnd": "Mon, 18 May 2026 07:00:00 GMT",
  "sites": {
    "https://www.truckmall.cz/": {
      "totalCitations": 12,
      "totalUniquePages": 4,
      "avgUniquePages": 4,
      "timeseries": [{ "Date": "2026-05-14T00:00:00", "Citations": 10, "UniqueCitedPages": 3 }],
      "topPages": [
        { "url": "https://www.truckmall.cz/zakladni-pravidla-...-a51/", "citations": 4 },
        { "url": "https://www.truckmall.cz/protiskluzova-podlozka-...p185478/", "citations": 4 }
      ],
      "groundingQueries": { "status": 404, "note": "No data available" }
    }
  },
  "errors": []
}
```

## Cena

- 1 run ≈ 30-60 sekund × 2 GB RAM = ~$0.005
- Denně = ~$0.15/měsíc
- Pod $5 free tier limit ✓

## Maintenance

**Session refresh** (jednou za ~30 dní):

Když Apify run failuje s `Session expired or invalid`:

```bash
cd ~/path/to/apify-bing-ai-perf-truckmall
export APIFY_TOKEN="apify_api_..."
node export-bing-session.js
```

Trvá ~2 min. Po dokončení další scheduled run bude OK.

## Troubleshooting

### `"No session found in KV Store bing-session"`
→ První setup ještě nebyl. Spustit `export-bing-session.js` lokálně.

### `"Session expired or invalid"`
→ Session vypršela (typicky po ~30 dnech). Spustit `export-bing-session.js` znovu.

### `"Failed to fetch CSRF token: HTTP 401"`
→ Session sice byla validní při startu, ale Bing ji během runu invalidoval. Spustit `export-bing-session.js` znovu.

### Site is missing from Bing WMT (empty data / errors)
→ tdt.sk a tagra.eu nejsou aktuálně verified v Bing WMT. Přidat je v Bing Webmaster Tools → Add site → DNS/meta verification, pak runs poskytnou data.

### Apify upload selhal (`APIFY_TOKEN` chybí)
→ Spustit `SKIP_UPLOAD=1 node export-bing-session.js` — uloží jen lokálně, pak nahraj `bing-storage-state.json` ručně přes Apify Console → Storage → bing-session → Upload.

## Files

- `src/main.js` — actor entrypoint (session-based auth)
- `export-bing-session.js` — lokální helper pro session export & Apify upload
- `package.json` — npm dependencies (apify, playwright)
- `.actor/actor.json` — Apify manifest
- `.actor/INPUT_SCHEMA.json` — input form schema
- `Dockerfile` — Apify build image

## Architektura

```
┌──────────────────────────────────────────────────────────────┐
│ Lokální Mac (1× za ~30 dní)                                  │
│                                                              │
│   export-bing-session.js                                     │
│   ├── Otevře viditelné Chromium                              │
│   ├── User se přihlas přes Google OAuth                      │
│   ├── Uloží storageState lokálně + nahraje do Apify          │
│   └── ✓ Done                                                 │
└─────────────────────────┬────────────────────────────────────┘
                          │ HTTP PUT
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ Apify KV Store: bing-session                                 │
│   key: storageState  →  { cookies, origins }                 │
└─────────────────────────┬────────────────────────────────────┘
                          │ načte
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ Apify Actor: TDxaZ9eaJabUpXBdX                               │
│ (denně cron 7:00 UTC)                                        │
│                                                              │
│   src/main.js                                                │
│   ├── Načte storageState                                     │
│   ├── Validuje session (profile API)                         │
│   ├── Get CSRF token                                         │
│   ├── Pro každý ze 5 webů:                                   │
│   │     ├── POST /aiperformance/citationstats                │
│   │     ├── POST /aiperformance/pages/stats                  │
│   │     └── POST /aiperformance/searchqueries/stats          │
│   ├── Refresh session cookies                                │
│   └── POST výsledek na Make webhook                          │
└─────────────────────────┬────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ Make scenario: bing_ai_perf_processor                        │
│   Webhook (3059855) → Data Store bing_ai_perf_snapshots      │
│                       (125404) + Slack alert                 │
└──────────────────────────────────────────────────────────────┘
```
