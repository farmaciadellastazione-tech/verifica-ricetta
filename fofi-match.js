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

// ── Export per browser + Node ────────────────────────────────────────────

const _exports = { STOPWORDS_FOFI, normalize, tokenize, haystackTokens, scoreMatch, calcolaScadenza };
Object.assign(globalThis, _exports);
if (typeof module !== 'undefined' && module.exports) module.exports = _exports;
