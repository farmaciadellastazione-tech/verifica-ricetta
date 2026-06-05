#!/usr/bin/env node
// bump-build.mjs — incrementa la versione e invalida la cache PWA in modo coerente.
//
// Tiene allineati i due marcatori (vedi CLAUDE.md → Versioning):
//   • index.html : APP_BUILD (intero) + APP_BUILD_DATE ('DD/MM/YYYY')
//   • sw.js      : CACHE_NAME = 'verifica-ricetta-build<N>'
// Il nuovo numero = APP_BUILD attuale + 1; CACHE_NAME viene allineato a quel numero.
//
// Uso: node tools/bump-build.mjs [--date DD/MM/YYYY]
// Le funzioni pure sono esportate e testate in tests/bump-build.test.js.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export function currentAppBuild(indexText) {
  const m = indexText.match(/const APP_BUILD = (\d+);/);
  if (!m) throw new Error('APP_BUILD non trovato in index.html');
  return parseInt(m[1], 10);
}

export function setAppBuild(indexText, n, dateStr) {
  if (!/const APP_BUILD = \d+;/.test(indexText)) throw new Error('APP_BUILD non trovato in index.html');
  if (!/const APP_BUILD_DATE = '[^']*';/.test(indexText)) throw new Error('APP_BUILD_DATE non trovato in index.html');
  return indexText
    .replace(/const APP_BUILD = \d+;/, `const APP_BUILD = ${n};`)
    .replace(/const APP_BUILD_DATE = '[^']*';/, `const APP_BUILD_DATE = '${dateStr}';`);
}

export function setCacheName(swText, n) {
  if (!/const CACHE_NAME = 'verifica-ricetta-build\d+';/.test(swText)) {
    throw new Error('CACHE_NAME non trovato in sw.js');
  }
  return swText.replace(/const CACHE_NAME = 'verifica-ricetta-build\d+';/,
    `const CACHE_NAME = 'verifica-ricetta-build${n}';`);
}

export function formatDateIt(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dateArg = (() => { const i = process.argv.indexOf('--date'); return i >= 0 ? process.argv[i + 1] : null; })();
  const indexPath = resolve(root, 'index.html');
  const swPath = resolve(root, 'sw.js');

  const indexText = readFileSync(indexPath, 'utf8');
  const swText = readFileSync(swPath, 'utf8');
  const current = currentAppBuild(indexText);
  const next = current + 1;
  const date = dateArg || formatDateIt(new Date());

  writeFileSync(indexPath, setAppBuild(indexText, next, date));
  writeFileSync(swPath, setCacheName(swText, next));
  console.log(`Build ${current} -> ${next} (${date}); CACHE_NAME -> verifica-ricetta-build${next}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
