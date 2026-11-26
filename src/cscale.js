// C.Scale project-data exports (WLCA workbook).
//
// These are not per Revit type. Results are grouped by C.Scale "Building
// Subsection" (e.g. "Enclosure > Exterior Walls"), per scenario:
//   "Takeoffs ..."      - one row per material: Scenario, Building Subsection,
//                         Assembly / Material Group, Material Name, Quantity,
//                         Unit, Total Emissions (kgCO2e, all life-cycle stages)
//   "Category by Stage" - per Scenario x Category (Structure, Enclosure, ...):
//                         tCO2e by stage, plus one "Stored Carbon" row
// Takeoffs carry no stage split, so each material's total is split across
// stages in the same proportions as its category in "Category by Stage".
// Stored carbon is only given per scenario; it is spread across bio-based
// materials by volume.
import { norm, num } from './data.js';

const OPERATIONAL = /electric|fossil|energy|operational/i;
const BIO = /timber|lumber|plywood|\bwood|\bclt\b|\bglt\b|glulam|\blvl\b|\bosb\b|bamboo|straw|hemp|cork|cellulose|mass timber/i;
const TO_M3 = { cy: 0.764555, yd3: 0.764555, 'yd³': 0.764555, m3: 1, 'm³': 1, ft3: 0.0283168, 'ft³': 0.0283168, cf: 0.0283168, bf: 0.00235974 };

const findHeader = (grid, res) => grid.findIndex((row) => res.every((re) => row.some((c) => re.test(String(c).trim()))));
const col = (H, re) => H.findIndex((h) => re.test(String(h).trim()));

export function isCScaleGrid(grid) {
  return findHeader(grid.slice(0, 20), [/^scenario$/i, /building subsection/i, /total emissions/i]) >= 0;
}

/** sheets: {takeoffs?: grid, categories?: grid} -> {sets: Map<scenario, data>, notes} */
export function parseCScale({ takeoffs, categories }) {
  const notes = [];
  const order = [];
  const seen = (s) => { if (s && !order.includes(s)) order.push(s); };

  // ---- Category by Stage: stage shares per scenario + category, stored carbon, extra categories
  const catRows = new Map(); // scenario -> [{cat, stages}]
  const stored = new Map();
  let stageLabels = [];
  if (categories) {
    const hi = findHeader(categories, [/^scenario$/i, /^category$/i]);
    if (hi >= 0) {
      const H = categories[hi].map((h) => String(h));
      const iS = col(H, /^scenario$/i), iC = col(H, /^category$/i), iSt = col(H, /stored carbon/i);
      const k = H.some((h) => /tCO/i.test(h)) ? 1000 : 1;
      const stageCols = H.map((h, i) => ({ h: h.trim(), i }))
        .filter(({ h }) => /^[ABCD]\d/.test(h))
        .map(({ h, i }) => ({ i, label: h.replace(/\s*\(.*$/, '').replace(/[‐-―−]/g, '-').trim() }));
      stageLabels = stageCols.map((s) => s.label);
      for (const row of categories.slice(hi + 1)) {
        const scen = String(row[iS] ?? '').trim(), cat = String(row[iC] ?? '').trim();
        if (!scen || !cat) continue;
        seen(scen);
        if (/stored carbon/i.test(cat)) {
          let v = num(row[iSt]) * k;
          if (v > 0) v = -v;
          stored.set(scen, (stored.get(scen) || 0) + v);
          continue;
        }
        if (OPERATIONAL.test(cat)) continue;
        const stages = {};
        for (const s of stageCols) stages[s.label] = num(row[s.i]) * k;
        if (!catRows.has(scen)) catRows.set(scen, []);
        catRows.get(scen).push({ cat, stages });
      }
      notes.push('Operational energy (electricity, fossil fuel) is left out: this viewer shows embodied carbon.');
    }
  }

  // ---- Takeoffs: one row per material
  const takeRows = new Map();
  if (takeoffs) {
    const hi = findHeader(takeoffs, [/^scenario$/i, /building subsection/i]);
    if (hi >= 0) {
      const H = takeoffs[hi].map((h) => String(h));
      const c = {
        scen: col(H, /^scenario$/i), sub: col(H, /building subsection/i), asm: col(H, /assembly/i),
        mat: col(H, /^material name$/i), qty: col(H, /^quantity$/i), unit: col(H, /^unit$/i), total: col(H, /total emissions/i),
      };
      for (const row of takeoffs.slice(hi + 1)) {
        const scen = String(row[c.scen] ?? '').trim(), sub = String(row[c.sub] ?? '').trim();
        if (!scen || !sub) continue;
        seen(scen);
        if (!takeRows.has(scen)) takeRows.set(scen, []);
        takeRows.get(scen).push({
          sub, asm: c.asm >= 0 ? String(row[c.asm] ?? '').trim() : '', mat: String(row[c.mat] ?? 'Material').trim(),
          qty: num(row[c.qty]), unit: String(row[c.unit] ?? '').trim().toLowerCase(), total: num(row[c.total]),
        });
      }
    }
  }

  const sets = new Map();
  for (const scen of order) {
    const types = new Map();
    const cats = catRows.get(scen) || [];
    const share = new Map(); // system (lowercase) -> {stage: fraction}
    for (const { cat, stages } of cats) {
      const tot = Object.values(stages).reduce((a, b) => a + b, 0);
      if (tot) share.set(cat.toLowerCase(), Object.fromEntries(Object.entries(stages).map(([s, v]) => [s, v / tot])));
    }
    const rows = takeRows.get(scen);
    const covered = new Set();
    const bio = [];

    if (rows?.length) {
      for (const r of rows) {
        const [sysRaw, ...rest] = r.sub.split('>');
        const system = sysRaw.trim();
        const label = rest.length ? rest.join('>').trim() : system;
        covered.add(system.toLowerCase());
        const key = `sub:${norm(r.sub)}`;
        if (!types.has(key)) types.set(key, { key, kind: 'subsection', category: system, family: '', type: label, system, subsection: r.sub, assemblies: new Set(), materials: new Map() });
        const rec = types.get(key);
        if (r.asm) rec.assemblies.add(r.asm);
        if (!rec.materials.has(r.mat)) rec.materials.set(r.mat, { stages: {}, biogenic: 0, mass: 0 });
        const mat = rec.materials.get(r.mat);
        const sh = share.get(system.toLowerCase());
        if (sh) for (const [s, f] of Object.entries(sh)) mat.stages[s] = (mat.stages[s] || 0) + r.total * f;
        else mat.stages.Total = (mat.stages.Total || 0) + r.total;
        if (BIO.test(r.mat)) bio.push({ mat, m3: TO_M3[r.unit] ? r.qty * TO_M3[r.unit] : 0, total: r.total });
      }
      for (const rec of types.values()) rec.family = [...rec.assemblies].join(' / ');
    } else {
      // No takeoffs for this scenario: one record per category (Structure, Enclosure, ...).
      for (const { cat, stages } of cats) {
        if (/construction|demolition|refrigerant/i.test(cat)) continue;
        covered.add(cat.toLowerCase());
        types.set(`sys:${norm(cat)}`, { key: `sys:${norm(cat)}`, kind: 'system', category: cat, family: '', type: cat, system: cat,
          materials: new Map([['All materials', { stages: { ...stages }, biogenic: 0, mass: 0 }]]) });
      }
      if (cats.length) notes.push(`"${scen}" has no takeoffs, so it is matched by category only.`);
    }

    // Project-level categories with no elements (construction activities, demolition, refrigerants).
    for (const { cat, stages } of cats) {
      if (covered.has(cat.toLowerCase())) continue;
      const key = `proj:${norm(cat)}`;
      types.set(key, { key, kind: 'project', category: 'Project', family: '', type: cat, system: 'Other',
        materials: new Map([[cat, { stages: { ...stages }, biogenic: 0, mass: 0 }]]) });
    }

    // Stored carbon: spread across bio-based materials by volume (or by emissions if no volumes).
    const st = stored.get(scen) || 0;
    if (st) {
      const vol = bio.reduce((a, b) => a + b.m3, 0);
      const em = bio.reduce((a, b) => a + b.total, 0);
      if (bio.length && (vol > 0 || em > 0)) {
        for (const b of bio) b.mat.biogenic += st * (vol > 0 ? b.m3 / vol : b.total / em);
      } else {
        types.set('proj:stored', { key: 'proj:stored', kind: 'project', category: 'Project', family: '', type: 'Stored carbon (not itemized)', system: 'Other',
          materials: new Map([['Stored carbon', { stages: {}, biogenic: st, mass: 0 }]]) });
      }
    }

    sets.set(scen, {
      types, elements: new Map(), perElement: false, warnings: [], mapping: null,
      stages: stageLabels.length ? stageLabels : ['Total'], hasBiogenic: stored.size > 0,
    });
  }
  if (stageLabels.length && takeRows.size) notes.push('Stage split for each material follows its category totals in "Category by Stage".');
  if (stored.size) notes.push('Stored carbon is spread across wood-based materials by volume.');
  return { sets, notes };
}
