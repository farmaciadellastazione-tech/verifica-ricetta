import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caricaRegole, corpoUtile, esaminaCircolare } from '../tools/update-regole.mjs';
import { regoleToDbFile } from '../regole-core.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEVOTUSS = readFileSync(resolve(ROOT, 'tests/fixtures/regole/231-levotuss.txt'), 'utf8');
const RISPOSTA_LEVOTUSS = JSON.stringify({ regole: [{
  tipo: 'riclassificazione', farmaci: ['Levotuss'], regola: 'Classe C dal 31/10/2026: su SSN non rimborsabile.',
  dal: '31/10/2026', estratto: 'dalla classe A in classe C con decorrenza 31 ottobre 2026',
}] });
const base = { subject: '231 -RRS- LEVOTUSS', testo: LEVOTUSS, d: '30/10/2026', msgId: '<msg-231@federfarma>', apiKey: 'AIza-chiave-di-prova', regoleEsistenti: [] };
describe('update-regole — helper', () => {
  it('caricaRegole rilegge il file generato', () => {
    const db = { regole: [{ tipo: 'dpc', farmaci: ['x'], regola: 'r', dal: '01/01/2027', estratto: 'e', fonte: 'f', d: '', k: '<k>' }], esaminate: ['<k>'] };
    expect(caricaRegole(regoleToDbFile(db))).toEqual(db);
  });

  it('corpoUtile toglie il piè di pagina di Federfarma (non è contenuto)', () => {
    const corpo = 'Buongiorno riceviamo da Federfarma Genova le note regionali.\nCordiali saluti\nLa segreteria\n\n[cid:image001.png@01DD5D4B.9F866BA0]\nC.so Nazionale 222\n19125 La Spezia\nINFORMAZIONI STRETTAMENTE CONFIDENZIALI';
    expect(corpoUtile(corpo)).toBe('Buongiorno riceviamo da Federfarma Genova le note regionali.\nCordiali saluti\nLa segreteria');
    expect(corpoUtile('[cid:image001.png@01DD6850.B0876AC0]\nC.so Nazionale 222\n19125 La Spezia')).toBe('');
    expect(corpoUtile(undefined)).toBe('');
  });
});

// Bug 28/11/2026: dentro il ciclo delle mail `const key = messageId` nascondeva
// la chiave Gemini → a Gemini arrivava il Message-ID → API_KEY_INVALID.
describe('esaminaCircolare — a Gemini va la chiave API, non il Message-ID', () => {
  it('passa apiKey a Gemini e usa msgId solo come k della regola', async () => {
    const chiamate = [];
    const gemini = async (prompt, k) => { chiamate.push(k); return RISPOSTA_LEVOTUSS; };
    const r = await esaminaCircolare({ ...base, gemini });
    expect(chiamate).toEqual(['AIza-chiave-di-prova']);
    expect(r.esito).toBe('letta');
    expect(r.regole).toHaveLength(1);
    expect(r.regole[0]).toMatchObject({ tipo: 'riclassificazione', k: '<msg-231@federfarma>', fonte: '231 -RRS- LEVOTUSS', d: '30/10/2026' });
  });

  it('chiave rifiutata da Gemini → esito chiave_rifiutata (la corsa si ferma)', async () => {
    const gemini = async () => { const e = new Error('HTTP 400 API_KEY_INVALID: API key not valid.'); e.chiaveRifiutata = true; throw e; };
    const r = await esaminaCircolare({ ...base, gemini });
    expect(r.esito).toBe('chiave_rifiutata');
    expect(r.errore).toContain('API_KEY_INVALID');
  });

  it('altro errore o risposta troncata → esito errore, nessuna regola', async () => {
    expect((await esaminaCircolare({ ...base, gemini: async () => { throw new Error('HTTP 500'); } })).esito).toBe('errore');
    const t = await esaminaCircolare({ ...base, gemini: async () => '{"regole":[{"tipo":' });
    expect(t.esito).toBe('errore');
    expect(t.regole).toEqual([]);
  });

  it('regola già presente → scartata come doppione', async () => {
    const prima = await esaminaCircolare({ ...base, gemini: async () => RISPOSTA_LEVOTUSS });
    const r = await esaminaCircolare({ ...base, regoleEsistenti: prima.regole, gemini: async () => RISPOSTA_LEVOTUSS });
    expect(r.regole).toEqual([]);
    expect(r.scartate[0].problemi.join()).toMatch(/già presente/);
  });
});
