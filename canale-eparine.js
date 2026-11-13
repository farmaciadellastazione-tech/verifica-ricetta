// canale-eparine.js — canale di erogazione dell'enoxaparina (DPC o convenzionata).
//
// Fonti: circ. Federfarma Liguria FF.Lig 0100 del 23/10/2026 (allegata la nota
// Regione Liguria Prot-2026-0524156 del 21/10/2026) e FF.Lig 0105 del 13/11/2026.
//   • Ricette SSN redatte fino al 15/11/2026 → DPC, entro i 30 gg di validità.
//   • Dal 16/11/2026: sigla "DPC" nel campo note (indicazione A-PHT, profilassi
//     TVP in chirurgia generale/ortopedica) → DPC; campo note vuoto → convenzionata.
//   • Biosimilari: il marchio prescritto non si sostituisce; con il solo principio
//     attivo il farmacista può fornire un analogo.
// Riguarda SOLO l'enoxaparina: le altre EBPM non sono citate dalle circolari.
//
// Logica pura, come fofi-match.js: caricata da index.html via <script src> e dai
// test vitest via import. La decisione la prende questo codice, non Gemini.

const DATA_NUOVE_REGOLE = 20261116; // yyyymmdd: dal 16/11/2026 conta la sigla DPC

// Marchi citati dalla circolare 0100 ("Rovi" compare come "Enoxaparina Rovi").
const MARCHI_ENOXAPARINA = ['inhixa', 'clexane', 'ghemaxan', 'rovinadil', 'rovi'];

function _parole(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean);
}

function _haMarchio(farmaco) {
  return _parole(farmaco).some(w => MARCHI_ENOXAPARINA.includes(w));
}

function isEnoxaparina(farmaco) {
  const w = _parole(farmaco);
  return w.some(x => x.startsWith('enoxaparin')) || _haMarchio(farmaco);
}

// 'yyyy-mm-dd' (campo data del modulo) oppure 'dd/mm/yyyy', 'dd-mm-yy', 'dd.mm.yyyy'
// (letta dalla foto) → numero yyyymmdd; null se assente o non valida.
function parseDataRicetta(s) {
  const t = String(s || '').trim();
  let y, m, d, r;
  if ((r = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [y, m, d] = [+r[1], +r[2], +r[3]];
  else if ((r = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/))) {
    [d, m, y] = [+r[1], +r[2], +r[3]];
    if (y < 100) y += 2000;
  } else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // es. 31/11
  return y * 10000 + m * 100 + d;
}

// farmaci: nomi letti dalla foto e/o digitati; tipo: tipoSelezionato;
// data: data di redazione; siglaDpc: 'presente' | 'assente' (campo note visibile
// e senza sigla) | 'non_visibile'. Restituisce null se il riquadro non serve.
function canaleEnoxaparina({ farmaci, tipo, data, siglaDpc } = {}) {
  const enox = (Array.isArray(farmaci) ? farmaci : [farmaci]).filter(isEnoxaparina);
  if (!enox.length || tipo !== 'ssn') return null;

  const sostituzione = enox.some(_haMarchio)
    ? 'Marchio prescritto non sostituibile: è un biosimilare.'
    : 'Prescritto il solo principio attivo: il farmacista può fornire un medicinale analogo (stesso dosaggio, forma e unità posologiche).';

  const giorno = parseDataRicetta(data);
  let canale, motivo;
  if (giorno === null) {
    canale = 'DA_VERIFICARE';
    motivo = 'Data di redazione non leggibile: controllala. Fino al 15/11/2026 → DPC; dal 16/11/2026 decide la sigla "DPC" nel campo note.';
  } else if (giorno < DATA_NUOVE_REGOLE) {
    canale = 'DPC';
    motivo = 'Ricetta redatta fino al 15/11/2026: si eroga in DPC (entro i 30 giorni di validità), con o senza sigla.';
  } else if (siglaDpc === 'presente') {
    canale = 'DPC';
    motivo = 'Sigla "DPC" nel campo note (profilassi TVP in chirurgia generale/ortopedica, A-PHT): ordine su GopenDPC.';
  } else if (siglaDpc === 'assente') {
    canale = 'CONVENZIONATA';
    motivo = 'Campo note senza sigla "DPC": canale convenzionato, farmaco dal grossista e ticket regionale.';
  } else {
    canale = 'DA_VERIFICARE';
    motivo = 'Campo note non visibile nella foto: controlla la ricetta a video. Sigla "DPC" → DPC; campo note vuoto → convenzionata.';
  }
  return { canale, motivo, sostituzione };
}

// ── Export per browser + Node ────────────────────────────────────────────

const _exportsEparine = { canaleEnoxaparina, isEnoxaparina, parseDataRicetta };
Object.assign(globalThis, _exportsEparine);
if (typeof module !== 'undefined' && module.exports) module.exports = _exportsEparine;
