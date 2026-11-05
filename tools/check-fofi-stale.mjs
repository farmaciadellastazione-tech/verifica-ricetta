#!/usr/bin/env node
// check-fofi-stale.mjs — fa fallire il workflow se la banca dati FOFI non riceve
// segnalazioni da troppo tempo: di solito significa che è cambiato il formato
// delle mail (es. 3/11/2026: stop all'Excel) e l'automazione non trova più nulla.
// Un fallimento visibile (mail di GitHub) invece di un'uscita silenziosa.
//
// Uso: node tools/check-fofi-stale.mjs [giorni]   (default 21)

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { giorniDa } = require(resolve(ROOT, 'fofi-avvisi.js'));

const soglia = parseInt(process.argv[2] || '21', 10);
const m = readFileSync(resolve(ROOT, 'fofi-db.js'), 'utf8').match(/FOFI_DB_AGGIORNATA\s*=\s*"([^"]*)"/);
const data = m ? m[1] : '';
const giorni = giorniDa(data, new Date());

if (giorni > soglia) {
  console.log(`::error::Banca dati FOFI ferma da ${giorni} giorni (ultimo aggiornamento ${data || 'sconosciuto'}). ` +
    'Controllare se è cambiato il formato delle mail dell\'Ordine/Federfarma.');
  process.exit(1);
}
console.log(`Banca dati FOFI aggiornata ${giorni} giorni fa (${data}): ok (soglia ${soglia}).`);
