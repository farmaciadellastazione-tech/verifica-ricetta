// fofi-xlsx.js — core puro per convertire il foglio Excel FOFI in voci FOFI_DB.
//
// L'Ordine dei Farmacisti invia periodicamente un .xlsx "Segnalazioni urgenti FOFI"
// strutturato a colonne:
//   B = numero circolare
//   C = SEGNALAZIONE FALSIFICAZIONE/FURTO DI RICETTE        -> tipo "F"
//   D = SEGNALAZIONE SMARRIMENTO/FURTO TIMBRO - RICETTARIO  -> tipo "T"
//   E = SEGNALAZIONE SMARRIMENTO BUONI ACQUISTO             -> tipo "B"
// Una riga con numero (col B) apre una o più voci (una per colonna C/D/E piena);
// le righe successive senza numero sono continuazioni del testo nella stessa colonna.
//
// Questo modulo NON fa unzip né I/O: riceve le due stringhe XML già estratte
// (sharedStrings.xml e sheetN.xml) e ritorna le voci. L'unzip è platform-specific
// (Node: zlib in tools/build-fofi-db.mjs · browser: DecompressionStream in admin.html).
//
// Esposto su globalThis (browser) e module.exports (Node), come fofi-match.js.

const COLTYPE = { C: 'F', D: 'T', E: 'B' };

// Decodifica entità XML di base presenti nelle celle Excel.
function decodeXmlEntities(s) {
  return (s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n').replace(/&#13;/g, '')
    .replace(/&#9;/g, '\t')
    .replace(/&amp;/g, '&'); // per ultimo: evita di ri-decodificare doppie entità
}

// sharedStrings.xml -> array di stringhe (indice = riferimento cella t="s").
// Gestisce rich-text (più <t> dentro un <si>) concatenando i frammenti.
function parseSharedStrings(xml) {
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]);
    out.push(decodeXmlEntities(parts.join('')));
  }
  return out;
}

// Estrae le celle non vuote di una riga -> { colLetter: valore }.
function rowCells(rowXml, sharedStrings) {
  const cells = [...rowXml.matchAll(/<c r="([A-Z]+)\d+"([^>]*)>(?:<v>([\s\S]*?)<\/v>)?(?:<is>([\s\S]*?)<\/is>)?<\/c>/g)];
  const o = {};
  for (const c of cells) {
    const col = c[1];
    const attrs = c[2] || '';
    const t = (attrs.match(/t="([^"]*)"/) || [])[1];
    let val = c[3];
    if (t === 's' && val != null) {
      val = sharedStrings[+val];
    } else if (t === 'inlineStr' && c[4] != null) {
      const parts = [...c[4].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]);
      val = decodeXmlEntities(parts.join(''));
    } else if (val != null) {
      val = decodeXmlEntities(val);
    }
    if (val != null && String(val).trim() !== '') o[col] = String(val).trim();
  }
  return o;
}

// Converte sheet + sharedStrings in voci [{ n, t:[tipo], tx }].
// minRow: prima riga dati (salta intestazioni). Default 5 nel formato attuale,
// ma rileviamo comunque l'intestazione cercando "CIRCOLARE FOFI".
function sheetToEntries(sharedStringsXml, sheetXml) {
  const sharedStrings = parseSharedStrings(sharedStringsXml);
  const entries = [];
  const last = { C: null, D: null, E: null };
  const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let r;
  while ((r = rowRe.exec(sheetXml))) {
    const o = rowCells(r[2], sharedStrings);
    // Salta righe d'intestazione (quella con "CIRCOLARE FOFI" o l'anno isolato).
    if (Object.values(o).some(v => /CIRCOLARE FOFI/i.test(v))) { last.C = last.D = last.E = null; continue; }
    const n = (o.B && /^\d+$/.test(o.B)) ? parseInt(o.B, 10) : null;
    if (n !== null) { last.C = last.D = last.E = null; } // nuova circolare: chiude le continuazioni aperte
    for (const col of ['C', 'D', 'E']) {
      if (!o[col]) continue;
      if (n === null && last[col]) {
        last[col].tx += '\n' + o[col]; // continuazione del testo nella stessa colonna
      } else {
        const e = { n, t: [COLTYPE[col]], tx: o[col] };
        entries.push(e);
        last[col] = e;
      }
    }
  }
  return entries;
}

// Serializza una voce nell'ordine canonico {n,t,tx,m,f} (m/f default []).
function entryToJson(e) {
  return JSON.stringify({
    n: (e.n === '' || e.n == null) ? null : e.n,
    t: e.t || [],
    tx: e.tx || '',
    m: e.m || [],
    f: e.f || []
  });
}

const DB_HEADER =
  '// Banca dati FOFI — circolari falsificazioni/furti ricette 2025-2026\n' +
  "// Estratto da index.html per manutenibilita'. Variabile globale FOFI_DB consumata dall'inline script principale.";

// Converte l'header "Date" di una mail (RFC 2822, es. "Wed, 21 May 2026 10:30:00 +0200")
// nel formato dd/mm/yyyy usato nel footer. Usa UTC per essere deterministica a
// prescindere dal fuso del runner CI. Ritorna '' se la data non è valida.
function formatEmailDate(rfc) {
  const d = new Date(rfc);
  if (!rfc || isNaN(d.getTime())) return '';
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

// entries -> contenuto completo di fofi-db.js (una voce per riga, per diff puliti).
// Se `aggiornata` è valorizzata (data dd/mm/yyyy ricavata dalla mail FOFI), viene
// emessa la costante FOFI_DB_AGGIORNATA letta dal footer dell'app.
function entriesToDbFile(entries, aggiornata) {
  const dateLine = aggiornata ? `const FOFI_DB_AGGIORNATA = ${JSON.stringify(aggiornata)};\n` : '';
  return DB_HEADER + '\n' + dateLine + 'const FOFI_DB = [\n' + entries.map(entryToJson).join(',\n') + '\n];\n';
}

// Fonde voci esistenti + nuove dall'xlsx: preserva le voci già presenti (con i loro
// m/f curati) e accoda solo le circolari il cui numero non è ancora in banca dati.
// Ritorna { merged, added } dove added sono le nuove voci accodate.
function mergeNewEntries(existing, fromXlsx) {
  const existingNumbers = new Set(existing.map(e => e.n).filter(n => n != null));
  const added = fromXlsx.filter(e => e.n != null && !existingNumbers.has(e.n));
  return { merged: existing.concat(added), added };
}

const _exports = {
  COLTYPE, decodeXmlEntities, parseSharedStrings, rowCells,
  sheetToEntries, entryToJson, entriesToDbFile, mergeNewEntries, formatEmailDate, DB_HEADER
};
Object.assign(globalThis, _exports);
if (typeof module !== 'undefined' && module.exports) module.exports = _exports;
