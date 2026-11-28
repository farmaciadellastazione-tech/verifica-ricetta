// update-regole.mjs — aggiornamenti normativi (note AIFA, riclassificazioni, DPC)
// dalle circolari di Federfarma La Spezia e dell'Ordine dei Farmacisti SP.
//
// Uso:
//   node tools/update-regole.mjs [--giorni N]
//       legge la posta degli ultimi N giorni (default 30), fa estrarre le regole
//       a Gemini, le controlla (regole-core.js → validaRegola) e aggiorna
//       regole-prescrizione.js. Scartate e avvisi vanno in .regole-report.json.
//   node tools/update-regole.mjs --report <regole-prescrizione.js di base>
//       stampa la descrizione della PR (markdown): regole nuove rispetto alla
//       base, con la citazione della circolare, + scartate/avvisi dell'ultima corsa.
//
// Variabili d'ambiente: GMAIL_USER, GMAIL_APP_PASSWORD (come la pipeline FOFI),
// GEMINI_API_KEY. Servono pdftotext (e per le scansioni pdftoppm + tesseract ita).
//
// Exit code: 0 = lette circolari nuove · 2 = credenziali mancanti ·
//            3 = niente di nuovo · altro = errore.

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { ImapFlow } from 'imapflow';
import { scaricaMail, allegatoToText } from './fetch-fofi-email.mjs';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE_REGOLE = resolve(ROOT, 'regole-prescrizione.js');
const FILE_REPORT = resolve(ROOT, '.regole-report.json');
const {
  circolarePertinente, circolareDaValutare, validaRegola, avvisiRegola, promptEstrazione, parseRispostaEstrazione, rispostaLeggibile, diagnosiChiave, erroreGemini, esitoCorsa,
  regoleToDbFile, regolaDuplicata, regoleNuove, reportPR,
} = require(resolve(ROOT, 'regole-core.js'));
const { dataDMY } = require(resolve(ROOT, 'fofi-match.js'));
const { isEnoxaparina } = require(resolve(ROOT, 'canale-eparine.js'));

const MITTENTI = ['federfarmalaspezia.it', 'fofiruf.it'];
const MODELLI = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest'];
const MAX_CARATTERI_TESTO = 60000;
const MIN_CARATTERI_TESTO = 150;

export function caricaRegole(src) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src + ';globalThis.__R = { regole: REGOLE_PRESCRIZIONE, esaminate: REGOLE_ESAMINATE };', ctx);
  return JSON.parse(JSON.stringify(ctx.__R));
}

// Il piè di pagina di Federfarma (indirizzo, avviso di riservatezza) è in ogni
// mail: non conta come contenuto.
export function corpoUtile(text) {
  return String(text || '').split(/(?:^|\n)\s*\[cid:|(?:^|\n)C\.so Nazionale 222/)[0].trim();
}

async function chiamaGemini(prompt, apiKey) {
  for (const modello of MODELLI) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modello}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          maxOutputTokens: 8192,
          thinkingConfig: { thinkingBudget: 1024 },
        },
      }),
    });
    if (r.status === 503 || r.status === 429) {
      console.warn(`[Regole] ${modello} non disponibile (${r.status}), provo il successivo`);
      continue;
    }
    if (!r.ok) {
      const e = erroreGemini(r.status, await r.text());
      throw Object.assign(new Error(`Gemini ${modello}: ${e.testo}`), { chiaveRifiutata: e.chiaveRifiutata });
    }
    const j = await r.json();
    return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  }
  throw new Error('Gemini: tutti i modelli occupati');
}

// Analisi di UNA circolare: Gemini estrae, validaRegola controlla.
// `apiKey` è la chiave Gemini, `msgId` il Message-ID della mail (diventa k):
// nomi distinti apposta (bug 28/11/2026: una variabile `key` per entrambi
// mandava a Gemini il Message-ID). `gemini` sostituibile nei test.
// Esito: 'letta' | 'errore' (da rileggere) | 'chiave_rifiutata' (stop).
export async function esaminaCircolare({ subject, testo, d, msgId, apiKey, regoleEsistenti = [], gemini = chiamaGemini }) {
  const fonte = subject;
  const out = { esito: 'letta', regole: [], scartate: [], avvisi: [], errore: '' };
  let risposta;
  try {
    risposta = await gemini(promptEstrazione(subject, testo), apiKey);
  } catch (err) {
    out.esito = err.chiaveRifiutata ? 'chiave_rifiutata' : 'errore';
    out.errore = err.message;
    out.avvisi.push({ fonte, problemi: [`Gemini non ha risposto (${err.message.slice(0, 160)}): circolare da rileggere alla prossima corsa`] });
    return out;
  }
  if (!rispostaLeggibile(risposta)) {
    out.esito = 'errore';
    out.errore = 'risposta di Gemini illeggibile o troncata';
    out.avvisi.push({ fonte, problemi: ['risposta di Gemini illeggibile o troncata: circolare da rileggere alla prossima corsa'] });
    return out;
  }
  const grezze = parseRispostaEstrazione(risposta);
  for (const g of grezze) {
    const r = {
      tipo: g.tipo,
      farmaci: Array.isArray(g.farmaci) ? g.farmaci.map(f => String(f).trim()).filter(Boolean) : [],
      regola: String(g.regola || '').trim(),
      dal: String(g.dal || '').trim(),
      estratto: String(g.estratto || '').trim(),
      fonte, d, k: msgId,
    };
    const problemi = validaRegola(r, testo);
    // L'enoxaparina la decide canale-eparine.js (codice testato, non il prompt).
    if (r.farmaci.length && r.farmaci.every(isEnoxaparina)) problemi.push('enoxaparina: già gestita da canale-eparine.js');
    if (!problemi.length && regolaDuplicata(r, [...regoleEsistenti, ...out.regole])) problemi.push('già presente (promemoria o reinoltro)');
    if (problemi.length) {
      out.scartate.push({ fonte, problemi: [`${r.farmaci.join(', ') || '?'} — ${problemi.join('; ')}`] });
      console.log(`  - scartata (${problemi.join('; ')})`);
      continue;
    }
    const av = avvisiRegola(r, testo);
    if (av.length) out.avvisi.push({ fonte, problemi: av });
    out.regole.push(r);
    console.log(`  + [${r.tipo}] ${r.farmaci.join(', ')} dal ${r.dal}`);
  }
  if (!grezze.length) console.log('  (nessuna regola)');
  return out;
}

// Controllo della chiave all'avvio del workflow, senza mai stamparla
// (repository pubblico: i log delle Actions sono visibili a tutti).
async function controllaChiave() {
  const grezza = process.env.GEMINI_API_KEY;
  const dia = diagnosiChiave(grezza);
  console.log(`Chiave Gemini: ${dia.lunghezza} caratteri, formato ${dia.formatoOk ? 'ok' : 'NON standard'}` +
    `${dia.spaziEsterni ? ', spazi/a capo ai lati (verranno tolti)' : ''}${dia.caratteriStrani ? ', CARATTERI NON VALIDI' : ''}`);
  if (!dia.lunghezza) { console.error('::error::Secret GEMINI_API_KEY assente o vuoto'); return 1; }
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
    headers: { 'x-goog-api-key': String(grezza).trim() },
  });
  if (r.ok) { console.log('Chiave Gemini accettata.'); return 0; }
  const e = erroreGemini(r.status, await r.text());
  console.error(`::error::Chiave Gemini non accettata: ${e.testo}`);
  return 1;
}

function giorniFa(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

async function aggiorna(giorni) {
  const { GMAIL_USER: user, GMAIL_APP_PASSWORD: pass } = process.env;
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!user || !pass || !apiKey) {
    console.error('Mancano GMAIL_USER / GMAIL_APP_PASSWORD / GEMINI_API_KEY.');
    return 2;
  }
  const db = caricaRegole(readFileSync(FILE_REGOLE, 'utf8'));
  const esaminate = new Set(db.esaminate);
  const scartate = [];
  const avvisi = [];
  let lette = 0;
  let erroriGemini = 0;

  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
  const tmp = mkdtempSync(join(tmpdir(), 'regole-'));
  await client.connect();
  try {
    const mailboxes = await client.list();
    const all = mailboxes.find(m => m.specialUse === '\\All');
    const lock = await client.getMailboxLock(all?.path || 'INBOX');
    try {
      const uids = new Set();
      for (const from of MITTENTI) {
        for (const u of await client.search({ from, since: giorniFa(giorni) }, { uid: true }) || []) uids.add(u);
      }
      for (const uid of [...uids].sort((a, b) => a - b)) {
        // prima solo l'intestazione: le mail non pertinenti non si scaricano
        const env = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
        const subject = (env?.envelope?.subject || '').trim();
        const msgId = env?.envelope?.messageId || '';
        const daValutare = circolareDaValutare(subject);
        if (!msgId || esaminate.has(msgId) || !(daValutare || circolarePertinente(subject))) continue;
        if (daValutare) {
          // stupefacenti: niente Gemini, la circolare la legge il revisore
          avvisi.push({ fonte: subject, problemi: ['circolare sugli stupefacenti: DA VALUTARE A MANO (cambia le regole di base del prompt, non estratta in automatico)'] });
          console.log(`Da valutare a mano: ${subject}`);
          esaminate.add(msgId);
          lette++;
          continue;
        }

        const parsed = await scaricaMail(client, uid);
        if (!parsed) continue;
        const allegati = (parsed.attachments || []).filter(a => /\.(pdf|docx)$/i.test(a.filename || ''));
        const letti = allegati.map(a => allegatoToText(a.content, a.filename, tmp));
        const testoAllegati = letti.map(l => [l.testo, l.ocr].filter(Boolean).join('\n')).join('\f').trim();
        const testo = [corpoUtile(parsed.text), testoAllegati].filter(Boolean).join('\n\n').slice(0, MAX_CARATTERI_TESTO);
        if (testo.replace(/\s+/g, ' ').length < MIN_CARATTERI_TESTO) {
          // scansione senza OCR (in locale manca tesseract): la si rilegge in CI
          console.warn(`[Regole] testo non leggibile, rimandata: ${subject}`);
          continue;
        }

        const d = parsed.date ? dataDMY(parsed.date) : '';
        console.log(`Esamino: ${subject} (${d})`);
        const r = await esaminaCircolare({ subject, testo, d, msgId, apiKey, regoleEsistenti: db.regole });
        scartate.push(...r.scartate);
        avvisi.push(...r.avvisi);
        if (r.esito === 'chiave_rifiutata') {
          console.error(`::error::Chiave Gemini rifiutata (${r.errore}): aggiornare il secret GEMINI_API_KEY`);
          return 1;
        }
        if (r.esito === 'errore') {
          // la mail NON va tra le esaminate: si rilegge alla prossima corsa
          console.warn(`::warning::[Regole] ${r.errore} — "${subject}" da rileggere alla prossima corsa`);
          erroriGemini++;
          continue;
        }
        db.regole.push(...r.regole);
        esaminate.add(msgId);
        lette++;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
    rmSync(tmp, { recursive: true, force: true });
  }

  const esito = esitoCorsa({ lette, erroriGemini });
  if (esito === 1) {
    console.error(`::error::Nessuna circolare letta: ${erroriGemini} errori di Gemini (vedi gli avvisi sopra)`);
    return 1;
  }
  if (esito === 3) {
    console.log('Nessuna circolare nuova da esaminare.');
    return 3;
  }
  db.esaminate = [...esaminate];
  writeFileSync(FILE_REGOLE, regoleToDbFile(db));
  writeFileSync(FILE_REPORT, JSON.stringify({ scartate, avvisi }, null, 1));
  console.log(`${lette} circolari esaminate -> regole-prescrizione.js`);
  return 0;
}

function report(fileBase) {
  const base = existsSync(fileBase) ? caricaRegole(readFileSync(fileBase, 'utf8')) : { regole: [] };
  const ora = caricaRegole(readFileSync(FILE_REGOLE, 'utf8'));
  const extra = existsSync(FILE_REPORT) ? JSON.parse(readFileSync(FILE_REPORT, 'utf8')) : {};
  console.log(reportPR(regoleNuove(base.regole, ora.regole), extra.scartate || [], extra.avvisi || []));
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--controlla-chiave')) return controllaChiave();
  const iReport = args.indexOf('--report');
  if (iReport >= 0) return report(resolve(args[iReport + 1] || ''));
  const iGiorni = args.indexOf('--giorni');
  const giorni = iGiorni >= 0 ? parseInt(args[iGiorni + 1], 10) : 30;
  if (!(giorni > 0)) throw new Error('--giorni deve essere un numero positivo');
  return aggiorna(giorni);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(code => process.exit(code)).catch(err => { console.error(err); process.exit(1); });
}
