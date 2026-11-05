import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  circolarePdfToEntry, tipiDaTesto, extractPdfLinks,
  isFederfarmaSegnalazione, federfarmaEntry, docxXmlToText, giorniDa,
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
