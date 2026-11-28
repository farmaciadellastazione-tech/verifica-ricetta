import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Nota 64 non esiste come nota AIFA vigente (verifica giugno 2026: sito AIFA,
// torrinomedica, posta e Drive della farmacia). Tolta dall'elenco in build 64,
// ma era rimasta nell'esempio delle note "non applicabili su bianca" (28/11/2026).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');

describe('prompt — note AIFA citate', () => {
  it('nessuna citazione della Nota 64 (inesistente)', () => {
    expect(html).not.toMatch(/\bnot[ae]\s+(aifa\s+)?64\b/i);
    for (const elenco of html.match(/note AIFA \([^)]*\)/gi) || [])
      expect(elenco.split(/[\s,()]+/), elenco).not.toContain('64');
  });

  it('l\'elenco delle note non applicabili su bianca resta (N01, 13, 75, 79, 87, 96)', () => {
    expect(html).toMatch(/note AIFA \(N01, 13, 75, 79, 87, 96, ecc\.\)/);
  });
});
