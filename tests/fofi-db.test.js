import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { problemiMetadati, ordinaRecenti, fofiRiferimento, chiaveData } from '../fofi-match.js';

// Qualità dei dati di fofi-db.js. Il matching gira su tx, ma i campi m/f
// compaiono come chip nella pagina banca-dati.html e d decide l'ordine
// dell'elenco. Le voci aggiunte dalla pipeline automatica hanno m/f vuoti;
// quelle da admin.html passano per lo stesso problemiMetadati prima di
// entrare in coda, quindi questi test non possono bloccare la pipeline.
const src = readFileSync(new URL('../fofi-db.js', import.meta.url), 'utf8');
const FOFI_DB = new Function(src + ';return FOFI_DB')();

describe('fofi-db.js — campi m (medici) e f (farmaci)', () => {
  it('nessun titolo, nome troncato, dosaggio o parola spuria', () => {
    const errati = FOFI_DB.flatMap(rec => problemiMetadati(rec).map(p => `${fofiRiferimento(rec)}: ${p}`));
    expect(errati).toEqual([]);
  });
});

describe('fofi-db.js — data d e ordine dell\'elenco', () => {
  it('d, se presente, è nel formato dd/mm/yyyy', () => {
    const errate = FOFI_DB.filter(r => r.d != null && !chiaveData(r.d)).map(fofiRiferimento);
    expect(errate).toEqual([]);
  });

  it('le voci senza numero (Federfarma/Ordine) hanno sempre la data', () => {
    expect(FOFI_DB.filter(r => r.n == null && !r.d).map(fofiRiferimento)).toEqual([]);
  });

  it('le circolari arrivate dopo la prima banca dati (n ≥ 15911) hanno la data', () => {
    expect(FOFI_DB.filter(r => r.n >= 15911 && !r.d).map(r => r.n)).toEqual([]);
  });

  it('elenco reale: l\'avviso Federfarma del 06/10 sta sotto la 16103 (08/10) e sopra la 16092 (02/10)', () => {
    const ord = ordinaRecenti(FOFI_DB);
    const pos = pred => ord.findIndex(pred);
    const ff = pos(r => r.src === 'Federfarma SP' && r.d === '06/10/2026');
    expect(pos(r => r.n === 16103)).toBeLessThan(ff);
    expect(pos(r => r.n === 16092)).toBeGreaterThan(ff);
  });
});
