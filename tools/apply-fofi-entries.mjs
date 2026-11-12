#!/usr/bin/env node
// apply-fofi-entries.mjs — accoda a fofi-db.js voci che non arrivano dall'Excel.
//
// Uso:
//   node tools/apply-fofi-entries.mjs <file.json | circolare.pdf ...> [--write] [--date dd/mm/yyyy]
//
//   file.json  prodotto da fetch-fofi-email.mjs: { aggiornata, entries: [...] }
//   *.pdf      circolari FOFI scaricate a mano (serve `pdftotext` nel PATH);
//              il numero è preso dal nome file ("16132.pdf") o dal testo.
//   --write    scrive fofi-db.js (default: solo anteprima)
//   --date     data "Aggiornamento" da mostrare nel footer (default: quella del
//              JSON, altrimenti resta quella già in fofi-db.js)
//
// Riga finale machine-readable per la CI: FOFI_ADDED=16130,16132,FF 05/11/2026

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { entriesToDbFile, mergeNewEntries } = require(resolve(ROOT, 'fofi-xlsx.js'));
const { circolarePdfToEntry, dataPiuRecente, applicaRiletture } = require(resolve(ROOT, 'fofi-avvisi.js'));
const { chiaveData } = require(resolve(ROOT, 'fofi-match.js'));

function loadCurrentDb() {
  const src = readFileSync(resolve(ROOT, 'fofi-db.js'), 'utf8');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src + ';globalThis.__FOFI=FOFI_DB;' +
    'globalThis.__AGG=(typeof FOFI_DB_AGGIORNATA!=="undefined")?FOFI_DB_AGGIORNATA:null;', ctx);
  return { db: ctx.__FOFI, aggiornata: ctx.__AGG };
}

const args = process.argv.slice(2);
const write = args.includes('--write');
const dIdx = args.indexOf('--date');
let aggiornata = dIdx >= 0 ? args[dIdx + 1] : null;
const inputs = args.filter((a, i) => !a.startsWith('--') && !(dIdx >= 0 && i === dIdx + 1));
if (!inputs.length) {
  console.error('Uso: node tools/apply-fofi-entries.mjs <file.json | circolare.pdf ...> [--write] [--date dd/mm/yyyy]');
  process.exit(1);
}
// La data finisce in fofi-db.js (d e "Aggiornamento"): un formato sbagliato
// farebbe fallire i test e bloccherebbe la pipeline.
if (dIdx >= 0 && !chiaveData(aggiornata)) {
  console.error(`--date deve essere dd/mm/yyyy (ricevuto: ${aggiornata}).`);
  process.exit(1);
}
// Per i PDF a mano la data della mail non si conosce: va data esplicitamente,
// altrimenti una circolare recuperata in ritardo salirebbe in cima all'elenco.
if (inputs.some(f => /\.pdf$/i.test(f)) && dIdx < 0) {
  console.error('Per i PDF serve --date dd/mm/yyyy (data della mail con cui è arrivata la circolare).');
  process.exit(1);
}

const nuove = [];
const riletture = []; // voci Federfarma già presenti, rilette con OCR
for (const f of inputs) {
  if (/\.json$/i.test(f)) {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    nuove.push(...(j.entries || []));
    riletture.push(...(j.riletture || []));
    if (!aggiornata && j.aggiornata) aggiornata = j.aggiornata;
  } else if (/\.pdf$/i.test(f)) {
    const text = execFileSync('pdftotext', ['-enc', 'UTF-8', f, '-'], { encoding: 'utf8' });
    const num = basename(f).match(/\b(1\d{4})\b/);
    const e = circolarePdfToEntry(text, num ? parseInt(num[1], 10) : undefined);
    // Data di arrivo (ordina l'elenco della banca dati): quella di --date.
    if (e) nuove.push({ ...e, d: e.d || args[dIdx + 1] });
    else console.log(`- ${basename(f)}: non è una segnalazione, ignorata.`);
  }
}

const { db, aggiornata: aggiornataAttuale } = loadCurrentDb();
const { merged: conNuove, added } = mergeNewEntries(db, nuove);
const { db: merged, aggiornate } = applicaRiletture(conNuove, riletture);
console.log(`Banca dati attuale: ${db.length} voci · candidate: ${nuove.length} · nuove: ${added.length} · rilette (OCR): ${aggiornate.length}`);
if (!added.length && !aggiornate.length) { console.log('✓ Nessuna voce nuova.'); process.exit(0); }

const etichetta = e => e.n != null ? String(e.n) : `${e.src === 'Ordine SP' ? 'OSP' : 'FF'} ${e.d}`;
added.forEach(e => console.log(`  ${etichetta(e)} [${e.t}] ${e.tx.replace(/\n/g, ' ').slice(0, 100)}`));
aggiornate.forEach(e => console.log(`  ~ OCR ${etichetta(e)} [${e.t}] ${e.tx.replace(/\n/g, ' ').slice(0, 100)}`));

if (write) {
  const data = dataPiuRecente(aggiornata, aggiornataAttuale); // mai all'indietro
  writeFileSync(resolve(ROOT, 'fofi-db.js'), entriesToDbFile(merged, data));
  console.log(`✓ Scritto fofi-db.js: ${merged.length} voci${data ? ` · aggiornamento ${data}` : ''}.`);
  // Etichette uniche: due avvisi senza numero dello stesso giorno restano due ("OSP 12/11/2026 #2").
  const conta = {};
  const unica = l => (conta[l] = (conta[l] || 0) + 1) > 1 ? `${l} #${conta[l]}` : l;
  console.log('FOFI_ADDED=' + [...added.map(etichetta), ...aggiornate.map(e => 'OCR ' + etichetta(e))].map(unica).join(','));
} else {
  console.log('(anteprima — rilancia con --write per applicare)');
}
