import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalize, STOPWORDS_FOFI } from '../fofi-match.js';

// Qualità dei dati di fofi-db.js. Il matching gira su tx, ma i campi m
// (medici estratti) compaiono come chip nella pagina banca-dati.html:
// devono essere nomi veri, non titoli o parole spurie.
const src = readFileSync(new URL('../fofi-db.js', import.meta.url), 'utf8');
const FOFI_DB = new Function(src + ';return FOFI_DB')();

const TITOLI = new Set(['dr', 'dott', 'dssa', 'dottori']);

describe('fofi-db.js — campi m (medici)', () => {
  const voci = FOFI_DB.flatMap(rec => (rec.m || []).map(m => ({ rec, m })));

  it('ogni nome è composto da parole presenti per intero nel testo tx', () => {
    const errati = voci.filter(({ rec, m }) => {
      const parole = new Set(normalize(rec.tx).split(' '));
      return !normalize(m).split(' ').every(w => parole.has(w));
    }).map(({ rec, m }) => `${rec.n}: ${m}`);
    expect(errati).toEqual([]);
  });

  it('niente titoli, qualifiche o parole generiche (Dott, Specialista, MMG, medesimo…)', () => {
    const errati = voci.filter(({ m }) =>
      normalize(m).split(' ').some(w => TITOLI.has(w) || STOPWORDS_FOFI.has(w) || w === 'salute')
    ).map(({ rec, m }) => `${rec.n}: ${m}`);
    expect(errati).toEqual([]);
  });

  it('almeno nome e cognome (due parole)', () => {
    const errati = voci.filter(({ m }) => normalize(m).split(' ').length < 2)
      .map(({ rec, m }) => `${rec.n}: ${m}`);
    expect(errati).toEqual([]);
  });

  it('niente spazi doppi o ai bordi', () => {
    const errati = voci.filter(({ m }) => m !== m.trim() || /\s{2,}/.test(m))
      .map(({ rec, m }) => `${rec.n}: ${m}`);
    expect(errati).toEqual([]);
  });
});
