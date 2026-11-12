import { describe, it, expect } from 'vitest';
import {
  STOPWORDS_FOFI, normalize, tokenize, haystackTokens, scoreMatch, calcolaScadenza, fofiRiferimento, ordinaRecenti, pulisciNome, problemiMetadati, dataDMY,
} from '../fofi-match.js';

describe('normalize — pulizia testo FOFI', () => {
  it('lowercase + trim', () => {
    expect(normalize('  HELLO  ')).toBe('hello');
    expect(normalize('Mario Rossi')).toBe('mario rossi');
  });

  it('rimuove accenti italiani (NFD strip)', () => {
    expect(normalize('Università')).toBe('universita');
    expect(normalize('Però è così')).toBe('pero e cosi');
  });

  it('punteggiatura diventa spazi (poi collassati)', () => {
    expect(normalize('Dott. M. Rossi')).toBe('dott m rossi');
    expect(normalize("Dr.ssa O'Brien")).toBe('dr ssa o brien');
  });

  it('numeri preservati', () => {
    expect(normalize('OXYCONTIN 80 mg')).toBe('oxycontin 80 mg');
  });

  it('input vuoto/null → ""', () => {
    expect(normalize('')).toBe('');
    expect(normalize(null)).toBe('');
    expect(normalize(undefined)).toBe('');
  });

  it('spazi multipli collassati', () => {
    expect(normalize('a   b    c')).toBe('a b c');
  });
});

describe('STOPWORDS_FOFI', () => {
  it('contiene titoli medici comuni', () => {
    expect(STOPWORDS_FOFI.has('dott')).toBe(true);
    expect(STOPWORDS_FOFI.has('dottoressa')).toBe(true);
    expect(STOPWORDS_FOFI.has('medico')).toBe(true);
  });

  it('contiene termini istituzionali (ASL, ATS, ecc.)', () => {
    expect(STOPWORDS_FOFI.has('asl')).toBe(true);
    expect(STOPWORDS_FOFI.has('ats')).toBe(true);
    expect(STOPWORDS_FOFI.has('ospedale')).toBe(true);
  });

  it('contiene parole-chiave delle circolari FOFI (falsificazione, furto)', () => {
    expect(STOPWORDS_FOFI.has('falsificazione')).toBe(true);
    expect(STOPWORDS_FOFI.has('furto')).toBe(true);
    expect(STOPWORDS_FOFI.has('ricetta')).toBe(true);
  });

  it('tutte le voci lowercase', () => {
    for (const w of STOPWORDS_FOFI) {
      expect(w).toBe(w.toLowerCase());
    }
  });
});

describe('tokenize — token significativi', () => {
  it('rimuove parole < 3 caratteri', () => {
    expect(tokenize('a b ci ciao')).toEqual(['ciao']);
  });

  it('rimuove stopword anche se lunghe', () => {
    expect(tokenize('dottore rossi')).toEqual(['rossi']);
    expect(tokenize('falsificazione ricetta oxycontin')).toEqual(['oxycontin']);
  });

  it('preserva token significativi', () => {
    const toks = tokenize('Dott. Mario Rossi prescrive Oxycontin');
    expect(toks).toContain('mario');
    expect(toks).toContain('rossi');
    expect(toks).toContain('oxycontin');
    expect(toks).toContain('prescrive');
    expect(toks).not.toContain('dott');
  });

  it('input vuoto → []', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
  });

  it('case-insensitive', () => {
    expect(tokenize('OXYCONTIN')).toEqual(['oxycontin']);
  });
});

describe('haystackTokens — Set token per record', () => {
  it('costruisce Set dai token del campo tx', () => {
    const r = { n: 1, t: ['F'], tx: 'Falsificazione ricetta Oxycontin Dr. Rossi' };
    const ht = haystackTokens(r);
    expect(ht.has('oxycontin')).toBe(true);
    expect(ht.has('rossi')).toBe(true);
    // Include parole < 3 char e stopword (filtro non applicato qui — solo nel tokenize lato query)
    expect(ht.has('dr')).toBe(true);
  });

  it('cacha sul record (_tok survive across calls)', () => {
    const r = { n: 2, t: ['T'], tx: 'Furto timbro Mario Bianchi' };
    const a = haystackTokens(r);
    const b = haystackTokens(r);
    expect(a).toBe(b); // stessa istanza Set
    expect(r._tok).toBe(a);
  });

  it('cache valida anche se tx mutasse (NO ricalcolo)', () => {
    // Documentato: la cache è "best-effort" — se qualcuno muta record.tx
    // dopo il primo lookup, l'haystack resta quello vecchio. Comportamento
    // accettabile perché in produzione FOFI_DB è effettivamente immutabile.
    const r = { n: 3, t: ['F'], tx: 'oxycontin' };
    haystackTokens(r);
    r.tx = 'morphina';
    expect(haystackTokens(r).has('oxycontin')).toBe(true);
    expect(haystackTokens(r).has('morphina')).toBe(false);
  });

  it('confronto a parola intera, non substring (no falsi positivi)', () => {
    // Critico: "mario" non deve matchare "primario", "rossi" non "rossini".
    const r = { n: 4, t: ['T'], tx: 'Dr Primario Rossini' };
    const ht = haystackTokens(r);
    expect(ht.has('mario')).toBe(false);
    expect(ht.has('rossi')).toBe(false);
    expect(ht.has('primario')).toBe(true);
    expect(ht.has('rossini')).toBe(true);
  });
});

describe('scoreMatch — punteggio match FOFI', () => {
  // Helper: crea record evitando contaminazione cache fra test.
  const rec = (tx) => ({ n: 1, t: ['F'], tx });

  it('+3 per token matchato di lunghezza ≥5', () => {
    const r = rec('Falsificazione ricetta Oxycontin Mario Rossi');
    const { score, matchedTokens } = scoreMatch(['oxycontin'], r);
    expect(score).toBe(3);
    expect(matchedTokens).toEqual(['oxycontin']);
  });

  it('+1 per token matchato di lunghezza < 5', () => {
    const r = rec('Dr Tizio prescrive');
    const { score } = scoreMatch(['dr'], r);
    expect(score).toBe(1);
  });

  it('multipli token sommano', () => {
    const r = rec('Mario Rossi prescrive Oxycontin');
    const { score, matchedTokens } = scoreMatch(['mario', 'rossi', 'oxycontin'], r);
    expect(score).toBe(3 + 3 + 3); // mario (5), rossi (5), oxycontin (9) — tutti ≥5
    expect(matchedTokens.sort()).toEqual(['mario', 'oxycontin', 'rossi']);
  });

  it('token non presenti non scorano', () => {
    const r = rec('Mario Rossi');
    const { score, matchedTokens } = scoreMatch(['paracetamolo'], r);
    expect(score).toBe(0);
    expect(matchedTokens).toEqual([]);
  });

  it('match a parola intera (no substring)', () => {
    // "mario" non deve matchare "primario" — vedi haystackTokens
    const r = rec('Dr Primario Bianchi');
    const { score } = scoreMatch(['mario'], r);
    expect(score).toBe(0);
  });

  it('token vuoti → score 0', () => {
    const r = rec('Mario Rossi');
    expect(scoreMatch([], r).score).toBe(0);
  });
});

describe('calcolaScadenza — +30 giorni TZ-safe', () => {
  it('aggiunge 30 giorni a data ISO', () => {
    expect(calcolaScadenza('2026-01-01')).toBe('2026-01-31');
    expect(calcolaScadenza('2026-05-25')).toBe('2026-06-24');
  });

  it('regressione TZ italiana: non torna il giorno precedente (UTC bug)', () => {
    // Prima del fix, toISOString() su Date in TZ Europe/Rome restituiva
    // il giorno precedente. La formattazione manuale getFullYear/getMonth/getDate
    // resta in TZ locale.
    // Per 2026-01-01 + 30gg ci aspettiamo 2026-01-31, non 2026-01-30.
    const r = calcolaScadenza('2026-01-01');
    expect(r).toBe('2026-01-31');
    expect(r).not.toBe('2026-01-30');
  });

  it('gestisce passaggio di mese / anno', () => {
    expect(calcolaScadenza('2026-01-15')).toBe('2026-02-14');
    expect(calcolaScadenza('2026-12-15')).toBe('2027-01-14');
  });

  it('gestisce mesi corti (febbraio)', () => {
    // 2026 non è bisestile (2024 lo era). 31 gen + 30gg = 2 mar.
    expect(calcolaScadenza('2026-01-31')).toBe('2026-03-02');
  });

  it('gestisce anno bisestile (2028 ha 29 feb)', () => {
    expect(calcolaScadenza('2028-01-30')).toBe('2028-02-29');
  });

  it('output padded yyyy-mm-dd', () => {
    expect(calcolaScadenza('2026-03-05')).toBe('2026-04-04');
    expect(calcolaScadenza('2026-09-09')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('input vuoto/non valido → ""', () => {
    expect(calcolaScadenza('')).toBe('');
    expect(calcolaScadenza(null)).toBe('');
    expect(calcolaScadenza(undefined)).toBe('');
    expect(calcolaScadenza('non-una-data')).toBe('');
  });
});

describe('fofiRiferimento — etichetta della fonte di una voce', () => {
  it('voce FOFI numerata → "Circ. FOFI n. X"', () => {
    expect(fofiRiferimento({ n: 16132, t: ['F'], tx: 'x' })).toBe('Circ. FOFI n. 16132');
  });
  it('voce senza numero (Federfarma SP) → fonte + data', () => {
    expect(fofiRiferimento({ n: null, t: ['T'], tx: 'x', src: 'Federfarma SP', d: '05/11/2026' }))
      .toBe('Segnalazione Federfarma SP del 05/11/2026');
  });
  it('voce senza numero né data → solo la fonte', () => {
    expect(fofiRiferimento({ n: null, t: ['T'], tx: 'x', src: 'Federfarma SP' })).toBe('Segnalazione Federfarma SP');
  });
});

describe('ordinaRecenti — elenco della banca dati per data di arrivo', () => {
  // Ordine nell'array volutamente diverso da quello temporale: un lotto della
  // pipeline accoda prima i PDF, poi Federfarma, poi Ordine; i recuperi arretrati
  // finiscono in coda anche se sono vecchi.
  const voci = [
    { n: 16092, t: ['F'], tx: 'a', d: '02/10/2026' },
    { n: 16135, t: ['T'], tx: 'b', d: '03/11/2026' },
    { n: 16141, t: ['F'], tx: 'c', d: '10/11/2026' },
    { n: null, t: ['T'], tx: 'd', src: 'Federfarma SP', d: '06/10/2026' },
    { n: null, t: ['T'], tx: 'e', src: 'Federfarma SP', d: '05/11/2026' },
    { n: null, t: ['F'], tx: 'f', src: 'Ordine SP', d: '12/11/2026' },
    { n: 16103, t: ['F'], tx: 'g', d: '08/10/2026' },
  ];

  it('dalla più recente alla più vecchia per data, avvisi e circolari mescolati', () => {
    expect(ordinaRecenti(voci).map(v => v.tx)).toEqual(['f', 'c', 'e', 'b', 'g', 'd', 'a']);
  });

  it('un avviso recuperato in ritardo non sale sopra circolari arrivate dopo', () => {
    const out = ordinaRecenti(voci).map(v => v.tx);
    expect(out.indexOf('g')).toBeLessThan(out.indexOf('d')); // 16103 (08/10) sopra FF 06/10
  });

  it('stessa data: circolari per numero decrescente', () => {
    const stessa = [
      { n: 16144, t: ['T'], tx: 'x', d: '12/11/2026' },
      { n: 16151, t: ['T'], tx: 'y', d: '12/11/2026' },
    ];
    expect(ordinaRecenti(stessa).map(v => v.n)).toEqual([16151, 16144]);
  });

  it('stessa data, una voce senza numero: vale l\'ordine di accodamento (ultima in cima)', () => {
    const stessa = [
      { n: 16151, t: ['T'], tx: 'x', d: '12/11/2026' },
      { n: null, t: ['F'], tx: 'y', src: 'Ordine SP', d: '12/11/2026' },
    ];
    expect(ordinaRecenti(stessa).map(v => v.tx)).toEqual(['y', 'x']);
  });

  it('voci senza data (prima banca dati) in fondo, per numero decrescente', () => {
    const miste = [
      { n: 15373, t: ['T'], tx: 'x' },
      { n: 15897, t: ['T'], tx: 'y' },
      { n: 15911, t: ['T'], tx: 'z', d: '06/06/2026' },
    ];
    expect(ordinaRecenti(miste).map(v => v.tx)).toEqual(['z', 'y', 'x']);
  });

  it('non modifica l\'array in ingresso', () => {
    const copia = voci.slice();
    ordinaRecenti(voci);
    expect(voci).toEqual(copia);
  });

  it('funziona anche sugli oggetti indice {rec, ...} di banca-dati.html', () => {
    const indice = voci.map(rec => ({ rec, hay: rec.tx }));
    expect(ordinaRecenti(indice)[0].rec.tx).toBe('f');
  });
});

describe('pulisciNome — nome del medico senza titoli né spazi doppi', () => {
  it('toglie i titoli in testa', () => {
    expect(pulisciNome('Dr. ROSSI MARIO')).toBe('ROSSI MARIO');
    expect(pulisciNome('Dott.ssa ANNA  BIANCHI')).toBe('ANNA BIANCHI');
    expect(pulisciNome('Dr.ssa Laura Zonta')).toBe('Laura Zonta');
    expect(pulisciNome('dottori MANGIA GIAMPAOLO')).toBe('MANGIA GIAMPAOLO');
    expect(pulisciNome('Prof. Dott. VERDI LUCA')).toBe('VERDI LUCA');
    expect(pulisciNome('D.ssa BIANCHI LAURA')).toBe('BIANCHI LAURA');
    expect(pulisciNome('Dott.ROSSI MARIO')).toBe('ROSSI MARIO');
    expect(pulisciNome('Dott.re VERDI LUCA')).toBe('VERDI LUCA');
  });
  it('lascia invariati i nomi già puliti, anche se iniziano come un titolo', () => {
    expect(pulisciNome('DRAGO MARIA')).toBe('DRAGO MARIA');
    expect(pulisciNome('DOTTI ANNA')).toBe('DOTTI ANNA');
  });
});

describe('problemiMetadati — controllo dei campi m/f di una voce', () => {
  const tx = 'falsificazione ricetta di OXYCONTIN 80 mg a firma del Dott. ROSSI MARIO e della Dr.ssa BONO';
  it('voce corretta → nessun problema (anche col solo cognome)', () => {
    expect(problemiMetadati({ n: 1, tx, m: ['ROSSI MARIO', 'BONO'], f: ['OXYCONTIN'] })).toEqual([]);
  });
  it('m e f vuoti o assenti → nessun problema', () => {
    expect(problemiMetadati({ n: 1, tx })).toEqual([]);
  });
  it('cognomi con particelle o parole comuni sono ammessi', () => {
    const t = 'ricette a firma del Dr. DEL PRETE MARIO e della Dr.ssa DELLA VALLE ANNA e del Dr. CORSO LUCA';
    expect(problemiMetadati({ n: 1, tx: t, m: ['DEL PRETE MARIO', 'DELLA VALLE ANNA', 'CORSO LUCA'], f: [] })).toEqual([]);
  });
  it('nome ricomposto da parole sparse nel testo → problema', () => {
    const t = 'ricetta a firma di ROSSI MARIO per paziente BIANCHI';
    expect(problemiMetadati({ n: 1, tx: t, m: ['MARIO BIANCHI'], f: [] })).toHaveLength(1);
  });
  it('qualifica attaccata al nome → problema', () => {
    expect(problemiMetadati({ n: 1, tx: 'Dr.ssa PAOLA GELOSO MMG ASL CN2', m: ['PAOLA GELOSO MMG'], f: [] })).toHaveLength(1);
  });
  it('titolo al posto del nome', () => {
    expect(problemiMetadati({ n: 1, tx, m: ['Dott'], f: [] })).toHaveLength(1);
  });
  it('nome troncato o assente dal testo', () => {
    expect(problemiMetadati({ n: 1, tx, m: ['ROSS'], f: [] })).toHaveLength(1);
  });
  it('farmaco con dosaggio, forma o parole di contorno', () => {
    expect(problemiMetadati({ n: 1, tx, m: [], f: ['OXYCONTIN 80 mg'] })).toHaveLength(1);
    expect(problemiMetadati({ n: 1, tx: 'presso Ospedale Sacco', m: [], f: ['Ospedale Sacco'] })).toHaveLength(1);
  });
});

describe('dataDMY — data dd/mm/yyyy nel fuso italiano', () => {
  it('formato dd/mm/yyyy', () => {
    expect(dataDMY(new Date('2026-11-10T11:15:15Z'))).toBe('10/11/2026');
  });
  it('dopo mezzanotte italiana è già il giorno dopo (UTC sarebbe ancora il 12)', () => {
    expect(dataDMY(new Date('2026-11-12T23:40:00Z'))).toBe('13/11/2026');
  });
  it('ora legale estiva', () => {
    expect(dataDMY(new Date('2026-07-14T22:30:00Z'))).toBe('15/07/2026');
  });
});

describe('ordinaRecenti — ordine totale a parità di data (dalla terza review)', () => {
  const a = { n: 16151, t: ['T'], tx: 'a', d: '12/11/2026' };
  const o = { n: null, t: ['F'], tx: 'o', src: 'Ordine SP', d: '12/11/2026' };
  const b = { n: 16144, t: ['T'], tx: 'b', d: '12/11/2026' };
  it('il risultato non dipende dall\'ordine in ingresso', () => {
    const atteso = ['o', 'a', 'b']; // avvisi senza numero, poi circolari per n° decrescente
    expect(ordinaRecenti([a, o, b]).map(v => v.tx)).toEqual(atteso);
    expect(ordinaRecenti([b, o, a]).map(v => v.tx)).toEqual(atteso);
    expect(ordinaRecenti([o, b, a]).map(v => v.tx)).toEqual(atteso);
  });
});

describe('problemiMetadati — casi dalla terza review', () => {
  it('il cognome RE è un nome valido', () => {
    expect(problemiMetadati({ n: 1, tx: 'ricetta a firma del Dott. RE GIUSEPPE', m: ['RE GIUSEPPE'], f: [] })).toEqual([]);
  });
  it('nomi commerciali con un numero sono validi, il dosaggio con unità no', () => {
    const tx = 'ricetta di EUTIROX 100 e VITAMINA B12 e OXYCONTIN 80 mg';
    expect(problemiMetadati({ n: 1, tx, m: [], f: ['EUTIROX 100', 'VITAMINA B12'] })).toEqual([]);
    expect(problemiMetadati({ n: 1, tx, m: [], f: ['OXYCONTIN 80 mg'] })).toHaveLength(1);
  });
});
