import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  STOPWORDS_FOFI, normalize, tokenize, haystackTokens, scoreMatch, calcolaScadenza, fofiRiferimento,
  NOMI_PROPRI, classificaHit,
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

// ── Avviso giallo "possibile omonimia" (12/11/2026) ──────────────────────
// "Giuseppe Verdiani" faceva scattare il banner rosso sulla circ. 15927 (Dr.
// BURASCHI GIUSEPPE). Le corrispondenze NON cambiano: cambia solo il colore.
// Giallo = in comune solo nomi di battesimo, nessun farmaco, e il cognome
// digitato non c'è. Tutto il resto resta rosso.
describe('classificaHit — rosso (forte) o giallo (solo nome di battesimo)', () => {
  const rec = tx => ({ tx });
  const c15927 = rec('circolazione di ricette false riportanti quale medico titolare il Dr.LEONE CARLO e con timbro e firma dei medici sostituti Dr. STRANIERI FRANCESCO e Dr. BURASCHI GIUSEPPE');

  it('nome in comune + cognome diverso → giallo (Giuseppe Verdiani)', () => {
    expect(classificaHit('Giuseppe Verdiani', 'Tachipirina', c15927)).toBe('debole');
  });

  it('due nomi propri di medici diversi + cognome assente → giallo', () => {
    expect(classificaHit('Giuseppe Francesco Verdiani', '', c15927)).toBe('debole');
  });

  it('refuso nel cognome → giallo, non sparisce (Giuseppe Buraski)', () => {
    expect(classificaHit('Giuseppe Buraski', '', c15927)).toBe('debole');
  });

  it('cognome presente → rosso, in qualunque ordine', () => {
    expect(classificaHit('Giuseppe Buraschi', '', c15927)).toBe('forte');
    expect(classificaHit('BURASCHI GIUSEPPE', '', c15927)).toBe('forte');
  });

  it('cognomi che sono anche nomi non sono nella lista ("Carlo Leone", "Luca Bruno")', () => {
    for (const c of ['bruno', 'leone', 'martino', 'marino', 'fiore', 'pace', 'vitale', 'gentile', 'santo', 'rocco', 'romano', 'giordano', 'valentino']) {
      expect(NOMI_PROPRI.has(c)).toBe(false);
    }
    expect(classificaHit('Carlo Leone', '', c15927)).toBe('forte');
    expect(classificaHit('Luca Bruno', '', rec('furto timbro del Dr. BRUNO Mario'))).toBe('forte');
  });

  it('cognome composto: dopo di/de/d\'/del/della/lo/la è cognome, non nome → rosso', () => {
    expect(classificaHit('Gianmarco Di Marco', '', rec('furto ricettario del Dott. DI MARCO, ASL'))).toBe('forte');
    expect(classificaHit("Mario D'Angelo", '', rec("timbro del Dr. D'ANGELO"))).toBe('forte');
    expect(classificaHit('Paolo De Luca', '', rec('ricette del Dr. DE LUCA'))).toBe('forte');
  });

  it('solo nomi propri digitati → rosso come oggi ("Giuseppe", "Calogero Piazza")', () => {
    expect(classificaHit('Giuseppe', '', c15927)).toBe('forte');
    const c15599 = rec('FURTO del ricettario SSN del Dr. PIAZZA CALOGERO, medico di medicina generale.');
    expect(classificaHit('Calogero Piazza', '', c15599)).toBe('forte');
  });

  it('farmaco in comune → sempre rosso', () => {
    expect(classificaHit('Giuseppe Verdiani', 'Minias gocce', rec('Dr. ROSSI GIUSEPPE, prescrizione di MINIAS gocce'))).toBe('forte');
  });

  it('"Dr.ssa" non conta come cognome ("ssa" è stopword)', () => {
    expect(STOPWORDS_FOFI.has('ssa')).toBe(true);
    expect(classificaHit('Dr.ssa Maria Verdi', '', rec('furto ricettario della Dr.ssa ROSSI MARIA'))).toBe('debole');
  });

  it('lista nomi: normalizzata, niente stopword', () => {
    for (const n of NOMI_PROPRI) {
      expect(n).toBe(normalize(n));
      expect(STOPWORDS_FOFI.has(n)).toBe(false);
    }
  });
});

// Regressione sulla banca dati reale: il nome completo di un medico segnalato
// deve dare ROSSO sulla sua voce (mai giallo). L'insieme delle corrispondenze
// non cambia per costruzione (classificaHit cambia solo il colore).
describe('classificaHit — regressione su fofi-db.js', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../fofi-db.js'), 'utf8') + ';globalThis.D=FOFI_DB;', ctx);
  const RE_NOME = /\b(?:Dr|Dott)\.?(?:ssa|\.ssa)?\.?\s*((?:[A-ZÀ-Ý][A-ZÀ-Ý'’]+\s*){1,3})/g;
  const casi = [];
  for (const r of ctx.D) {
    for (const m of r.tx.matchAll(RE_NOME)) casi.push([r, m[1].trim()]);
    for (const m of r.m || []) casi.push([r, m]);
  }

  it('estrae abbastanza nomi da essere significativa', () => {
    expect(casi.length).toBeGreaterThan(100);
  });

  it('nome completo presente nella voce → mai giallo', () => {
    const gialli = casi.filter(([r, nome]) => {
      const tok = tokenize(nome);
      if (!tok.length || !tok.every(t => haystackTokens(r).has(t))) return false;
      return classificaHit(nome, '', r) !== 'forte';
    }).map(([r, nome]) => `${r.n ?? r.src}: ${nome}`);
    expect(gialli).toEqual([]);
  });
});
