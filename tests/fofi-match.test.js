import { describe, it, expect } from 'vitest';
import {
  STOPWORDS_FOFI, normalize, tokenize, haystackTokens, scoreMatch, calcolaScadenza,
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
