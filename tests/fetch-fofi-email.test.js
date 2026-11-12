import { describe, it, expect } from 'vitest';
import { extractXlsxUrl, collectBody, decodeB64Url, findXlsxPart, scaricaMail, preparaIncoming } from '../tools/fetch-fofi-email.mjs';

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

describe('scaricaMail — download IMAP tollerante', () => {
  const MAIL = 'Subject: prova\r\nMessage-ID: <x@y>\r\n\r\ncorpo\r\n';
  const stream = s => (async function* () { yield Buffer.from(s); })();

  it('download senza contenuto (12/11/2026, run #153) → riprova, poi null senza eccezioni', async () => {
    let chiamate = 0;
    const client = { download: async () => { chiamate++; return {}; } };
    await expect(scaricaMail(client, 7)).resolves.toBeNull();
    expect(chiamate).toBe(2);
  });

  it('primo tentativo vuoto, secondo ok → mail letta', async () => {
    let n = 0;
    const client = { download: async () => (++n === 1 ? {} : { content: stream(MAIL) }) };
    const p = await scaricaMail(client, 7);
    expect(p.subject).toBe('prova');
  });

  it('errore IMAP → null (la singola mail non blocca le altre)', async () => {
    const client = { download: async () => { throw new Error('connessione chiusa'); } };
    await expect(scaricaMail(client, 7)).resolves.toBeNull();
  });
});

describe('preparaIncoming — voci trovate nelle mail → .fofi-incoming.json', () => {
  const circ = (n, iso) => ({ entry: { n, t: ['F'], tx: `c${n}` }, date: new Date(iso) });
  const ff = (d, iso) => ({ entry: { n: null, t: ['T'], tx: `ff${d}`, src: 'Federfarma SP', d }, date: new Date(iso) });

  it('le circolari prendono come data d quella della mail', () => {
    const { entries } = preparaIncoming([circ(16141, '2026-11-10T11:15:15Z')]);
    expect(entries[0].d).toBe('10/11/2026');
  });

  it('la data già presente (Federfarma/Ordine) non viene toccata', () => {
    const { entries } = preparaIncoming([ff('05/11/2026', '2026-11-06T08:00:00Z')]);
    expect(entries[0].d).toBe('05/11/2026');
  });

  it('un lotto di più giorni è accodato per data crescente, non raggruppato per fonte', () => {
    // fetch raccoglie prima tutti i PDF, poi Federfarma, poi Ordine.
    const { entries } = preparaIncoming([
      circ(16141, '2026-11-10T11:15:15Z'),
      circ(16144, '2026-11-12T08:00:00Z'),
      ff('11/11/2026', '2026-11-11T09:00:00Z'),
    ]);
    expect(entries.map(e => e.tx)).toEqual(['c16141', 'ff11/11/2026', 'c16144']);
  });

  it('riletture OCR separate; "aggiornata" segue solo le voci nuove', () => {
    const rilettura = { ...ff('06/10/2026', '2026-12-01T08:00:00Z'), rilettura: true };
    const out = preparaIncoming([circ(16141, '2026-11-10T11:15:15Z'), rilettura]);
    expect(out.entries).toHaveLength(1);
    expect(out.riletture).toHaveLength(1);
    expect(out.aggiornata).toBe('10/11/2026');
  });

  it('non modifica le voci in ingresso', () => {
    const t = circ(16141, '2026-11-10T11:15:15Z');
    preparaIncoming([t]);
    expect(t.entry.d).toBeUndefined();
  });
});
