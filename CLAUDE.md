# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Italian-language single-page PWA for **Farmacia della Stazione** (La Spezia) that pre-checks medical prescriptions before dispensing. The app takes a photo of the ricetta (and/or manually entered fields), sends it to Google Gemini for OCR + regulatory analysis, and cross-references prescriber name and drug against the **FOFI banca dati** (Federazione Ordini Farmacisti Italiani — official Italian register of stolen stamps / falsified prescriptions). All UI text is Italian and must stay Italian. Regulatory terms (SSN, RMR/RNR, allegato III-bis, nota AIFA, DPR 309/90, D.Lgs. 219/2006) are legal names — never translate or rename.

## Files

- `index.html` — the entire app (~1570 lines: HTML, CSS, vanilla JS). Inlines the Gemini prompt + FOFI matching logic + UI.
- `fofi-db.js` — banca dati FOFI as a single `const FOFI_DB = [...]` array, loaded via `<script src>` before the inline script. ~144 entries per object: `{n, t, tx, m, f}` — `n`=numero circolare, `t`=tipi (`F` falsificazione, `T` furto/timbro, `B` buoni acquisto), `tx`=testo originale, `m`=medici estratti, `f`=farmaci estratti. **Il matching gira su `tx`** (vedi `cercaFOFI`/`scoreMatch`), non su `m`/`f`: quei due campi sono metadati di corredo — la cosa critica è che `tx` contenga nome medico e farmaco per esteso. Espone anche `const FOFI_DB_AGGIORNATA` (data `dd/mm/yyyy` della mail FOFI che ha portato l'ultimo Excel): è la data mostrata nel footer come "Aggiornamento" — **non è la data del build**, è quella della segnalazione dell'Ordine, ricavata automaticamente (vedi `fetch-fofi-email.mjs`). Updated when new FOFI circolari arrive (vedi `admin.html`).
- `fofi-xlsx.js` — core puro (browser+Node, come `fofi-match.js`) che converte il foglio Excel FOFI in voci `FOFI_DB`. Non fa unzip né I/O: riceve le stringhe XML già estratte. Funzioni chiave: `sheetToEntries(sharedStringsXml, sheetXml)`, `mergeNewEntries(existing, fromXlsx)` (accoda solo le circolari con numero nuovo, preserva i `m`/`f` esistenti), `entriesToDbFile(entries, aggiornata?)` (se `aggiornata` è valorizzata emette la costante `FOFI_DB_AGGIORNATA`), `formatEmailDate(rfc2822)` (header `Date` della mail → `dd/mm/yyyy` in UTC). Testato in `tests/fofi-xlsx.test.js`.
- `tools/build-fofi-db.mjs` — script Node (ESM) per aggiornare la banca dati dall'Excel FOFI. `node tools/build-fofi-db.mjs file.xlsx` (anteprima) / `--write` (accoda) / `--full` (rigenera da zero, perde i `m`/`f`). Per la data "Aggiornamento" cerca un file di appoggio `file.xlsx.date` (scritto da `fetch-fofi-email.mjs` con la data della mail); se manca conserva la data già in `fofi-db.js`. Include un mini-lettore ZIP senza dipendenze (`zlib.inflateRawSync`). npm script: `npm run update-fofi`.
- `admin.html` — pagina di manutenzione **non linkata dall'app** (solo via URL `/admin.html`). Due input: **(a)** carica l'allegato `.xlsx` della mail "Segnalazioni urgenti FOFI" (unzip in-browser via `DecompressionStream`, riusa `sheetToEntries`/`mergeNewEntries` — deterministico, no AI); **(b)** incolla il testo di una singola circolare → Gemini estrae `{n,t,tx,m,f}`. Entrambi alimentano la stessa coda e scaricano un `fofi-db.js` rigenerato (una voce per riga). Non è nel precache del service worker. Dopo l'inserimento bumpare `CACHE_NAME` in `sw.js`.

**Fonte aggiornamenti FOFI**: mail periodica da `ordinesp@fofiruf.it` (Ordine Farmacisti SP), oggetto "Segnalazioni urgenti FOFI…", con allegato Excel (colonne: B=numero, C=falsificazione/`F`, D=furto-smarrimento timbro/`T`, E=buoni acquisto/`B`). È la fonte canonica della banca dati; le circolari FOFI numerate su altri temi (corsi, note operative) NON vanno in `FOFI_DB`.

**Automazione** (`.github/workflows/fofi-update.yml`, vedi `AUTOMAZIONE-FOFI.md`): workflow schedulato che scarica la mail (`tools/fetch-fofi-email.mjs`, Gmail API read-only via secret `GMAIL_*`), aggiorna la banca dati, bumpa versione+cache (`tools/bump-build.mjs`), gira i test e apre una PR su `dev`. **Mai su `main`**. Lo scheduler parte solo dal branch di default (`main`): finché il workflow è solo su `dev`, va lanciato a mano (workflow_dispatch). `tools/bump-build.mjs` tiene allineati `APP_BUILD`/`APP_BUILD_DATE` (index.html) e `CACHE_NAME` (sw.js) — funzioni pure testate in `tests/bump-build.test.js`.
- `sw.js` — service worker, cache-first for app shell, bypass for cross-origin (Gemini API).
- `manifest.webmanifest` — PWA manifest, standalone display, "Verifica Ricetta" short name.
- `icon-{180,192,512}.png` — PWA icons.
- `worker/proxy.js` — Cloudflare Worker that proxies Gemini calls with a server-held key. **Currently NOT used** by `index.html` (which calls Gemini directly with the user's per-device key). The worker is kept as an alternative path; if you wire it in, set `PROXY_URL` in the app and use it instead of the direct `generativelanguage.googleapis.com` fetch. The previous embedded key approach was abandoned after Google secret scanning flagged it.

## Run / build / test

No build system, no package manager, no test suite. Open `index.html` over a static HTTP server (the PWA service worker requires HTTPS or localhost — opening as `file://` will break SW registration). Deployment is via GitHub Pages on `https://farmaciadellastazione-tech.github.io/`.

After any non-trivial edit, **manually verify in a browser**:
1. Switch through tutti i tipi ricetta (`bianca`, `ssn`, `stupefacenti`) and entrambi gli stati (`da-spedire`, `gia-spedita`) — the "stupefacenti" tab reveals the n° ricettario field, "ssn" reveals the NRE field.
2. Upload a photo (or paste fields manually) and run a real analysis — check that the FOFI banner appears when the prescriber name or drug matches an entry in `FOFI_DB`.
3. Confirm `console` has no errors and the footer build label updates (see Versioning).

## Architecture

### AI call (Gemini, direct from browser)

`analizza()` (around `index.html:1139`) builds a multimodal request: one `inline_data` part per uploaded image + one text part with the prompt (`buildPrompt()`). The prompt is large and tipo-specific — it embeds the regulatory checklist for ricetta SSN / bianca / stupefacenti and instructs the model to return a JSON checklist.

**Model fallback chain**: `gemini-2.5-flash` → `gemini-flash-latest` → `gemini-flash-lite-latest`. Only 503/429 trigger fallback; other errors surface immediately. `thinkingBudget: 2000` caps reasoning so the 16k token budget leaves ~14k for the JSON. Temperature is 0.0 — do not raise it casually, regulatory checks must be deterministic.

**API key handling**: the user pastes their own Gemini key into the input, persisted in `localStorage` under `gemini-api-key`. `EMBEDDED_GEMINI_KEY` is intentionally an empty string — **do not re-add an embedded key**. The previous embedded key was revoked by Google secret scanning even with referer restriction. If you want a shared key, route through the Cloudflare Worker in `worker/proxy.js` (key as Secret, origin-checked).

### FOFI cross-check

The FOFI database is matched against the prescriber and drug returned by Gemini (and against manually entered fields). Matching is fuzzy and case-insensitive against the `m` (medici) and `f` (farmaci) arrays in each `FOFI_DB` entry. Hits are surfaced in a red alert banner above the result. The banner is the user's primary safety signal — preserve its prominence (red `var(--red-400)` border + `var(--red-50)` background).

### Tipo ricetta vs stato

- `tipoSelezionato`: `'bianca' | 'ssn' | 'stupefacenti'` — drives which checklist the prompt loads and which input fields appear (NRE for SSN, n° ricettario for stupefacenti).
- `statoRicetta`: `'da-spedire'` (pre-controllo, default) | `'gia-spedita'` (verifica conformità a posteriori) — changes the button label and tweaks the prompt's framing.

The regulatory logic for ricetta bianca privata vs SSN is **substantially different** and is encoded in the prompt itself (see the `bianca` / `ssn` / `stupefacenti` blocks inside `buildPrompt`). Notable rules already baked in:
- Note AIFA (N01, 13, 64, 75, ecc.) apply only su SSN, mai su bianca privata.
- RMR (ricalco) vs RNR (bianca/SSN non a ricalco) determina la necessità del documento ritirante per stupefacenti allegato III-bis (vedi DPR 309/90 art. 45 c. 6-bis).
- Alcuni farmaci sono OSP1 (uso ospedaliero esclusivo, art. 92 DL 219/06) — segnala "errore di prescrivibilità", non "manca documento".

If you change the regulatory text in the prompt, double-check against the most recent version of D.Lgs. 219/2006 and DPR 309/90; these are the regulatory anchors the prompt is built around.

### Versioning + PWA cache

Two version markers must stay in sync:
- `APP_BUILD` (integer) + `APP_BUILD_DATE` near the top of the inline `<script>` in `index.html` — drives the footer "Build N · DD/MM/YYYY" label.
- `CACHE_NAME` in `sw.js` (e.g. `verifica-ricetta-build56`) — must include the same build number, otherwise the SW won't invalidate the old cached app shell and users keep seeing the previous version.

**Bump both together** on every user-visible change.

### Photo input on iOS PWA

`.foto-input { position: fixed; top: 0; left: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none; }` is intentional — on iOS when the app runs as installed PWA, `display:none` on `<input type="file">` makes `input.click()` silently no-op. Keep the input in layout (positioned off-screen + opacity 0). Don't "tidy up" to `display:none` or `visibility:hidden`.

### Italian-keyboard quirks

The Italian keyboard layout occasionally mangles characters from scanned QR codes elsewhere in our codebase (galenico). This app doesn't currently parse scan-wedge input, but if added, watch for `ç`→`:` and `-`→`/` substitutions.

## Conventions and gotchas

- **No framework** — vanilla JS, plain DOM. Don't introduce React/Vue/build steps; the deployment story is "git push, GH Pages serves, PWA caches".
- **Italian decimals / numbers**: not relevant in this project (no calculations), but if you add any, prefer raw `,` display + `parseFloat` after `.replace(',', '.')`.
- **Pharmacy identity hardcoded** in the footer: `Farmacia della Stazione · Via Fiume 75, 19122 La Spezia · P.I. 01317570115`. Same across all our farmacia projects — if branding changes, grep across `C:\Progetti\` rather than guessing a config location.
- **Logging**: `console.warn` / `console.info` with `[Verifica]` prefix for model fallback events. Keep noise low — users open DevTools in panic, don't flood it.
- **Comments in Italian** in the code (author preference). Keep new comments Italian unless context demands otherwise.

## Linguaggio della comunicazione

L'autore è italiano: risposte e commenti nei file in italiano salvo richiesta diversa.

## Testing rules
- Never modify existing tests to make them pass (fix the implementation)
- Never update snapshots without explicit instruction
- Use transactions for database tests (roll back after each test)
- Mark flaky tests with @pytest.mark.flaky
- Write the failing test before fixing any reported bug
- Run the full suite before declaring work complete
