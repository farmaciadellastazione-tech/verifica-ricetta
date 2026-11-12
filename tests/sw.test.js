import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Installazione del service worker: i file vanno scaricati dalla rete, non presi
// dalla cache HTTP del browser (GitHub Pages: max-age=600). Altrimenti una
// pagina nuova può finire in cache con un fofi-match.js vecchio di 10 minuti.
const SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../sw.js'), 'utf8');

function installa() {
  const listeners = {};
  const richieste = [];
  class FakeRequest { constructor(url, init = {}) { this.url = url; this.cache = init.cache ?? 'default'; } }
  const ctx = {
    Request: FakeRequest,
    URL,
    self: { addEventListener: (t, fn) => { listeners[t] = fn; }, skipWaiting: () => {}, location: { origin: 'https://x' } },
    caches: { open: async () => ({ addAll: async reqs => { richieste.push(...reqs); } }) },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC + ';globalThis.__ASSETS = ASSETS;', ctx);
  let attesa;
  listeners.install({ waitUntil: p => { attesa = p; } });
  return attesa.then(() => ({ richieste, assets: ctx.__ASSETS }));
}

describe('sw.js — install', () => {
  it('scarica tutti gli ASSETS bypassando la cache HTTP (cache: reload)', async () => {
    const { richieste, assets } = await installa();
    expect(richieste.map(r => (typeof r === 'string' ? r : r.url))).toEqual(assets);
    for (const r of richieste) {
      expect(typeof r).not.toBe('string');
      expect(r.cache).toBe('reload');
    }
  });

  it('fofi-match.js e fofi-db.js sono tra gli asset in cache', async () => {
    const { assets } = await installa();
    expect(assets).toEqual(expect.arrayContaining(['./fofi-match.js', './fofi-db.js', './index.html']));
  });
});
