import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  circolarePertinente, estrattoPresente, validaRegola, avvisiRegola, regoleToPrompt, regoleToDbFile,
  promptEstrazione, parseRispostaEstrazione, regoleNuove, reportPR, regolaDuplicata, rispostaLeggibile, diagnosiChiave, erroreGemini, esitoCorsa, prRegoleInAttesa, circolareDaValutare,
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

// Review 27/11: una risposta troncata o illeggibile non deve valere come
// "nessuna regola", altrimenti la circolare finisce tra le esaminate per sempre.
describe('rispostaLeggibile — distingue "nessuna regola" da risposta rotta', () => {
  it('JSON con l\'array regole (anche vuoto) → leggibile', () => {
    expect(rispostaLeggibile('{"regole":[]}')).toBe(true);
    expect(rispostaLeggibile('```json\n{"regole":[{"tipo":"dpc"}]}\n```')).toBe(true);
  });
  it('troncata, vuota o senza regole → non leggibile', () => {
    expect(rispostaLeggibile('{"regole":[{"tipo":"nota_aifa","farmaci":["dii')).toBe(false);
    expect(rispostaLeggibile('')).toBe(false);
    expect(rispostaLeggibile(null)).toBe(false);
    expect(rispostaLeggibile('non so')).toBe(false);
    expect(rispostaLeggibile('{"altro":1}')).toBe(false);
  });
});

describe('review 27/11 — numeri e parole corte devono coincidere', () => {
  it('classe o anno diversi non passano anche con citazione lunga', () => {
    expect(estrattoPresente('dalla classe A in classe H con decorrenza 31 ottobre 2026', LEVOTUSS)).toBe(false);
    expect(estrattoPresente('dalla classe A in classe C con decorrenza 31 ottobre 2027', LEVOTUSS)).toBe(false);
    expect(estrattoPresente('dalla classe A in classe C con decorrenza 30 ottobre 2026', LEVOTUSS)).toBe(false);
  });
  it('la citazione esatta continua a passare', () => {
    expect(estrattoPresente('dalla classe A in classe C con decorrenza 31 ottobre 2026', LEVOTUSS)).toBe(true);
  });
  it('tipi ereditati da Object (toString, constructor) non sono tipi validi', () => {
    for (const tipo of ['toString', 'constructor', '__proto__'])
      expect(validaRegola({ ...regolaLevotuss, tipo }, LEVOTUSS).join()).toMatch(/tipo/);
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

// Review 28/11: secret GEMINI_API_KEY rifiutato (API_KEY_INVALID) mentre la
// stessa chiave funzionava nel browser; il workflow risultava "riuscito".
describe('diagnosiChiave — controlla il secret senza mai mostrarlo', () => {
  const buona = 'AIza' + 'x'.repeat(35);
  it('chiave nel formato giusto', () => {
    expect(diagnosiChiave(buona)).toEqual({ lunghezza: 39, formatoOk: true, spaziEsterni: false, caratteriStrani: false });
  });
  it('spazi o a capo ai lati, caratteri invisibili, formato diverso', () => {
    expect(diagnosiChiave(buona + '\n').spaziEsterni).toBe(true);
    expect(diagnosiChiave(' ' + buona).spaziEsterni).toBe(true);
    expect(diagnosiChiave(buona.slice(0, 10) + '​' + buona.slice(10)).caratteriStrani).toBe(true);
    expect(diagnosiChiave('"' + buona + '"').caratteriStrani).toBe(true);
    expect(diagnosiChiave('AQ.' + 'x'.repeat(40)).formatoOk).toBe(false);
    expect(diagnosiChiave(buona.slice(0, 30)).formatoOk).toBe(false);
  });
  it('il risultato non contiene la chiave', () => {
    expect(JSON.stringify(diagnosiChiave(buona))).not.toContain('xxxx');
  });
});

describe('erroreGemini — messaggio su una riga (gli avvisi di GitHub mostrano solo la prima)', () => {
  const corpo = JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, null, 2);
  it('estrae motivo e messaggio', () => {
    const e = erroreGemini(400, corpo);
    expect(e.testo).toBe('HTTP 400 API_KEY_INVALID: API key not valid. Please pass a valid API key.');
    expect(e.testo).not.toContain('\n');
    expect(e.chiaveRifiutata).toBe(true);
  });
  it('altri errori: niente chiaveRifiutata; corpo non JSON accorciato su una riga', () => {
    expect(erroreGemini(404, '{"error":{"message":"model not found","status":"NOT_FOUND"}}')).toEqual({ testo: 'HTTP 404 NOT_FOUND: model not found', chiaveRifiutata: false });
    const e = erroreGemini(500, 'errore\ninterno ' + 'x'.repeat(500));
    expect(e.testo).not.toContain('\n');
    expect(e.testo.length).toBeLessThan(250);
  });
  it('403 con chiave bloccata o permesso negato vale come chiave rifiutata', () => {
    expect(erroreGemini(403, '{"error":{"message":"blocked","details":[{"reason":"API_KEY_SERVICE_BLOCKED"}]}}').chiaveRifiutata).toBe(true);
  });
});

describe('esitoCorsa — errori di Gemini non devono sembrare "niente di nuovo"', () => {
  it('circolari lette → 0; niente da leggere → 3', () => {
    expect(esitoCorsa({ lette: 2, erroriGemini: 0 })).toBe(0);
    expect(esitoCorsa({ lette: 2, erroriGemini: 1 })).toBe(0);
    expect(esitoCorsa({ lette: 0, erroriGemini: 0 })).toBe(3);
  });
  it('nessuna letta e almeno un errore di Gemini → errore (1)', () => {
    expect(esitoCorsa({ lette: 0, erroriGemini: 5 })).toBe(1);
  });
});

describe('circolarePertinente — revoche AIC rimandate alla fase 2', () => {
  it('scarta le revoche AIC/AIP anche se citano AIFA', () => {
    expect(circolarePertinente("244-RRS-REVOCHE AIC E AIP SPECIALITA' MEDICINALI. ANTICIPAZIONI AIFA")).toBe(false);
    expect(circolarePertinente('250 -RRS-REVOCHE AIC E AIP SPECIALITÀ MEDICINALI - ANTICIPAZIONI AIFA')).toBe(false);
    expect(circolarePertinente('240 -RRS-DECADENZA AIC SPECIALITÀ MEDICINALI')).toBe(false);
  });
  it('le riclassificazioni restano', () => {
    expect(circolarePertinente("231 -RRS- RICLASSIFICAZIONE SPECIALITA' MEDICINALE LEVOTUSS GOCCE IN CLASSE C")).toBe(true);
  });
});

// Avviso nell'app quando c'è una PR delle regole da rivedere (28/11/2026).
describe('prRegoleInAttesa — risposta dell\'API GitHub /pulls', () => {
  const pr = (n, ref, state = 'open') => ({ number: n, state, html_url: `https://github.com/x/y/pull/${n}`, head: { ref } });
  it('solo le PR aperte del branch auto/regole-update', () => {
    expect(prRegoleInAttesa([pr(28, 'auto/regole-update'), pr(29, 'auto/fofi-update'), pr(27, 'auto/regole-update', 'closed')]))
      .toEqual([{ numero: 28, url: 'https://github.com/x/y/pull/28' }]);
  });
  it('risposta vuota, errore o formato inatteso → nessun avviso', () => {
    expect(prRegoleInAttesa([])).toEqual([]);
    expect(prRegoleInAttesa({ message: 'API rate limit exceeded' })).toEqual([]);
    expect(prRegoleInAttesa(null)).toEqual([]);
    expect(prRegoleInAttesa([{ number: 1 }])).toEqual([]);
  });
  it('url non GitHub scartato (niente link arbitrari nella pagina)', () => {
    expect(prRegoleInAttesa([{ ...pr(30, 'auto/regole-update'), html_url: 'https://evil.example/pull/30' }])).toEqual([]);
  });
});

describe('index.html — avviso PR regole', () => {
  it('ha il riquadro e lo popola all\'avvio', () => {
    const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
    expect(html).toContain('id="avviso-regole"');
    expect(html).toMatch(/controllaPRRegole\(\)/);
    expect(html).toContain('api.github.com/repos/farmaciadellastazione-tech/verifica-ricetta/pulls');
  });
});

// Lettura di 365 giorni (PR #28, 28/11/2026): 20 regole su 49 erano logistica
// DPC o carenze, non regole per controllare una ricetta.
describe('logistica DPC e carenze — non sono regole di prescrizione', () => {
  it('oggetti di sola logistica/carenza: mail scartate', () => {
    for (const s of [
      '!!! DPC ministock. Entro DOMANI, 10-12-2025 RESO SELEPARINA 3800 UI',
      'circ FF.Lig 0176 del 18-12-25 DPC inventario al 31-12-2025 (2 parte) - Operativita della farmacia',
      'circ FF.Lig 0041 del 24-04-26 DPC: dal 01-05-2026 modifica PEC per richiesta addebito invendibili/smarriti e segnalazione difetti',
      'DPC disponibilità farmaci. Nota ATSL per i medici. Aggiornamento disponibilità BINOCRIT',
      'circ FF Liguria n. 0071 del 06-07-2026 DPC elenco contingentati aggiornamento 06-07-2026',
      'circ FF.Lig 0052 del 03-06-26 ACCORDO DPC: PROROGA al 31-05-2027',
      'circ FF.Lig 0019 del 10-02-26 Carenza Depakin granulato r.m. Nota Regione Liguria 10-02-2026. Comunicato Sanofi/AIFA',
    ]) expect(circolarePertinente(s), s).toBe(false);
  });
  it('gli aggiornamenti dell\'elenco A DPC restano', () => {
    for (const s of [
      'circ FF.Lig 0036 del 03-04-26 DPC. Aggiornamento elenco A dal 07-04-2026.',
      'circ FF.Lig 0053 del 08-06-26 DPC. Aggiornamento elenco A dal 08-06-2026',
      'circ FF.Lig 0010 del 27-01-26 DPC Aggiornamento elenco A dal 28-01-2026. Nuove formulazione RYBELSUS',
    ]) expect(circolarePertinente(s), s).toBe(true);
  });
  it('il prompt di estrazione esclude esplicitamente la logistica DPC', () => {
    const p = promptEstrazione('x', 'y').toLowerCase();
    for (const w of ['ministock', 'inventari', 'contingentament', 'allocazion', 'pec', 'esaurimento scorte', 'carenz'])
      expect(p, w).toContain(w);
  });
});

// Review 28/11: "accordo"/"disponibilità" sono generiche: se l'oggetto annuncia
// medicinali che entrano o escono dalla DPC la circolare va letta comunque.
describe('logistica DPC — eccezione per entrate/uscite di medicinali', () => {
  it('ingressi/uscite DPC con parole generiche nell\'oggetto: lette', () => {
    for (const s of [
      'Nuovo accordo DPC: inserimento di MOUNJARO',
      'Disponibilità in DPC di OBODENCE: inserimento in elenco',
      'DPC: esclusione di PROLIA dalla distribuzione per conto',
      'Proroga accordo DPC e uscita di EPREX dal canale',
    ]) expect(circolarePertinente(s), s).toBe(true);
  });
});

// Circolari sugli stupefacenti (28/11/2026): cambiano le regole di base del
// prompt, non una regola per farmaco → nella PR come "da valutare a mano".
describe('circolareDaValutare — stupefacenti da leggere a mano', () => {
  it('oggetti con sigla STUP o stupefacenti', () => {
    for (const s of [
      '245 -STUP- DEMATERIALIZZAZIONE DELLE RICETTE A CAARICO DEL CITTADINO (CD RICETTE BIANCHE) PER I MEDICINALI STUPEFACENTI DELLE SEZIONI B,C,D ED E',
      '249 -STUP-DEMATERIALIZZAZIONE RICETTE BIANCHE STUPEFACENTI SEZIONI B, C, D ED E. PRECISAZIONI',
      'circ FF Lig. n. 0070 del 06-07-26 Erogazione ricette dema farmaci stupefacenti. Chiarimenti Federfarma momentanea sospensione',
    ]) expect(circolareDaValutare(s), s).toBe(true);
  });
  it('le altre circolari no; le segnalazioni FOFI di furti/falsi nemmeno', () => {
    for (const s of [
      '241 -AIFA-DETERMINAZIONI 20 OTTOBRE 2026. AGGIORNAMENTO NOTA AIFA 31.',
      'circ FF.Lig 0053 del 08-06-26 DPC. Aggiornamento elenco A dal 08-06-2026',
      'IMPORTANTE : Segnalazione possibile ricetta falsificata stupefacenti',
      'furto ricettario stupefacenti',
      '', null,
    ]) expect(circolareDaValutare(s), String(s)).toBe(false);
  });
});
