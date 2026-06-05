# Checklist — aggiornare la banca dati FOFI

Da seguire **quando arriva la mail** dell'Ordine dei Farmacisti
(`ordinesp@fofiruf.it`, oggetto *"Segnalazioni urgenti FOFI… falsificazione
ricette / smarrimento timbro / buoni acquisto"*) con l'allegato Excel.

> ⚠️ Solo questa mail aggiorna `fofi-db.js`. Le altre circolari FOFI numerate
> (corsi, note operative) **non** vanno in banca dati.

Struttura dell'Excel (per riferimento): colonna **B** = numero circolare ·
**C** = falsificazione ricette (`F`) · **D** = furto/smarrimento timbro o
ricettario (`T`) · **E** = buoni acquisto (`B`).

---

## Metodo A — Script Node (consigliato)

```bash
# 0. assicurati di essere sul branch dev
git checkout dev && git pull

# 1. salva l'allegato .xlsx (es. nel Desktop) e fai l'ANTEPRIMA
node tools/build-fofi-db.mjs "C:\percorso\Circolari FOFI Segnalazioni.xlsx"
#    -> elenca le circolari nuove. Se dice "già aggiornata", FINE.

# 2. se ci sono voci nuove, APPLICA
node tools/build-fofi-db.mjs "C:\percorso\Circolari FOFI Segnalazioni.xlsx" --write
```

- [ ] Anteprima eseguita, controllato l'elenco delle nuove circolari
- [ ] `--write` eseguito → `fofi-db.js` aggiornato
- [ ] **Bump `CACHE_NAME`** in `sw.js` (es. `…-build57` → `…-build58`)
- [ ] `npm test` → suite verde
- [ ] `git add -A && git commit` + `git push origin dev`
- [ ] Aperta l'app su `dev`, verificato che il banner FOFI scatti su un nome
      preso da una circolare nuova

---

## Metodo B — Pagina admin (senza PC/repo a portata)

1. Apri `…/admin.html` (URL diretto, non c'è link dall'app).
2. Sezione **"2-bis · Carica l'Excel FOFI"** → seleziona il `.xlsx`.
3. Vengono messe in coda **solo le circolari non ancora presenti**.
4. **Scarica `fofi-db.js`** e committalo nel repo (sostituendo il file).

- [ ] Excel caricato, controllata la coda delle nuove voci
- [ ] `fofi-db.js` scaricato e messo nel repo su `dev`
- [ ] **Bump `CACHE_NAME`** in `sw.js`
- [ ] commit + push su `dev`

> Per una singola circolare arrivata **fuori** dall'Excel, usa la sezione
> "2 · Incolla il testo" (estrazione via Gemini) invece dell'upload.

---

## Note

- Il matching del farmacista gira sul campo **`tx`** (il testo): i campi
  `m`/`f` sono metadati e per le voci importate da Excel restano vuoti — il
  riconoscimento funziona comunque.
- Il **primo** `--write` produce un diff grande: `fofi-db.js` passa da
  riga-unica a una-voce-per-riga (reformat una-tantum, voluto). Dai successivi
  in poi il diff mostra solo le righe aggiunte.
- Il bump di `CACHE_NAME` è **obbligatorio**: senza, le PWA già installate
  restano alla banca dati vecchia.
- Merge su `main` (produzione) solo dopo verifica su `dev` e con conferma.
