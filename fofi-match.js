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

// Nomi di battesimo italiani comuni (normalizzati). Nel campo medico un match
// SOLO su questi non conta: "Giuseppe Verdiani" faceva scattare il banner sulla
// circolare del "Dr. BURASCHI GIUSEPPE". Esclusi apposta i nomi che sono anche
// cognomi diffusi (Bruno, Leone, Martino, Marino, Fiore, Pace, Vitale, Gentile,
// Santo, Rocco, Romano, Giordano, Valentino…): un cognome non deve mai finire qui,
// altrimenti una circolare col solo cognome non verrebbe più trovata.
// Il test di regressione su fofi-db.js verifica che nessun medico si perda.
const NOMI_PROPRI = new Set([
  // maschili
  'giuseppe','giovanni','antonio','mario','francesco','luigi','angelo','vincenzo','pietro',
  'salvatore','carlo','franco','domenico','paolo','michele','giorgio','roberto','stefano',
  'alessandro','andrea','marco','luca','matteo','lorenzo','davide','simone','federico',
  'riccardo','gabriele','emanuele','daniele','fabio','massimo','maurizio','claudio','sergio',
  'enrico','alberto','alfredo','raffaele','nicola','gianni','giancarlo','gianluca',
  'gianfranco','giampaolo','gianpaolo','pierluigi','piero','renato','sandro','silvio',
  'tommaso','umberto','valerio','vittorio','walter','aldo','alessio','antonino','armando',
  'arturo','attilio','cesare','ciro','cristian','christian','dario','diego','edoardo','elia',
  'emilio','enzo','ernesto','ettore','fabrizio','filippo','flavio','gaetano','giacomo','gino',
  'giulio','giuliano','guido','ivan','jacopo','leonardo','lucio','luciano','manuel',
  'marcello','mattia','mauro','michelangelo','mirko','nicolo','nino','oreste','orazio',
  'osvaldo','pasquale','patrizio','raimondo','rosario','ruggero','samuele','sebastiano',
  'silvano','tiziano','tullio','vito','carmelo','calogero','gennaro','girolamo','ignazio',
  'nunzio','saverio','teodoro','adriano','agostino','alfonso','amedeo','beniamino','corrado',
  'cosimo','damiano','donato','eugenio','fausto','ferdinando','fulvio','graziano','livio',
  'massimiliano','nazario','ottavio','rodolfo','romeo','severino','virgilio',
  // femminili
  'maria','anna','giuseppina','rosa','angela','giovanna','teresa','lucia','carmela',
  'caterina','francesca','antonietta','carla','elena','rita','paola','laura','sara','giulia',
  'chiara','martina','valentina','alessandra','federica','silvia','simona','elisa','claudia',
  'cristina','roberta','barbara','monica','daniela','patrizia','stefania','sabrina',
  'manuela','emanuela','michela','raffaella','serena','veronica','alice','giorgia','ilaria',
  'irene','marta','beatrice','eleonora','aurora','sofia','gaia','noemi','arianna','camilla',
  'debora','deborah','erica','erika','fabiola','gabriella','graziella','lorena','loredana',
  'luisa','marisa','mirella','nadia','nicoletta','ornella','rossana','sonia','tiziana',
  'vanessa','viviana','adele','agnese','annalisa','antonella','assunta','benedetta',
  'carolina','cinzia','concetta','donatella','emma','enrica','filomena','franca','grazia',
  'immacolata','ivana','lidia','luciana','margherita','mariangela','mariella','matilde',
  'nunzia','rachele','rebecca','rosanna','rosaria','rossella','sandra','silvana','susanna',
  'vincenza','verdiana','carmen','lucrezia','annamaria',
]);

// Punteggio FOFI con medico e farmaco separati.
// Medico: conta se combacia almeno un token che NON è un nome proprio (il
// cognome), oppure almeno due token del nome ("Carlo Leone" vs "Dr. LEONE CARLO"),
// oppure se l'input contiene solo nomi propri (vedi sotto).
// Farmaco: come scoreMatch (il solo farmaco basta). Stessi punti di scoreMatch:
// +3 per token ≥5 caratteri, +1 altrimenti; la soglia del banner resta in index.html.
// medicoHit/farmacoHit: per i contatori live (token ≥4 caratteri, parola intera).
function scoreFofi(tokMedico, tokFarmaco, record) {
  const ht = haystackTokens(record);
  const punti = toks => toks.reduce((s, t) => s + (t.length >= 5 ? 3 : 1), 0);

  // Il solo nome proprio si scarta SOLO se è stato digitato anche un cognome
  // (token non-nome) che qui non c'è. Se l'input è fatto solo di nomi propri
  // ("Giuseppe", o "Calogero Piazza" dove "piazza" è stopword) vale come prima:
  // meglio un falso allarme che un medico segnalato non trovato.
  const medTrovati = [...new Set(tokMedico)].filter(t => ht.has(t));
  const soloNomiDigitati = tokMedico.every(t => NOMI_PROPRI.has(t));
  const medicoValido = medTrovati.some(t => !NOMI_PROPRI.has(t)) || medTrovati.length >= 2 ||
    (medTrovati.length > 0 && soloNomiDigitati);
  const medicoOk = medicoValido ? medTrovati : [];

  const farmTrovati = [...new Set(tokFarmaco)].filter(t => ht.has(t));

  return {
    score: punti(medicoOk) + punti(farmTrovati),
    matchedTokens: [...medicoOk, ...farmTrovati],
    medicoHit: medicoOk.some(t => t.length >= 4),
    farmacoHit: farmTrovati.some(t => t.length >= 4),
  };
}

// "1 segnalazione" / "N segnalazioni" (prima: "segnalazionei").
function etichettaSegnalazioni(n) {
  return `${n} ${n === 1 ? 'segnalazione' : 'segnalazioni'}`;
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

// ── Export per browser + Node ────────────────────────────────────────────

const _exports = {
  STOPWORDS_FOFI, NOMI_PROPRI, normalize, tokenize, haystackTokens, scoreMatch, scoreFofi,
  etichettaSegnalazioni, calcolaScadenza, fofiRiferimento,
};
Object.assign(globalThis, _exports);
if (typeof module !== 'undefined' && module.exports) module.exports = _exports;
