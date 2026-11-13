import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canaleEnoxaparina, isEnoxaparina, parseDataRicetta } from '../canale-eparine.js';

// Regole: circ. FF.Lig 0100 del 23/10/2026 (+ nota Regione Liguria
// Prot-2026-0524156) e FF.Lig 0105 del 13/11/2026.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('isEnoxaparina — riconosce i medicinali interessati', () => {
  it('principio attivo e marchi citati dalla circolare', () => {
    for (const f of ['Enoxaparina', 'ENOXAPARINA SODICA 4000 UI', 'Inhixa', 'CLEXANE', 'Clexane T', 'Ghemaxan', 'Rovinadil', 'Enoxaparina Rovi'])
      expect(isEnoxaparina(f)).toBe(true);
  });

  it('altre eparine e farmaci non c\'entrano', () => {
    for (const f of ['Fraxiparina', 'Fragmin', 'Fluxum', 'Arixtra', 'eparina sodica', 'Tachipirina', 'Seleparina', '', null])
      expect(isEnoxaparina(f)).toBe(false);
  });
});

describe('parseDataRicetta — formati accettati', () => {
  it('ISO del campo data del modulo', () => {
    expect(parseDataRicetta('2026-11-15')).toBe(20261115);
  });

  it('formato italiano letto dalla foto', () => {
    expect(parseDataRicetta('16/11/2026')).toBe(20261116);
    expect(parseDataRicetta('3-12-2026')).toBe(20261203);
    expect(parseDataRicetta('16.11.26')).toBe(20261116);
  });

  it('date assenti o non valide → null', () => {
    for (const d of ['', null, undefined, 'illeggibile', '32/11/2026', '16/13/2026'])
      expect(parseDataRicetta(d)).toBeNull();
  });
});

describe('canaleEnoxaparina — decisione del canale', () => {
  const base = { tipo: 'ssn', farmaci: ['Inhixa 4000 UI'] };

  it('nessuna enoxaparina → null (niente riquadro)', () => {
    expect(canaleEnoxaparina({ ...base, farmaci: ['Fraxiparina'], data: '20/11/2026', siglaDpc: 'presente' })).toBeNull();
  });

  it('ricetta bianca o non SSN → null (vendita privata, il canale non si pone)', () => {
    expect(canaleEnoxaparina({ ...base, tipo: 'bianca', data: '20/11/2026', siglaDpc: 'assente' })).toBeNull();
    expect(canaleEnoxaparina({ ...base, tipo: 'veterinaria', data: '20/11/2026' })).toBeNull();
  });

  it('redatta fino al 15/11/2026 → DPC anche senza sigla', () => {
    for (const siglaDpc of ['presente', 'assente', 'non_visibile', undefined]) {
      const r = canaleEnoxaparina({ ...base, data: '15/11/2026', siglaDpc });
      expect(r.canale).toBe('DPC');
      expect(r.motivo).toMatch(/15\/11\/2026/);
    }
    expect(canaleEnoxaparina({ ...base, data: '2026-10-30', siglaDpc: 'assente' }).canale).toBe('DPC');
  });

  it('dal 16/11/2026 con sigla DPC nel campo note → DPC', () => {
    expect(canaleEnoxaparina({ ...base, data: '16/11/2026', siglaDpc: 'presente' }).canale).toBe('DPC');
  });

  it('dal 16/11/2026 con campo note visibile e senza sigla → CONVENZIONATA', () => {
    const r = canaleEnoxaparina({ ...base, data: '16/11/2026', siglaDpc: 'assente' });
    expect(r.canale).toBe('CONVENZIONATA');
    expect(r.motivo).toMatch(/ticket/i);
  });

  it('dal 16/11/2026 con campo note non visibile → DA_VERIFICARE a video', () => {
    for (const siglaDpc of ['non_visibile', undefined, '', 'boh']) {
      const r = canaleEnoxaparina({ ...base, data: '20/11/2026', siglaDpc });
      expect(r.canale).toBe('DA_VERIFICARE');
      expect(r.motivo).toMatch(/a video/i);
    }
  });

  it('data non leggibile → DA_VERIFICARE, si chiede di controllare la data', () => {
    const r = canaleEnoxaparina({ ...base, data: '', siglaDpc: 'presente' });
    expect(r.canale).toBe('DA_VERIFICARE');
    expect(r.motivo).toMatch(/data/i);
  });

  it('marchio prescritto → non sostituibile (biosimilare)', () => {
    const r = canaleEnoxaparina({ ...base, farmaci: ['Clexane 6000 UI'], data: '20/11/2026', siglaDpc: 'presente' });
    expect(r.sostituzione).toMatch(/non sostituibile/i);
  });

  it('solo principio attivo → il farmacista può scegliere il medicinale', () => {
    const r = canaleEnoxaparina({ ...base, farmaci: ['Enoxaparina 4000 UI'], data: '20/11/2026', siglaDpc: 'presente' });
    expect(r.sostituzione).toMatch(/può fornire/i);
  });

  it('enoxaparina tra più farmaci: basta che ci sia', () => {
    const r = canaleEnoxaparina({ ...base, farmaci: ['Tachipirina', 'Ghemaxan'], data: '20/11/2026', siglaDpc: 'assente' });
    expect(r.canale).toBe('CONVENZIONATA');
  });
});

describe('caricamento nell\'app', () => {
  it('index.html include canale-eparine.js e sw.js lo mette in cache', () => {
    expect(readFileSync(resolve(ROOT, 'index.html'), 'utf8')).toMatch(/<script src="canale-eparine\.js"><\/script>/);
    expect(readFileSync(resolve(ROOT, 'sw.js'), 'utf8')).toMatch(/'\.\/canale-eparine\.js'/);
  });
});
