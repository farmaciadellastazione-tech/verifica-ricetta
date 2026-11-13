import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { FILE_CON_BUILD } from '../tools/bump-build.mjs';

// Bug 13/11/2026: bump-build aggiornava anche banca-dati.html ma il workflow
// committava solo fofi-db.js, sw.js e index.html → build disallineate su dev/main.
describe('workflow FOFI — il commit automatico include tutti i file toccati dal bump', () => {
  const wf = readFileSync(new URL('../.github/workflows/fofi-update.yml', import.meta.url), 'utf8');
  const riga = wf.split('\n').find(l => /^\s*git add /.test(l)) || '';

  it('git add contiene fofi-db.js, sw.js e ogni pagina con la build', () => {
    for (const f of ['fofi-db.js', 'sw.js', ...FILE_CON_BUILD]) {
      expect(riga.split(/\s+/)).toContain(f);
    }
  });
});
