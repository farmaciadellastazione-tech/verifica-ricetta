import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Le regole di prescrizione cambiano il prompt: la PR la rivede il farmacista.
describe('workflow regole — revisione umana obbligatoria', () => {
  const wf = readFileSync(new URL('../.github/workflows/regole-update.yml', import.meta.url), 'utf8');

  it('nessun merge automatico (né della PR né dei branch)', () => {
    expect(wf).not.toMatch(/\/merge\b/);
    expect(wf).not.toMatch(/\/merges\b/);
    expect(wf).not.toMatch(/gh pr merge/);
  });

  it('la PR tocca solo regole-prescrizione.js (niente conflitti con i bump della pipeline FOFI)', () => {
    const add = wf.split('\n').filter(l => /^\s*git add /.test(l));
    expect(add).toEqual([expect.stringMatching(/git add regole-prescrizione\.js\s*$/)]);
  });

  it('il bump dopo il merge committa tutti i file toccati da bump-build', () => {
    expect(wf).toMatch(/node tools\/bump-build\.mjs\s+git commit -qam/);
  });
});
