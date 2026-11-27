import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  circolarePertinente, estrattoPresente, validaRegola, avvisiRegola, regoleToPrompt, regoleToDbFile,
  promptEstrazione, parseRispostaEstrazione, regoleNuove, reportPR, regolaDuplicata,
} from '../regole-core.js';

// Circolari reali Federfarma La Spezia (solo oggetto e testo normativo).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fx = n => readFileSync(resolve(ROOT, 'tests/fixtures/regole', n), 'utf8');
const LEVOTUSS = fx('231-levotuss.txt');
const NOTA31 = fx('241-nota31.txt');

const regolaLevotuss = {
  tipo: 'riclassificazione',
  farmaci: ['Levotuss', 'levodropropizina'],
  regola: 'Levotuss gocce passa dalla classe A alla classe C: non rimborsabile SSN, resta RR.',
  dal: '31/10/2026',
  estratto: 'dalla classe A in classe C con decorrenza 31 ottobre 2026',
};

describe('circolarePertinente — quali mail esaminare', () => {
  it('note AIFA, riclassificazioni, DPC e modalità di prescrizione', () => {
    for (const s of [
      '241 -AIFA-DETERMINAZIONI 20 OTTOBRE 2026. AGGIORNAMENTO NOTA AIFA 31.',
      "231 -RRS- RICLASSIFICAZIONE SPECIALITA' MEDICINALE LEVOTUSS GOCCE IN CLASSE C",
      'Nota regionale farmaci in DPC',
      'IMPORTANTE! circ FF.Lig 0100 del 23-10-26 EBPM-nuove modalità di prescrizione ed erogazione a carico del SSR',
      'circ FF. Lig 0107 del 18-11-26 Chiarimenti erogazione ENOXAPARINA',
    ]) expect(circolarePertinente(s), s).toBe(true);
  });

  it('scarta vaccini, rimborsi, corsi, ritiri lotto e segnalazioni FOFI', () => {
    for (const s of [
      'circ FF.Lig 0106 del 17-11-26 Aggiornamento valori di rimborso regionali dal 18 novembre 2026',
      '254 - RRS - AUTORIZZAZIONE VACCINO TETANICO',
      'IMPORTANTE : Circolare FOFI nr. 16113 : On-line corso ECM 2026-2027',
      'CIRC. 229 - RRS - RITIRO LOTTO MYNZEPLI - RITIRO LOTTO CIQORIN - REVOCHE AIC',
      'Nuovo punto prelievi nel DSS18',
      '209-VA-RIEPILOGO CIRCOLARI SETTEMBRE 2026',
      'IMPORTANTE : Segnalazione possibile ricetta falsificata',
      '', null,
    ]) expect(circolarePertinente(s), String(s)).toBe(false);
  });
});

describe('estrattoPresente — la citazione deve essere nel testo', () => {
  it('citazione testuale, anche con a capo e accenti diversi', () => {
    expect(estrattoPresente('dalla classe A in classe C con decorrenza 31 ottobre 2026', LEVOTUSS)).toBe(true);
    expect(estrattoPresente('nella Nota 31 rimangono i farmaci a base di diidrocodeina', NOTA31)).toBe(true);
    expect(estrattoPresente('Rimane invariato il regime di fornitura', LEVOTUSS.replace(/ /g, '\n'))).toBe(true);
  });

  it('tollera qualche errore di OCR', () => {
    const ocr = LEVOTUSS.replace('decorrenza', 'dec0rrenza').replace('ottobre', 'ottobrc');
    expect(estrattoPresente('dalla classe A in classe C con decorrenza 31 ottobre 2026 e il relativo provvedimento', ocr)).toBe(true);
  });

  it('rifiuta citazioni inventate o troppo corte', () => {
    expect(estrattoPresente('dalla classe A in classe H con decorrenza 1 dicembre 2026', LEVOTUSS)).toBe(false);
    expect(estrattoPresente('la levodropropizina richiede piano terapeutico specialistico', NOTA31)).toBe(false);
    expect(estrattoPresente('classe C', LEVOTUSS)).toBe(false);
    expect(estrattoPresente('', LEVOTUSS)).toBe(false);
  });
});

describe('validaRegola — controlli prima della PR', () => {
  it('regola corretta: nessun problema', () => {
    expect(validaRegola(regolaLevotuss, LEVOTUSS)).toEqual([]);
  });

  it('tipo non previsto', () => {
    expect(validaRegola({ ...regolaLevotuss, tipo: 'stupefacenti' }, LEVOTUSS).join()).toMatch(/tipo/);
  });

  it('nessun farmaco citato nella circolare: scartata', () => {
    expect(validaRegola({ ...regolaLevotuss, farmaci: ['Sedotuss'] }, LEVOTUSS).join()).toMatch(/Sedotuss/);
    expect(validaRegola({ ...regolaLevotuss, farmaci: [] }, LEVOTUSS).join()).toMatch(/farmac/);
  });

  it('principio attivo aggiunto da Gemini ma non citato: solo avviso per il revisore', () => {
    expect(validaRegola(regolaLevotuss, LEVOTUSS)).toEqual([]);
    expect(avvisiRegola(regolaLevotuss, LEVOTUSS).join()).toMatch(/levodropropizina/);
    expect(avvisiRegola({ ...regolaLevotuss, farmaci: ['Levotuss'] }, LEVOTUSS)).toEqual([]);
  });

  it('data di decorrenza non valida', () => {
    expect(validaRegola({ ...regolaLevotuss, dal: '2026-10-31' }, LEVOTUSS).join()).toMatch(/dal/);
    expect(validaRegola({ ...regolaLevotuss, dal: '31/02/2026' }, LEVOTUSS).join()).toMatch(/dal/);
  });

  it('estratto non presente nel testo', () => {
    expect(validaRegola({ ...regolaLevotuss, estratto: 'classificata in fascia H uso ospedaliero dal primo dicembre' }, LEVOTUSS).join()).toMatch(/estratto/);
  });

  it('regola vuota o troppo lunga', () => {
    expect(validaRegola({ ...regolaLevotuss, regola: '' }, LEVOTUSS).join()).toMatch(/regola/);
    expect(validaRegola({ ...regolaLevotuss, regola: 'x'.repeat(601) }, LEVOTUSS).join()).toMatch(/regola/);
  });
});

describe('parseRispostaEstrazione — JSON di Gemini', () => {
  it('accetta {regole:[...]} anche dentro un blocco ```json', () => {
    const r = parseRispostaEstrazione('```json\n{"regole":[{"tipo":"nota_aifa"}]}\n```');
    expect(r).toEqual([{ tipo: 'nota_aifa' }]);
  });
  it('nessuna regola o risposta illeggibile → []', () => {
    expect(parseRispostaEstrazione('{"regole":[]}')).toEqual([]);
    expect(parseRispostaEstrazione('non so')).toEqual([]);
    expect(parseRispostaEstrazione('{"altro":1}')).toEqual([]);
  });
});

describe('promptEstrazione', () => {
  it('contiene oggetto, testo e le tre categorie, e chiede la citazione testuale', () => {
    const p = promptEstrazione('231 -RRS- RICLASSIFICAZIONE', LEVOTUSS);
    expect(p).toContain('231 -RRS- RICLASSIFICAZIONE');
    expect(p).toContain('Levotuss Tosse');
    for (const t of ['nota_aifa', 'riclassificazione', 'dpc', 'estratto']) expect(p).toContain(t);
  });
});

describe('regoleToPrompt — sezione per il prompt della verifica', () => {
  const regole = [
    { ...regolaLevotuss, fonte: '231 -RRS- RICLASSIFICAZIONE LEVOTUSS', d: '30/10/2026', k: '<a@x>' },
    { tipo: 'nota_aifa', farmaci: ['diidrocodeina'], regola: 'Nota 31 solo per diidrocodeina.', dal: '31/10/2026', fonte: '241 -AIFA- NOTA 31', d: '12/11/2026', k: '<b@x>', estratto: 'x' },
  ];
  it('vuota senza regole', () => {
    expect(regoleToPrompt([])).toBe('');
    expect(regoleToPrompt(undefined)).toBe('');
  });
  it('elenca regola, farmaci, decorrenza e fonte; prevale sull\'elenco fisso', () => {
    const p = regoleToPrompt(regole);
    expect(p).toMatch(/AGGIORNAMENTI NORMATIVI/);
    expect(p).toMatch(/prevalgono/i);
    expect(p).toContain('dal 31/10/2026');
    expect(p).toContain('Levotuss, levodropropizina');
    expect(p).toContain('231 -RRS- RICLASSIFICAZIONE LEVOTUSS');
    expect(p).toContain('Nota 31 solo per diidrocodeina.');
  });
});

describe('regoleToDbFile — file regole-prescrizione.js', () => {
  it('ricaricato dà le stesse regole e circolari esaminate', () => {
    const db = { regole: [{ ...regolaLevotuss, fonte: 'f', d: '30/10/2026', k: '<a@x>' }], esaminate: ['<a@x>', '<c@x>'] };
    const src = regoleToDbFile(db);
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(src + ';globalThis.__R = { regole: REGOLE_PRESCRIZIONE, esaminate: REGOLE_ESAMINATE };', ctx);
    expect(JSON.parse(JSON.stringify(ctx.__R))).toEqual(db);
  });
});

describe('regolaDuplicata — promemoria e reinoltri della stessa circolare', () => {
  const a = { ...regolaLevotuss, fonte: '231', d: '30/10/2026', k: '<a@x>' };
  it('stesso tipo, stessa decorrenza, stessi farmaci (maiuscole e ordine a parte)', () => {
    expect(regolaDuplicata({ ...regolaLevotuss, farmaci: ['LEVODROPROPIZINA', 'levotuss'], regola: 'altro testo' }, [a])).toBe(true);
  });
  it('decorrenza, tipo o farmaci diversi: regola nuova', () => {
    expect(regolaDuplicata({ ...regolaLevotuss, dal: '01/12/2026' }, [a])).toBe(false);
    expect(regolaDuplicata({ ...regolaLevotuss, tipo: 'nota_aifa' }, [a])).toBe(false);
    expect(regolaDuplicata({ ...regolaLevotuss, farmaci: ['Levotuss'] }, [a])).toBe(false);
    expect(regolaDuplicata(regolaLevotuss, [])).toBe(false);
  });
});

describe('regoleNuove + reportPR — descrizione della PR', () => {
  const a = { ...regolaLevotuss, fonte: '231 -RRS- LEVOTUSS', d: '30/10/2026', k: '<a@x>' };
  const b = { tipo: 'nota_aifa', farmaci: ['diidrocodeina'], regola: 'Nota 31.', dal: '31/10/2026', fonte: '241 NOTA 31', d: '12/11/2026', k: '<b@x>', estratto: 'nella Nota 31 rimangono' };
  it('solo le regole assenti nella base', () => {
    expect(regoleNuove([a], [a, b])).toEqual([b]);
    expect(regoleNuove([], [a])).toEqual([a]);
  });
  it('mostra regola ed estratto della circolare per la revisione', () => {
    const md = reportPR([b], [{ fonte: 'X', problemi: ['estratto non trovato'] }]);
    expect(md).toContain('Nota 31.');
    expect(md).toContain('nella Nota 31 rimangono');
    expect(md).toContain('241 NOTA 31');
    expect(md).toMatch(/scartat/i);
    expect(md).toContain('estratto non trovato');
  });
});

describe('regole-prescrizione.js — dati pubblicati', () => {
  it('si carica e ogni regola ha i campi obbligatori', () => {
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(readFileSync(resolve(ROOT, 'regole-prescrizione.js'), 'utf8') + ';globalThis.__R = { regole: REGOLE_PRESCRIZIONE, esaminate: REGOLE_ESAMINATE };', ctx);
    expect(Array.isArray(ctx.__R.esaminate)).toBe(true);
    for (const r of ctx.__R.regole) {
      expect(['nota_aifa', 'riclassificazione', 'dpc']).toContain(r.tipo);
      expect(r.farmaci.length).toBeGreaterThan(0);
      expect(r.regola).toBeTruthy();
      expect(r.dal).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
      expect(r.fonte).toBeTruthy();
      expect(r.estratto).toBeTruthy();
    }
  });

  it('index.html carica regole-core.js e regole-prescrizione.js; il SW li mette in cache', () => {
    const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
    expect(html).toContain('<script src="regole-prescrizione.js"></script>');
    expect(html).toContain('<script src="regole-core.js"></script>');
    expect(html).toMatch(/regoleToPrompt\(/);
    const sw = readFileSync(resolve(ROOT, 'sw.js'), 'utf8');
    expect(sw).toContain("'./regole-prescrizione.js'");
    expect(sw).toContain("'./regole-core.js'");
  });
});
