import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { cercaVoci, integraFOFI } from '../fofi-match.js';

// Bug 13/11/2026: con la sola foto il confronto FOFI non girava (usava solo i
// campi digitati a mano) e a Gemini veniva detto "nessuna corrispondenza".
// Ora medico e farmaci letti dalla foto passano da cercaVoci, e integraFOFI
// rende il controllo "Verifica FOFI" del risultato coerente con la banca dati.

const src = readFileSync(new URL('../fofi-db.js', import.meta.url), 'utf8');
const FOFI_DB = new Function(src + ';return FOFI_DB')();

const db = () => [
  { n: 15540, t: ['F'], tx: 'ricette false di LYRICA a firma del dott. Bianchi' },
  { n: 16154, t: ['F'], tx: 'ricette MOUNJARO, LYRICA e DEPALGOS', d: '13/11/2026' },
  { n: 16100, t: ['T'], tx: 'furto timbro dott. Verdi Giuseppe', d: '01/11/2026' },
];

describe('cercaVoci — confronto FOFI su più testi (campi + dati letti dalla foto)', () => {
  it('trova la circolare dal solo farmaco letto dalla foto, a campi vuoti', () => {
    const { voci, totale } = cercaVoci(['', '', 'Dott. Mario Rossi', 'LYRICA 75 mg 56 capsule'], db());
    expect(totale).toBe(2);
    expect(voci.map(v => v.rec.n)).toContain(16154);
  });

  it('a parità di punteggio la segnalazione più recente viene prima', () => {
    const { voci } = cercaVoci(['Lyrica'], db());
    expect(voci.map(v => v.rec.n)).toEqual([16154, 15540]);
  });

  it('lo stesso nome nel campo e nella foto non raddoppia il punteggio', () => {
    const { voci } = cercaVoci(['Lyrica', 'LYRICA 75 mg'], db());
    expect(voci[0].score).toBe(3);
  });

  it('niente testi o nessuna corrispondenza → elenco vuoto', () => {
    expect(cercaVoci([], db())).toEqual({ voci: [], totale: 0 });
    expect(cercaVoci([null, undefined, 'Tachipirina'], db())).toEqual({ voci: [], totale: 0 });
  });

  it('limite sulle voci restituite, totale sempre completo', () => {
    const { voci, totale } = cercaVoci(['Lyrica'], db(), 1);
    expect(voci).toHaveLength(1);
    expect(totale).toBe(2);
  });

  it('banca dati vera: una ricetta di Lyrica trova la circ. 16154 tra le prime tre', () => {
    const { voci } = cercaVoci(['LYRICA 75 mg'], FOFI_DB);
    expect(voci.slice(0, 3).map(v => v.rec.n)).toContain(16154);
  });
});

describe('integraFOFI — controllo "Verifica FOFI" deciso dalla banca dati, non da Gemini', () => {
  const risultato = () => ({
    verdetto: 'VALIDA', sommario: 'ok', punteggio: 95,
    controlli: [
      { campo: 'Data prescrizione', stato: 'ok', note: 'presente' },
      { campo: 'Verifica FOFI', stato: 'ok', note: 'nessuna corrispondenza' },
    ],
    azioni_richieste: [], azioni_urgenti: [],
  });
  const hits = () => cercaVoci(['Lyrica'], db());

  it('con corrispondenze: sostituisce il "FOFI ok" di Gemini con un controllo fofi', () => {
    const r = integraFOFI(risultato(), hits());
    const fofi = r.controlli.filter(c => /fofi/i.test(c.campo));
    expect(fofi).toHaveLength(1);
    expect(fofi[0].stato).toBe('fofi');
    expect(fofi[0].note).toContain('16154');
    expect(r.controlli[0].stato).toBe('fofi'); // in cima, ben visibile
  });

  it('con corrispondenze: un verdetto positivo diventa ATTENZIONE', () => {
    expect(integraFOFI(risultato(), hits()).verdetto).toBe('ATTENZIONE');
    expect(integraFOFI({ ...risultato(), verdetto: 'NON_NECESSARIA' }, hits()).verdetto).toBe('ATTENZIONE');
  });

  it('con corrispondenze: verdetti già negativi restano come sono', () => {
    expect(integraFOFI({ ...risultato(), verdetto: 'SOSPETTA_FALSA' }, hits()).verdetto).toBe('SOSPETTA_FALSA');
    expect(integraFOFI({ ...risultato(), verdetto: 'NON_VALIDA' }, hits()).verdetto).toBe('NON_VALIDA');
  });

  it('con corrispondenze: aggiunge un\'azione richiesta di verifica', () => {
    const r = integraFOFI(risultato(), hits());
    expect(r.azioni_richieste.join(' ')).toMatch(/FOFI/);
  });

  it('senza corrispondenze: un solo controllo FOFI, ok, verdetto invariato', () => {
    const r = integraFOFI(risultato(), { voci: [], totale: 0 });
    const fofi = r.controlli.filter(c => /fofi/i.test(c.campo));
    expect(fofi).toEqual([{ campo: 'Verifica FOFI', stato: 'ok', note: 'Nessuna corrispondenza nella banca dati FOFI' }]);
    expect(r.verdetto).toBe('VALIDA');
  });

  it('non modifica il risultato originale e tollera campi mancanti', () => {
    const orig = risultato();
    integraFOFI(orig, hits());
    expect(orig.verdetto).toBe('VALIDA');
    expect(orig.controlli).toHaveLength(2);
    const r = integraFOFI({ verdetto: 'VALIDA' }, hits());
    expect(r.controlli[0].stato).toBe('fofi');
  });
});
