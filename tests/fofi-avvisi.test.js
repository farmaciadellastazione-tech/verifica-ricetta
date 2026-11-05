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

// ── OCR ATSL: lettera di accompagnamento e firmatari (dry run #143) ─────────
// L'OCR reale ha letto solo la pagina 1 (accompagnamento ATSL), piena di
// intestazioni ("Via Cisa Sud c/o P.O. San Bartolomeo — SARZANA"): un medico di
// nome Bartolomeo avrebbe fatto scattare il banner. Le pagine arrivano separate
// da \f (pdftotext e OCR); il taglio firme vale pagina per pagina.
const ACCOMPAGNAMENTO = [
  'ATS LIGURIA',
  'AZIENDA TUTELA DELLA SALUTE LIGURIA',
  'AREA SOCIOSANITARIA LOCALE 5',
  'S.C. Assistenza Farmaceutica',
  'Via Cisa Sud c/o P.O. San Bartolomeo — SARZANA SP',
  'Tel.: 0187-604736',
  'Associazione Titolari Farmacia',
  'Provincia della Spezia',
  'ap.laspezia@pec.federfarma.it',
  'Oggetto: invio copia smarrimento/furto ricettari e/o timbri medici.',
  'Si trasmette in allegato comunicazione prot. n. 123 relativa all\'oggetto, per conoscenza e con preghiera di massima diffusione.',
  'Distinti saluti',
  'Il Direttore',
  'Dott. Ernesto Pallavicini',
].join('\n');
const COMUNICAZIONE = [
  'Si comunica lo smarrimento del timbro personale della dott.ssa RAPETTI Francesca,',
  'medico di continuità assistenziale, codice regionale 123456.',
  'Il Direttore Sanitario',
  'Dott. Gualtiero Bonaventura',
].join('\n');

describe('federfarmaEntry — OCR ATSL: niente pagina di accompagnamento né firmatari', () => {
  const sogg = 'dott.ssa RAPETTI Francesca - smarrimento timbro';

  it('scarta la pagina di accompagnamento ma tiene la comunicazione delle pagine successive', () => {
    const text = 'ATSL.REGISTRO UFFICIALE.0408733.U.22-10-2026.h.11:59\f' + ACCOMPAGNAMENTO + '\f' + COMUNICAZIONE;
    const e = federfarmaEntry({ subject: sogg, text, date: '22/10/2026', key: '<x@y>' });
    expect(e.tx).toMatch(/smarrimento del timbro personale della dott\.ssa RAPETTI/);
    expect(e.tx).not.toMatch(/Bartolomeo|SARZANA|Liguria|Spezia|Pallavicini|massima diffusione/i);
  });

  it('i firmatari ATSL/ospedale (Il Direttore…) non entrano nel tx', () => {
    const e = federfarmaEntry({ subject: sogg, text: COMUNICAZIONE, date: '22/10/2026', key: '<x@y>' });
    expect(e.tx).not.toMatch(/Bonaventura|Direttore/);
  });

  it('se c\'è solo la pagina di accompagnamento il tx resta l\'oggetto', () => {
    const e = federfarmaEntry({ subject: sogg, text: ACCOMPAGNAMENTO, date: '22/10/2026', key: '<x@y>' });
    expect(e.tx).toBe(sogg);
  });
});

describe('applicaRiletture — scarta OCR con residui di intestazione', () => {
  it('non applica una rilettura che contiene ancora intestazioni ATSL/Federfarma', () => {
    const db = [{ n: null, t: ['T'], tx: 'dott.ssa X - smarrimento timbro', m: [], f: [], k: '<a>' }];
    const sporca = 'dott.ssa X - smarrimento timbro\n' +
      'Comunicazione relativa allo smarrimento del timbro, presso P.O. San Bartolomeo SARZANA, ' +
      'si prega di diffondere a tutte le farmacie interessate del territorio provinciale.';
    const { aggiornate } = applicaRiletture(db, [{ k: '<a>', t: ['T'], tx: sporca }]);
    expect(aggiornate).toHaveLength(0);
  });
});

// ── OCR solo consultabile (dry run #144) ─────────────────────────────────
// Le lettere dell'ospedale lette con OCR contengono decine di nomi estranei
// (amministrativi, infermieri, direttori, città): nel tx farebbero scattare il
// banner per ogni medico "Roberto" o "Amato". Il testo OCR va nel campo `ocr`,
// mostrato nella pagina Banca dati ma escluso dal matching (che gira su tx).
const LETTERA_OSPEDALE = [
  'PLESSO OSPEDALIERO IRCCS POLICLINICO SAN MARTINO',
  'Responsabile del procedimento: Dott.ssa Rosa Amato',
  'Oggetto: Smarrimento o furto timbro di reparto',
  'Si trasmette, per opportuna conoscenza, l\'acclusa copia della denuncia riguardante lo smarrimento',
  'di un timbro ospedaliero relativo alla U.O. EMATOLOGIA DEGENZA (Direttore Prof. ROBERTO MASSIMO LEMOLI).',
].join('\n');

describe('federfarmaEntry — testo OCR nel campo ocr, non nel tx', () => {
  const sogg = 'U.O. EMATOLOGIA DEGENZA - Osp. S. Martino GE - smarrimento timbro';
  const timbro = 'ATSL.REGISTRO UFFICIALE.0401016.U.16-10-2026.h.12:26';

  it('tx resta l\'oggetto, ocr contiene la lettera senza la pagina di accompagnamento', () => {
    const e = federfarmaEntry({ subject: sogg, text: timbro, ocr: ACCOMPAGNAMENTO + '\f' + LETTERA_OSPEDALE, date: '19/10/2026', key: 'k1' });
    expect(e.tx).toBe(sogg);
    expect(e.ocr).toMatch(/EMATOLOGIA DEGENZA/);
    expect(e.ocr).not.toMatch(/massima diffusione|REGISTRO UFFICIALE/);
  });

  it('OCR vuoto o inutilizzabile → nessun campo ocr', () => {
    const e = federfarmaEntry({ subject: sogg, text: timbro, ocr: ACCOMPAGNAMENTO, date: '19/10/2026', key: 'k1' });
    expect(e.ocr).toBeUndefined();
  });
});

describe('serveRilettura / applicaRiletture — campo ocr', () => {
  const vecchia = { n: null, t: ['T'], tx: 'U.O. EMATOLOGIA - smarrimento timbro', m: [], f: [], src: 'Federfarma SP', d: '19/10/2026', k: 'k1' };

  it('voce che ha già il testo OCR → non va riletta', () => {
    expect(serveRilettura({ ...vecchia, ocr: LETTERA_OSPEDALE })).toBe(false);
  });

  it('la rilettura aggiunge ocr e lascia tx invariato', () => {
    const { db, aggiornate } = applicaRiletture([vecchia], [{ ...vecchia, ocr: LETTERA_OSPEDALE }]);
    expect(db[0].tx).toBe(vecchia.tx);
    expect(db[0].ocr).toBe(LETTERA_OSPEDALE);
    expect(aggiornate).toHaveLength(1);
  });

  it('i nomi del testo OCR non fanno scattare il matching (che gira su tx)', async () => {
    const { scoreMatch, tokenize } = await import('../fofi-match.js');
    const { db } = applicaRiletture([vecchia], [{ ...vecchia, ocr: LETTERA_OSPEDALE }]);
    expect(scoreMatch(tokenize('Amato Roberto'), db[0]).score).toBe(0);
  });
});

// ── OCR: niente dati personali dai verbali di denuncia (dry run #145) ────────
// Gli allegati contengono anche i verbali dei Carabinieri con codice fiscale,
// indirizzo, telefono e documento del denunciante: fofi-db.js è pubblico (GitHub
// Pages), quindi del testo OCR si tiene solo il paragrafo "Oggetto: … Distinti
// saluti" della lettera dell'ospedale. Dati di fantasia.
const LETTERA_E_VERBALE = [
  'PLESSO OSPEDALIERO IRCCS POLICLINICO SAN MARTINO',
  'Responsabile del procedimento: Dott.ssa Mara Rossetti',
  'E-mail: mara.rossetti@ospedale.it Tel, 0105550000 Segreteria',
  'Al Presidente Ordine dei Medici di Genova',
  'Oggetto: Smarrimento timbro medico Dott.ssa Bianchi Lucia.',
  'Si trasmette, per opportuna conoscenza, l\'acclusa copia della denuncia riguardante lo smarrimento',
  'del timbro della U.O. Cardiologia (Direttore Prof. Carlo Neri).',
  'Distinti Saluti',
  'LA DIRETTRICE ff',
].join('\n') + '\f' + [
  'VERBALE di ricezione denuncia orale sporta da:',
  'BIANCHI LUCIA nata a Genova (GE) il 01/01/1980, codice fiscale: BNCLCU80A41D969X, residente a',
  'Genova (GE) in VIA ROMA, 1, tel. 3330000000, professione: Medico, carta identita\' nr. CA0000000',
  'Genova, li 28 Settembre 2026',
  'OGGETTO: Denuncia di smarrimento/furto timbro',
  'Io sottoscritta, Verdi Anna, CPSI in servizio presso la Cardiologia, con matricola 0000000,',
  'DICHIARO che: mi sono accorta della sparizione del timbro.',
].join('\n');

describe('federfarmaEntry — ocr senza dati personali dei verbali', () => {
  const e = federfarmaEntry({ subject: 'dott.ssa BIANCHI Lucia - smarrimento timbro', text: '', ocr: LETTERA_E_VERBALE, date: '22/10/2026', key: 'k' });

  it('tiene il paragrafo Oggetto della lettera dell\'ospedale', () => {
    expect(e.ocr).toMatch(/Oggetto: Smarrimento timbro medico Dott\.ssa Bianchi Lucia/);
    expect(e.ocr).toMatch(/U\.O\. Cardiologia/);
  });

  it('niente codice fiscale, telefono, indirizzo, nascita, documento, email', () => {
    expect(e.ocr).not.toMatch(/BNCLCU80A41D969X|3330000000|VIA ROMA|nata a|residente|CA0000000|@|0105550000/i);
  });

  it('niente dichiarazioni dei denuncianti (verbale, "sottoscritta", matricola)', () => {
    expect(e.ocr).not.toMatch(/VERBALE|sottoscritt|DICHIARO|matricola|Verdi Anna/i);
  });

  it('nessun paragrafo Oggetto utilizzabile → nessun campo ocr', () => {
    const solo = federfarmaEntry({ subject: 's', text: '', ocr: LETTERA_E_VERBALE.split('\f')[1], date: '', key: 'k' });
    expect(solo.ocr).toBeUndefined();
  });
});
