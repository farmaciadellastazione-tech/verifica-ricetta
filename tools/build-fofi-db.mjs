#!/usr/bin/env node
// build-fofi-db.mjs — rigenera fofi-db.js dall'Excel "Segnalazioni urgenti FOFI".
//
// Uso:
//   node tools/build-fofi-db.mjs <file.xlsx> [--write] [--full]
//
//   (default)  mostra un riepilogo delle nuove circolari, NON scrive nulla.
//   --write    accoda le nuove voci a fofi-db.js (preserva le voci esistenti e i loro m/f).
//   --full     rigenera fofi-db.js da zero SOLO dall'xlsx (perde i metadati m/f curati;
//              usare solo per una ricostruzione completa, non per gli aggiornamenti).
//
// L'estrazione dei campi n/t/tx è deterministica (vedi fofi-xlsx.js): nessuna AI.
// I campi m/f (medici/farmaci) sono metadati non usati dal matching (che gira su tx):
// per le voci nuove restano [] e possono essere arricchiti a parte via admin.html.

import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const { sheetToEntries, entriesToDbFile, mergeNewEntries } = require(resolve(ROOT, 'fofi-xlsx.js'));

// ── Mini-lettore ZIP (no dipendenze) ─────────────────────────────────────
// Legge la central directory e ritorna una mappa { nomeFile: Buffer contenuto }.
function unzip(buf) {
  // Trova l'End Of Central Directory (firma 0x06054b50), scansionando dal fondo.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP non valido: EOCD non trovato (file Excel corrotto?).');
  const nEntries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // offset central directory

  const files = {};
  for (let i = 0; i < nEntries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break; // firma central dir entry
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // Vai al local header per calcolare l'inizio dei dati.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    files[name] = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// Trova il primo foglio (xl/worksheets/sheetN.xml).
function firstSheet(files) {
  const names = Object.keys(files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => (parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/))));
  if (!names.length) throw new Error('Nessun foglio di lavoro trovato nell\'xlsx.');
  return names[0];
}

// Carica l'array FOFI_DB corrente da fofi-db.js (eval in sandbox).
function loadCurrentDb() {
  const src = readFileSync(resolve(ROOT, 'fofi-db.js'), 'utf8');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src + ';globalThis.__FOFI=FOFI_DB;', ctx);
  return ctx.__FOFI;
}

// ── Main ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const xlsxPath = args.find(a => !a.startsWith('--'));

if (!xlsxPath) {
  console.error('Uso: node tools/build-fofi-db.mjs <file.xlsx> [--write] [--full]');
  process.exit(1);
}

const buf = readFileSync(resolve(xlsxPath));
const files = unzip(buf);
const sharedStrings = files['xl/sharedStrings.xml'] ? files['xl/sharedStrings.xml'].toString('utf8') : '';
const sheetXml = files[firstSheet(files)].toString('utf8');
const fromXlsx = sheetToEntries(sharedStrings, sheetXml);

const numbers = [...new Set(fromXlsx.map(e => e.n).filter(Boolean))];
console.log(`Excel: ${fromXlsx.length} voci · ${numbers.length} circolari · range ${Math.min(...numbers)}–${Math.max(...numbers)}`);

if (flags.has('--full')) {
  const out = entriesToDbFile(fromXlsx);
  writeFileSync(resolve(ROOT, 'fofi-db.js'), out);
  console.log(`⚠ Rigenerato fofi-db.js da zero: ${fromXlsx.length} voci (metadati m/f azzerati).`);
  process.exit(0);
}

const current = loadCurrentDb();
const { merged, added } = mergeNewEntries(current, fromXlsx);
console.log(`Banca dati attuale: ${current.length} voci.`);

if (!added.length) {
  console.log('✓ Nessuna circolare nuova: la banca dati è già aggiornata.');
  process.exit(0);
}

console.log(`\n→ ${added.length} voci nuove da accodare (circolari ${[...new Set(added.map(e => e.n))].join(', ')}):`);
added.forEach(e => console.log(`  n.${e.n} [${e.t}] ${e.tx.replace(/\n/g, ' ').slice(0, 90)}`));

if (flags.has('--write')) {
  writeFileSync(resolve(ROOT, 'fofi-db.js'), entriesToDbFile(merged));
  console.log(`\n✓ Scritto fofi-db.js: ${merged.length} voci totali. Ricorda di bumpare CACHE_NAME in sw.js.`);
} else {
  console.log('\n(anteprima — niente scritto. Rilancia con --write per applicare.)');
}
