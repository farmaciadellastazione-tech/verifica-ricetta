import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Testi con un numero in index.html: prima i plurali erano costruiti a suffisso
// ("2 segnalazionei", "2 corrispondenzae", "In scadenza tra 1 giorni").
// plurale() è definita dentro index.html (non in fofi-match.js: vedi commento lì),
// quindi la si estrae dal sorgente della pagina.
const HTML = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../index.html'), 'utf8');
const src = HTML.match(/function plurale\(n, singolare, plur\) \{[\s\S]*?\n\}/);
const plurale = src && new Function(`${src[0]}; return plurale;`)();

describe('plurale — singolare/plurale nei testi di index.html', () => {
  it('è definita in index.html', () => {
    expect(typeof plurale).toBe('function');
  });

  it('1 → singolare, altrimenti plurale', () => {
    expect(plurale(1, 'segnalazione', 'segnalazioni')).toBe('segnalazione');
    expect(plurale(2, 'segnalazione', 'segnalazioni')).toBe('segnalazioni');
    expect(plurale(17, 'corrispondenza', 'corrispondenze')).toBe('corrispondenze');
    expect(plurale(1, 'giorno', 'giorni')).toBe('giorno');
    expect(plurale(0, 'segnalazione', 'segnalazioni')).toBe('segnalazioni');
  });

  it('nessun plurale costruito a suffisso (es. giorn${…?\'o\':\'i\'})', () => {
    expect(HTML).not.toMatch(/[a-z]\$\{[^}]*\?\s*'[a-z]*'\s*:\s*'[a-z]*'\s*\}/);
  });

  it('nessun "N giorni" / "N segnalazioni" fisso dove N può valere 1', () => {
    expect(HTML).not.toMatch(/\$\{diff\} giorni/);
    expect(HTML).not.toMatch(/<strong>\$\{fofiHits\.length\}<\/strong> segnalazioni/);
  });
});
