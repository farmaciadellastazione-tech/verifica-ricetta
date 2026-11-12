// fofi-match.js — logica pura di matching FOFI + utility scadenza.
//
// Caricato da:
//   • index.html via <script src="fofi-match.js"> (dopo fofi-db.js, prima del main inline).
//   • vitest tests via import (Node).
//
// Esposto su globalThis per il main script e via module.exports per Node.
// Non dipende da FOFI_DB (le funzioni prendono record/token come parametri).

// ── Costanti ─────────────────────────────────────────────────────────────

// Stopword italiane / medico-istituzionali: token frequenti nel testo delle
// circolari FOFI che, se cercati, producono match casuali su record non correlati.
const STOPWORDS_FOFI = new Set([
  'dot','dott','dottore','dottoressa','dottori','dottoresse','dssa','prof','sig',
  'medico','medici','chirurgo','chirurghi','dirigente','direttore','specialista',
  'specializzato','specializzata','pediatra','psichiatra','psicologo','farmacista',
  'infermiere','odontoiatra','geriatra','radiologo','cardiologo','oncologo',
  'ospedale','clinica','presidio','ambulatorio','poliambulatorio','azienda','presso',
  'asl','asst','ats','usl','irccs','sert','uoc','uos','ssd','scd','mmg','map',
  'regione','provincia','comune','citta','via','viale','corso','piazza',
  'della','dello','delle','degli','dei','del','dal','dalla','dai','dagli','dalle',
  'con','per','nel','nella','nello','sul','sulla','sui','sugli','alla','allo','alle','agli',
  'che','non','sua','suo','suoi','una','uno','gli','questo','questa','questi','queste',
  'cui','tra','fra',
  'ricetta','ricette','ricettario','ricettari','prescrizione','prescrizioni',
  'prescritto','prescritta','timbro','timbri','firma','firme','badge',
  'blocchetto','foglio','fogli',
  'falsificazione','falsificata','falsificate','falsificazioni','falsa','false',
  'furto','furti','smarrimento','smarrimenti','denuncia','denunce','segnalazione',
  'segnalazioni','contraffatta','contraffatto','medesimo','medesima',
  'cpr','compresse','compressa','confezione','confezioni','scatola','scatole',
  'fiala','fiale','flacone','flaconi','gocce','sciroppo','cerotti','capsule','capsula',
  'iscritto','iscritta','iscrizione','albo','ordine','codice','numero','data',
  'nato','nata','anni','anno','servizio','reparto','unita','operativa','operativo',
  'farmaco','farmaci','specialita','medicinale','medicinali','nome','cognome',
  'paziente','intestata','intestato','firmata','firmato','timbrata','timbrato',
  'centro','sede','dipartimento','direzione','sanitaria','sanitario'
]);

// ── Normalizzazione e tokenizzazione ─────────────────────────────────────

function normalize(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Token significativi per il match: ≥3 caratteri, non stopword.
function tokenize(s) {
  return normalize(s).split(' ').filter(w => w.length > 2 && !STOPWORDS_FOFI.has(w));
}

// ── Match scoring ────────────────────────────────────────────────────────

// Cache token-set per record (calcolato una volta al primo match).
// Confronto a parola intera invece di substring per evitare falsi positivi
// (es. "mario" non deve matchare "primario", "rossi" non deve matchare "rossini").
// Side effect: mutate record._tok per caching. Su FOFI_DB (const array) funziona —
// const lega l'identità dell'array, non l'immutabilità dei suoi elementi.
function haystackTokens(record) {
  if (!record._tok) {
    record._tok = new Set(normalize(record.tx).split(' ').filter(w => w.length > 0));
  }
  return record._tok;
}

// Scoring: +3 per token matchato lungo ≥5, +1 altrimenti. Ritorna {score, matchedTokens}.
function scoreMatch(tokens, record) {
  const ht = haystackTokens(record);
  let score = 0;
  let matchedTokens = [];
  tokens.forEach(tok => {
    if (ht.has(tok)) {
      score += tok.length >= 5 ? 3 : 1;
      matchedTokens.push(tok);
    }
  });
  return { score, matchedTokens };
}

// ── Scadenza ricetta ─────────────────────────────────────────────────────

// Default conservativo 30 giorni (SSN non ripetibile, bianca non ripetibile,
// stupefacenti DPR 309/90, veterinaria). Ripetibili croniche (6 mesi / 180 gg)
// vanno impostate manualmente: il farmacista sovrascrive il campo e il flag
// userEdited blocca il ricalcolo automatico.
//
// Note TZ: la formattazione manuale yyyy-mm-dd evita il bug di toISOString()
// che ritorna UTC: in TZ italiana (UTC+1/+2) il giorno precedente.
function calcolaScadenza(dataStr) {
  if (!dataStr) return '';
  const d = new Date(dataStr + 'T00:00:00');
  if (isNaN(d)) return '';
  d.setDate(d.getDate() + 30);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Etichetta della fonte di una voce: circolare FOFI numerata, oppure inoltro
// senza numero (es. Federfarma SP) identificato da fonte + data mail.
function fofiRiferimento(rec) {
  if (rec.n != null) return `Circ. FOFI n. ${rec.n}`;
  return `Segnalazione ${rec.src || 'non FOFI'}${rec.d ? ` del ${rec.d}` : ''}`;
}

// ── Ordine dell'elenco (banca-dati.html) ─────────────────────────────────

// Date → "dd/mm/yyyy" nel fuso italiano: unico formattatore per la data d
// (pipeline, apply-fofi-entries, admin.html). Una mail delle 00:40 italiane
// è del giorno dopo rispetto all'UTC.
function dataDMY(date) {
  return date.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric' });
}

// "dd/mm/yyyy" → "yyyymmdd" confrontabile; '' se assente o malformata.
function chiaveData(d) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d || '');
  return m ? m[3] + m[2] + m[1] : '';
}

// Più recenti in cima, per data di arrivo d (data della mail per tutte le
// fonti: circolari FOFI, inoltri Federfarma, avvisi Ordine). A parità di data:
// circolari per numero decrescente, altrimenti l'ultima accodata in cima.
// Le voci senza data (la prima banca dati, maggio 2026) vanno in fondo.
// Accetta record o oggetti indice {rec, ...}; restituisce un nuovo array.
function ordinaRecenti(voci) {
  const rec = v => v.rec || v;
  return voci.map((v, i) => ({ v, i, d: chiaveData(rec(v).d), n: rec(v).n }))
    .sort((a, b) => {
      if (a.d !== b.d) return b.d.localeCompare(a.d);
      if (a.n != null && b.n != null && a.n !== b.n) return b.n - a.n;
      return b.i - a.i;
    })
    .map(x => x.v);
}

// ── Metadati m/f (chip della banca dati) ─────────────────────────────────

const TITOLI_MEDICO = new Set(['dr', 'dott', 'dssa', 'ssa', 're', 'dottor', 'dottore', 'dottoressa', 'dottori', 'prof', 'sig', 'sigra']);
// Parole di qualifica/contesto che non fanno parte di un nome. Volutamente NON
// tutte le STOPWORDS_FOFI: particelle e parole comuni (DEL, DELLA, CORSO, VIA…)
// possono essere cognomi veri.
const QUALIFICHE_MEDICO = new Set([
  'medico', 'medici', 'chirurgo', 'dirigente', 'direttore', 'specialista', 'specializzato',
  'specializzata', 'pediatra', 'psichiatra', 'psicologo', 'geriatra', 'odontoiatra', 'mmg', 'map',
  'asl', 'asst', 'ats', 'usl', 'ospedale', 'dipartimento', 'servizio', 'reparto', 'presso',
  'medesimo', 'medesima', 'ricetta', 'ricette', 'timbro', 'firma'
]);
// Titolo in testa: "Dr.", "Dr.ssa", "D.ssa", "Dott.re", "Dott.ROSSI" (senza spazio), "Prof."…
const RE_TITOLO = /^(dott(?:\.?ssa|\.?re|ori|oressa|ore|or)?|d\.?ssa|dr(?:\.?ssa)?|prof(?:\.?ssa)?|sig(?:\.?ra)?)(?:\.\s*|\s+)/i;

// Nome del medico senza titoli in testa e senza spazi doppi.
function pulisciNome(s) {
  let out = String(s || '').replace(/\s+/g, ' ').trim();
  while (RE_TITOLO.test(out)) out = out.replace(RE_TITOLO, '').trim();
  return out;
}

// Problemi dei campi m (medici) e f (farmaci) di una voce: ogni nome deve
// comparire per intero nel testo tx e non contenere titoli, qualifiche,
// dosaggi o parole generiche. Il solo cognome è ammesso (alcune circolari
// riportano solo quello). Usato dai test su fofi-db.js e da admin.html.
function problemiMetadati(rec) {
  const testo = ` ${normalize(rec.tx)} `;
  const out = [];
  for (const [campo, etichetta, vietate] of [['m', 'medico', QUALIFICHE_MEDICO], ['f', 'farmaco', STOPWORDS_FOFI]]) {
    for (const v of rec[campo] || []) {
      const w = normalize(v).split(' ').filter(Boolean);
      if (!w.length) out.push(`${etichetta} vuoto`);
      else if (v !== v.trim() || /\s{2,}/.test(v)) out.push(`${etichetta} "${v}": spazi in eccesso`);
      // Frase contigua, non parole sparse: "MARIO BIANCHI" non deve passare se nel
      // testo ci sono "ROSSI MARIO" e un paziente "BIANCHI".
      else if (!testo.includes(` ${w.join(' ')} `)) out.push(`${etichetta} "${v}": non compare per intero nel testo`);
      else if (w.some(x => TITOLI_MEDICO.has(x) || vietate.has(x))) out.push(`${etichetta} "${v}": contiene titoli o parole generiche`);
      else if (campo === 'f' && w.some(x => /\d/.test(x))) out.push(`${etichetta} "${v}": contiene il dosaggio`);
    }
  }
  return out;
}

// ── Export per browser + Node ────────────────────────────────────────────

const _exports = { STOPWORDS_FOFI, normalize, tokenize, haystackTokens, scoreMatch, calcolaScadenza, fofiRiferimento, dataDMY, chiaveData, ordinaRecenti, pulisciNome, problemiMetadati };
Object.assign(globalThis, _exports);
if (typeof module !== 'undefined' && module.exports) module.exports = _exports;
