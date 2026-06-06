// fetch-fofi-email.mjs — scarica l'Excel dall'ultima mail FOFI.
//
// Uso: node tools/fetch-fofi-email.mjs [output.xlsx]
//
// Legge le credenziali Gmail (sola lettura) dalle variabili d'ambiente:
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
// (vedi AUTOMAZIONE-FOFI.md per come ottenerle).
//
// Da ~giugno 2026 FOFI non allega più l'Excel come file MIME: il corpo HTML
// contiene solo un LINK Azure blob (rufblob.blob.core.windows.net/.../<guid>.xlsx),
// scaricabile pubblicamente senza auth. Lo script prova prima l'allegato MIME
// (retrocompatibilità) e in fallback estrae e scarica quel link dal corpo.
//
// Exit code: 0 = xlsx scaricato · 2 = credenziali mancanti ·
//            3 = nessuna mail/xlsx (niente da fare) · altro = errore.
//
// (niente shebang: il file è importato dai test e il transform di Vite non
//  strippa `#!`. Si lancia come `node tools/fetch-fofi-email.mjs`.)

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { formatEmailDate } = require(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fofi-xlsx.js'));

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
// Query Gmail: mail delle segnalazioni urgenti dell'Ordine. NON filtriamo su
// has:attachment perché ora l'Excel è un link nel corpo, non un allegato.
const QUERY = 'from:fofiruf.it (Segnalazioni urgenti OR falsificazione) newer_than:120d';

// ── Helper puri (esportati e testati in tests/fetch-fofi-email.test.js) ──────

// Decodifica una stringa base64url (formato usato da Gmail per body/allegati).
export function decodeB64Url(data) {
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Concatena il testo di tutte le parti text/html e text/plain del messaggio.
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

// Cerca ricorsivamente la prima parte con filename .xlsx e attachmentId (MIME).
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

// ── Esecuzione (solo se lanciato come script, non quando importato dai test) ──

async function accessToken(creds) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.id, client_secret: creds.secret,
      refresh_token: creds.refresh, grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) throw new Error(`OAuth token ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

async function main() {
  const OUT = process.argv[2] || '.fofi-incoming.xlsx';
  // File di appoggio con la data della mail (dd/mm/yyyy): build-fofi-db.mjs la
  // legge e la scrive in fofi-db.js come FOFI_DB_AGGIORNATA.
  const DATE_OUT = OUT + '.date';

  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    console.error('Mancano i secret GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN.');
    return 2;
  }

  const at = await accessToken({ id: GMAIL_CLIENT_ID, secret: GMAIL_CLIENT_SECRET, refresh: GMAIL_REFRESH_TOKEN });
  const H = { Authorization: 'Bearer ' + at };

  const listRes = await fetch(`${API}/messages?q=${encodeURIComponent(QUERY)}&maxResults=10`, { headers: H });
  if (!listRes.ok) throw new Error(`Gmail list ${listRes.status}: ${await listRes.text()}`);
  const list = await listRes.json();
  if (!list.messages || !list.messages.length) {
    console.log('Nessuna mail FOFI di segnalazioni trovata.');
    return 3;
  }

  // Messaggi in ordine cronologico inverso: prendo il primo da cui ricavo un xlsx
  // (allegato MIME o link nel corpo).
  for (const { id } of list.messages) {
    const msg = await (await fetch(`${API}/messages/${id}`, { headers: H })).json();
    let buf = null;
    let sorgente = '';

    const part = findXlsxPart(msg.payload);
    if (part) {
      const att = await (await fetch(`${API}/messages/${id}/attachments/${part.body.attachmentId}`, { headers: H })).json();
      buf = decodeB64Url(att.data);
      sorgente = `allegato "${part.filename}"`;
    } else {
      const url = extractXlsxUrl(collectBody(msg.payload));
      if (!url) continue; // niente xlsx in questa mail (es. circolare con PDF)
      const r = await fetch(url);
      if (!r.ok) { console.warn(`[FOFI] link xlsx non scaricabile (${r.status}): ${url}`); continue; }
      buf = Buffer.from(await r.arrayBuffer());
      sorgente = `link ${url}`;
    }

    writeFileSync(OUT, buf);
    const rawDate = header(msg.payload, 'Date');
    const dataMail = formatEmailDate(rawDate);
    if (dataMail) writeFileSync(DATE_OUT, dataMail);
    console.log(`Scaricato xlsx (${buf.length} byte) da ${sorgente} — mail del ${rawDate}${dataMail ? ` (${dataMail})` : ''} -> ${OUT}`);
    return 0;
  }

  console.log('Nessun xlsx (allegato o link) nelle mail candidate.');
  return 3;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(code => process.exit(code)).catch(err => { console.error(err); process.exit(1); });
}
