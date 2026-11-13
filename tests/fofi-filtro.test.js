import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { cercaVoci, hashFiltroFOFI, leggiFiltroFOFI } from '../fofi-match.js';

// Dall'avviso FOFI dell'app si apre la banca dati filtrata sulle segnalazioni
// della ricetta. I nomi (medico, farmaci) viaggiano nel #: restano nel
// dispositivo, non arrivano a GitHub Pages. banca-dati.html rifà la ricerca
// con cercaVoci sugli stessi testi → stesso elenco dell'avviso.

const src = readFileSync(new URL('../fofi-db.js', import.meta.url), 'utf8');
const FOFI_DB = new Function(src + ';return FOFI_DB')();

describe('hashFiltroFOFI / leggiFiltroFOFI — filtro della banca dati nel #', () => {
  it('andata e ritorno conservano i testi', () => {
    const testi = ['Mario Rossi', 'LYRICA 75 mg'];
    const hash = hashFiltroFOFI(testi);
    expect(hash.startsWith('#')).toBe(true);
    expect(leggiFiltroFOFI(hash)).toEqual(testi);
  });

  it('caratteri speciali e accenti non rompono il filtro', () => {
    const testi = ["Dott.ssa D'Amico & C.", 'Niccolò #2', 'a=b?c'];
    expect(leggiFiltroFOFI(hashFiltroFOFI(testi))).toEqual(testi);
  });

  it('testi vuoti scartati; nessun testo → stringa vuota', () => {
    expect(leggiFiltroFOFI(hashFiltroFOFI(['', '  ', null, undefined, 'Lyrica']))).toEqual(['Lyrica']);
    expect(hashFiltroFOFI([])).toBe('');
    expect(hashFiltroFOFI(['', null])).toBe('');
  });

  it('hash assente o senza filtro → nessun testo', () => {
    expect(leggiFiltroFOFI('')).toEqual([]);
    expect(leggiFiltroFOFI('#')).toEqual([]);
    expect(leggiFiltroFOFI(undefined)).toEqual([]);
    expect(leggiFiltroFOFI('#altro=1')).toEqual([]);
  });

  it('il nome del medico non finisce nella parte inviata al server', () => {
    const hash = hashFiltroFOFI(['Mario Rossi']);
    const url = new URL('banca-dati.html' + hash, 'https://example.org/app/');
    expect(url.search).toBe('');
    expect(url.pathname + url.search).not.toMatch(/rossi/i);
  });

  it('la banca dati filtrata trova le stesse segnalazioni dell\'avviso', () => {
    const testi = ['', '', 'Mario Rossi', 'LYRICA'];
    const avviso = cercaVoci(testi, FOFI_DB, Infinity).voci.map(v => v.rec);
    const filtrate = cercaVoci(leggiFiltroFOFI(hashFiltroFOFI(testi)), FOFI_DB, Infinity).voci.map(v => v.rec);
    expect(filtrate).toEqual(avviso);
    expect(filtrate.map(r => r.n)).toContain(16154);
  });
});
