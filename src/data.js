// Reading a Tally / C.Scale results export (CSV or XLSX) into per-type carbon
// records keyed by Revit Category + Family + Type.
//
// The exact column layout of Tally 2.0 exports isn't documented publicly, so
// columns are detected by name. Two layouts are supported:
//   wide - one GWP column per life-cycle stage ("GWP A1-A3 ...", "GWP A4 ...")
//   long - one "Life Cycle Stage" column plus a single GWP value column
// Optional: Material (layer breakdown), Biogenic carbon, Mass, Element ID
// (if the export is per element instead of per type).

import { isCScaleGrid, parseCScale } from './cscale.js';

const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs';

export const norm = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[‐-―−]/g, '-') // en/em dashes -> hyphen
  .replace(/[×]/g, 'x')
  .replace(/\s+/g, ' ')
  .replace(/\s*([:\-x+/])\s*/g, '$1')
  .trim();

export const typeKey = (category, family, type) => `${norm(category)}|${norm(family)}|${norm(type)}`;

// ---------------------------------------------------------------- parsing

export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const delim = sniffDelimiter(text);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function sniffDelimiter(text) {
  const sample = text.slice(0, 5000);
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const c of sample) if (c in counts) counts[c]++;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

export async function readTableFile(file) {
  const name = file.name.toLowerCase();
  if (/\.(xlsx|xlsm|xls)$/.test(name)) {
    const XLSX = await import(XLSX_URL);
    const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
    const grids = wb.SheetNames.map((sn) => ({ sn, grid: XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '', raw: true }) }));
    const cs = cscaleFromGrids(grids);
    if (cs) return cs;
    // Pick the sheet whose detected header looks most like a results table.
    let best = null;
    for (const sn of wb.SheetNames) {
      const grid = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '', raw: true });
      const t = gridToTable(grid);
      if (t && (!best || t.score > best.score)) best = { ...t, sheet: sn };
    }
    if (!best) throw new Error('No sheet with Category / Family / Type columns found.');
    return best;
  }
  return tableFromText(await file.text());
}

export function tableFromText(text) {
  const grid = parseCSV(text);
  const t = cscaleFromGrids([{ sn: '', grid }]) || gridToTable(grid);
  if (!t) throw new Error('Could not find a header row with Type and GWP columns.');
  return t;
}

const isCategoryByStage = (grid) => grid.slice(0, 20).some((row) => {
  const r = row.map((c) => String(c).trim());
  return r.some((c) => /^scenario$/i.test(c)) && r.some((c) => /^category$/i.test(c)) && r.some((c) => /^A1/.test(c));
});

// A C.Scale project-data export: takeoffs by building subsection and/or category by stage.
function cscaleFromGrids(grids) {
  const take = grids.find((g) => isCScaleGrid(g.grid));
  const cats = grids.find((g) => /category by stage/i.test(g.sn) && isCategoryByStage(g.grid)) || grids.find((g) => isCategoryByStage(g.grid));
  if (!take && !cats) return null;
  const { sets, notes } = parseCScale({ takeoffs: take?.grid, categories: cats?.grid });
  if (!sets.size) return null;
  return { cscale: true, sets, notes, headers: [], rows: [], mapping: null, sheets: [take?.sn, cats?.sn].filter(Boolean) };
}

/** Results per scenario: Map<scenario name, data>. Exports without scenarios get one entry. */
export function buildDataSets(table) {
  if (table.cscale) return table.sets;
  const m = table.mapping;
  if (!m.scenario) return new Map([['', buildCarbonData(table)]]);
  const by = new Map();
  for (const row of table.rows) {
    const s = String(row[m.scenario] ?? '').trim() || '(no scenario)';
    if (!by.has(s)) by.set(s, []);
    by.get(s).push(row);
  }
  return new Map([...by].map(([s, rows]) => [s, buildCarbonData({ ...table, rows })]));
}

// Find the header row (exports often start with title lines) and return rows as objects.
function gridToTable(grid) {
  let best = null;
  for (let r = 0; r < Math.min(grid.length, 40); r++) {
    const headers = grid[r].map((h) => String(h ?? '').trim());
    const m = detectColumns(headers);
    const score = (m.type || m.familyType ? 3 : 0) + (m.family ? 1 : 0) + (m.category ? 1 : 0)
      + (m.gwp.length ? 3 : 0) + (m.elementId ? 1 : 0);
    if (score >= 5 && (!best || score > best.score)) best = { r, headers, mapping: m, score };
  }
  if (!best) return null;
  const rows = grid.slice(best.r + 1)
    .filter((row) => row.some((v) => String(v ?? '').trim() !== ''))
    .map((row) => Object.fromEntries(best.headers.map((h, i) => [h, row[i]])));
  return { headers: best.headers, rows, mapping: best.mapping, score: best.score };
}

// ---------------------------------------------------------------- columns

const STAGE_PATTERNS = [
  [/a1\s*-?\s*(to|-|–)?\s*a?3|\bproduct\b|manufactur/, 'A1-A3'],
  [/\ba4\b|transport/, 'A4'],
  [/\ba5\b|construction|installation/, 'A5'],
  [/\bb1\b|\buse\b/, 'B1'],
  [/\bb2\s*-?\s*(to|-)?\s*b?5\b|maintenance|replacement|refurb|repair/, 'B2-B5'],
  [/\bb6\b|operational energy/, 'B6'],
  [/\bc1\s*-?\s*(to|-)?\s*c?4\b|\bc2\s*-?\s*(to|-)?\s*c?4\b|end of life|eol|disposal|demolition/, 'C1-C4'],
  [/module d|\bd\b|beyond|benefits/, 'D'],
];

export function stageFromText(s) {
  const t = String(s).toLowerCase();
  for (const [re, label] of STAGE_PATTERNS) if (re.test(t)) {
    // Keep the export's own label where it's a standard module code ("C2-C4").
    const m = t.match(/\b([abcd]\d?\s*-\s*[abcd]?\d)\b/);
    return m ? m[1].toUpperCase().replace(/\s/g, '') : label;
  }
  return null;
}

export function detectColumns(headers) {
  const m = { category: null, family: null, type: null, familyType: null, elementId: null,
    material: null, mass: null, biogenic: null, stageCol: null, system: null, scenario: null, gwp: [], total: null };
  const H = headers.map((h) => ({ h, n: h.toLowerCase().replace(/[_]/g, ' ').replace(/\s+/g, ' ').trim() }));
  const pick = (pred) => H.find(({ n }) => n && pred(n))?.h ?? null;

  m.familyType = pick((n) => /family\s*(and|&|\/|\+)?\s*type/.test(n));
  m.category = pick((n) => /\bcategory\b/.test(n) && !/material/.test(n));
  m.family = pick((n) => /\bfamily\b/.test(n) && !/type/.test(n));
  m.type = pick((n) => /^(revit )?type( name)?$/.test(n))
    ?? pick((n) => /\btype\b/.test(n) && !/family|material|stage|entry|element|unit|id\b/.test(n));
  m.elementId = pick((n) => /element\s*id|elementid|revit id|^id$|unique id/.test(n));
  m.material = pick((n) => /material name|tally entry|^material$/.test(n))
    ?? pick((n) => /material|product name|layer/.test(n) && !/group|category|type/.test(n));
  m.mass = pick((n) => /\bmass\b|weight/.test(n));
  m.scenario = pick((n) => /^scenario( name)?$|design option|^option$/.test(n));
  m.system = pick((n) => /building system|^system$|building element|element group|^division$/.test(n));
  m.biogenic = pick((n) => /biogenic/.test(n));
  m.stageCol = pick((n) => /life\s*-?\s*cycle stage|lifecycle stage|^stage$|^module$|^phase$/.test(n));

  const isGwp = (n) => /gwp|global warming|co2|carbon/.test(n) && !/biogenic|per |\/m|intensity|%/.test(n);
  for (const { h, n } of H) {
    if (!n || !isGwp(n)) continue;
    const stage = stageFromText(n.replace(/gwp|global warming( potential)?|kg\s*co2\s*e?q?|co2e?/g, ''));
    if (stage) m.gwp.push({ col: h, stage });
    else if (/total|net|sum/.test(n) || !m.total) m.total = h;
  }
  if (!m.gwp.length && m.total) m.gwp.push({ col: m.total, stage: m.stageCol ? null : 'Total' });
  return m;
}

export function num(v) {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').trim();
  if (!s || s === '-') return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[^0-9eE.,+-]/g, '');
  if (/,\d{1,2}$/.test(s) && !/\./.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,5
  else s = s.replace(/,/g, '');
  const x = parseFloat(s);
  return Number.isFinite(x) ? (neg ? -x : x) : 0;
}

// ---------------------------------------------------------------- aggregation

/**
 * @returns {{types: Map<string, TypeRec>, elements: Map<string, TypeRec>, stages: string[],
 *            hasBiogenic: boolean, perElement: boolean, warnings: string[]}}
 * TypeRec: {key, category, family, type, materials: Map<name, {stages:{}, biogenic, mass}>}
 */
export function buildCarbonData(table) {
  const m = table.mapping;
  const warnings = [];
  const types = new Map();
  const elements = new Map();
  const stages = new Set();
  let hasBiogenic = false;

  for (const row of table.rows) {
    let category = m.category ? row[m.category] : '';
    let family = m.family ? row[m.family] : '';
    let type = m.type ? row[m.type] : '';
    if (m.familyType && (!type || !family)) {
      const ft = String(row[m.familyType] ?? '');
      const i = ft.indexOf(':');
      if (i >= 0) { family = family || ft.slice(0, i); type = type || ft.slice(i + 1); }
      else type = type || ft;
    }
    category = String(category ?? '').trim();
    family = String(family ?? '').trim();
    type = String(type ?? '').trim();
    const eid = m.elementId ? String(row[m.elementId] ?? '').trim() : '';
    if (!type && !eid) continue;
    if (/^(grand )?total$|^sum$|^subtotal$/i.test(type) || /^total$/i.test(category)) continue;

    const key = eid ? `id:${eid}` : typeKey(category, family, type);
    const target = eid ? elements : types;
    if (!target.has(key)) target.set(key, { key, category, family, type, elementId: eid || null, materials: new Map() });
    const rec = target.get(key);
    if (m.system && !rec.system && row[m.system]) rec.system = String(row[m.system]).trim();
    const matName = String((m.material && row[m.material]) || 'Assembly').trim() || 'Assembly';
    if (!rec.materials.has(matName)) rec.materials.set(matName, { stages: {}, biogenic: 0, mass: 0 });
    const mat = rec.materials.get(matName);

    for (const g of m.gwp) {
      const stage = g.stage ?? (m.stageCol ? stageFromText(row[m.stageCol]) || String(row[m.stageCol] || 'Total').trim() : 'Total');
      const v = num(row[g.col]);
      if (/biogenic/i.test(stage)) { mat.biogenic += v; hasBiogenic = true; continue; }
      stages.add(stage);
      mat.stages[stage] = (mat.stages[stage] || 0) + v;
    }
    if (m.biogenic) {
      let b = num(row[m.biogenic]);
      // Storage is a removal: if the export reports it as a positive quantity, flip it.
      if (b > 0 && /storage|stored|sequest/i.test(m.biogenic)) b = -b;
      mat.biogenic += b;
      if (b) hasBiogenic = true;
    }
    if (m.mass) mat.mass += num(row[m.mass]);
  }

  if (!types.size && !elements.size) warnings.push('No rows with a Type or Element ID were found.');
  const order = ['A1-A3', 'A4', 'A5', 'B1', 'B2-B5', 'B6', 'C1-C4', 'C2-C4', 'D', 'Total'];
  const rank = (s) => { const i = order.indexOf(s); return i < 0 ? 50 : i; };
  const stageList = [...stages].sort((a, b) => rank(a) - rank(b));
  return { types, elements, stages: stageList, hasBiogenic, perElement: elements.size > 0, warnings, mapping: m };
}

/** Net kgCO2e of a record for the chosen stages, plus its per-material breakdown. */
export function evalRecord(rec, selectedStages, includeBiogenic) {
  let net = 0, emissions = 0, biogenic = 0;
  const mats = [];
  for (const [name, mat] of rec.materials) {
    let v = 0;
    for (const s of selectedStages) v += mat.stages[s] || 0;
    const b = includeBiogenic ? mat.biogenic : 0;
    emissions += v;
    biogenic += b;
    net += v + b;
    mats.push({ name, value: v + b, emissions: v, biogenic: b, mass: mat.mass });
  }
  mats.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return { net, emissions, biogenic, materials: mats };
}
