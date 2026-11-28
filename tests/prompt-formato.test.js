import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Ricetta cartacea vs dematerializzata (28/11/2026). Fonti:
// - circ. MEF-Salute 02/03/2022 (DM 30/12/2020): bianca dematerializzata con NRBE,
//   promemoria come la SSN (DM 2/11/2011), conservazione assolta dal SAC (RR e RNR);
// - circ. FF Liguria 18/05/2022: avvio in Liguria dal 30/05/2022;
// - circ. Federfarma 245 e 249/2026: stupefacenti sez. B-E dal 23/11/2026, sez. A e
//   magistrali escluse, documento ritirante e frazionamento annotati sul Sistema TS;
// - promemoria SSN reale (Drive): medico identificato da CF + codice autenticazione.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const sezione = (inizio, fine) => {
  const a = html.indexOf(inizio);
  const b = html.indexOf(fine, a + inizio.length);
  return a >= 0 && b > a ? html.slice(a, b) : '';
};

describe('prompt — formato della ricetta (cartacea / dematerializzata)', () => {
  const formato = sezione('FORMATO DELLA RICETTA: CARTACEA O DEMATERIALIZZATA', 'CASISTICHE PARTICOLARI DI EROGAZIONE');

  it('la sezione esiste nella parte fissa, prima delle casistiche', () => {
    expect(formato.length).toBeGreaterThan(500);
  });

  it('riconoscimento: NRE per la SSN, NRBE per la bianca; niente firma/timbro sul promemoria', () => {
    expect(formato).toMatch(/NRE/);
    expect(formato).toMatch(/NRBE/);
    expect(formato).toMatch(/codice (di )?autenticazione/i);
    expect(formato).toMatch(/firma autografa/i);
  });

  it('conservazione e annotazioni sul Sistema TS (regola generale sulle regole di dettaglio)', () => {
    expect(formato).toMatch(/Sistema TS/);
    expect(formato).toMatch(/trattenere la ricetta/i);
    expect(formato).toMatch(/frazionat/i);
  });

  it('stupefacenti: sez. B-E dal 23/11/2026, sez. A solo ricalco, magistrali escluse, cartacea valida', () => {
    expect(formato).toContain('23/11/2026');
    expect(formato).toMatch(/sezioni B, C, D ed E/);
    expect(formato).toMatch(/sezione A[^.]*ricalco/i);
    expect(formato).toMatch(/magistrali/i);
    expect(formato).toMatch(/cartace[ae][^.]*valid/i);
  });
});

describe('prompt — requisiti bianca e SSN distinguono cartacea e dematerializzata', () => {
  it('bianca: firma autografa solo su cartacea; NRBE solo se dematerializzata', () => {
    const bianca = sezione('bianca: `Requisiti ricetta bianca', 'VALIDITA\' RICETTA BIANCA');
    expect(bianca).toMatch(/Firma autografa del medico \(solo ricetta cartacea/);
    expect(bianca).toMatch(/NRBE/);
    expect(bianca).not.toMatch(/NON servono: NRE,/);
  });

  it('SSN: firma e timbro solo su cartacea', () => {
    const ssn = sezione('ssn: `Requisiti ricetta SSN', 'VALIDITA\' SSN');
    expect(ssn).toMatch(/Timbro[^\n]*\(solo ricetta cartacea/);
    expect(ssn).toMatch(/Firma autografa del medico \(solo ricetta cartacea/);
  });

  it('indizi visivi: il promemoria con NRBE e\' una bianca, non una SSN', () => {
    expect(html).toMatch(/\* Bianca privata:[^\n]*NRBE/);
  });
});

describe('interfaccia — la dematerializzata non e\' solo SSN', () => {
  it('la scheda SSN non si chiama piu\' "SSN / Dematerializzata"', () => {
    expect(html).not.toContain('SSN / Dematerializzata');
  });
});
