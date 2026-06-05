import { describe, it, expect } from 'vitest';
import { currentAppBuild, setAppBuild, setCacheName, formatDateIt } from '../tools/bump-build.mjs';

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
