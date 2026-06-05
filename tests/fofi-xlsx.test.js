import { describe, it, expect } from 'vitest';
import {
  parseSharedStrings, sheetToEntries, entryToJson, entriesToDbFile, mergeNewEntries, COLTYPE,
} from '../fofi-xlsx.js';

// ── Fixture: una sharedStrings + un foglio in miniatura che riproduce la
// struttura reale del file FOFI (B=numero, C=F, D=T, E=B, continuazioni). ──
const SHARED = `<?xml version="1.0"?><sst>
<si><t>CIRCOLARE FOFI</t></si>
<si><t>SEGNALAZIONE FALSIFICAZIONE /FURTO  DI  RICETTE</t></si>
<si><t>SEGNALAZIONE SMARRIMENTO / FURTO TIMBRO MEDICO - RICETTARIO</t></si>
<si><t>SEGNALAZIONE SMARRIMENTO BUONI ACQUISTO</t></si>
<si><t>falsificazione ricetta del Dott. MARIO ROSSI con OXYCONTIN &amp; TARGIN</t></si>
<si><t>smarrimento timbro del Dr. BIANCHI LUCA</t></si>
<si><t>riportante nome e cognome</t></si>
<si><t>smarrimento di n. 3 buoni acquisto</t></si>
</sst>`;

// Riga 3 = intestazione (contiene "CIRCOLARE FOFI" → va saltata).
// Riga 5: circ 15001, falsificazione (col C).
// Riga 6: circ 15002, timbro (col D).
// Riga 7: senza numero, col D → continuazione del testo di 15002.
// Riga 8: circ 15003, buoni acquisto (col E).
// Riga 9: circ 15004, sia C che D → due voci (F e T).
const SHEET = `<worksheet><sheetData>
<row r="3"><c r="B3" t="s"><v>0</v></c><c r="C3" t="s"><v>1</v></c><c r="D3" t="s"><v>2</v></c><c r="E3" t="s"><v>3</v></c></row>
<row r="5"><c r="B5"><v>15001</v></c><c r="C5" t="s"><v>4</v></c></row>
<row r="6"><c r="B6"><v>15002</v></c><c r="D6" t="s"><v>5</v></c></row>
<row r="7"><c r="D7" t="s"><v>6</v></c></row>
<row r="8"><c r="B8"><v>15003</v></c><c r="E8" t="s"><v>7</v></c></row>
<row r="9"><c r="B9"><v>15004</v></c><c r="C9" t="s"><v>4</v></c><c r="D9" t="s"><v>5</v></c></row>
</sheetData></worksheet>`;

describe('parseSharedStrings', () => {
  it('estrae le stringhe in ordine e decodifica le entità', () => {
    const s = parseSharedStrings(SHARED);
    expect(s[0]).toBe('CIRCOLARE FOFI');
    expect(s[4]).toBe('falsificazione ricetta del Dott. MARIO ROSSI con OXYCONTIN & TARGIN');
  });

  it('concatena rich-text (più <t> in un <si>)', () => {
    const rich = '<sst><si><r><t>OXY</t></r><r><t>CONTIN</t></r></si></sst>';
    expect(parseSharedStrings(rich)[0]).toBe('OXYCONTIN');
  });
});

describe('sheetToEntries — mappatura colonna→tipo', () => {
  const entries = sheetToEntries(SHARED, SHEET);

  it('salta la riga di intestazione', () => {
    expect(entries.some(e => /CIRCOLARE FOFI/.test(e.tx))).toBe(false);
  });

  it('colonna C → tipo F, D → T, E → B', () => {
    expect(entries.find(e => e.n === 15001).t).toEqual(['F']);
    expect(entries.find(e => e.n === 15003).t).toEqual(['B']);
    expect(COLTYPE).toEqual({ C: 'F', D: 'T', E: 'B' });
  });

  it('legge il numero circolare come intero dalla colonna B', () => {
    expect(entries.map(e => e.n)).toContain(15001);
    expect(typeof entries[0].n).toBe('number');
  });

  it('una riga senza numero è continuazione del testo nella stessa colonna', () => {
    const e = entries.find(x => x.n === 15002);
    expect(e.tx).toBe('smarrimento timbro del Dr. BIANCHI LUCA\nriportante nome e cognome');
    // la continuazione NON deve creare una voce con n=null
    expect(entries.some(x => x.n == null)).toBe(false);
  });

  it('stesso numero con C e D piene → due voci (F e T)', () => {
    const due = entries.filter(e => e.n === 15004);
    expect(due.map(e => e.t[0]).sort()).toEqual(['F', 'T']);
  });

  it('totale voci attese', () => {
    // 15001(F) + 15002(T) + 15003(B) + 15004(F) + 15004(T) = 5
    expect(entries.length).toBe(5);
  });
});

describe('mergeNewEntries — aggiornamento incrementale', () => {
  it('accoda solo le circolari con numero non già presente', () => {
    const existing = [{ n: 15001, t: ['F'], tx: 'vecchia', m: ['ROSSI'], f: [] }];
    const fromXlsx = sheetToEntries(SHARED, SHEET);
    const { merged, added } = mergeNewEntries(existing, fromXlsx);
    expect(added.map(e => e.n)).toEqual([15002, 15003, 15004, 15004]);
    expect(merged.length).toBe(1 + 4);
  });

  it('preserva intatte le voci esistenti (e i loro m/f curati)', () => {
    const existing = [{ n: 15001, t: ['F'], tx: 'vecchia', m: ['ROSSI'], f: ['OXY'] }];
    const { merged } = mergeNewEntries(existing, sheetToEntries(SHARED, SHEET));
    expect(merged[0]).toEqual({ n: 15001, t: ['F'], tx: 'vecchia', m: ['ROSSI'], f: ['OXY'] });
  });

  it('nessuna voce nuova se tutti i numeri sono già presenti', () => {
    const fromXlsx = sheetToEntries(SHARED, SHEET);
    const { added } = mergeNewEntries(fromXlsx, fromXlsx);
    expect(added).toEqual([]);
  });
});

describe('entriesToDbFile — serializzazione', () => {
  it('produce un fofi-db.js valido e ri-parsabile con i campi {n,t,tx,m,f}', () => {
    const entries = sheetToEntries(SHARED, SHEET);
    const file = entriesToDbFile(entries);
    // valuta il file generato e recupera FOFI_DB
    const sandbox = {};
    // eslint-disable-next-line no-new-func
    new Function('globalThis', file + ';globalThis.OUT=FOFI_DB;')(sandbox);
    expect(sandbox.OUT).toHaveLength(5);
    expect(sandbox.OUT[0]).toEqual({ n: 15001, t: ['F'], tx: entries[0].tx, m: [], f: [] });
  });

  it('una voce per riga (diff puliti)', () => {
    const file = entriesToDbFile(sheetToEntries(SHARED, SHEET));
    const bodyLines = file.split('\n').filter(l => l.startsWith('{'));
    expect(bodyLines.length).toBe(5);
  });

  it('entryToJson normalizza n vuoto/mancante a null e default m/f', () => {
    expect(JSON.parse(entryToJson({ t: ['F'], tx: 'x' }))).toEqual({ n: null, t: ['F'], tx: 'x', m: [], f: [] });
  });
});
