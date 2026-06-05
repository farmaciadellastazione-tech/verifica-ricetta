# Automazione aggiornamento FOFI (GitHub Actions)

Il workflow [`.github/workflows/fofi-update.yml`](.github/workflows/fofi-update.yml)
controlla ogni mattina la casella della farmacia: se è arrivato un nuovo Excel
*"Segnalazioni urgenti FOFI"* dall'Ordine (`ordinesp@fofiruf.it`), aggiorna
`fofi-db.js`, bumpa versione + cache, lancia i test e **apre una Pull Request su
`dev`** con l'elenco delle nuove circolari. Tu controlli il diff e fai merge.

**Non tocca mai `main`** (la produzione resta a conferma manuale) e accede alla
mail in **sola lettura**. Se il formato dell'Excel cambia, il job **fallisce in
modo rumoroso** invece di committare dati sbagliati.

---

## Setup una-tantum (~10 minuti)

Serve dare al workflow una credenziale Gmail propria (sola lettura), indipendente
dal tuo accesso. Si fa con tre "secret" del repository.

### 1. Abilita la Gmail API e crea le credenziali OAuth

1. Vai su [Google Cloud Console](https://console.cloud.google.com/) → crea (o scegli)
   un progetto.
2. **API e servizi → Libreria** → cerca **Gmail API** → *Abilita*.
3. **API e servizi → Schermata consenso OAuth** → tipo *Esterno* → inserisci come
   *utente di test* l'indirizzo `farmaciadellastazione@gmail.com`.
4. **API e servizi → Credenziali → Crea credenziali → ID client OAuth** → tipo
   *Applicazione web* → in *URI di reindirizzamento autorizzati* aggiungi
   `https://developers.google.com/oauthplayground` → *Crea*.
5. Copia **ID client** e **Client secret**.

### 2. Ottieni il Refresh token (con OAuth Playground)

1. Apri [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/).
2. Ingranaggio (⚙, in alto a destra) → spunta *Use your own OAuth credentials* →
   incolla **ID client** e **Client secret**.
3. A sinistra, nel campo *Input your own scopes*, scrivi:
   `https://www.googleapis.com/auth/gmail.readonly` → **Authorize APIs** →
   accedi con `farmaciadellastazione@gmail.com` e concedi.
4. **Exchange authorization code for tokens** → copia il **Refresh token**.

### 3. Aggiungi i secret al repository

GitHub → repo `verifica-ricetta` → **Settings → Secrets and variables → Actions →
New repository secret**. Crea i tre:

| Nome | Valore |
|------|--------|
| `GMAIL_CLIENT_ID` | l'ID client del punto 1 |
| `GMAIL_CLIENT_SECRET` | il client secret del punto 1 |
| `GMAIL_REFRESH_TOKEN` | il refresh token del punto 2 |

---

## Provarla

- GitHub → scheda **Actions** → *Aggiornamento banca dati FOFI* → **Run workflow**
  (sul branch `dev`). Se non ci sono circolari nuove, il job termina senza fare
  nulla; altrimenti compare una PR verso `dev`.

> Lo **scheduler automatico** (ogni mattina) parte solo quando il workflow è
> presente sul **branch di default** del repo (`main`): finché resta solo su
> `dev`, usalo a mano con *Run workflow*. Dopo il merge su `main` (con la tua
> conferma) gira da solo.

## Cosa fa, passo per passo

1. `tools/fetch-fofi-email.mjs` — scarica l'allegato `.xlsx` dell'ultima mail FOFI.
2. `tools/build-fofi-db.mjs --write` — accoda solo le circolari con numero nuovo
   (deterministico, nessuna AI; preserva le voci esistenti).
3. `tools/bump-build.mjs` — incrementa `APP_BUILD`/data in `index.html` e allinea
   `CACHE_NAME` in `sw.js` (invalida la cache delle PWA installate).
4. `npm test` — la suite deve passare.
5. Apre/aggiorna la PR `auto/fofi-update` → `dev`.

## Se qualcosa va storto

- **Job fallito su "fetch mail"**: token scaduto/revocato o quota → rigenera il
  refresh token (passo 2) e aggiorna il secret.
- **Job fallito su build/test**: probabile cambio di formato dell'Excel → apri
  il log, aggiorna `fofi-xlsx.js` e i test, poi rilancia.
- In ogni caso la banca dati **non** viene modificata finché la PR non è approvata.
