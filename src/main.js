import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadDemoModel, loadIfcModel } from './model.js';
import {
  readTableFile, tableFromText, buildCarbonData, evalRecord, detectColumns, norm, typeKey,
} from './data.js';
import { divergingColor, cssColor, gradientCSS, percentile } from './color.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ state
const state = {
  model: null,            // {elements, name}
  table: null,            // parsed table {headers, rows, mapping}
  data: null,             // buildCarbonData result
  dataName: '',
  metric: 'absolute',     // absolute | area | volume
  stages: new Set(),
  biogenic: true,
  clip: 95,
  shared: false,
  cut: 1,                 // section-cut height as a fraction of model height (1 = off)
  isolate: null,          // group key
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
}

// ------------------------------------------------------------------ data
function setTable(table, name) {
  state.table = table;
  state.dataName = name;
  state.data = buildCarbonData(table);
  state.stages = new Set(state.data.stages.filter((s) => s !== 'D' || state.data.stages.length === 1));
  state.biogenic = state.data.hasBiogenic;
  $('#bioToggle').checked = state.biogenic;
  $('#bioToggle').disabled = !state.data.hasBiogenic;
  state.isolate = null;
}

// ------------------------------------------------------------------ matching + values
function match() {
  const { data, model } = state;
  for (const el of model.elements) { el.rec = null; el.matchedBy = null; }
  if (!data) return;
  const byFamType = new Map(), byType = new Map();
  for (const rec of data.types.values()) {
    const ft = `${norm(rec.family)}|${norm(rec.type)}`;
    (byFamType.get(ft) || byFamType.set(ft, []).get(ft)).push(rec);
    (byType.get(norm(rec.type)) || byType.set(norm(rec.type), []).get(norm(rec.type))).push(rec);
  }
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
    if (rec) { el.rec = rec; el.matchedBy = how; }
  }
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
    for (const m of g.ev.materials) {
      // Split gross emissions vs storage at the material level.
      emissions += Math.max(0, m.value);
      storage += Math.min(0, m.value);
    }
    for (const el of g.els) {
      const share = g.volume > 1e-9 ? el.volume / g.volume : g.area > 1e-9 ? el.area / g.area : 1 / g.els.length;
      el.share = share;
      el.abs = g.ev.net * share;
      el.value = state.metric === 'absolute' ? el.abs : state.metric === 'area' ? g.perArea : g.perVolume;
      matchedEls++;
    }
  }
  // Results in the export that never matched the model still count toward its total.
  let unmatchedNet = 0, unmatchedTypes = 0;
  const src = state.data ? [...state.data.types.values(), ...state.data.elements.values()] : [];
  for (const rec of src) if (!groups.has(rec.key)) { unmatchedNet += evalRecord(rec, stages, state.biogenic).net; unmatchedTypes++; }

  state.groups = groups;
  state.totals = { net, emissions, storage, matchedEls, unmatchedNet, unmatchedTypes, totalTypes: src.length };

  // Colour scale: clip each side at the chosen percentile of the element values.
  const vals = model.elements.filter((e) => e.rec).map((e) => e.value);
  const pos = vals.filter((v) => v > 0).sort((a, b) => a - b);
  const neg = vals.filter((v) => v < 0).map((v) => -v).sort((a, b) => a - b);
  let pMax = percentile(pos, state.clip) || 1, nMax = percentile(neg, state.clip) || 1;
  if (state.shared) pMax = nMax = Math.max(pos.length ? pMax : 0, neg.length ? nMax : 0) || 1;
  state.scale = { pos: pMax, neg: nMax, hasPos: pos.length > 0, hasNeg: neg.length > 0 };
}

function tOf(v) { return v >= 0 ? v / state.scale.pos : v / state.scale.neg; }

const tmpColor = new THREE.Color();
function paint() {
  for (const el of state.model.elements) {
    const m = el.mesh.material;
    const ghost = state.isolate && el.rec?.key !== state.isolate;
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
  absolute: "Each type's result is split across its elements by volume, so big elements read hotter.",
  area: "Type result ÷ total face area of its elements. Compares assemblies like walls, floors and roofs fairly. Face area is measured from the geometry.",
  volume: "Type result ÷ total volume of its elements. Suited to columns, beams and foundations.",
};

function renderSidebar() {
  const { totals, model, data } = state;
  $('#sources').innerHTML = `Model: <b>${esc(model.name)}</b> · ${model.elements.length.toLocaleString()} elements<br>
    Results: <b>${esc(state.dataName || 'none')}</b>${data ? ` · ${(data.types.size + data.elements.size).toLocaleString()} ${data.perElement ? 'records' : 'types'}` : ''}`;

  const net = fmtMass(totals.net, { sign: true });
  const em = fmtMass(totals.emissions);
  const st = fmtMass(totals.storage);
  const pct = model.elements.length ? Math.round((totals.matchedEls / model.elements.length) * 100) : 0;
  $('#summary').innerHTML = `
    <div class="stats">
      <div class="stat big"><div class="k">Net embodied carbon · matched elements</div>
        <div class="v ${signCls(totals.net)}">${net.n}<small>${net.u}</small></div></div>
      <div class="stat"><div class="k">Emissions</div><div class="v pos">${em.n}<small>${em.u}</small></div></div>
      <div class="stat"><div class="k">Biogenic storage</div><div class="v neg">${st.n}<small>${st.u}</small></div></div>
      <div class="stat"><div class="k">Elements matched</div><div class="v">${pct}<small>% of ${model.elements.length.toLocaleString()}</small></div></div>
      <div class="stat"><div class="k">Results not in model</div><div class="v">${totals.unmatchedTypes}<small>${totals.unmatchedTypes ? fmtMassStr(totals.unmatchedNet, { sign: true }) : 'types'}</small></div></div>
    </div>`;

  // Metric
  document.querySelectorAll('#metricSeg button').forEach((b) => b.classList.toggle('on', b.dataset.metric === state.metric));
  $('#metricNote').textContent = METRIC_NOTES[state.metric];

  // Stages
  $('#stageChips').innerHTML = (data?.stages || []).map((s) =>
    `<button class="chip ${state.stages.has(s) ? 'on' : ''}" data-stage="${esc(s)}">${esc(s)}</button>`).join('')
    || '<span class="note">No stage columns detected.</span>';
  $('#clipVal').textContent = state.clip === 100 ? 'max (no clip)' : `${state.clip}th`;

  // Types list, sorted by the current metric
  const groups = [...state.groups.values()];
  const mval = (g) => (state.metric === 'absolute' ? g.ev.net : state.metric === 'area' ? g.perArea : g.perVolume);
  groups.sort((a, b) => mval(b) - mval(a));
  const maxAbs = Math.max(1e-9, ...groups.map((g) => Math.abs(mval(g))));
  $('#typeList').innerHTML = groups.map((g) => {
    const v = mval(g);
    const f = fmtMetric(v, state.metric, { sign: true });
    const w = (Math.abs(v) / maxAbs) * 50;
    const tcol = cssColor(state.metric === 'absolute' ? Math.sign(v) * Math.min(1, Math.abs(v) / maxAbs) : tOf(v));
    const bar = v >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`;
    return `<li data-key="${esc(g.key)}" class="${state.isolate === g.key ? 'on' : ''}" title="${esc(g.rec.family)}: ${esc(g.rec.type)}">
      <span class="nm"><span class="sw" style="background:${tcol}"></span>${esc(g.rec.type || g.rec.elementId)}</span>
      <span class="vv ${signCls(v)}">${f.n}</span>
      <span class="bar"><i style="${bar};background:${tcol}"></i></span>
      <span class="meta">${esc(g.rec.category || '—')} · ${g.els.length} el. · ${state.metric === 'absolute' ? '' : fmtMassStr(g.ev.net, { sign: true }) + ' · '}${f.u}</span>
    </li>`;
  }).join('') || '<li class="meta">No elements matched. Open “Matching &amp; columns” below.</li>';

  renderDiagnostics();
}

function renderDiagnostics() {
  const { model, data, table } = state;
  const unmatched = new Map();
  for (const el of model.elements) if (!el.rec) {
    const k = `${el.category} · ${el.family ? el.family + ': ' : ''}${el.type || '(no type)'}`;
    unmatched.set(k, (unmatched.get(k) || 0) + 1);
  }
  const notInModel = data ? [...data.types.values(), ...data.elements.values()].filter((r) => !state.groups.has(r.key)) : [];
  const how = new Map();
  for (const el of model.elements) if (el.matchedBy) how.set(el.matchedBy, (how.get(el.matchedBy) || 0) + 1);

  let html = '';
  if (how.size) html += `<h3>Matched by</h3><ul>${[...how].map(([k, n]) => `<li>${esc(k)}: ${n}</li>`).join('')}</ul>`;
  if (unmatched.size) html += `<h3>Model types with no results (${unmatched.size})</h3><ul>${[...unmatched].sort((a, b) => b[1] - a[1]).slice(0, 40)
    .map(([k, n]) => `<li>${esc(k)} <span class="muted">×${n}</span></li>`).join('')}</ul>`;
  if (notInModel.length) html += `<h3>Results with no model elements (${notInModel.length})</h3><ul>${notInModel.slice(0, 40)
    .map((r) => `<li>${esc(r.category)} · ${esc(r.family)}: ${esc(r.type || r.elementId)}</li>`).join('')}</ul>`;

  if (table) {
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
  const u = ref.u;
  const fmt = (v) => (state.metric === 'absolute' && ref.u === 'tCO₂e' ? fmtNum(v / 1000, 1) : fmtMetric(v, state.metric).n);
  const clipNote = state.clip < 100 ? `clipped at p${state.clip}` : 'full range';
  $('#legend').innerHTML = `
    <div class="ttl"><b>${state.metric === 'absolute' ? 'Embodied carbon per element' : 'Carbon intensity'}</b><span>${u} · ${clipNote}</span></div>
    <div class="grad" style="background:${gradientCSS()}"></div>
    <div class="ticks"><span>${scale.hasNeg ? '−' + fmt(scale.neg) : '—'}</span><span>0</span><span>${scale.hasPos ? '+' + fmt(scale.pos) : '—'}</span></div>
    <div class="ends"><span>stores carbon</span><span>emits carbon</span></div>
    <div class="nodata"><i></i>No matching results</div>`;
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
  const targets = state.model.elements.filter((e) => !state.isolate || e.rec?.key === state.isolate).map((e) => e.mesh);
  const hit = raycaster.intersectObjects(targets, false).find((h) => state.cut >= 1 || cutPlane.distanceToPoint(h.point) >= 0);
  return hit ? hit.object.userData.element : null;
}

function cardHTML(el) {
  const g = el.rec ? state.groups.get(el.rec.key) : null;
  const title = el.type || el.name || '(unnamed element)';
  const sub = [el.category, el.family].filter(Boolean).join(' · ');
  const idLine = el.elementId ? `<span>Revit Element ID</span><span>${esc(el.elementId)}</span>` : '';
  const qty = `<span>Volume</span><span>${fmtNum(el.volume, 2)} m³</span><span>Face area</span><span>${fmtNum(el.area, 1)} m²</span>`;
  if (!g) {
    return `<div class="hd"><span class="sw" style="background:var(--nodata)"></span><div>
      <div class="tt">${esc(title)}</div><div class="st">${esc(sub)}</div></div></div>
      <div class="kv">${idLine}${qty}</div>
      <div class="warn">No matching row in the results export for this Category / Family / Type.</div>`;
  }
  const col = cssColor(tOf(el.value));
  const abs = fmtMass(el.abs, { sign: true });
  const shareSt = state.totals.storage ? (Math.min(0, el.abs) / state.totals.storage) * 100 : 0;
  const shareEm = state.totals.emissions ? (Math.max(0, el.abs) / state.totals.emissions) * 100 : 0;
  const mats = g.ev.materials.slice(0, 5);
  const mMax = Math.max(1e-9, ...mats.map((m) => Math.abs(m.value)));
  const matHTML = mats.length > 1 || (mats[0] && mats[0].name !== 'Assembly') ? `<div class="mats"><div class="h">What drives it · per element</div>${mats.map((m) => {
    const w = (Math.abs(m.value) / mMax) * 50;
    const c = cssColor(Math.sign(m.value) * Math.max(0.35, Math.abs(m.value) / mMax));
    const pos = m.value >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`;
    return `<div class="mat"><span class="n" title="${esc(m.name)}">${esc(m.name)}</span><span class="x ${signCls(m.value)}">${fmtMassStr(m.value * el.share, { sign: true }).replace('CO₂e', '')}</span>
      <span class="b"><i style="${pos};background:${c}"></i><span class="zero" style="left:50%"></span></span></div>`;
  }).join('')}${g.ev.materials.length > 5 ? `<div class="h">+ ${g.ev.materials.length - 5} more</div>` : ''}</div>` : '';
  return `<div class="hd"><span class="sw" style="background:${col}"></span><div>
      <div class="tt">${esc(title)}</div><div class="st">${esc(sub)}</div></div></div>
    <div class="hero"><span class="v ${signCls(el.abs)}">${abs.n}</span><span class="u">${abs.u} this element</span></div>
    <div class="kv">
      <span>Type intensity</span><span>${fmtMetric(g.perArea, 'area', { sign: true }).n} kg/m² · ${fmtMetric(g.perVolume, 'volume', { sign: true }).n} kg/m³</span>
      <span>Type total (${g.els.length} el.)</span><span>${fmtMassStr(g.ev.net, { sign: true })}</span>
      ${el.abs > 0 ? `<span>Share of emissions</span><span>${fmtNum(shareEm, 1)}%</span>` : `<span>Share of storage</span><span>${fmtNum(shareSt, 1)}%</span>`}
      ${idLine}${qty}
    </div>${matHTML}
    ${el.matchedBy && el.matchedBy !== 'Category + Family + Type' && el.matchedBy !== 'Element ID' ? `<div class="warn">Matched on ${esc(el.matchedBy)}.</div>` : ''}`;
}

function showCard(el, x, y) {
  card.hidden = false;
  card.classList.toggle('pinned', el === state.pinned);
  card.innerHTML = (el === state.pinned ? '<button class="close" aria-label="Close">×</button>' : '') + cardHTML(el);
  if (x !== undefined) placeCard(x, y);
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
  if (state.pinned) showCard(el, e.clientX, e.clientY); else { card.hidden = true; card.classList.remove('pinned'); }
});
card.addEventListener('click', (e) => {
  if (e.target.closest('.close')) { state.pinned = null; card.hidden = true; paint(); }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { state.pinned = null; state.isolate = null; card.hidden = true; paint(); renderSidebar(); }
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
  const li = e.target.closest('li[data-key]'); if (!li) return;
  state.isolate = state.isolate === li.dataset.key ? null : li.dataset.key;
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
  $('#diag').open = true;
});

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
      status('Loading model…', { sticky: true });
      const model = await loadIfcModel(file, (m) => status(m, { sticky: true }));
      setModel(model);
      refresh();
      const pct = Math.round((state.totals.matchedEls / Math.max(1, model.elements.length)) * 100);
      status(`${model.elements.length.toLocaleString()} elements loaded · ${pct}% matched to results`);
    } else if (/\.(csv|tsv|txt|xlsx|xlsm|xls)$/.test(n)) {
      status('Reading results…', { sticky: true });
      const table = await readTableFile(file);
      setTable(table, file.name + (table.sheet ? ` › ${table.sheet}` : ''));
      refresh();
      status(`${state.data.types.size + state.data.elements.size} result records · ${state.totals.matchedEls} elements matched`);
    } else status(`Unsupported file: ${file.name}`, { error: true });
  } catch (err) {
    console.error(err);
    status(`Couldn't load ${file.name}: ${err.message}`, { error: true });
  }
}
$('#ifcInput').addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ''; });
$('#dataInput').addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ''; });

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
  try {
    const text = await (await fetch('sample/sample-tally.csv')).text();
    setTable(tableFromText(text), 'sample-tally.csv (synthetic)');
  } catch (err) {
    console.error(err);
    status('Could not fetch the sample results. Serve this folder over http (see README).', { error: true });
  }
  refresh();
}
$('#demoBtn').addEventListener('click', loadDemo);

// ------------------------------------------------------------------ boot
resize();
applyTheme();
loadDemo();
window.__viewer = { state, camera, controls, refresh };
