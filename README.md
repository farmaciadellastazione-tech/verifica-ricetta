# Verifica Ricetta

PWA in italiano per la **Farmacia della Stazione** (La Spezia) che effettua un
pre-controllo delle ricette mediche prima della spedizione.

L'app scatta una foto della ricetta (e/o accetta i campi inseriti a mano), la
invia a **Google Gemini** per OCR + analisi normativa, e incrocia il nome del
medico prescrittore e il farmaco con la **banca dati FOFI** (Federazione Ordini
Farmacisti Italiani — registro ufficiale di timbri rubati / ricette falsificate).

> ⚠️ **Strumento di supporto, non sostituisce il giudizio del farmacista.** L'esito
> va sempre verificato. Non è un parere legale né un'autorità normativa.

**Online:** https://farmaciadellastazione-tech.github.io/verifica-ricetta/

---

## Funzioni

- **Tre tipi di ricetta**: `bianca` (privata), `ssn` (dematerializzata/NRE),
  `stupefacenti` (con n° ricettario). Ogni tipo carica la checklist normativa
  specifica.
- **Due stati**: `da-spedire` (pre-controllo) e `gia-spedita` (verifica di
  conformità a posteriori).
- **OCR + analisi normativa** via Gemini: SSN, RMR/RNR, allegato III-bis, note
  AIFA, DPR 309/90, D.Lgs. 219/2006.
- **Allerta FOFI**: banner rosso quando il medico o il farmaco corrispondono a
  una segnalazione nella banca dati delle circolari FOFI. È il principale segnale
  di sicurezza dell'app.
- **Stampa report** per il medico/paziente quando mancano elementi.
- Funziona **offline come PWA** (installabile), tranne la chiamata a Gemini.

---

## Chiave API

L'app usa **la chiave Gemini personale dell'utente**, incollata nell'apposito
campo e salvata solo in `localStorage` del dispositivo (`gemini-api-key`).
Si ottiene gratis su [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

Non c'è una chiave condivisa incorporata: quella precedente è stata revocata da
Google secret scanning. Per un eventuale percorso con chiave server-side esiste
`worker/proxy.js` (Cloudflare Worker), al momento **non collegato**.

---

## File principali

| File | Ruolo |
|------|-------|
| `index.html` | L'intera app: HTML + CSS + JS vanilla. Inlina il prompt Gemini, la logica di matching FOFI e la UI. |
| `fofi-db.js` | Banca dati FOFI come array `const FOFI_DB = [...]`. Ogni voce: `{n, t, tx, m, f}` (numero circolare, tipi, testo, medici, farmaci). |
| `fofi-match.js` | Logica pura di matching FOFI + calcolo scadenza. Condivisa da app e test. |
| `fofi-xlsx.js` | Core puro: converte il foglio Excel FOFI in voci `FOFI_DB`. Condiviso da script Node, `admin.html` e test. |
| `tools/build-fofi-db.mjs` | Script Node: legge l'Excel FOFI e accoda le nuove circolari a `fofi-db.js` (vedi sotto). |
| `admin.html` | Pagina di manutenzione per **aggiornare la banca dati FOFI** (vedi sotto). |
| `sw.js` | Service worker, cache-first per l'app shell. |
| `manifest.webmanifest` | Manifest PWA. |
| `worker/proxy.js` | Cloudflare Worker proxy per Gemini (alternativa, non in uso). |

---

## Aggiornare la banca dati FOFI

**Fonte degli aggiornamenti:** l'Ordine dei Farmacisti della Spezia
(`ordinesp@fofiruf.it`) invia periodicamente una mail *"Segnalazioni urgenti FOFI —
falsificazione ricette / smarrimento timbro / buoni acquisto"* con allegato un
file **Excel** che sostituisce il precedente. Il foglio è strutturato a colonne:
colonna **B** = numero circolare, **C** = falsificazione ricette (`F`),
**D** = furto/smarrimento timbro o ricettario (`T`), **E** = buoni acquisto (`B`).
Da qui i campi `n`, `t` e `tx` si ricavano in modo **deterministico, senza AI**.

Due strumenti, stesso motore (`fofi-xlsx.js`):

### A) Script Node (consigliato)

```bash
# anteprima: mostra solo le circolari nuove, non scrive nulla
node tools/build-fofi-db.mjs "Circolari FOFI Segnalazioni.xlsx"

# applica: accoda le nuove voci a fofi-db.js (preserva le esistenti e i loro m/f)
node tools/build-fofi-db.mjs "Circolari FOFI Segnalazioni.xlsx" --write
```

Poi commit/push su `dev` e **bumpa `CACHE_NAME` in `sw.js`**.

### B) Pagina admin (`admin.html`)

Pagina non linkata dall'app, raggiungibile solo via URL. Due modi:

- **Carica l'Excel FOFI** (sezione "2-bis"): trascini il `.xlsx`, vengono messe
  in coda solo le circolari non ancora presenti, poi **Scarica `fofi-db.js`**.
- **Incolla il testo** di una singola circolare (sezione "2"): Gemini estrae
  `{n, t, tx, m, f}` per i casi fuori-Excel. Riusa la chiave dell'app.

> Il matching del farmacista avviene sul campo `tx`: i campi `m`/`f`
> (medici/farmaci) sono solo metadati di corredo. Per le voci importate da Excel
> restano vuoti — il riconoscimento funziona comunque sul testo.

---

## Sviluppo

Non c'è build step in produzione: l'app è un single-file servito statico.
Per lo sviluppo basta un server HTTP statico locale (il service worker richiede
HTTPS o `localhost`; aprire come `file://` rompe la registrazione del SW).

```bash
# esempio di server statico locale
python -m http.server 8080
# poi apri http://localhost:8080
```

### Test

Esiste una suite [Vitest](https://vitest.dev/) sulla logica pura di matching
(`fofi-match.js`):

```bash
npm install     # solo la prima volta
npm test        # esegue la suite
npm run test:watch
```

---

## Versioning + cache PWA

Due marcatori vanno tenuti allineati **a ogni modifica visibile**:

- `APP_BUILD` (intero) + `APP_BUILD_DATE` in cima allo `<script>` di `index.html`
  → guidano la label "Build N · DD/MM/YYYY" nel footer.
- `CACHE_NAME` in `sw.js` (es. `verifica-ricetta-build57`) → deve contenere lo
  stesso numero di build, altrimenti il SW non invalida la cache e gli utenti
  vedono la versione precedente.

## Deploy

Push su GitHub → GitHub Pages serve `https://farmaciadellastazione-tech.github.io/`.
Si lavora sempre sul branch `dev`; il merge sul branch di produzione va fatto con
conferma esplicita.

---

Farmacia della Stazione · Via Fiume 75, 19122 La Spezia · P.I. 01317570115
