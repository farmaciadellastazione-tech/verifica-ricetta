// fetch-fofi-email.mjs — scarica l'Excel dall'ultima mail FOFI via IMAP.
//
// Uso: node tools/fetch-fofi-email.mjs [output.xlsx]
//
// Autenticazione via App Password Gmail (nessun OAuth, nessuna scadenza):
//   GMAIL_USER         — indirizzo Gmail (es. farmaciadellastazione@gmail.com)
//   GMAIL_APP_PASSWORD — App Password Google a 16 caratteri (senza spazi)
//
// Exit code: 0 = xlsx scaricato · 2 = credenziali mancanti ·
//            3 = nessuna mail/xlsx (niente da fare) · altro = errore.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const require = createRequire(import.meta.url);
const { formatEmailDate } = require(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fofi-xlsx.js'));

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

// ── Esecuzione (solo se lanciato come script, non quando importato dai test) ──

async function main() {
  const OUT = process.argv[2] || '.fofi-incoming.xlsx';
  const DATE_OUT = OUT + '.date';

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

  await client.connect();
  try {
    // Usa "All Mail" per trovare anche mail archiviate
    const mailboxes = await client.list();
    const allMailbox = mailboxes.find(m => m.specialUse === '\\All');
    const mailboxPath = allMailbox?.path || 'INBOX';

    const lock = await client.getMailboxLock(mailboxPath);
    try {
      const since = new Date();
      since.setDate(since.getDate() - 120);

      const uids = await client.search({
        from: 'fofiruf.it',
        subject: 'segnalazioni',
        since,
      }, { uid: true });

      if (!uids?.length) {
        console.log('Nessuna mail FOFI di segnalazioni trovata.');
        return 3;
      }

      // UIDs decrescenti = più recenti prima
      for (const uid of [...uids].sort((a, b) => b - a)) {
        const { content } = await client.download(String(uid), undefined, { uid: true });
        const chunks = [];
        for await (const chunk of content) chunks.push(chunk);
        const parsed = await simpleParser(Buffer.concat(chunks));

        let buf = null;
        let sorgente = '';

        // 1. Allegato MIME xlsx (retrocompatibilità)
        const att = parsed.attachments?.find(a => /\.xlsx$/i.test(a.filename || ''));
        if (att) {
          buf = att.content;
          sorgente = `allegato "${att.filename}"`;
        } else {
          // 2. Link rufblob nel corpo HTML (formato attuale da ~giugno 2026)
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
        if (dataMail) writeFileSync(DATE_OUT, dataMail);
        console.log(`Scaricato xlsx (${buf.length} byte) da ${sorgente} — mail del ${rawDate}${dataMail ? ` (${dataMail})` : ''} -> ${OUT}`);
        return 0;
      }

      console.log('Nessun xlsx (allegato o link) nelle mail candidate.');
      return 3;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(code => process.exit(code)).catch(err => { console.error(err); process.exit(1); });
}
