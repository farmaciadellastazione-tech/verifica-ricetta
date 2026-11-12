import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  STOPWORDS_FOFI, normalize, tokenize, haystackTokens, scoreMatch, calcolaScadenza, fofiRiferimento,
  NOMI_PROPRI, scoreFofi, etichettaSegnalazioni,
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

// ── Nome di battesimo da solo non basta (12/11/2026) ─────────────────────
// "Giuseppe Verdiani" faceva scattare il banner sulla circ. 15927 (Dr. BURASCHI
// GIUSEPPE): il solo nome proprio dava 3 punti, la soglia del banner.
describe('scoreFofi — medico: il solo nome proprio non è una corrispondenza', () => {
  const rec = tx => ({ tx });
  const c15927 = rec('circolazione di ricette false riportanti quale medico titolare il Dr.LEONE CARLO e con timbro e firma dei medici sostituti Dr. STRANIERI FRANCESCO e Dr. BURASCHI GIUSEPPE');

  it('nome proprio + cognome diverso → nessun match (caso Giuseppe Verdiani)', () => {
    const r = scoreFofi(tokenize('Giuseppe Verdiani'), tokenize('Tachipirina'), c15927);
    expect(r.medicoHit).toBe(false);
    expect(r.score).toBeLessThan(3);
  });

  it('solo nomi propri digitati → match come prima (prudenza: niente falsi negativi)', () => {
    expect(scoreFofi(tokenize('Giuseppe'), [], c15927).medicoHit).toBe(true);
    // "piazza" è stopword: di "Calogero Piazza" resta solo il nome (circ. 15599)
    const c15599 = rec('FURTO del ricettario SSN del Dr. PIAZZA CALOGERO, medico di medicina generale.');
    expect(scoreFofi(tokenize('Calogero Piazza'), [], c15599).score).toBeGreaterThanOrEqual(3);
  });

  it('mentre si digita il cognome ("Giuseppe Ver") il nome da solo non basta', () => {
    expect(scoreFofi(tokenize('Giuseppe Ver'), [], c15927).medicoHit).toBe(false);
  });

  it('cognome che coincide → match (in qualunque ordine)', () => {
    expect(scoreFofi(tokenize('Giuseppe Buraschi'), [], c15927).medicoHit).toBe(true);
    expect(scoreFofi(tokenize('Buraschi Giuseppe'), [], c15927).score).toBeGreaterThanOrEqual(3);
  });

  it('nome e cognome entrambi nomi propri ma entrambi presenti → match ("Carlo Leone")', () => {
    expect(scoreFofi(tokenize('Carlo Leone'), [], c15927).medicoHit).toBe(true);
  });

  it('circolare col solo cognome, digitato nome + cognome → match', () => {
    const r = scoreFofi(tokenize('Mario Scalini'), [], rec('FURTO del RICETTARIO del Dott. SCALINI, ASL TO4.'));
    expect(r.medicoHit).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(3);
  });

  it('cognomi che sono anche nomi propri non sono nella lista ("Luca Bruno" vs Dr. BRUNO Mario)', () => {
    for (const cognome of ['bruno', 'leone', 'martino', 'marino', 'fiore', 'pace', 'vitale', 'gentile', 'santo']) {
      expect(NOMI_PROPRI.has(cognome)).toBe(false);
    }
    expect(scoreFofi(tokenize('Luca Bruno'), [], rec('furto timbro del Dr. BRUNO Mario')).medicoHit).toBe(true);
  });

  it('farmaco invariato: il solo farmaco basta (Minias)', () => {
    const r = scoreFofi([], tokenize('Minias gocce'), rec('prescrizione di “MINIAS gocce”'));
    expect(r.farmacoHit).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(3);
  });

  it('lista nomi: minuscola, senza accenti, niente stopword', () => {
    for (const n of NOMI_PROPRI) {
      expect(n).toBe(normalize(n));
      expect(STOPWORDS_FOFI.has(n)).toBe(false);
    }
    expect(NOMI_PROPRI.has('giuseppe')).toBe(true);
    expect(NOMI_PROPRI.has('francesca')).toBe(true);
  });
});

// Regressione sulla banca dati reale: nessun allarme esistente deve sparire.
describe('scoreFofi — regressione su fofi-db.js', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../fofi-db.js'), 'utf8') + ';globalThis.D=FOFI_DB;', ctx);
  const DB = ctx.D;

  // Nomi dal testo: "Dr./Dott./Dott.ssa/Dr.ssa COGNOME NOME" in maiuscolo.
  const RE_NOME = /\b(?:Dr|Dott)\.?(?:ssa|\.ssa)?\.?\s*((?:[A-ZÀ-Ý][A-ZÀ-Ý'’]+\s*){1,3})/g;
  const casi = [];
  for (const r of DB) {
    for (const m of r.tx.matchAll(RE_NOME)) casi.push([r, m[1].trim()]);
    for (const m of r.m || []) casi.push([r, m]);
  }

  it('estrae abbastanza nomi da essere significativa', () => {
    expect(casi.length).toBeGreaterThan(100);
  });

  // Confronto con la logica precedente (scoreMatch): ogni medico che col vecchio
  // calcolo faceva scattare il banner sulla propria voce deve farlo ancora.
  // Si considerano solo i nomi interamente presenti nella voce: l'estrazione via
  // regex a volte tronca i nomi in maiuscolo/minuscolo ("Federica Sar").
  it('ogni medico che prima trovava la propria voce la trova ancora (con banner)', () => {
    const persi = casi.filter(([r, nome]) => {
      const tok = tokenize(nome);
      if (!tok.length) return false; // "DOTT", "dottori": nessun token cercabile
      if (!tok.every(t => haystackTokens(r).has(t))) return false; // nome troncato dall'estrazione
      if (scoreMatch(tok, r).score < 3) return false; // non scattava nemmeno prima (es. ANNA GINI)
      const s = scoreFofi(tok, [], r);
      return !(s.medicoHit && s.score >= 3);
    }).map(([r, nome]) => `${r.n ?? r.src}: ${nome}`);
    expect(persi).toEqual([]);
  });
});

describe('etichettaSegnalazioni — singolare/plurale', () => {
  it('1 → segnalazione, N → segnalazioni (non "segnalazionei")', () => {
    expect(etichettaSegnalazioni(1)).toBe('1 segnalazione');
    expect(etichettaSegnalazioni(2)).toBe('2 segnalazioni');
    expect(etichettaSegnalazioni(17)).toBe('17 segnalazioni');
  });
});
