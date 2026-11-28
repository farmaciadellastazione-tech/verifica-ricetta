// regole-core.js — aggiornamenti normativi (note AIFA, riclassificazioni, DPC)
// estratti dalle circolari di Federfarma SP e dell'Ordine.
//
// Flusso: tools/update-regole.mjs legge la posta, Gemini estrae le regole,
// questo modulo le controlla (citazione testuale presente nella circolare,
// farmaci citati, data valida) e il workflow apre una PR su dev che il
// farmacista rivede prima del merge. Le regole approvate stanno in
// regole-prescrizione.js e finiscono nel prompt della verifica (regoleToPrompt).
//
// Logica pura, come fofi-match.js: caricata da index.html via <script src>,
// dai test vitest e dallo script Node.

const TIPI_REGOLA = {
  nota_aifa: 'NOTA AIFA',
  riclassificazione: 'RICLASSIFICAZIONE',
  dpc: 'DPC',
};

// Oggetto della mail → vale la pena farla leggere a Gemini?
const _PERTINENTE = /\bAIFA\b|\bnot[ae]\s+(aifa\s+)?\d|riclassific|\bclasse\s+[ACH]\b|\bfascia\s+[ACH]\b|\bDPC\b|\bPHT\b|modalit[aà]\s+di\s+(prescrizione|erogazione)|\berogazione\b|regime\s+di\s+fornitura|piano\s+terapeutico/i;
const _ESCLUSA = /vaccin|valori\s+di\s+rimborso|\bECM\b|\bcorso\b|prelievi|riepilogo|segnalazion|falsificat|furto|smarriment|ritiro\s+lott|revoc|decadenz/i;

function circolarePertinente(oggetto) {
  const s = String(oggetto || '');
  if (!s.trim() || _ESCLUSA.test(s) && !/riclassific|nota\s+aifa|\bDPC\b/i.test(s)) return false;
  return _PERTINENTE.test(s);
}

// Testo normalizzato per i confronti: minuscolo, senza accenti, sillabazione
// di fine riga ricomposta, punteggiatura e a capo ridotti a spazi.
function _norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/-\s*\n\s*/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function _tok(s) {
  const n = _norm(s);
  return n ? n.split(' ') : [];
}

// Distanza di modifica ≤ 1 (un carattere diverso, in più o in meno).
function _quasiUguali(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}

const MIN_PAROLE_ESTRATTO = 6;
const SOGLIA_ESTRATTO = 0.85;

// La citazione `estratto` compare nel testo della circolare? Uguale (a meno di
// a capo, accenti e punteggiatura) oppure, per il testo da OCR, con almeno
// l'85% delle parole allineate; sulle parole lunghe è tollerato un carattere
// sbagliato. Numeri e parole corte devono essere identici: "classe H" al
// posto di "classe C" o una data diversa non passano.
function estrattoPresente(estratto, testo) {
  const e = _tok(estratto);
  if (e.length < MIN_PAROLE_ESTRATTO) return false;
  const t = _tok(testo);
  if (` ${t.join(' ')} `.includes(` ${e.join(' ')} `)) return true;
  const minimo = Math.ceil(e.length * SOGLIA_ESTRATTO);
  const lunga = x => x.length >= 5 && !/\d/.test(x);
  const maxMancate = e.length - minimo;
  for (let i = 0; i + e.length <= t.length; i++) {
    let mancate = 0;
    let k = 0;
    for (; k < e.length; k++) {
      const x = e[k], y = t[i + k];
      if (x === y || (lunga(x) && _quasiUguali(x, y))) continue;
      // numeri e parole corte ("classe H", "2027") devono essere identici:
      // basta uno diverso per scartare la finestra
      if (!lunga(x) || ++mancate > maxMancate) break;
    }
    if (k === e.length) return true;
  }
  return false;
}

function _dataValida(s) {
  const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return false;
  const [d, mo, y] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function _citato(farmaco, testo) {
  const f = _norm(farmaco);
  return !!f && ` ${_norm(testo)} `.includes(` ${f} `);
}

const MAX_CARATTERI_REGOLA = 600;

// Problemi BLOCCANTI di una regola estratta: se ce n'è anche uno la regola
// non entra nella PR (va solo nel resoconto come "scartata").
function validaRegola(r, testo) {
  const out = [];
  if (!r || typeof r !== 'object') return ['regola non valida'];
  if (!Object.hasOwn(TIPI_REGOLA, String(r.tipo))) out.push(`tipo "${r.tipo}" non previsto`);
  const farmaci = Array.isArray(r.farmaci) ? r.farmaci.filter(f => typeof f === 'string' && f.trim()) : [];
  if (!farmaci.length) out.push('nessun farmaco indicato');
  else if (!farmaci.some(f => _citato(f, testo))) out.push(`nessun farmaco citato nella circolare (${farmaci.join(', ')})`);
  if (typeof r.regola !== 'string' || !r.regola.trim()) out.push('regola vuota');
  else if (r.regola.length > MAX_CARATTERI_REGOLA) out.push(`regola troppo lunga (${r.regola.length} caratteri)`);
  if (!_dataValida(r.dal)) out.push(`data "dal" non valida (${r.dal})`);
  if (!estrattoPresente(r.estratto, testo)) out.push('estratto non trovato nel testo della circolare');
  return out;
}

// Avvisi NON bloccanti, da mostrare al revisore: farmaci aggiunti da Gemini
// (di solito il principio attivo) che la circolare non nomina.
function avvisiRegola(r, testo) {
  return (r.farmaci || []).filter(f => !_citato(f, testo))
    .map(f => `farmaco "${f}" non citato nella circolare: verificare`);
}

// Prompt per Gemini: estrae le regole da una circolare.
function promptEstrazione(oggetto, testo) {
  return `Sei un farmacista italiano. Leggi la circolare qui sotto (Federfarma o Ordine dei Farmacisti) ed estrai SOLO le novita' che cambiano come il farmacista deve controllare o spedire una ricetta al banco, in una di queste tre categorie:
- "nota_aifa": introduzione, modifica o abrogazione di una Nota AIFA (farmaci interessati, condizioni di rimborsabilita' SSN);
- "riclassificazione": cambio di classe di rimborsabilita' (A, C, H) o di regime di fornitura (RR, RNR, RRL, RNRL, OSP, SOP, OTC) di un medicinale;
- "dpc": inserimento o uscita di un medicinale dalla Distribuzione Per Conto regionale, o cambio del canale di erogazione (DPC / convenzionata).
NON estrarre: carenze e disponibilita' di magazzino, prezzi, valori di rimborso, ritiri di lotti, revoche AIC, vaccini, corsi, aspetti amministrativi o contabili.

Per ogni regola restituisci:
- "tipo": "nota_aifa" | "riclassificazione" | "dpc"
- "farmaci": nomi dei medicinali e/o principi attivi COME SCRITTI nella circolare (senza dosaggio)
- "regola": cosa deve fare il farmacista, in italiano, max 300 caratteri, operativo (es. "Su ricetta SSN non piu' rimborsabile: classe C, a carico del cittadino. Regime di fornitura invariato (RR).")
- "dal": data di decorrenza gg/mm/aaaa; se la circolare non la indica, la data del provvedimento o della circolare
- "estratto": UNA frase copiata PAROLA PER PAROLA dalla circolare (almeno 8 parole) che dimostra la regola. Non riassumere, non correggere: deve essere ritrovabile identica nel testo.

Se la circolare non contiene regole di queste categorie rispondi {"regole": []}.
Rispondi SOLO con JSON: {"regole": [{"tipo": "...", "farmaci": ["..."], "regola": "...", "dal": "gg/mm/aaaa", "estratto": "..."}]}

OGGETTO: ${oggetto}

TESTO DELLA CIRCOLARE:
${testo}`;
}

// Risposta di Gemini → array di regole grezze (da validare). [] se illeggibile.
function parseRispostaEstrazione(s) {
  const t = String(s || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try {
    const j = JSON.parse(t);
    return Array.isArray(j?.regole) ? j.regole : [];
  } catch {
    return [];
  }
}

// La risposta di Gemini è un JSON completo con l'array "regole" (anche vuoto)?
// No (troncata, bloccata, testo libero) → la circolare va riletta, non
// segnata come esaminata.
function rispostaLeggibile(s) {
  const t = String(s || '').replace(/^s*```(?:json)?s*/i, '').replace(/s*```s*$/, '');
  try {
    return Array.isArray(JSON.parse(t)?.regole);
  } catch {
    return false;
  }
}

// Etichetta del tipo (solo chiavi proprie: niente "toString" o "constructor").
function _etichetta(tipo) {
  return Object.hasOwn(TIPI_REGOLA, String(tipo)) ? TIPI_REGOLA[tipo] : String(tipo);
}

// Sezione del prompt di verifica con le regole approvate.
function regoleToPrompt(regole) {
  if (!Array.isArray(regole) || !regole.length) return '';
  const righe = regole.map(r =>
    `- [${_etichetta(r.tipo)}] ${(r.farmaci || []).join(', ')}: ${r.regola} (dal ${r.dal}; fonte: ${r.fonte})`);
  return `AGGIORNAMENTI NORMATIVI RECENTI (circolari Federfarma/Ordine riviste dal farmacista; PREVALGONO sulle indicazioni generali sopra, comprese le note AIFA elencate in NORMATIVA, in caso di conflitto):
Applica ciascuna regola solo se il farmaco prescritto e' tra quelli indicati e la data di redazione della ricetta e' uguale o successiva alla decorrenza ("dal"); per le ricette precedenti vale la disciplina previgente. Riclassificazione in classe C: su ricetta SSN il farmaco non e' piu' rimborsabile (controllo "errore", da spedire come privata), su ricetta bianca privata nessun effetto. Nota AIFA: vale solo su SSN. DPC: controllo "attenzione" sul canale di erogazione. Cita la fonte nella nota del controllo.
${righe.join('\n')}`;
}

// Contenuto di regole-prescrizione.js (una regola per riga, diff leggibili nella PR).
function regoleToDbFile({ regole = [], esaminate = [] } = {}) {
  return `// regole-prescrizione.js — aggiornamenti normativi approvati (note AIFA,
// riclassificazioni, DPC). Generato da tools/update-regole.mjs e rivisto a mano
// nella PR prima del merge. Campi: tipo, farmaci, regola, dal (decorrenza),
// estratto (citazione testuale della circolare), fonte (oggetto della mail),
// d (data della mail), k (Message-ID). Per togliere una regola cancellare la
// sua riga: la circolare resta in REGOLE_ESAMINATE e non viene riproposta.
const REGOLE_PRESCRIZIONE = [
${regole.map(r => JSON.stringify(r) + ',\n').join('')}];
// Message-ID delle mail già lette (con o senza regole): non si rileggono.
const REGOLE_ESAMINATE = [
${esaminate.map(k => JSON.stringify(k) + ',\n').join('')}];
`;
}

// La stessa regola è già in elenco? (promemoria o reinoltro della circolare:
// stesso tipo, stessa decorrenza, stessi farmaci a meno di maiuscole e ordine)
function regolaDuplicata(r, elenco) {
  const firma = x => [x.tipo, x.dal, (x.farmaci || []).map(_norm).sort().join('|')].join('#');
  const f = firma(r);
  return (elenco || []).some(x => firma(x) === f);
}

// Regole presenti in `dopo` e assenti in `prima` (confronto per contenuto).
function regoleNuove(prima, dopo) {
  const viste = new Set((prima || []).map(r => JSON.stringify(r)));
  return (dopo || []).filter(r => !viste.has(JSON.stringify(r)));
}

// Descrizione della PR: per ogni regola nuova la citazione della circolare,
// così il farmacista la controlla senza aprire la mail.
function reportPR(nuove, scartate = [], avvisi = []) {
  const md = [];
  md.push('Aggiornamenti normativi estratti in automatico dalle circolari. **Da rivedere prima del merge**: dopo il merge in `dev` la pipeline FOFI li porta in produzione.');
  md.push('');
  if (nuove.length) {
    md.push(`## Regole da approvare (${nuove.length})`);
    for (const r of nuove) {
      md.push('');
      md.push(`### [${_etichetta(r.tipo)}] ${(r.farmaci || []).join(', ')} — dal ${r.dal}`);
      md.push(`**Regola:** ${r.regola}`);
      md.push('');
      md.push(`> ${r.estratto}`);
      md.push('');
      md.push(`Fonte: ${r.fonte}${r.d ? ` (mail del ${r.d})` : ''}`);
    }
  } else {
    md.push('Nessuna regola nuova.');
  }
  if (avvisi.length) {
    md.push('');
    md.push('## Avvisi');
    for (const a of avvisi) md.push(`- ${a.fonte}: ${a.problemi.join('; ')}`);
  }
  if (scartate.length) {
    md.push('');
    md.push('## Regole scartate dal controllo automatico');
    for (const s of scartate) md.push(`- ${s.fonte}: ${s.problemi.join('; ')}`);
  }
  md.push('');
  md.push('Per togliere una regola: modificare `regole-prescrizione.js` in questo branch cancellando la sua riga.');
  return md.join('\n');
}

// ── Diagnostica della chiave Gemini (workflow) ──────────────────────────

// Controlla il valore del secret SENZA mai restituirlo: il repository è
// pubblico e i log delle Actions sono visibili a tutti.
function diagnosiChiave(k) {
  const s = String(k ?? '');
  const t = s.trim();
  return {
    lunghezza: t.length,
    formatoOk: /^AIza[0-9A-Za-z_-]{35}$/.test(t),
    spaziEsterni: s !== t,
    caratteriStrani: /[^0-9A-Za-z_.-]/.test(t),
  };
}

const _MOTIVI_CHIAVE = /API_KEY_INVALID|API_KEY_SERVICE_BLOCKED|API_KEY_HTTP_REFERRER_BLOCKED|API_KEY_IP_ADDRESS_BLOCKED|API_KEY_ANDROID_APP_BLOCKED|API_KEY_IOS_APP_BLOCKED|API_KEY_EXPIRED/;

// Errore HTTP di Gemini → messaggio su UNA riga (gli avvisi di GitHub ne
// mostrano solo la prima) + se dipende dalla chiave (inutile proseguire).
function erroreGemini(status, corpo) {
  let motivo = '', messaggio = '';
  try {
    const e = JSON.parse(corpo).error || {};
    motivo = (e.details || []).map(d => d.reason).find(Boolean) || e.status || '';
    messaggio = e.message || '';
  } catch {
    messaggio = String(corpo || '');
  }
  messaggio = messaggio.replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    testo: `HTTP ${status}${motivo ? ' ' + motivo : ''}: ${messaggio}`,
    chiaveRifiutata: _MOTIVI_CHIAVE.test(motivo),
  };
}

// Exit code della corsa: 0 = circolari lette, 3 = niente di nuovo,
// 1 = nessuna letta per errori di Gemini (deve risultare in rosso).
function esitoCorsa({ lette, erroriGemini }) {
  if (lette > 0) return 0;
  return erroriGemini > 0 ? 1 : 3;
}

// ── Avviso nell'app: PR delle regole in attesa di revisione ─────────────

const BRANCH_PR_REGOLE = 'auto/regole-update';

// Risposta di GET /repos/.../pulls → PR aperte del workflow regole.
// Qualsiasi risposta inattesa (errore, rate limit) → [] (nessun avviso).
function prRegoleInAttesa(pulls) {
  if (!Array.isArray(pulls)) return [];
  return pulls
    .filter(p => p && p.state === 'open' && p.head?.ref === BRANCH_PR_REGOLE && Number.isInteger(p.number)
      && /^https:\/\/github\.com\//.test(String(p.html_url || '')))
    .map(p => ({ numero: p.number, url: p.html_url }));
}

// ── Export per browser + Node ────────────────────────────────────────────

const _regoleExports = { TIPI_REGOLA, circolarePertinente, estrattoPresente, validaRegola, avvisiRegola, promptEstrazione, parseRispostaEstrazione, rispostaLeggibile, regoleToPrompt, regoleToDbFile, regolaDuplicata, regoleNuove, reportPR, diagnosiChiave, erroreGemini, esitoCorsa, prRegoleInAttesa };
Object.assign(globalThis, _regoleExports);
if (typeof module !== 'undefined' && module.exports) module.exports = _regoleExports;
