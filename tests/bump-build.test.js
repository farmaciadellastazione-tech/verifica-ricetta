import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentAppBuild, setAppBuild, setCacheName, formatDateIt, FILE_CON_BUILD } from '../tools/bump-build.mjs';

const INDEX = `...\nconst APP_BUILD = 57;\nconst APP_BUILD_DATE = '25/05/2026';\n...`;
const SW = `const CACHE_NAME = 'verifica-ricetta-build57';\nconst ASSETS = [];`;

describe('bump-build — funzioni pure', () => {
  it('legge APP_BUILD corrente', () => {
    expect(currentAppBuild(INDEX)).toBe(57);
  });

  it('incrementa APP_BUILD e aggiorna la data', () => {
    const out = setAppBuild(INDEX, 58, '06/06/2026');
    expect(out).toContain('const APP_BUILD = 58;');
    expect(out).toContain("const APP_BUILD_DATE = '06/06/2026';");
    expect(out).not.toContain('APP_BUILD = 57');
  });

  it('allinea CACHE_NAME al nuovo numero', () => {
    expect(setCacheName(SW, 58)).toContain("verifica-ricetta-build58");
    expect(setCacheName(SW, 58)).not.toContain('build57');
  });

  it('formatDateIt → DD/MM/YYYY zero-padded', () => {
    expect(formatDateIt(new Date(2026, 5, 6))).toBe('06/06/2026');
    expect(formatDateIt(new Date(2026, 11, 31))).toBe('31/12/2026');
  });

  it('errore chiaro se i marcatori mancano', () => {
    expect(() => currentAppBuild('niente')).toThrow(/APP_BUILD/);
    expect(() => setCacheName('niente', 1)).toThrow(/CACHE_NAME/);
  });

  it('round-trip coerente: index e sw finiscono sullo stesso numero', () => {
    const n = currentAppBuild(INDEX) + 1;
    const idx = setAppBuild(INDEX, n, '06/06/2026');
    const sw = setCacheName(SW, n);
    expect(idx).toContain(`APP_BUILD = ${n};`);
    expect(sw).toContain(`build${n}'`);
  });
});

describe('bump-build — file reali allineati', () => {
  // banca-dati.html ha un suo footer "Build N · data": era rimasto a 60 (06/06/2026)
  // perché bump-build aggiornava solo index.html e sw.js.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const leggi = f => readFileSync(resolve(root, f), 'utf8');

  it('index.html, banca-dati.html e sw.js hanno lo stesso numero di build', () => {
    const n = currentAppBuild(leggi('index.html'));
    expect(currentAppBuild(leggi('banca-dati.html'))).toBe(n);
    expect(leggi('sw.js')).toContain(`verifica-ricetta-build${n}'`);
  });

  it('stessa data di build in index.html e banca-dati.html', () => {
    const data = f => leggi(f).match(/const APP_BUILD_DATE = '([^']*)';/)[1];
    expect(data('banca-dati.html')).toBe(data('index.html'));
  });

  it('FILE_CON_BUILD comprende banca-dati.html', () => {
    expect(FILE_CON_BUILD).toEqual(expect.arrayContaining(['index.html', 'banca-dati.html']));
  });
});
