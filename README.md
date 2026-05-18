# Bing AI Performance — TRUCKMALL Apify Actor

Stahuje AI citation data z Bing Webmaster Tools (BETA, neoficiální API) pro celou TRUCKMALL skupinu webů a posílá výsledky do Make.

## Co dělá

Každý den (nebo jak často naplánuješ):

1. Přihlásí se do Bing WMT skrz uloženou session (MFA ručně jen 1× na začátku)
2. Pro každý web extrahuje CSRF token z UI a zavolá interní API:
   - `citationstats` — kolik citation celkem + denní timeseries
   - `pages/stats` — top citované URL s počty
   - `searchqueries/stats` — grounding queries (často prázdné u malých webů)
3. Pošle kompletní JSON na Make webhook
4. Uloží snapshot do Apify Dataset + Key-Value Store

## Webhook payload (Make dostává tohle)

```json
{
  "runDate": "2026-05-18T07:00:00.000Z",
  "daysBack": 90,
  "rangeStart": "Mon, 17 Feb 2026 00:00:00 GMT",
  "rangeEnd": "Mon, 18 May 2026 07:00:00 GMT",
  "sites": {
    "https://www.truckmall.cz/": {
      "totalCitations": 10,
      "totalUniquePages": 3,
      "avgUniquePages": 3,
      "timeseries": [{ "Date": "2026-05-14T00:00:00", "Citations": 10, "UniqueCitedPages": 3 }],
      "topPages": [
        { "url": "https://www.truckmall.cz/zakladni-pravidla-...-a51/", "citations": 4 },
        { "url": "https://www.truckmall.cz/protiskluzova-podlozka-...p185478/", "citations": 4 }
      ],
      "groundingQueries": { "status": 404, "note": "No data available" }
    },
    "...": "..."
  },
  "errors": []
}
```

## Setup (jednorázový)

### 1. Vytvořit Apify účet

→ https://console.apify.com/sign-up — žádná kreditka, $5 free credits/měsíc, resetuje se každý měsíc.

### 2. Vytvořit Actor

V Apify Console:
- **Actors → Development → Create new**
- Source type: **"Source code"** (ne Web IDE, chceš to v Gitu)
- NEBO **"Web IDE"** pokud chceš to zkopírovat ručně (jednodušší pro první start)

Pro Web IDE variant:
1. Zkopíruj všechny soubory z této složky (package.json, src/main.js, Dockerfile, .actor/*)
2. V Apify Console klikni Build (~3 min)

Pro Git variant:
1. Pushni složku do GitHub repa
2. V Apify Console: Source → Git repo URL → Build

### 3. Nastavit Secrets

V Apify Console → Settings → Integrations → **Secrets**:
- `MS_EMAIL` = `libor.dospel@gmail.com`
- `MS_PASSWORD` = (tvoje Microsoft heslo)

Tyto secrets se pak v inputu reference jako `{{secrets.MS_EMAIL}}`.

### 4. První interaktivní run (MFA challenge)

⚠️ DŮLEŽITÉ: Pokud máš na Microsoft účtu MFA (Authenticator/SMS), první run **MUSÍ** být interaktivní:

1. Klikni **Start** s defaultním inputem
2. Když actor startuje, klikni **Live View** v pravém horním rohu
3. Sleduj browser ve full screen — když narazí na MFA, **dokonči to ručně**
4. Actor uloží session do KV Store (`bing-session/storageState`)
5. Další runs (i scheduled) už používají uloženou session bez MFA

Session vydrží 30+ dní u Microsoft business účtů. Pokud expiruje, actor selže s screenshotem `mfa-blocker.png` v KV Store → spustíš znovu interaktivně.

### 5. Nastavit Make webhook

V tomto projektu udělám Make scenario (přijímá webhook → ukládá do Datastore → posílá Slack notifikaci). Webhook URL vložíš do `makeWebhookUrl` v Apify inputu.

### 6. Schedule

V Apify Console → **Schedules → Create new schedule**:
- Cron expression: `0 7 * * *` (každý den 7:00 UTC = 8:00 CET / 9:00 CEST)
- Actor: tento
- Memory: 2048 MB
- Timeout: 600 s

## Cena

- 1 run ≈ 2-3 minuty × 2 GB RAM = ~$0.03
- Denně = ~$0.90/měsíc
- Pod $5 free tier limit ✓

## Troubleshooting

### "Login did not reach Webmaster Tools within 90s"
→ MFA challenge. Spustit znovu interaktivně přes Live View.

### "No CSRF token captured for {url}"
→ Bing UI změnilo strukturu. Otevři `mfa-blocker.png` (Actor automaticky screenshot) a podle něj uprav selektory.

### Site is missing from Bing WMT (404 / empty data)
→ tdt.sk a tagra.eu nejsou aktuálně verified v Bing WMT. Přidat je v Bing Webmaster Tools → Add site → DNS/meta verification, pak runs poskytnou data.

## Files

- `package.json` — npm dependencies
- `src/main.js` — actor entrypoint
- `.actor/actor.json` — Apify manifest
- `.actor/INPUT_SCHEMA.json` — input form schema
- `Dockerfile` — Apify build image
