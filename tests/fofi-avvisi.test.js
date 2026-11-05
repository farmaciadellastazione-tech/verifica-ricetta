import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  circolarePdfToEntry, tipiDaTesto, extractPdfLinks,
  isFederfarmaSegnalazione, federfarmaEntry, docxXmlToText, giorniDa, dataPiuRecente,
  testoInsufficiente, serveRilettura, applicaRiletture,
} from '../fofi-avvisi.js';

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const txt = n => readFileSync(resolve(FIX, `circ-${n}.txt`), 'utf8');

// ── Circolari FOFI in PDF (dal 3/11/2026 l'Ordine non manda più l'Excel) ──
// Fixture = output reale di `pdftotext -enc UTF-8` sulle circolari 16130/16132/16135.

describe('circolarePdfToEntry — PDF circolare FOFI → voce FOFI_DB', () => {
  it('16132: falsificazione, numero dal testo, farmaco e medico nel tx', () => {
    const e = circolarePdfToEntry(txt(16132));
    expect(e.n).toBe(16132);
    expect(e.t).toEqual(['F']);
    expect(e.tx).toMatch(/STRACI EMANUELE/);
    expect(e.tx).toMatch(/DEPALGOS/);
    expect(e.tx).not.toMatch(/Si chiede ai Presidenti/);
    expect(e.tx).not.toMatch(/scrivente Federazione/);
  });

  it('16135: furto ricettario e timbro → T, numero isolato nel testo', () => {
    const e = circolarePdfToEntry(txt(16135));
    expect(e.n).toBe(16135);
    expect(e.t).toContain('T');
    expect(e.tx).toMatch(/SCALINI/);
    expect(e.tx).toMatch(/01020 0006360/);
  });

  it('16130: più medici in elenco puntato, tutti nel tx', () => {
    const e = circolarePdfToEntry(txt(16130));
    expect(e.n).toBe(16130);
    expect(e.t).toContain('T');
    for (const nome of ['QUADRELLI', 'FERRARO MARGHERITA', 'ANIBAN LEO']) expect(e.tx).toMatch(nome);
    expect(e.tx).not.toMatch(/•/);
  });

  it('il numero suggerito (nome file "16132.pdf") ha la precedenza', () => {
    expect(circolarePdfToEntry(txt(16132), 16132).n).toBe(16132);
  });

  it('circolare non di segnalazione (corso ECM) → null', () => {
    const corso = 'Ufficio: Protocollo: Oggetto:\nRoma, 01/11/2026 Corso ECM FAD per farmacisti vaccinatori\nCircolare n.\n16113\n';
    expect(circolarePdfToEntry(corso)).toBeNull();
  });

  it('nessun numero ricavabile → null (non si inventano voci senza n)', () => {
    expect(circolarePdfToEntry('Segnalazione urgente: furto timbro del Dr. X. relativa al furto del timbro. Si chiede')).toBeNull();
  });
});

describe('tipiDaTesto — F/T/B dalle parole chiave', () => {
  it('falsificazione / ricette false → F', () => {
    expect(tipiDaTesto('falsificazione ricette')).toEqual(['F']);
    expect(tipiDaTesto('PRESCRIZIONI MEDICHE FALSE')).toEqual(['F']);
    expect(tipiDaTesto('dubbia autenticità di una ricetta')).toEqual(['F']);
  });
  it('timbro / ricettario → T', () => {
    expect(tipiDaTesto('smarrimento timbro personale')).toEqual(['T']);
    expect(tipiDaTesto('furto del ricettario')).toEqual(['T']);
  });
  it('buoni acquisto → B', () => {
    expect(tipiDaTesto('smarrimento buono acquisto stupefacenti')).toEqual(['B']);
  });
  it('furto di ricette + timbro → F e T', () => {
    expect(tipiDaTesto('FURTO di n. 5 RICETTE SSN e del TIMBRO')).toEqual(['F', 'T']);
  });
});

describe('extractPdfLinks — link rufblob ai PDF nel corpo mail', () => {
  const HTML = `<b>Allegati</b><br/><p><ul>
<li><a href="https://rufblob.blob.core.windows.net/rufpublic/attachment5c176d9e-aef2.pdf">16132.pdf (Url: https://rufblob.blob.core.windows.net/rufpublic/attachment5c176d9e-aef2.pdf)</a></li>
<li><a href="https://rufblob.blob.core.windows.net/rufpublic/attachmentaff06e12.pdf">16135.pdf (Url: ...)</a></li>
<li><a href="https://rufblob.blob.core.windows.net/rufpublic/attachmentxyz.pdf">Manuale operativo.pdf</a></li>
</ul></p>`;
  it('estrae URL + numero circolare dal nome file', () => {
    expect(extractPdfLinks(HTML)).toEqual([
      { url: 'https://rufblob.blob.core.windows.net/rufpublic/attachment5c176d9e-aef2.pdf', n: 16132 },
      { url: 'https://rufblob.blob.core.windows.net/rufpublic/attachmentaff06e12.pdf', n: 16135 },
      { url: 'https://rufblob.blob.core.windows.net/rufpublic/attachmentxyz.pdf', n: null },
    ]);
  });
  it('nessun link → []', () => {
    expect(extractPdfLinks('<p>niente</p>')).toEqual([]);
  });
});

// ── Federfarma La Spezia: inoltri singoli senza numero FOFI ──────────────

describe('isFederfarmaSegnalazione — filtro oggetto mail', () => {
  it.each([
    'Furto dr Andrea CANTATORE - Rozzano (MI)',
    'dott.ssa RAPETTI Francesca - smarrimento timbro',
    'U.O. EMATOLOGIA DEGENZA - Osp. S. Martino GE - smarrimento timbro',
    'Falsificazione ricette Dr. Rossi',
  ])('segnalazione: %s', s => expect(isFederfarmaSegnalazione(s)).toBe(true));

  it.each([
    '223-RRS-FURTO MEDICINALI PRESSO FARMACIA OSPEDALIERA AUSL PIACENZA (PC)',
    "227 -RRS- SEGNALAZIONE LOTTO FALSIFICATO SPECIALITA' MEDICINALE KEYTRUDA",
    '233-VA-RIEPILOGO CIRCOLARI MESE DI OTTOBRE 2026',
    'I: FarmacistaPiù, XIII edizione',
  ])('NON segnalazione: %s', s => expect(isFederfarmaSegnalazione(s)).toBe(false));
});

describe('federfarmaEntry — voce senza numero, con chiave di deduplica', () => {
  it('n null, src/d/k valorizzati, oggetto + testo allegato nel tx', () => {
    const e = federfarmaEntry({
      subject: 'Furto dr Andrea CANTATORE - Rozzano (MI)',
      text: 'Si comunica il furto del ricettario e del timbro del dr. Andrea Cantatore.',
      date: '05/11/2026', key: '<abc@federfarma>',
    });
    expect(e).toMatchObject({ n: null, src: 'Federfarma SP', d: '05/11/2026', k: '<abc@federfarma>' });
    expect(e.tx).toMatch(/^Furto dr Andrea CANTATORE/);
    expect(e.tx).toMatch(/ricettario/);
    expect(e.t).toContain('T');
  });
  it('senza allegato leggibile usa solo l\'oggetto', () => {
    const e = federfarmaEntry({ subject: 'dott.ssa RAPETTI Francesca - smarrimento timbro', text: '', date: '22/10/2026', key: 'k1' });
    expect(e.tx).toBe('dott.ssa RAPETTI Francesca - smarrimento timbro');
    expect(e.t).toEqual(['T']);
  });
  it('tipo non deducibile → F (prudenziale: mai voce senza tipo)', () => {
    expect(federfarmaEntry({ subject: 'Furto dr Rossi', text: '', date: '01/11/2026', key: 'k2' }).t.length).toBeGreaterThan(0);
  });
});

describe('docxXmlToText — testo da word/document.xml', () => {
  it('un paragrafo per riga, tag rimossi, entità decodificate', () => {
    const xml = '<w:document><w:body><w:p><w:r><w:t>Furto timbro</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Dr. Rossi &amp; C.</w:t></w:r></w:p></w:body></w:document>';
    expect(docxXmlToText(xml)).toBe('Furto timbro\nDr. Rossi & C.');
  });
});

describe('giorniDa — età dell\'ultimo aggiornamento', () => {
  it('differenza in giorni da dd/mm/yyyy', () => {
    expect(giorniDa('27/10/2026', new Date(Date.UTC(2026, 10, 5)))).toBe(9);
  });
  it('data non valida → Infinity (va trattata come "vecchia")', () => {
    expect(giorniDa('', new Date())).toBe(Infinity);
  });
});

// ── Correzioni dalla code review (05/11/2026) ────────────────────────────

describe('federfarmaEntry — niente firmatari/intestazioni nel tx (falsi positivi)', () => {
  // Testo reale dell'allegato docx Federfarma (furto timbro dr Cantatore).
  const e = federfarmaEntry({
    subject: 'Furto dr Andrea CANTATORE - Rozzano (MI)',
    text: readFileSync(resolve(FIX, 'federfarma-cantatore.txt'), 'utf8'),
    date: '05/11/2026', key: 'k',
  });
  it('tiene medico, timbro e farmaco', () => {
    expect(e.tx).toMatch(/CANTATORE/);
    expect(e.tx).toMatch(/28672/);
    expect(e.tx).toMatch(/Mounjaro/);
  });
  it('taglia saluti e firmatari Federfarma', () => {
    expect(e.tx).not.toMatch(/PELLEGRINI|COSSOLO|SEGRETARIO|Cordiali/);
  });
  it('toglie intestazione (data, protocollo, destinatari)', () => {
    expect(e.tx).not.toMatch(/ALLE ASSOCIAZIONI|Uff\.-Prot|Roma, 5 novembre/);
  });
});

describe('circolarePdfToEntry — il numero si cerca dopo "Circolare n."', () => {
  it('un CAP prima di "Circolare n." non viene scambiato per il numero', () => {
    const s = 'Ufficio: Protocollo: Oggetto:\nVia Roma 1, 16121 Genova\nCircolare n.\n16140\n' +
      'Segnalazione urgente: furto timbro\nSi informa che la scrivente Federazione ha ricevuto una segnalazione relativa al furto del timbro del Dr. X.\nSi chiede ai Presidenti';
    expect(circolarePdfToEntry(s).n).toBe(16140);
  });
});

describe('isFederfarmaSegnalazione — "medicinali" non esclude furti di ricettario', () => {
  it('furto ricettario con "medicinali" nell\'oggetto → segnalazione', () => {
    expect(isFederfarmaSegnalazione('Furto ricettario e timbro dr Rossi - prescrizioni medicinali stupefacenti')).toBe(true);
  });
});

describe('dataPiuRecente — la data "Aggiornamento" non torna indietro', () => {
  it('sceglie la più recente fra due dd/mm/yyyy', () => {
    expect(dataPiuRecente('05/11/2026', '20/10/2026')).toBe('05/11/2026');
    expect(dataPiuRecente('20/10/2026', '05/11/2026')).toBe('05/11/2026');
  });
  it('ignora valori vuoti/non validi', () => {
    expect(dataPiuRecente('', '05/11/2026')).toBe('05/11/2026');
    expect(dataPiuRecente('05/11/2026', null)).toBe('05/11/2026');
  });
});

// ── OCR dei PDF scansionati (ATSL: pdftotext estrae solo il timbro di protocollo) ──

const SOLO_TIMBRO = 'ATSL.REGISTRO UFFICIALE.0401016.U.16-10-2026.h.12:26\n\f';
const TESTO_OCR = 'Si comunica lo smarrimento del timbro personale della Dott.ssa Maria Bianchi, ' +
  'dirigente medico U.O. Ematologia, Ospedale Policlinico San Martino di Genova.';

describe('testoInsufficiente — quando serve l\'OCR', () => {
  it('solo timbro di protocollo ATSL → serve OCR', () => {
    expect(testoInsufficiente(SOLO_TIMBRO)).toBe(true);
  });
  it('vuoto → serve OCR', () => {
    expect(testoInsufficiente('')).toBe(true);
  });
  it('testo vero (circolare FOFI) → niente OCR', () => {
    expect(testoInsufficiente(txt(16135))).toBe(false);
  });
});

describe('federfarmaEntry — il timbro di protocollo ATSL non entra nel tx', () => {
  it('tx = solo oggetto se l\'allegato è solo timbro', () => {
    const e = federfarmaEntry({ subject: 'dott.ssa RAPETTI Francesca - smarrimento timbro', text: SOLO_TIMBRO, date: '22/10/2026', key: 'k' });
    expect(e.tx).toBe('dott.ssa RAPETTI Francesca - smarrimento timbro');
  });
});

describe('serveRilettura — voci Federfarma già salvate ma senza testo allegato', () => {
  it('voce con solo oggetto + timbro → da rileggere', () => {
    expect(serveRilettura({ n: null, src: 'Federfarma SP', k: 'k', tx: 'U.O. EMATOLOGIA - smarrimento timbro\n' + SOLO_TIMBRO })).toBe(true);
  });
  it('voce con testo completo → no', () => {
    expect(serveRilettura({ n: null, src: 'Federfarma SP', k: 'k', tx: 'Oggetto\n' + TESTO_OCR })).toBe(false);
  });
  it('circolari FOFI numerate → mai', () => {
    expect(serveRilettura({ n: 16130, t: ['T'], tx: 'x' })).toBe(false);
  });
});

describe('applicaRiletture — sostituisce tx/t delle voci con la stessa k', () => {
  const vecchia = { n: null, t: ['T'], tx: 'U.O. EMATOLOGIA - smarrimento timbro', m: [], f: [], src: 'Federfarma SP', d: '19/10/2026', k: 'k1' };
  const altra = { n: 16130, t: ['T'], tx: 'x', m: [], f: [] };
  it('aggiorna la voce, lascia le altre e conserva posizione, d e k', () => {
    const nuova = { ...vecchia, tx: 'U.O. EMATOLOGIA - smarrimento timbro\n' + TESTO_OCR, t: ['T'] };
    const { db, aggiornate } = applicaRiletture([altra, vecchia], [nuova]);
    expect(db[0]).toBe(altra);
    expect(db[1].tx).toMatch(/Maria Bianchi/);
    expect(db[1]).toMatchObject({ d: '19/10/2026', k: 'k1', src: 'Federfarma SP' });
    expect(aggiornate).toHaveLength(1);
  });
  it('non sostituisce con un testo non più ricco (OCR fallito)', () => {
    const { db, aggiornate } = applicaRiletture([vecchia], [{ ...vecchia, tx: 'U.O. EMATOLOGIA' }]);
    expect(db[0]).toBe(vecchia);
    expect(aggiornate).toEqual([]);
  });
});
