#!/usr/bin/env node
// fetch-fofi-email.mjs — scarica l'allegato Excel dall'ultima mail FOFI.
//
// Uso: node tools/fetch-fofi-email.mjs [output.xlsx]
//
// Legge le credenziali Gmail (sola lettura) dalle variabili d'ambiente:
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
// (vedi AUTOMAZIONE-FOFI.md per come ottenerle).
//
// Exit code: 0 = allegato scaricato · 2 = credenziali mancanti ·
//            3 = nessuna mail/allegato (niente da fare) · altro = errore.

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { formatEmailDate } = require(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fofi-xlsx.js'));

const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
const OUT = process.argv[2] || '.fofi-incoming.xlsx';
// File di appoggio con la data della mail (dd/mm/yyyy): build-fofi-db.mjs la
// legge e la scrive in fofi-db.js come FOFI_DB_AGGIORNATA.
const DATE_OUT = OUT + '.date';

if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
  console.error('Mancano i secret GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN.');
  process.exit(2);
}

// Query Gmail: mail dell'Ordine con allegato .xlsx delle segnalazioni urgenti.
const QUERY = 'from:fofiruf.it (Segnalazioni urgenti OR falsificazione) has:attachment filename:xlsx newer_than:120d';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function accessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) throw new Error(`OAuth token ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

// Cerca ricorsivamente la prima parte con filename .xlsx e attachmentId.
function findXlsxPart(payload) {
  if (!payload) return null;
  const fn = payload.filename || '';
  if (/\.xlsx$/i.test(fn) && payload.body && payload.body.attachmentId) return payload;
  for (const p of payload.parts || []) {
    const found = findXlsxPart(p);
    if (found) return found;
  }
  return null;
}

function header(payload, name) {
  return (payload.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

const at = await accessToken();
const H = { Authorization: 'Bearer ' + at };

const listRes = await fetch(`${API}/messages?q=${encodeURIComponent(QUERY)}&maxResults=5`, { headers: H });
if (!listRes.ok) throw new Error(`Gmail list ${listRes.status}: ${await listRes.text()}`);
const list = await listRes.json();
if (!list.messages || !list.messages.length) {
  console.log('Nessuna mail FOFI con allegato .xlsx trovata.');
  process.exit(3);
}

// I messaggi sono in ordine cronologico inverso: prendo il primo con allegato xlsx.
for (const { id } of list.messages) {
  const msg = await (await fetch(`${API}/messages/${id}`, { headers: H })).json();
  const part = findXlsxPart(msg.payload);
  if (!part) continue;
  const att = await (await fetch(`${API}/messages/${id}/attachments/${part.body.attachmentId}`, { headers: H })).json();
  const buf = Buffer.from(att.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  writeFileSync(OUT, buf);
  const rawDate = header(msg.payload, 'Date');
  const dataMail = formatEmailDate(rawDate);
  if (dataMail) writeFileSync(DATE_OUT, dataMail);
  console.log(`Scaricato "${part.filename}" (${buf.length} byte) dalla mail del ${rawDate}${dataMail ? ` (${dataMail})` : ''} -> ${OUT}`);
  process.exit(0);
}

console.log('Nessun allegato .xlsx nelle mail candidate.');
process.exit(3);
