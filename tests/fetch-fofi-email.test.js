import { describe, it, expect } from 'vitest';
import { extractXlsxUrl, collectBody, decodeB64Url, findXlsxPart } from '../tools/fetch-fofi-email.mjs';

// HTML reale (semplificato) della mail "Segnalazioni urgenti" FOFI: l'Excel è
// un link Azure blob nel corpo, non un allegato MIME.
const HTML_SEGNALAZIONI = `<p>Buongiorno, si invia in allegato...</p>
<b>Allegati</b>
<ul><li><a href="https://rufblob.blob.core.windows.net/rufpublic/attachmentddc280d0-8f03-443f-81a9-f14e5f8e2cb9.xlsx">Circolari FOFI Segnalazioni 21.05.26.xlsx</a></li></ul>`;

// Mail "circolare" con allegato PDF (manuale operativo): nessun xlsx.
const HTML_PDF = `<b>Allegati</b>
<ul><li><a href="https://rufblob.blob.core.windows.net/rufpublic/attachment2b5df9e9.pdf">15928.pdf</a></li></ul>`;

describe('extractXlsxUrl — link Excel dal corpo mail', () => {
  it('estrae il link rufblob .xlsx', () => {
    expect(extractXlsxUrl(HTML_SEGNALAZIONI)).toBe(
      'https://rufblob.blob.core.windows.net/rufpublic/attachmentddc280d0-8f03-443f-81a9-f14e5f8e2cb9.xlsx'
    );
  });

  it('ritorna null se c\'è solo un PDF (nessun xlsx)', () => {
    expect(extractXlsxUrl(HTML_PDF)).toBeNull();
  });

  it('decodifica le entità &amp; nell\'URL', () => {
    const html = '<a href="https://rufblob.blob.core.windows.net/x/a.xlsx?sv=1&amp;sig=abc.xlsx">f</a>';
    expect(extractXlsxUrl(html)).toBe('https://rufblob.blob.core.windows.net/x/a.xlsx?sv=1&sig=abc.xlsx');
  });

  it('preferisce il link rufblob anche se c\'è un altro .xlsx prima', () => {
    const html = 'vedi https://altro.example.com/file.xlsx e https://rufblob.blob.core.windows.net/r/b.xlsx';
    expect(extractXlsxUrl(html)).toBe('https://rufblob.blob.core.windows.net/r/b.xlsx');
  });

  it('fallback: un qualsiasi link .xlsx se non c\'è rufblob', () => {
    expect(extractXlsxUrl('scarica https://example.com/dati.xlsx ora')).toBe('https://example.com/dati.xlsx');
  });

  it('stringa vuota / senza link -> null', () => {
    expect(extractXlsxUrl('')).toBeNull();
    expect(extractXlsxUrl('nessun link qui')).toBeNull();
  });
});

describe('collectBody — testo da payload Gmail multipart', () => {
  it('concatena text/html e text/plain decodificati (base64url)', () => {
    const b64 = s => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('ciao') } },
        { mimeType: 'text/html', body: { data: b64('<p>link a.xlsx</p>') } },
      ],
    };
    const body = collectBody(payload);
    expect(body).toContain('ciao');
    expect(body).toContain('a.xlsx');
  });
});

describe('decodeB64Url / findXlsxPart', () => {
  it('decodeB64Url gestisce - e _', () => {
    const enc = Buffer.from('a+b/c', 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    expect(decodeB64Url(enc).toString('utf8')).toBe('a+b/c');
  });

  it('findXlsxPart trova la parte con allegato MIME .xlsx', () => {
    const payload = { parts: [
      { filename: 'foto.png', body: { attachmentId: 'x' } },
      { filename: 'dati.xlsx', body: { attachmentId: 'ATT123' } },
    ] };
    expect(findXlsxPart(payload)?.body.attachmentId).toBe('ATT123');
  });

  it('findXlsxPart ritorna null senza allegati xlsx', () => {
    expect(findXlsxPart({ parts: [{ filename: 'a.pdf', body: { attachmentId: 'y' } }] })).toBeNull();
  });
});
