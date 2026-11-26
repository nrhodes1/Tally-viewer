import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadDemoModel, loadIfcModel } from './model.js';
import {
  readTableFile, tableFromText, buildDataSets, evalRecord, detectColumns, norm, typeKey,
} from './data.js';
import { mergeMaterials } from './cscale.js';
import { divergingColor, cssColor, gradientCSS, percentile } from './color.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ state
const state = {
  model: null,            // {elements, name}
  table: null,            // parsed table {headers, rows, mapping}
  sets: null,             // Map<scenario, results>
  scenario: '',
  data: null,             // results for the selected scenario
  dataName: '',
  modelFile: null,        // {name, at: Date, demo}
  dataFile: null,
  metric: 'absolute',     // absolute | area | volume
  stages: new Set(),
  biogenic: true,
  clip: 95,
  shared: false,
  cut: 1,                 // section-cut height as a fraction of model height (1 = off)
  isolate: null,          // {kind: 'type' | 'system', key}
  hovered: null,
  pinned: null,
  groups: new Map(),      // key -> {key, rec, els, volume, area, ev, value per metric}
  totals: null,
  scale: { neg: 1, pos: 1 },
};

// ------------------------------------------------------------------ three.js
const canvas = $('#viewport');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a80, 1.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.3);
sun.position.set(0.6, 1, 0.35);
scene.add(sun);
renderer.localClippingEnabled = true;
const cutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e9);
const modelRoot = new THREE.Group();
scene.add(modelRoot);

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  return { bg: cs.getPropertyValue('--viewport').trim(), nodata: cs.getPropertyValue('--nodata').trim() };
}
function applyTheme() {
  const t = themeColors();
  scene.background = new THREE.Color(t.bg);
  NODATA.set(t.nodata);
  if (state.model) paint();
}
const NODATA = new THREE.Color('#c3c5c0');
const EDGE_MAT = new THREE.LineBasicMaterial({ color: 0x1d1f1c, transparent: true, opacity: 0.22, clippingPlanes: [cutPlane] });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement);

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

function frameModel() {
  const box = new THREE.Box3().setFromObject(modelRoot);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = size.length() / 2;
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.9 / Math.min(1, camera.aspect * 0.9);
  const dir = new THREE.Vector3(-0.75, 0.55, 1).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(0.05, dist / 500);
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function setModel(model) {
  for (const c of [...modelRoot.children]) {
    modelRoot.remove(c);
    c.geometry?.dispose();
    c.material?.dispose();
    c.children.forEach((e) => e.geometry?.dispose());
  }
  state.model = model;
  state.isolate = state.hovered = state.pinned = null;
  const withEdges = model.elements.length < 6000;
  model.elements.forEach((el, i) => {
    el.uid = i;
    if (withEdges) el.mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(el.mesh.geometry, 25), EDGE_MAT));
    modelRoot.add(el.mesh);
  });
  modelBox.setFromObject(modelRoot);
  state.cut = 1;
  $('#cutRange').value = 100;
  applyCut();
  frameModel();
}
const modelBox = new THREE.Box3();
function applyCut() {
  const h = modelBox.isEmpty() ? 1e9 : modelBox.min.y + (modelBox.max.y - modelBox.min.y) * state.cut + 1e-3;
  cutPlane.constant = state.cut >= 1 ? 1e9 : h;
  $('#cutVal').textContent = state.cut >= 1 ? 'off' : `${fmtNum(h - modelBox.min.y, 1)} m`;
  $('#cutSum').textContent = $('#cutVal').textContent;
}

// ------------------------------------------------------------------ data
function setTable(table, name) {
  state.table = table;
  state.dataName = name;
  state.sets = buildDataSets(table);
  const names = [...state.sets.keys()];
  if (!names.includes(state.scenario)) state.scenario = names[0];
  applyScenario(true);
}
function applyScenario(resetStages = false) {
  state.data = state.sets.get(state.scenario);
  const stages = state.data.stages;
  if (resetStages || ![...state.stages].every((s) => stages.includes(s)) || !state.stages.size) {
    state.stages = new Set(stages.filter((s) => !/^D/.test(s) || stages.length === 1));
    state.biogenic = state.data.hasBiogenic;
  }
  $('#bioToggle').checked = state.biogenic && state.data.hasBiogenic;
  $('#bioToggle').disabled = !state.data.hasBiogenic;
  if (state.isolate?.kind === 'type' && !state.data.types.has(state.isolate.key)) state.isolate = null;
}

// ------------------------------------------------------------------ matching + values
function match() {
  const { data, model } = state;
  for (const el of model.elements) { el.rec = null; el.matchedBy = null; }
  if (!data) return;
  const byFamType = new Map(), byType = new Map();
  for (const rec of data.types.values()) {
    if (rec.kind) continue; // C.Scale groups match by subsection, below
    const ft = `${norm(rec.family)}|${norm(rec.type)}`;
    (byFamType.get(ft) || byFamType.set(ft, []).get(ft)).push(rec);
    (byType.get(norm(rec.type)) || byType.set(norm(rec.type), []).get(norm(rec.type))).push(rec);
  }
  const subRecs = [...data.types.values()].filter((r) => r.kind === 'subsection');
  const sysRecs = [...data.types.values()].filter((r) => r.kind === 'system');
  for (const el of model.elements) {
    let rec = null, how = null;
    if (data.perElement && el.elementId) { rec = data.elements.get(`id:${el.elementId}`); how = 'Element ID'; }
    if (!rec && el.type) {
      rec = data.types.get(typeKey(el.category, el.family, el.type)); how = 'Category + Family + Type';
      if (!rec) {
        const c = byFamType.get(`${norm(el.family)}|${norm(el.type)}`);
        if (c?.length === 1) { rec = c[0]; how = 'Family + Type'; }
      }
      if (!rec) {
        const c = byType.get(norm(el.type));
        if (c?.length === 1) { rec = c[0]; how = 'Type name only'; }
      }
    }
    if (!rec && (subRecs.length || sysRecs.length)) {
      const sys = systemOf(el).toLowerCase();
      const cands = subRecs.filter((r) => r.system.toLowerCase() === sys);
      for (const re of subsectionHints(el, sys)) {
        rec = cands.find((r) => re.test(r.type.toLowerCase()));
        if (rec) { how = 'Building subsection'; break; }
      }
      if (!rec) { rec = sysRecs.find((r) => r.system.toLowerCase() === sys); how = 'Category'; }
    }
    if (rec) { el.rec = rec; el.matchedBy = how; }
  }
  splitByAssembly();
}

// ---- C.Scale assemblies -------------------------------------------------------
// A subsection can hold several assemblies (e.g. a rainscreen wall and a brick wall
// under Exterior Walls). Elements go to the assembly whose name and materials share
// the most keywords with their Revit family/type name. Elements with no keyword
// match take the assemblies nobody claimed; if every assembly was claimed, they join
// the one with the most matched elements.
const SYNONYMS = [
  [/\b(gwb|gyp\w*|drywall|sheetrock)\b/g, ' gypsum '], [/\bcmu\b|\bblock\b/g, ' masonry '], [/\bact\b|acoustic/g, ' act '],
  [/\bigu\b|glaz\w*|glass/g, ' glass '], [/cross.?lam\w*|\bclt\b/g, ' clt '], [/glu.?lam\w*|\bglt\b/g, ' glulam '],
  [/timber|lumber|softwood|plywood|\bwood\b/g, ' wood '], [/\bstuds?\b|framing|\bcfs\b/g, ' stud '], [/alumin\w*/g, ' aluminum '],
  [/fib(er|re).?cement|\bfcb\b/g, ' fibercement '], [/\blvt\b|vinyl/g, ' vinyl '], [/terraz+o/g, ' terrazzo '],
  [/mineral wool|rock.?wool/g, ' mineralwool '], [/\bmcm\b|\bacm\b|metal composite|composite metal/g, ' mcm '], [/curtain.?wall/g, ' curtainwall '],
];
const STOPWORDS = new Set(('wall walls interior exterior partition partitions floor floors roof roofs basic type generic finish system systems '
  + 'assembly with and the for new existing typ typical two one sides side both large small layer layers material materials').split(' '));
function keywords(text) {
  let s = ` ${String(text).toLowerCase()} `;
  for (const [re, r] of SYNONYMS) s = s.replace(re, r);
  return new Set(s.split(/[^a-z]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t)));
}
const FRAMING_MAT = /glue.?lam|glulam|\bglt\b|structural steel|hot.?rolled|hrsss|\blvl\b|\bpsl\b|beam|column/i;
const PANEL_MAT = /cross.?lam|\bclt\b|concrete|plywood|lumber|deck|\bosb\b|joist|\bnlt\b|\bdlt\b|topping/i;
function splitByAssembly() {
  const { data, model } = state;
  const parents = new Map();
  for (const el of model.elements) {
    if (el.rec?.kind === 'subsection' && el.rec.groups?.size > 1) {
      if (!parents.has(el.rec)) parents.set(el.rec, []);
      parents.get(el.rec).push(el);
    }
  }
  data._split = new Map(); // parent key -> leaf records
  const cache = data._derived || (data._derived = new Map());
  const leaf = (parent, name, mats) => {
    const key = `${parent.key}|asm:${norm(name)}`;
    if (!cache.has(key)) cache.set(key, { ...parent, key, family: name, parent: parent.key, groups: null, materials: mats, byMaterial: parent.byMaterial });
    return cache.get(key);
  };
  for (const [parent, els] of parents) {
    const groups = [...parent.groups.values()].map((g) => ({
      ...g, words: keywords(`${g.name} ${[...g.materials.keys()].join(' ')}`), els: [],
      kind: FRAMING_MAT.test(g.name) ? 'framing' : PANEL_MAT.test(g.name) ? 'panel' : '',
      size: [...g.materials.values()].reduce((a, m) => a + Math.abs(Object.values(m.stages).reduce((x, y) => x + y, 0)), 0),
    }));
    const rest = [];
    for (const el of els) {
      const words = keywords(`${el.family} ${el.type}`);
      const elKind = /column|framing|beam|truss|brace/i.test(el.category) ? 'framing' : /floor|slab|roof|deck/i.test(el.category) ? 'panel' : '';
      // Score: shared keywords count double; the material suiting the element's category adds one.
      // Ties go to the larger group.
      let best = null, bestScore = 0;
      for (const g of groups) {
        let score = 0;
        for (const w of words) if (g.words.has(w)) score += 2;
        if (parent.byMaterial && elKind && g.kind === elKind) score += 1;
        if (score > bestScore || (score && score === bestScore && g.size > best.size)) { best = g; bestScore = score; }
      }
      if (best) best.els.push(el); else rest.push(el);
    }
    const claimed = groups.filter((g) => g.els.length);
    if (!claimed.length) continue; // nothing to go on: keep the subsection whole
    const unclaimed = groups.filter((g) => !g.els.length);
    const leaves = [];
    for (const g of claimed) {
      const r = leaf(parent, g.name, g.materials);
      for (const el of g.els) { el.rec = r; el.matchedBy = parent.byMaterial ? 'Material' : 'Assembly'; }
      leaves.push(r);
    }
    if (unclaimed.length && rest.length) {
      const name = unclaimed.map((g) => g.name).join(' / ');
      const r = leaf(parent, name, mergeMaterials(unclaimed.map((g) => g.materials)));
      for (const el of rest) el.rec = r;
      leaves.push(r);
    } else {
      for (const g of unclaimed) leaves.push(leaf(parent, g.name, g.materials));
      const biggest = claimed.reduce((a, b) => (b.els.length > a.els.length ? b : a));
      for (const el of rest) el.rec = leaf(parent, biggest.name, biggest.materials);
    }
    data._split.set(parent.key, leaves);
  }
}

/** Result records after any assembly split: what elements can actually match. */
function leafRecords() {
  const { data } = state;
  if (!data) return [];
  const out = [];
  for (const r of [...data.types.values(), ...data.elements.values()]) {
    if (data._split?.has(r.key)) out.push(...data._split.get(r.key)); else out.push(r);
  }
  return out;
}

// C.Scale groups results by building subsection ("Enclosure > Exterior Walls"), not by Revit type.
// For each element, the subsection names to look for, most specific first.
function subsectionHints(el, sys) {
  const c = String(el.category || '').toLowerCase();
  const t = `${el.family} ${el.type}`.toLowerCase();
  if (sys === 'sitework') return [/hardscape|paving/, /landscape|planting/];
  if (/floor/.test(c) && sys === 'interiors') return [/flooring|floor finish/];
  if (/floor/.test(c) && sys === 'enclosure') return [/roof/];
  if (/foundation/.test(c)) return [/foundations?$/, /foundation/];
  if (/floor|slab/.test(c)) return /grade|\bsog\b/.test(t) ? [/on.?grade/, /slab/] : [/slabs?\/decks?|deck|suspended/, /floor|slab/];
  if (/column/.test(c)) return [/column/, /frame|framing/, /slabs?\/decks?|deck/];
  if (/framing|beam|truss/.test(c)) return [/beam|framing|frame/, /slabs?\/decks?|deck/];
  if (/roof/.test(c)) return [/roof/];
  if (/window|skylight/.test(c)) return [/window|glazing/, /curtain/];
  if (/curtain/.test(c)) return [/curtain/, /glazing|window/];
  if (/door/.test(c)) return sys === 'enclosure' ? [/exterior door|entrance/, /door/] : [/interior door/, /door/];
  if (/ceiling/.test(c)) return [/ceiling/];
  if (/stair/.test(c)) return [/stair/];
  if (/railing/.test(c)) return [/railing/];
  if (/casework|furniture|millwork/.test(c)) return [/casework|millwork|furni/];
  if (/wall/.test(c)) {
    if (sys === 'structure') return /foundation|basement|retaining/.test(t) ? [/foundation wall|retaining|basement/, /foundation/] : [/shear|core|structural wall|bearing wall/];
    if (sys === 'enclosure') return [/exterior wall|facade|cladding/, /wall/];
    return [/partition/, /interior wall/, /wall/];
  }
  return [];
}

function compute() {
  const { model } = state;
  const stages = [...state.stages];
  const groups = new Map();
  for (const el of model.elements) {
    if (!el.rec) continue;
    const k = el.rec.key;
    if (!groups.has(k)) groups.set(k, { key: k, rec: el.rec, els: [], volume: 0, area: 0 });
    const g = groups.get(k);
    g.els.push(el); g.volume += el.volume; g.area += el.area;
  }
  let net = 0, emissions = 0, storage = 0, matchedEls = 0;
  for (const g of groups.values()) {
    g.ev = evalRecord(g.rec, stages, state.biogenic);
    g.perArea = g.area > 1e-9 ? g.ev.net / g.area : 0;
    g.perVolume = g.volume > 1e-9 ? g.ev.net / g.volume : 0;
    net += g.ev.net;
    // Emissions = selected life-cycle stages; storage = biogenic carbon, kept separate.
    emissions += g.ev.emissions;
    storage += g.ev.biogenic;
    for (const el of g.els) {
      // C.Scale subsections quantified per ft²/m² are spread by face area; everything else by volume.
      const byArea = g.rec.basis === 'area' && g.area > 1e-9;
      const share = byArea ? el.area / g.area
        : g.volume > 1e-9 ? el.volume / g.volume : g.area > 1e-9 ? el.area / g.area : 1 / g.els.length;
      el.share = share;
      el.abs = g.ev.net * share;
      el.value = state.metric === 'absolute' ? el.abs : state.metric === 'area' ? g.perArea : g.perVolume;
      matchedEls++;
    }
  }
  // Results in the export that never matched the model still count toward its total.
  let unmatchedNet = 0, unmatchedTypes = 0;
  const src = leafRecords();
  for (const rec of src) if (!groups.has(rec.key)) { unmatchedNet += evalRecord(rec, stages, state.biogenic).net; unmatchedTypes++; }

  state.groups = groups;
  state.totals = { net, emissions, storage, matchedEls, unmatchedNet, unmatchedTypes, totalTypes: src.length };

  // Color scale: clip each side at the chosen percentile of the element values.
  const vals = model.elements.filter((e) => e.rec).map((e) => e.value);
  const pos = vals.filter((v) => v > 0).sort((a, b) => a - b);
  const neg = vals.filter((v) => v < 0).map((v) => -v).sort((a, b) => a - b);
  let pMax = percentile(pos, state.clip) || 1, nMax = percentile(neg, state.clip) || 1;
  if (state.shared) pMax = nMax = Math.max(pos.length ? pMax : 0, neg.length ? nMax : 0) || 1;
  state.scale = { pos: pMax, neg: nMax, hasPos: pos.length > 0, hasNeg: neg.length > 0 };
}

function tOf(v) { return v >= 0 ? v / state.scale.pos : v / state.scale.neg; }

// Building systems, as Tally reports group results (Structure / Enclosure / Interiors).
const SYSTEMS = ['Structure', 'Enclosure', 'Interiors', 'Services', 'Sitework', 'Other'];
function systemOf(rec) {
  if (rec.system) {
    const s = rec.system.toLowerCase();
    if (/struct|foundation|substructure|frame/.test(s)) return 'Structure';
    if (/enclos|envelope|facade|façade|exterior|roof/.test(s)) return 'Enclosure';
    if (/interior|finish|partition/.test(s)) return 'Interiors';
    return rec.system;
  }
  const c = String(rec.category || '').toLowerCase();
  const t = `${rec.family} ${rec.type}`.toLowerCase();
  // Site, finish and roof-terrace floors are modeled as Revit floors but aren't structure.
  if (/floor|wall/.test(c) && /\b(sidewalk|hardscape|landscape|lawn|paving|planter)\b/.test(t)) return 'Sitework';
  if (/floor/.test(c) && /\b(finish floor|laminate|carpet|tile|terrazz?o|vinyl|polished|flooring)\b/.test(t)) return 'Interiors';
  if (/floor/.test(c) && /\broof\s*-/.test(t)) return 'Enclosure';
  if (/structural|foundation|^floors?$|^columns?$|framing|rebar|truss|^beams?$|^slabs?$/.test(c)) return 'Structure';
  if (/curtain|window|roof|skylight|facade|fascia|soffit|gutter/.test(c)) return 'Enclosure';
  if (/wall/.test(c)) {
    if (/\b(ext|exterior|external|facade|façade|cladding|envelope|veneer|curtain|parapet)\b/.test(t)) return 'Enclosure';
    if (/\b(core|shear|structural|retaining|foundation|basement|load.?bearing)\b/.test(t)) return 'Structure';
    return 'Interiors';
  }
  if (/door/.test(c)) return /\b(ext|exterior|entrance|storefront)\b/.test(t) ? 'Enclosure' : 'Interiors';
  if (/ceiling|stair|railing|casework|furniture|finish|partition|specialty|millwork/.test(c)) return 'Interiors';
  return 'Other';
}
function inIsolation(el) {
  const iso = state.isolate;
  if (!iso) return true;
  if (!el.rec) return false;
  return iso.kind === 'type' ? el.rec.key === iso.key : systemOf(el.rec) === iso.key;
}

const tmpColor = new THREE.Color();
function paint() {
  for (const el of state.model.elements) {
    const m = el.mesh.material;
    const ghost = !inIsolation(el);
    if (el.rec) {
      const [r, g, b] = divergingColor(tOf(el.value));
      m.color.setRGB(r, g, b, THREE.SRGBColorSpace);
    } else m.color.copy(NODATA);
    m.transparent = ghost;
    m.opacity = ghost ? 0.07 : 1;
    m.depthWrite = !ghost;
    const hl = el === state.hovered || el === state.pinned;
    m.emissive.setRGB(hl ? 0.07 : 0, hl ? 0.07 : 0, hl ? 0.09 : 0);
    m.clippingPlanes = [cutPlane];
    m.needsUpdate = true;
    if (el.mesh.children[0]) el.mesh.children[0].visible = !ghost;
  }
  updateLegendMarker();
}

function refresh() {
  if (!state.model) return;
  match();
  compute();
  paint();
  renderSidebar();
  renderLegend();
  if (state.pinned) showCard(state.pinned);
}

// ------------------------------------------------------------------ formatting
const UNIT = { absolute: 'kgCO₂e', area: 'kgCO₂e/m²', volume: 'kgCO₂e/m³' };
function fmtMass(v, { sign = false } = {}) {
  const a = Math.abs(v);
  const s = sign && v > 0 ? '+' : v < 0 ? '−' : '';
  if (a >= 1000) return { n: s + (a / 1000).toLocaleString(undefined, { maximumFractionDigits: a >= 1e5 ? 0 : 1 }), u: 'tCO₂e' };
  return { n: s + a.toLocaleString(undefined, { maximumFractionDigits: a >= 10 ? 0 : 1 }), u: 'kgCO₂e' };
}
const fmtMassStr = (v, o) => { const f = fmtMass(v, o); return `${f.n} ${f.u}`; };
function fmtMetric(v, metric = state.metric, o) {
  if (metric === 'absolute') return fmtMass(v, o);
  const a = Math.abs(v);
  const s = o?.sign && v > 0 ? '+' : v < 0 ? '−' : '';
  return { n: s + a.toLocaleString(undefined, { maximumFractionDigits: a >= 100 ? 0 : 1 }), u: UNIT[metric] };
}
const fmtNum = (v, d = 1) => v.toLocaleString(undefined, { maximumFractionDigits: d });
const signCls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

// ------------------------------------------------------------------ sidebar
const METRIC_NOTES = {
  absolute: 'Each result split across its elements by volume (by area for C.Scale results quantified per ft² or m²).',
  area: 'Type total ÷ face area. Best for walls, floors, roofs.',
  volume: 'Type total ÷ volume. Best for columns, beams, footings.',
};

function renderSidebar() {
  const { totals, model, data } = state;
  renderModelData();

  const net = fmtMass(totals.net, { sign: true });
  const em = fmtMass(totals.emissions);
  const st = fmtMass(totals.storage);
  const pct = model.elements.length ? Math.round((totals.matchedEls / model.elements.length) * 100) : 0;
  $('#summarySum').textContent = `${net.n} ${net.u} net`;
  $('#summaryBody').innerHTML = `
    <div class="stats">
      <div class="stat big"><div class="k">Net embodied carbon</div>
        <div class="v ${signCls(totals.net)}">${net.n}<small>${net.u}</small></div></div>
      <div class="stat"><div class="k">Emissions</div><div class="v pos">${em.n}<small>${em.u}</small></div></div>
      <div class="stat"><div class="k">Biogenic storage</div><div class="v neg">${st.n}<small>${st.u}</small></div></div>
      <div class="stat"><div class="k">Elements matched</div><div class="v">${pct}<small>% of ${model.elements.length.toLocaleString()}</small></div></div>
      <div class="stat"><div class="k">Unmatched results</div><div class="v">${totals.unmatchedTypes}<small>${totals.unmatchedTypes ? fmtMassStr(totals.unmatchedNet, { sign: true }) : 'types'}</small></div></div>
    </div>`;

  // Metric
  document.querySelectorAll('#metricSeg button').forEach((b) => b.classList.toggle('on', b.dataset.metric === state.metric));
  $('#metricNote').textContent = METRIC_NOTES[state.metric];

  // Stages
  $('#stageChips').innerHTML = (data?.stages || []).map((s) =>
    `<button class="chip ${state.stages.has(s) ? 'on' : ''}" data-stage="${esc(s)}">${esc(s)}</button>`).join('')
    || '<span class="note">No stage columns detected.</span>';
  $('#clipVal').textContent = state.clip === 100 ? 'off' : `${state.clip}th percentile`;

  // Types grouped by building system, each sorted by the current metric
  const groups = [...state.groups.values()];
  const mval = (g) => (state.metric === 'absolute' ? g.ev.net : state.metric === 'area' ? g.perArea : g.perVolume);
  const maxAbs = Math.max(1e-9, ...groups.map((g) => Math.abs(mval(g))));
  const bySys = new Map();
  for (const g of groups) {
    const sys = systemOf(g.rec);
    if (!bySys.has(sys)) bySys.set(sys, []);
    bySys.get(sys).push(g);
  }
  const order = [...bySys.keys()].sort((x, y) => {
    const i = SYSTEMS.indexOf(x), j = SYSTEMS.indexOf(y);
    return (i < 0 ? 2.5 : i) - (j < 0 ? 2.5 : j) || x.localeCompare(y);
  });
  const isOn = (kind, key) => state.isolate?.kind === kind && state.isolate.key === key;
  const row = (g) => {
    const v = mval(g);
    const f = fmtMetric(v, state.metric, { sign: true });
    const w = (Math.abs(v) / maxAbs) * 50;
    const tcol = cssColor(state.metric === 'absolute' ? Math.sign(v) * Math.min(1, Math.abs(v) / maxAbs) : tOf(v));
    const bar = v >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`;
    return `<li data-kind="type" data-key="${esc(g.key)}" class="${isOn('type', g.key) ? 'on' : ''}" title="${esc(g.rec.family)}: ${esc(g.rec.type)}">
      <span class="nm"><span class="sw" style="background:${tcol}"></span>${esc((g.rec.parent && g.rec.family) || g.rec.type || g.rec.elementId)}</span>
      <span class="vv ${signCls(v)}">${f.n}</span>
      <span class="bar"><i style="${bar};background:${tcol}"></i></span>
      <span class="meta">${esc(g.rec.parent ? g.rec.type : (g.rec.kind === 'subsection' && g.rec.family) || g.rec.category || '—')} · ${g.els.length} el.${state.metric === 'absolute' ? '' : ` · ${fmtMassStr(g.ev.net, { sign: true })} total`}</span>
    </li>`;
  };
  $('#typesSum').textContent = `${groups.length} ${groups.length === 1 ? 'type' : 'types'}`;
  $('#typeList').innerHTML = order.map((sys) => {
    const list = bySys.get(sys).sort((x, y) => mval(y) - mval(x));
    const net = list.reduce((acc, g) => acc + g.ev.net, 0);
    const count = list.reduce((acc, g) => acc + g.els.length, 0);
    return `<section class="sys">
      <button class="sys-hd ${isOn('system', sys) ? 'on' : ''}" data-kind="system" data-key="${esc(sys)}">
        <span class="sys-nm">${esc(sys)}</span>
        <span class="sys-meta">${list.length} ${list.length === 1 ? 'type' : 'types'} · ${count} el.</span>
        <span class="sys-v ${signCls(net)}">${fmtMassStr(net, { sign: true })}</span>
      </button>
      <ol>${list.map(row).join('')}</ol>
    </section>`;
  }).join('') || '<p class="note">No matches. See Settings › Matching.</p>';

  renderDiagnostics();
}

function fmtWhen(d) {
  if (!d) return '';
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = new Date().toDateString() === d.toDateString();
  return today ? `today ${time}` : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}
function renderModelData() {
  const { model, data, modelFile, dataFile } = state;
  const mf = modelFile || { name: model.name, demo: true };
  const df = dataFile || { name: state.dataName || 'None loaded', demo: true };
  $('#ifcFile').textContent = mf.name;
  $('#ifcMeta').textContent = [`${model.elements.length.toLocaleString()} elements`,
    mf.demo ? 'built-in demo' : `uploaded ${fmtWhen(mf.at)}`].join(' · ');
  $('#dataFile').textContent = df.name;
  const nScen = state.sets?.size || 0;
  $('#dataMeta').textContent = data ? [
    state.table?.cscale ? 'C.Scale export' : `${(data.types.size + data.elements.size).toLocaleString()} ${data.perElement ? 'records' : 'types'}`,
    nScen > 1 ? `${nScen} scenarios` : '',
    df.demo ? 'synthetic sample' : `uploaded ${fmtWhen(df.at)}`].filter(Boolean).join(' · ') : '';

  // Scenario selector: shown when the export has more than one scenario.
  $('#scenarioBlock').hidden = nScen < 2;
  if (nScen > 1) {
    $('#scenarioSum').textContent = state.scenario;
    $('#scenarioSel').innerHTML = [...state.sets.keys()].map((s) =>
      `<option ${s === state.scenario ? 'selected' : ''}>${esc(s)}</option>`).join('');
  }
  $('#mdSum').textContent = `${mf.name} · ${df.name}`;
}

function renderDiagnostics() {
  const { model, data, table } = state;
  const unmatched = new Map();
  for (const el of model.elements) if (!el.rec) {
    const k = `${el.category} · ${el.family ? el.family + ': ' : ''}${el.type || '(no type)'}`;
    unmatched.set(k, (unmatched.get(k) || 0) + 1);
  }
  const notInModel = leafRecords().filter((r) => !state.groups.has(r.key));
  const how = new Map();
  for (const el of model.elements) if (el.matchedBy) how.set(el.matchedBy, (how.get(el.matchedBy) || 0) + 1);

  let html = '';
  if (how.size) html += `<h3>Matched by</h3><ul>${[...how].map(([k, n]) => `<li>${esc(k)}: ${n}</li>`).join('')}</ul>`;
  if (unmatched.size) html += `<h3>Unmatched model types (${unmatched.size})</h3><ul>${[...unmatched].sort((a, b) => b[1] - a[1]).slice(0, 40)
    .map(([k, n]) => `<li>${esc(k)} <span class="muted">×${n}</span></li>`).join('')}</ul>`;
  if (notInModel.length) html += `<h3>Unmatched results (${notInModel.length})</h3><ul>${notInModel.slice(0, 40)
    .map((r) => `<li>${esc(r.category)} · ${esc(r.family)}: ${esc(r.type || r.elementId)}</li>`).join('')}</ul>`;

  if (table?.cscale) {
    html += `<h3>C.Scale export</h3><ul><li>Sheets used: ${table.sheets.map(esc).join(', ')}</li>${table.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
  } else if (table) {
    const m = table.mapping;
    const opt = (field) => `<select data-map="${field}"><option value="">—</option>${table.headers.filter(Boolean).map((h) =>
      `<option ${m[field] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>`;
    const used = new Set(m.gwp.map((g) => g.col));
    html += `<h3>Column mapping</h3><div class="map">
      <span>Category</span>${opt('category')}<span>Family</span>${opt('family')}<span>Type</span>${opt('type')}
      <span>Family &amp; Type</span>${opt('familyType')}<span>Element ID</span>${opt('elementId')}
      <span>Material</span>${opt('material')}<span>Biogenic</span>${opt('biogenic')}<span>Stage column</span>${opt('stageCol')}
    </div>
    <h3>GWP columns</h3><div class="gwp">${table.headers.filter(Boolean).map((h) =>
      `<label><input type="checkbox" data-gwp="${esc(h)}" ${used.has(h) ? 'checked' : ''}> ${esc(h)}</label>`).join('')}</div>`;
  }
  $('#diagBody').innerHTML = html;
}

function renderLegend() {
  const { scale } = state;
  const ref = fmtMetric(Math.max(scale.pos, scale.neg), state.metric);
  const fmt = (v) => (state.metric === 'absolute' && ref.u === 'tCO₂e' ? fmtNum(v / 1000, 1) : fmtMetric(v, state.metric).n);
  $('#legend').innerHTML = `
    <span>${scale.hasNeg ? '−' + fmt(scale.neg) : '0'}</span>
    <span class="bar" style="background:${gradientCSS()}"><span class="z"></span><i class="mk" hidden></i></span>
    <span>${scale.hasPos ? '+' + fmt(scale.pos) : '0'}</span>
    <span class="u">${ref.u}</span>`;
  $('#legend').title = state.clip < 100 ? `Clipped at ${state.clip}th percentile` : 'Not clipped';
  updateLegendMarker();
}
// Marks where the focused (pinned or hovered) element sits on the gradient.
function updateLegendMarker() {
  const mk = document.querySelector('#legend .mk');
  if (!mk) return;
  const el = state.pinned || state.hovered;
  mk.hidden = !el?.rec;
  if (!el?.rec) return;
  const t = Math.max(-1, Math.min(1, tOf(el.value)));
  mk.style.left = `${((t + 1) / 2) * 100}%`;
  mk.style.background = cssColor(t);
}

// ------------------------------------------------------------------ hover card
const card = $('#card');
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let lastPointer = null;

function pick(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const targets = state.model.elements.filter(inIsolation).map((e) => e.mesh);
  const hit = raycaster.intersectObjects(targets, false).find((h) => state.cut >= 1 || cutPlane.distanceToPoint(h.point) >= 0);
  return hit ? hit.object.userData.element : null;
}

// mode: 'full' (phone panel), 'compact' (desktop hover), 'expanded' (desktop click)
function cardHTML(el, mode = 'full') {
  const inline = mode !== 'full';
  const g = el.rec ? state.groups.get(el.rec.key) : null;
  const title = el.type || el.name || '(unnamed element)';
  const sub = [el.category, el.family].filter(Boolean).join(' · ');
  const idLine = el.elementId ? `<span>Element ID</span><span>${esc(el.elementId)}</span>` : '';
  const qty = `<span>Volume</span><span>${fmtNum(el.volume, 2)} m³</span><span>Area</span><span>${fmtNum(el.area, 1)} m²</span>`;
  const head = (color, value) => `<div class="hd"><span class="sw" style="background:${color}"></span><div class="hd-txt">
      <div class="tt">${esc(title)}</div><div class="st">${esc(sub)}</div></div>${inline ? value : ''}</div>`;
  if (!g) {
    const h = head('var(--nodata)', '<span class="hv muted">No data</span>');
    if (mode === 'compact') return h;
    const body = `<div class="kv">${idLine}${qty}</div><div class="warn">No Tally results for this type.</div>`;
    return h + (inline ? `<div class="more">${body}</div>` : body);
  }
  const col = cssColor(tOf(el.value));
  const abs = fmtMass(el.abs, { sign: true });
  const shareEm = state.totals.emissions ? ((g.ev.emissions * el.share) / state.totals.emissions) * 100 : 0;
  const shareSt = state.totals.storage ? ((g.ev.biogenic * el.share) / state.totals.storage) * 100 : 0;
  const mats = g.ev.materials;
  const mMax = Math.max(1e-9, ...mats.map((m) => Math.abs(m.value)));
  const matHTML = mats.length > 1 || (mats[0] && mats[0].name !== 'Assembly') ? `<div class="mats"><div class="h">Assembly</div>${mats.map((m) => {
    const w = (Math.abs(m.value) / mMax) * 50;
    const c = cssColor(Math.sign(m.value) * Math.max(0.35, Math.abs(m.value) / mMax));
    const pos = m.value >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`;
    return `<div class="mat"><span class="n" title="${esc(m.name)}">${esc(m.name)}</span><span class="x ${signCls(m.value)}">${fmtMassStr(m.value * el.share, { sign: true }).replace('CO₂e', '')}</span>
      <span class="b"><i style="${pos};background:${c}"></i><span class="zero" style="left:50%"></span></span></div>`;
  }).join('')}</div>` : '';
  const h = head(col, `<span class="hv ${signCls(el.abs)}">${abs.n}<small>${abs.u}</small></span>`);
  if (mode === 'compact') return h;
  const hero = inline ? '' : `<div class="hero"><span class="v ${signCls(el.abs)}">${abs.n}</span><span class="u">${abs.u}</span></div>`;
  const body = `<div class="kv">
      <span>Intensity</span><span>${fmtMetric(g.perArea, 'area', { sign: true }).n} kg/m² · ${fmtMetric(g.perVolume, 'volume', { sign: true }).n} kg/m³</span>
      ${g.rec.kind ? `<span>Group</span><span>${esc(g.rec.kind === 'subsection' ? `${g.rec.system} › ${g.rec.type}` : g.rec.type)}</span>` : ''}
      ${g.rec.kind === 'subsection' && g.rec.family ? `<span>C.Scale ${g.rec.byMaterial ? 'material' : 'assembly'}</span><span>${esc(g.rec.family)}</span>` : ''}
      <span>${g.rec.kind ? 'Group' : 'Type'} total · ${g.els.length} el.</span><span>${fmtMassStr(g.ev.net, { sign: true })}</span>
      ${g.ev.emissions > 0 ? `<span>Share of emissions</span><span>${fmtNum(shareEm, 1)}%</span>` : ''}
      ${g.ev.biogenic < 0 ? `<span>Share of storage</span><span>${fmtNum(shareSt, 1)}%</span>` : ''}
      ${idLine}${qty}
    </div>${matHTML}
    ${el.matchedBy && !['Category + Family + Type', 'Element ID', 'Building subsection', 'Assembly', 'Material'].includes(el.matchedBy) ? `<div class="warn">Matched by ${esc(el.matchedBy.toLowerCase())}</div>` : ''}`;
  return h + hero + (inline ? `<div class="more">${body}</div>` : body);
}

const isPhone = () => matchMedia('(max-width: 760px)').matches;
const elCard = $('#elCard');
// On phones a pinned element's card replaces the project totals below the model.
function showCard(el, x, y) {
  if (el === state.pinned && isPhone()) {
    card.hidden = true;
    elCard.innerHTML = '<button class="close" aria-label="Back to project totals">×</button>' + cardHTML(el);
    elCard.hidden = false;
    $('#summary').hidden = true;
    return;
  }
  elCard.hidden = true;
  $('#summary').hidden = false;
  card.hidden = false;
  const pinned = el === state.pinned;
  const wasPinned = card.classList.contains('pinned') && card.dataset.uid === String(el.uid);
  card.classList.toggle('pinned', pinned);
  card.classList.toggle('compact', !pinned);
  card.dataset.uid = el.uid;
  card.innerHTML = (pinned ? '<button class="close" aria-label="Close">×</button>' : '') + cardHTML(el, pinned ? 'expanded' : 'compact');
  if (x !== undefined) placeCard(x, y);
  // Drop the details down only when the card first opens, not on every refresh.
  if (pinned && !wasPinned) card.querySelector('.more')?.classList.add('drop');
}
function placeCard(clientX, clientY) {
  const r = canvas.parentElement.getBoundingClientRect();
  const w = card.offsetWidth, h = card.offsetHeight;
  let x = clientX - r.left + 16, y = clientY - r.top + 16;
  if (x + w > r.width - 8) x = clientX - r.left - w - 16;
  if (y + h > r.height - 8) y = Math.max(8, r.height - h - 8);
  card.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
}
function hideCard() { if (!state.pinned) card.hidden = true; }
function clearPin() {
  state.pinned = null;
  card.hidden = true;
  card.classList.remove('pinned');
  elCard.hidden = true;
  $('#summary').hidden = false;
  paint();
}

let rafPending = false;
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  lastPointer = [e.clientX, e.clientY];
  if (rafPending || !state.model) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (e.buttons) { return; }
    const el = pick(...lastPointer);
    if (el !== state.hovered) { state.hovered = el; paint(); }
    if (state.pinned) return;
    if (el) showCard(el, ...lastPointer); else hideCard();
  });
});
canvas.addEventListener('pointerleave', () => {
  if (state.hovered) { state.hovered = null; paint(); }
  hideCard();
});
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const el = pick(e.clientX, e.clientY);
  state.pinned = el && el !== state.pinned ? el : null;
  state.hovered = el;
  paint();
  if (state.pinned) showCard(el, e.clientX, e.clientY); else clearPin();
});
card.addEventListener('click', (e) => {
  if (e.target.closest('.close')) clearPin();
});
elCard.addEventListener('click', (e) => { if (e.target.closest('.close')) clearPin(); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#settings').open) { state.isolate = null; clearPin(); renderSidebar(); }
});

// ------------------------------------------------------------------ controls
$('#metricSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.metric = b.dataset.metric; refresh();
});
$('#stageChips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  const s = b.dataset.stage;
  if (state.stages.has(s)) state.stages.delete(s); else state.stages.add(s);
  refresh();
});
$('#bioToggle').addEventListener('change', (e) => { state.biogenic = e.target.checked; refresh(); });
$('#sharedToggle').addEventListener('change', (e) => { state.shared = e.target.checked; refresh(); });
$('#cutRange').addEventListener('input', (e) => { state.cut = +e.target.value / 100; applyCut(); });
$('#clipRange').addEventListener('input', (e) => { state.clip = +e.target.value; refresh(); });
$('#typeList').addEventListener('click', (e) => {
  const li = e.target.closest('[data-kind]'); if (!li) return;
  const next = { kind: li.dataset.kind, key: li.dataset.key };
  state.isolate = state.isolate?.kind === next.kind && state.isolate.key === next.key ? null : next;
  paint(); renderSidebar();
});
$('#diagBody').addEventListener('change', (e) => {
  const t = state.table; if (!t) return;
  if (e.target.dataset.map) t.mapping[e.target.dataset.map] = e.target.value || null;
  if (e.target.dataset.gwp !== undefined) {
    const h = e.target.dataset.gwp;
    if (e.target.checked) {
      const auto = detectColumns([h]).gwp[0];
      t.mapping.gwp.push({ col: h, stage: auto?.stage && auto.stage !== 'Total' ? auto.stage : (t.mapping.stageCol ? null : h) });
    } else t.mapping.gwp = t.mapping.gwp.filter((g) => g.col !== h);
  }
  setTable(t, state.dataName);
  refresh();
});

$('#scenarioSel').addEventListener('change', (e) => {
  state.scenario = e.target.value;
  applyScenario();
  refresh();
});

// ------------------------------------------------------------------ settings sheet
const settings = $('#settings');
$('#settingsBtn').addEventListener('click', () => settings.showModal());
$('#settingsClose').addEventListener('click', () => settings.close());
// Tapping the dimmed backdrop (outside the sheet) closes it.
settings.addEventListener('click', (e) => { if (e.target === settings) settings.close(); });

// ------------------------------------------------------------------ file loading
const statusEl = $('#status');
let statusTimer;
function status(msg, { error = false, sticky = false } = {}) {
  clearTimeout(statusTimer);
  statusEl.hidden = !msg;
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('err', error);
  if (msg && !sticky) statusTimer = setTimeout(() => (statusEl.hidden = true), error ? 9000 : 3500);
}

async function handleFile(file) {
  const n = file.name.toLowerCase();
  try {
    if (n.endsWith('.ifc')) {
      if ($('#ifcZone').classList.contains('disabled')) { status('IFC upload is in the full version only', { error: true }); return; }
      status('Loading model…', { sticky: true });
      const model = await loadIfcModel(file, (m) => status(m, { sticky: true }));
      setModel(model);
      state.modelFile = { name: file.name, at: new Date() };
      refresh();
      const pct = Math.round((state.totals.matchedEls / Math.max(1, model.elements.length)) * 100);
      status(`${model.elements.length.toLocaleString()} elements loaded · ${pct}% matched to results`);
    } else if (/\.(csv|tsv|txt|xlsx|xlsm|xls)$/.test(n)) {
      status('Reading results…', { sticky: true });
      const table = await readTableFile(file);
      setTable(table, file.name + (table.sheet ? ` › ${table.sheet}` : ''));
      state.dataFile = { name: state.dataName, at: new Date() };
      refresh();
      const n = state.sets.size;
      status(`${n > 1 ? `${n} scenarios · ` : ''}${state.totals.matchedEls} of ${state.model.elements.length} elements matched`);
    } else status(`Unsupported file: ${file.name}`, { error: true });
  } catch (err) {
    console.error(err);
    status(`Couldn't load ${file.name}: ${err.message}`, { error: true });
  }
}
$('#ifcInput').addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ''; });
$('#dataInput').addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ''; });

// Drop zones in Model data: highlight while a file is dragged over them.
for (const z of [$('#ifcZone'), $('#dataZone')]) {
  z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('over'); });
  z.addEventListener('dragleave', () => z.classList.remove('over'));
  z.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); z.classList.remove('over');
    dragDepth = 0; $('#dropHint').hidden = true;
    [...e.dataTransfer.files].forEach(handleFile);
  });
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#dropHint').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropHint').hidden = true;
  [...e.dataTransfer.files].sort((a) => (a.name.toLowerCase().endsWith('.ifc') ? -1 : 1)).forEach(handleFile);
});

async function loadDemo() {
  setModel(loadDemoModel());
  state.modelFile = state.dataFile = null;
  try {
    const text = window.__SAMPLE_CSV ?? await (await fetch('sample/sample-tally.csv')).text();
    setTable(tableFromText(text), 'sample-tally.csv (synthetic)');
  } catch (err) {
    console.error(err);
    status("Couldn't load the sample results. Serve this folder over http.", { error: true });
  }
  refresh();
}
$('#demoBtn').addEventListener('click', loadDemo);

// ------------------------------------------------------------------ boot
resize();
applyTheme();
loadDemo();
window.__viewer = { state, camera, controls, refresh };
