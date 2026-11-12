// fetch-fofi-email.mjs — raccoglie le segnalazioni FOFI dalla mail via IMAP.
//
// Uso: node tools/fetch-fofi-email.mjs [output.xlsx]
//
// Tre fonti, tutte facoltative:
//   1. Excel cumulativo dell'Ordine (allegato o link rufblob .xlsx) -> output.xlsx
//      (formato storico, sospeso dall'Ordine il 3/11/2026: resta per retrocompatibilità)
//   2. PDF delle singole circolari FOFI linkati nelle mail dell'Ordine (fofiruf.it)
//   3. inoltri singoli di Federfarma La Spezia (allegato PDF/docx, senza numero FOFI)
//   4. avvisi dell'Ordine nel corpo mail (segnalazione di una farmacia, senza PDF né numero)
//   Le voci di 2, 3 e 4 vanno in output.json ({aggiornata, entries}), da applicare con
//   tools/apply-fofi-entries.mjs. Servono `pdftotext`/`pdftoppm` (poppler-utils), `unzip`
//   e `tesseract` con lingua ita (OCR delle scansioni ATSL) nel PATH.
//
// Autenticazione via App Password Gmail (nessun OAuth, nessuna scadenza):
//   GMAIL_USER         — indirizzo Gmail (es. farmaciadellastazione@gmail.com)
//   GMAIL_APP_PASSWORD — App Password Google a 16 caratteri (senza spazi)
//
// Exit code: 0 = trovato qualcosa (xlsx e/o json) · 2 = credenziali mancanti ·
//            3 = niente di nuovo · altro = errore.

import { writeFileSync, readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { formatEmailDate } = require(resolve(ROOT, 'fofi-xlsx.js'));
const {
  extractPdfLinks, circolarePdfToEntry, isFederfarmaSegnalazione, federfarmaEntry, docxXmlToText,
  testoInsufficiente, serveRilettura, isAvvisoOrdine, ordineAvvisoEntry,
} = require(resolve(ROOT, 'fofi-avvisi.js'));

const GIORNI_XLSX = 30; // Excel sospeso dal 3/11/2026: non riscaricare quello vecchio per mesi
const GIORNI_AVVISI = 30; // finestra per PDF circolari
const GIORNI_FEDERFARMA = 45; // più ampia: permette di rileggere con OCR voci di inizio ottobre
const MAX_PAGINE_OCR = 3;

// ── Helper puri (esportati, testati in tests/fetch-fofi-email.test.js) ──────
// Mantenuti per compatibilità con i test esistenti.

export function decodeB64Url(data) {
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function collectBody(payload) {
  if (!payload) return '';
  let out = '';
  const mt = payload.mimeType || '';
  if ((mt === 'text/html' || mt === 'text/plain') && payload.body && payload.body.data) {
    out += decodeB64Url(payload.body.data).toString('utf8') + '\n';
  }
  for (const p of payload.parts || []) out += collectBody(p);
  return out;
}

// Estrae dall'HTML l'URL dell'Excel: prima il blob FOFI (rufblob), poi un
// qualsiasi link .xlsx. Ritorna null se non c'è. Gestisce le entità &amp;.
export function extractXlsxUrl(html) {
  const s = String(html || '').replace(/&amp;/g, '&');
  const rufblob = s.match(/https?:\/\/rufblob\.blob\.core\.windows\.net\/[^\s"'<>)]+\.xlsx/i);
  if (rufblob) return rufblob[0];
  const any = s.match(/https?:\/\/[^\s"'<>)]+\.xlsx/i);
  return any ? any[0] : null;
}

export function findXlsxPart(payload) {
  if (!payload) return null;
  const fn = payload.filename || '';
  if (/\.xlsx$/i.test(fn) && payload.body && payload.body.attachmentId) return payload;
  for (const p of payload.parts || []) {
    const found = findXlsxPart(p);
    if (found) return found;
  }
  return null;
}

export function header(payload, name) {
  return (payload.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

// ── I/O ──────────────────────────────────────────────────────────────────

// Numeri circolare e chiavi già in fofi-db.js: evitano download inutili.
function loadKnown() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, 'fofi-db.js'), 'utf8') + ';globalThis.__FOFI=FOFI_DB;', ctx);
  return {
    numeri: new Set(ctx.__FOFI.map(e => e.n).filter(n => n != null)),
    chiavi: new Set(ctx.__FOFI.map(e => e.k).filter(Boolean)),
    // voci Federfarma salvate con solo l'oggetto (scansione non letta): da rileggere con OCR
    daRileggere: new Set(ctx.__FOFI.filter(serveRilettura).map(e => e.k)),
  };
}

// OCR di un PDF scansionato: pdftoppm (pagine -> PNG in scala di grigi, 300 dpi)
// + tesseract in italiano. '' se gli strumenti mancano o falliscono.
function ocrPdf(f, tmp) {
  try {
    const prefisso = join(tmp, 'ocr' + Math.random().toString(36).slice(2));
    execFileSync('pdftoppm', ['-r', '300', '-gray', '-png', '-l', String(MAX_PAGINE_OCR), f, prefisso]);
    const base = basename(prefisso);
    return readdirSync(tmp).filter(n => n.startsWith(base) && n.endsWith('.png')).sort()
      .map(n => execFileSync('tesseract', [join(tmp, n), '-', '-l', 'ita'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
      .join('\f'); // pagine separate: accompagnamento e firme si tolgono per pagina
  } catch (err) {
    console.warn(`[FOFI] OCR non riuscito: ${err.message}`);
    return '';
  }
}

// Buffer di un allegato -> testo (pdf via pdftotext, con OCR se è una scansione;
// docx via unzip). '' se non leggibile.
function allegatoToText(buf, nomeFile, tmp) {
  const f = join(tmp, 'a' + Math.random().toString(36).slice(2) + (/\.docx$/i.test(nomeFile) ? '.docx' : '.pdf'));
  writeFileSync(f, buf);
  try {
    if (/\.pdf$/i.test(nomeFile)) {
      const testo = execFileSync('pdftotext', ['-enc', 'UTF-8', f, '-'], { encoding: 'utf8' });
      if (!testoInsufficiente(testo)) return { testo, ocr: '' };
      console.log(`  (${nomeFile}: scansione, uso OCR)`);
      return { testo, ocr: ocrPdf(f, tmp) }; // OCR a parte: solo consultabile, non nel tx
    }
    if (/\.docx$/i.test(nomeFile)) return { testo: docxXmlToText(execFileSync('unzip', ['-p', f, 'word/document.xml'], { encoding: 'utf8' })), ocr: '' };
  } catch (err) {
    console.warn(`[FOFI] allegato non leggibile (${nomeFile}): ${err.message}`);
  }
  return { testo: '', ocr: '' };
}

// Scarica e analizza una mail. Ogni tanto Gmail risponde al download senza
// contenuto (run #153 del 12/11/2026: TypeError sull'iteratore): si riprova
// una volta, poi si salta la mail con un avviso. Ritorna null se non leggibile:
// una singola mail non deve bloccare l'aggiornamento di tutte le altre.
export async function scaricaMail(client, uid, tentativi = 2) {
  for (let i = 1; i <= tentativi; i++) {
    try {
      const res = await client.download(String(uid), undefined, { uid: true });
      if (!res?.content) throw new Error('download senza contenuto');
      const chunks = [];
      for await (const chunk of res.content) chunks.push(chunk);
      return await simpleParser(Buffer.concat(chunks));
    } catch (err) {
      if (i === tentativi) {
        console.warn(`[FOFI] mail uid ${uid} non leggibile, saltata: ${err.message}`);
        return null;
      }
    }
  }
  return null;
}

function giorniFa(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// 1. Excel cumulativo (formato storico): scrive OUT + OUT.date. Ritorna true se trovato.
async function cercaXlsx(client, OUT) {
  const uids = await client.search({ from: 'fofiruf.it', subject: 'segnalazioni', since: giorniFa(GIORNI_XLSX) }, { uid: true });
  for (const uid of [...(uids || [])].sort((a, b) => b - a)) {
    const parsed = await scaricaMail(client, uid);
    if (!parsed) continue;
    let buf = null;
    let sorgente = '';
    const att = parsed.attachments?.find(a => /\.xlsx$/i.test(a.filename || ''));
    if (att) {
      buf = att.content;
      sorgente = `allegato "${att.filename}"`;
    } else {
      const url = extractXlsxUrl(parsed.html || parsed.textAsHtml || '');
      if (!url) continue;
      const r = await fetch(url);
      if (!r.ok) { console.warn(`[FOFI] xlsx non scaricabile (${r.status}): ${url}`); continue; }
      buf = Buffer.from(await r.arrayBuffer());
      sorgente = `link ${url}`;
    }
    writeFileSync(OUT, buf);
    const rawDate = parsed.date?.toUTCString() || '';
    const dataMail = formatEmailDate(rawDate);
    if (dataMail) writeFileSync(OUT + '.date', dataMail);
    console.log(`Scaricato xlsx (${buf.length} byte) da ${sorgente} — mail del ${rawDate} -> ${OUT}`);
    return true;
  }
  console.log('Nessun xlsx (allegato o link) nelle mail recenti.');
  return false;
}

// 2. PDF delle circolari FOFI nelle mail dell'Ordine. Ritorna [{entry, date}].
async function cercaPdfCircolari(client, known, tmp) {
  const out = [];
  const uids = await client.search({ from: 'fofiruf.it', since: giorniFa(GIORNI_AVVISI) }, { uid: true });
  for (const uid of uids || []) {
    const parsed = await scaricaMail(client, uid);
    if (!parsed) continue;
    const subject = parsed.subject || '';
    // PDF senza numero nel nome: li apriamo solo se la mail parla di segnalazioni
    // (le altre circolari sono corsi/note e non vanno in banca dati).
    const links = extractPdfLinks(parsed.html || parsed.textAsHtml || '')
      .filter(l => l.n != null ? !known.numeri.has(l.n) : /segnalaz/i.test(subject));
    for (const l of links) {
      const r = await fetch(l.url);
      if (!r.ok) { console.warn(`[FOFI] PDF non scaricabile (${r.status}): ${l.url}`); continue; }
      const { testo: text } = allegatoToText(Buffer.from(await r.arrayBuffer()), 'c.pdf', tmp);
      const e = circolarePdfToEntry(text, l.n ?? undefined);
      if (e && !known.numeri.has(e.n)) {
        known.numeri.add(e.n);
        out.push({ entry: e, date: parsed.date });
        console.log(`+ circolare ${e.n} [${e.t}] da "${subject}"`);
      }
    }
  }
  return out;
}

// 3. Inoltri Federfarma La Spezia (oggetto "furto/smarrimento/falsificazione ...").
async function cercaFederfarma(client, known, tmp) {
  const out = [];
  const uids = await client.search({ from: 'federfarmalaspezia.it', since: giorniFa(GIORNI_FEDERFARMA) }, { uid: true });
  for (const uid of uids || []) {
    const parsed = await scaricaMail(client, uid);
    if (!parsed) continue;
    const subject = (parsed.subject || '').trim();
    const key = parsed.messageId || '';
    const rilettura = known.daRileggere.has(key);
    if (!key || (known.chiavi.has(key) && !rilettura) || !isFederfarmaSegnalazione(subject)) continue;
    const letti = (parsed.attachments || [])
      .filter(a => /\.(pdf|docx)$/i.test(a.filename || ''))
      .map(a => allegatoToText(a.content, a.filename, tmp));
    const text = letti.map(l => l.testo).join('\f');
    const ocr = letti.map(l => l.ocr).filter(Boolean).join('\f');
    const date = formatEmailDate(parsed.date?.toUTCString() || '');
    known.chiavi.add(key);
    known.daRileggere.delete(key);
    out.push({ entry: federfarmaEntry({ subject, text, ocr, date, key }), date: parsed.date, rilettura });
    console.log(`${rilettura ? '~ rilettura OCR' : '+'} Federfarma SP ${date}: ${subject}`);
  }
  return out;
}

// 4. Avvisi dell'Ordine con il testo nel corpo mail (nessun PDF, nessun numero).
async function cercaAvvisiOrdine(client, known) {
  const out = [];
  const uids = await client.search({ from: 'fofiruf.it', since: giorniFa(GIORNI_AVVISI) }, { uid: true });
  for (const uid of uids || []) {
    const parsed = await scaricaMail(client, uid);
    if (!parsed) continue;
    const subject = (parsed.subject || '').trim();
    const key = parsed.messageId || '';
    if (!key || known.chiavi.has(key) || !isAvvisoOrdine(subject)) continue;
    // Con link a PDF e nessun testo tra virgolette è un inoltro di circolari
    // (lo gestisce cercaPdfCircolari); con l'avviso nel corpo si prende comunque,
    // anche se in allegato c'è un PDF (es. la denuncia).
    if (extractPdfLinks(parsed.html || parsed.textAsHtml || '').length &&
        !/"[^"]{40,}"|“[^”]{40,}”|«[^»]{40,}»/.test(parsed.text || '')) continue;
    const date = formatEmailDate(parsed.date?.toUTCString() || '');
    known.chiavi.add(key);
    out.push({ entry: ordineAvvisoEntry({ subject, text: parsed.text || '', date, key }), date: parsed.date });
    console.log(`+ Ordine SP ${date}: ${subject}`);
  }
  return out;
}

async function main() {
  const OUT = process.argv[2] || '.fofi-incoming.xlsx';
  const JSON_OUT = OUT.replace(/\.xlsx$/i, '') + '.json';

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.error('Mancano GMAIL_USER / GMAIL_APP_PASSWORD.');
    return 2;
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  const tmp = mkdtempSync(join(tmpdir(), 'fofi-'));
  await client.connect();
  try {
    // Usa "All Mail" per trovare anche mail archiviate
    const mailboxes = await client.list();
    const allMailbox = mailboxes.find(m => m.specialUse === '\\All');
    const lock = await client.getMailboxLock(allMailbox?.path || 'INBOX');
    try {
      const xlsx = await cercaXlsx(client, OUT);
      const known = loadKnown();
      const trovate = [
        ...await cercaPdfCircolari(client, known, tmp),
        ...await cercaFederfarma(client, known, tmp),
        ...await cercaAvvisiOrdine(client, known),
      ];
      if (trovate.length) {
        const nuove = trovate.filter(t => !t.rilettura);
        // La data "Aggiornamento" segue solo le segnalazioni nuove, non le riletture OCR.
        const piuRecente = nuove.map(t => t.date).filter(Boolean).sort((a, b) => b - a)[0];
        const aggiornata = piuRecente ? formatEmailDate(piuRecente.toUTCString()) : '';
        writeFileSync(JSON_OUT, JSON.stringify({
          aggiornata,
          entries: nuove.map(t => t.entry),
          riletture: trovate.filter(t => t.rilettura).map(t => t.entry),
        }, null, 1));
        console.log(`${trovate.length} voci da PDF/Federfarma/Ordine (di cui riletture OCR: ${trovate.length - nuove.length}) -> ${JSON_OUT}`);
      } else {
        console.log('Nessuna circolare PDF o inoltro Federfarma nuovo.');
      }
      return (xlsx || trovate.length) ? 0 : 3;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
    rmSync(tmp, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(code => process.exit(code)).catch(err => { console.error(err); process.exit(1); });
}
