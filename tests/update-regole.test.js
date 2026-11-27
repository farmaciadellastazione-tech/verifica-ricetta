import { describe, it, expect } from 'vitest';
import { caricaRegole, corpoUtile } from '../tools/update-regole.mjs';
import { regoleToDbFile } from '../regole-core.js';

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
