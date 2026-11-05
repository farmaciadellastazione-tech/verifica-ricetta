// fofi-avvisi.js — core puro per le segnalazioni che NON arrivano come Excel.
//
// Dal 3/11/2026 l'Ordine dei Farmacisti SP non invia più l'Excel cumulativo:
// manda i PDF delle singole circolari FOFI ("Segnalazione urgente: ...") come
// link rufblob nel corpo mail. In parallelo Federfarma La Spezia inoltra
// segnalazioni singole (furto/smarrimento timbro, falsificazioni) senza numero
// di circolare, con allegato PDF o docx.
//
// Questo modulo NON fa I/O: riceve il testo già estratto (pdftotext / docx XML)
// e ritorna voci FOFI_DB. Estrazione deterministica, nessuna AI.
// Esposto su globalThis (browser) e module.exports (Node), come fofi-xlsx.js.

(function () {

// Tipi F/T/B dalle parole chiave (stessa semantica delle colonne dell'Excel:
// F = falsificazione/furto di ricette, T = timbro/ricettario, B = buoni acquisto).
function tipiDaTesto(s) {
  const x = String(s || '').toLowerCase();
  const t = [];
  if (/falsific|\bfals[ei]\b|\bfalso\b|dubbia autenticit|contraff/.test(x) ||
      /(furt|smarriment)[^;\n]{0,60}\bricett[ae]\b/.test(x)) t.push('F');
  if (/timbr|ricettari/.test(x)) t.push('T');
  if (/buon[oi]\s+(di\s+)?acquisto/.test(x)) t.push('B');
  return t;
}

// Righe pulite: niente bullet, spazi compressi, righe vuote rimosse.
function pulisciRighe(s) {
  return String(s || '').split('\n')
    .map(r => r.replace(/[••\f]/g, ' ').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean).join('\n');
}

// Testo di una circolare FOFI (output pdftotext) -> voce {n,t,tx} o null se la
// circolare non è una segnalazione (corsi, note operative...) o se manca il numero.
// nHint: numero ricavato dal nome file del link ("16132.pdf"), ha la precedenza.
function circolarePdfToEntry(text, nHint) {
  const s = String(text || '').replace(/\r/g, '');
  if (!/Segnalazione urgente/i.test(s)) return null;

  let n = Number.isInteger(nHint) ? nHint : null;
  if (n == null) {
    // Cerca dopo "Circolare n." (se c'è): prima potrebbero esserci CAP o codici.
    const i = s.search(/Circolare n\./i);
    const m = s.slice(Math.max(i, 0)).match(/(?:^|\s)(1[5-9]\d{3})(?=\s|$)/m);
    n = m ? parseInt(m[1], 10) : null;
  }
  if (n == null) return null;

  const oggetti = [...s.matchAll(/Segnalazione urgente:\s*([^\n]+)/gi)].map(m => m[1]).join('\n');
  const corpo = s.match(/segnalazione relativa\s+([\s\S]*?)\n\s*Si chiede/i);
  let tx = corpo ? corpo[1].replace(/^(a|al|alla|allo|ai|alle|agli)\b\s*:?\s*/i, '') : oggetti;
  tx = pulisciRighe(tx);

  let t = tipiDaTesto(oggetti);
  if (!t.length) t = tipiDaTesto(tx);
  if (!t.length) t = ['F'];
  return { n, t, tx };
}

// Link ai PDF rufblob nel corpo HTML della mail -> [{url, n}] (n dal nome file
// "16132.pdf" se presente, altrimenti null). Deduplica per URL.
function extractPdfLinks(html) {
  const s = String(html || '').replace(/&amp;/g, '&');
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="(https?:\/\/rufblob\.blob\.core\.windows\.net\/[^"]+\.pdf)"[^>]*>([^<]*)</gi;
  let m;
  while ((m = re.exec(s))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const num = m[2].match(/\b(1\d{4})\.pdf/i);
    out.push({ url: m[1], n: num ? parseInt(num[1], 10) : null });
  }
  for (const u of s.match(/https?:\/\/rufblob\.blob\.core\.windows\.net\/[^\s"'<>)]+\.pdf/gi) || []) {
    if (!seen.has(u)) { seen.add(u); out.push({ url: u, n: null }); }
  }
  return out;
}

// Oggetto mail Federfarma SP -> è una segnalazione su ricette/timbri di un medico?
// Esclude furti di medicinali, lotti falsificati, riepiloghi.
function isFederfarmaSegnalazione(subject) {
  const s = String(subject || '').toLowerCase();
  if (/lotto|riepilogo|furto (di )?medicinali|farmacia ospedaliera/.test(s)) return false;
  return /furt|smarrim|falsific|\bfals[ei]\b/.test(s) &&
         /\bdr\b|\bdr\.|\bdott|timbr|ricett|\bmedic[oa]\b|\bu\.\s?o\./.test(s);
}

const MAX_TX_FF = 1500; // gli allegati Federfarma possono avere intestazioni lunghe

// Voce senza numero FOFI per un inoltro Federfarma SP. `key` (Message-ID) serve
// a non riaccodarla ai giri successivi; `date` (dd/mm/yyyy) è mostrata in UI.
// Il matching gira su tx e basta un token lungo per dare l'allarme: intestazione
// (data, protocollo, destinatari) e firmatari Federfarma vanno tolti, altrimenti
// un medico che si chiama come un firmatario farebbe scattare il banner.
const FINE_CORPO_FF = /^(cordiali saluti|distinti saluti|il segretario|il presidente|il direttore|il dirigente|il responsabile)\b/i;
const INTESTAZIONE_FF = new RegExp([
  /^(roma,|uff\.|prot|alle? |ai |agli |a tutte|loro sedi)/.source,
  /registro ufficiale/.source,
  // carta intestata ATSL / destinatari delle lettere di accompagnamento
  /^(ats liguria|azienda tutela|area sociosanitaria|s\.c\. |via |tel|associazione titolari|ordine farmacisti|provincia della spezia)/.source,
  /@|\bpec\./.source,
].join('|'), 'i');
// Pagina di accompagnamento ATSL ("invio copia smarrimento/furto…"): solo
// intestazioni e destinatari, la segnalazione vera è nelle pagine dopo.
const ACCOMPAGNAMENTO_ATSL = /invio copia (dello? )?(smarrimento|furto)|preghiera di massima diffusione/i;
// Se dopo la pulizia restano parole di intestazione (OCR sporco), meglio tenere
// solo l'oggetto: "Bartolomeo" (P.O. San Bartolomeo) farebbe scattare il banner
// per qualunque medico con quel nome.
const RESIDUI_INTESTAZIONE = /bartolomeo|sarzana|federfarma|farmacisti|liguria|massima diffusione/i;

function corpoFederfarma(text) {
  const corpo = String(text || '').split('\f')
    .filter(p => !ACCOMPAGNAMENTO_ATSL.test(p.replace(/\s+/g, ' ')))
    .map(p => {
      const righe = pulisciRighe(p).split('\n');
      const fine = righe.findIndex(r => FINE_CORPO_FF.test(r));
      return (fine >= 0 ? righe.slice(0, fine) : righe).filter(r => !INTESTAZIONE_FF.test(r));
    })
    .flat().join('\n');
  return RESIDUI_INTESTAZIONE.test(corpo) ? '' : corpo;
}

// Testo OCR delle scansioni -> campo `ocr`, solo da consultare (pagina Banca
// dati): NON entra nel tx perché le lettere degli ospedali contengono decine di
// nomi estranei (amministrativi, infermieri, direttori) che farebbero scattare
// il banner per qualunque medico omonimo. '' se l'OCR non ha prodotto nulla.
const MAX_OCR = 3000;

function testoOcr(text) {
  const s = String(text || '').split('\f')
    .filter(p => !ACCOMPAGNAMENTO_ATSL.test(p.replace(/\s+/g, ' ')))
    .map(p => pulisciRighe(p).split('\n').filter(r => !/registro ufficiale/i.test(r)).join('\n'))
    .filter(Boolean).join('\n').slice(0, MAX_OCR);
  return testoInsufficiente(s) ? '' : s;
}

function federfarmaEntry({ subject, text, ocr, date, key }) {
  const sogg = String(subject || '').trim();
  const corpo = corpoFederfarma(text).slice(0, MAX_TX_FF);
  const tx = corpo ? sogg + '\n' + corpo : sogg;
  let t = tipiDaTesto(sogg + '\n' + corpo);
  if (!t.length) t = ['F'];
  const e = { n: null, t, tx, m: [], f: [], src: 'Federfarma SP', d: date || '', k: key || '' };
  const o = testoOcr(ocr);
  if (o) e.ocr = o;
  return e;
}

// word/document.xml di un .docx -> testo semplice (un paragrafo per riga).
function docxXmlToText(xml) {
  const s = String(xml || '')
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return pulisciRighe(s);
}

// Giorni trascorsi da una data dd/mm/yyyy (Infinity se non valida).
function giorniDa(dmy, now) {
  const m = String(dmy || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return Infinity;
  const d = Date.UTC(+m[3], +m[2] - 1, +m[1]);
  const oggi = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((oggi - d) / 86400000);
}

// ── OCR dei PDF scansionati ──────────────────────────────────────────────
// I PDF di ATSL inoltrati da Federfarma sono scansioni: pdftotext estrae solo il
// timbro di protocollo ("ATSL.REGISTRO UFFICIALE..."). Sotto questa soglia di
// lettere il testo non è utilizzabile e va riletto con OCR (Tesseract, in CI).
const MIN_LETTERE = 80;

function testoInsufficiente(text) {
  const utile = String(text || '').split('\n')
    .filter(r => !/registro ufficiale/i.test(r)).join(' ');
  return (utile.match(/[a-zà-ù]/gi) || []).length < MIN_LETTERE;
}

// Voce Federfarma già in banca dati ma salvata con solo l'oggetto (allegato
// scansionato, prima dell'OCR): va riletta per recuperare nomi e dettagli.
function serveRilettura(e) {
  if (e.n != null || !e.k || e.ocr) return false;
  return testoInsufficiente(String(e.tx || '').split('\n').slice(1).join('\n'));
}

// Sostituisce tx/t delle voci con la stessa k, solo se il nuovo testo è
// davvero più ricco (un OCR fallito non deve peggiorare la voce).
// Ritorna { db, aggiornate } con db nello stesso ordine.
function applicaRiletture(db, riletture) {
  const perK = new Map(riletture.filter(r => r.k).map(r => [r.k, r]));
  const aggiornate = [];
  const out = db.map(e => {
    const r = e.k && perK.get(e.k);
    if (!r) return e;
    let nuova = e;
    // tx: solo testo vero (pdftotext/docx), più ricco e senza intestazioni
    const corpoNuovo = String(r.tx || '').split('\n').slice(1).join('\n');
    if (r.tx && r.tx.length > e.tx.length &&
        !testoInsufficiente(corpoNuovo) && !RESIDUI_INTESTAZIONE.test(corpoNuovo)) {
      nuova = { ...nuova, tx: r.tx, t: r.t };
    }
    // ocr: testo delle scansioni, solo consultabile (fuori dal matching)
    if (r.ocr && r.ocr.length > String(e.ocr || '').length) nuova = { ...nuova, ocr: r.ocr };
    if (nuova !== e) aggiornate.push(nuova);
    return nuova;
  });
  return { db: out, aggiornate };
}

// La più recente fra due date dd/mm/yyyy (valori non validi ignorati).
function dataPiuRecente(a, b) {
  const k = d => /^\d{2}\/\d{2}\/\d{4}$/.test(d || '') ? d.split('/').reverse().join('') : '';
  if (!k(a)) return k(b) ? b : '';
  if (!k(b)) return a;
  return k(a) >= k(b) ? a : b;
}

const _exports = {
  testoInsufficiente, serveRilettura, applicaRiletture,
  dataPiuRecente, tipiDaTesto, circolarePdfToEntry, extractPdfLinks,
  isFederfarmaSegnalazione, federfarmaEntry, docxXmlToText, giorniDa,
};
Object.assign(globalThis, _exports);
if (typeof module !== 'undefined' && module.exports) module.exports = _exports;
})();
