// Generates the sample files from src/demo-building.js:
//   sample/sample-tally.csv     - a synthetic, Tally-style type-level export
//   sample/demo-building.ifc    - the same building as an IFC4 file (Revit-style
//                                 names: "Family:Type:ElementId", Tag = ElementId)
// Run: node tools/make-samples.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildDemoElements, DEMO_ASSEMBLIES, IFC_CLASS } from '../src/demo-building.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const els = buildDemoElements();

const dims = (e) => [0, 1, 2].map((i) => e.max[i] - e.min[i]);
const volume = (e) => dims(e).reduce((a, b) => a * b, 1);
const faceArea = (e) => { const [a, b, c] = dims(e); return Math.max(a * b, a * c, b * c); };

// ---------- CSV ----------
const byType = new Map();
for (const e of els) {
  const k = `${e.category}|${e.family}|${e.type}`;
  if (!byType.has(k)) byType.set(k, { ...e, area: 0, volume: 0 });
  const t = byType.get(k);
  t.area += faceArea(e);
  t.volume += volume(e);
}
const header = ['Revit Category', 'Revit Family', 'Revit Type', 'Material', 'Mass Total (kg)',
  'GWP A1-A3 Product (kgCO2eq)', 'GWP A4 Transportation (kgCO2eq)',
  'GWP B2-B5 Maintenance & Replacement (kgCO2eq)', 'GWP C2-C4 End of Life (kgCO2eq)',
  'GWP D Module D (kgCO2eq)', 'Biogenic Carbon Storage (kgCO2eq)'];
const q = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
const lines = [
  'Project,Demo Office (synthetic sample data - not real LCA results)',
  'Report,Type-level results by material',
  '',
  header.map(q).join(','),
];
for (const t of byType.values()) {
  const a = DEMO_ASSEMBLIES[t.type];
  if (!a) throw new Error('No assembly for ' + t.type);
  const qty = a.basis === 'area' ? t.area : t.volume;
  for (const [name, mass, ...vals] of a.materials) {
    lines.push([t.category, t.family, t.type, name, (mass * qty).toFixed(1),
      ...vals.map((v) => (v * qty).toFixed(2))].map(q).join(','));
  }
}
writeFileSync(join(root, 'sample/sample-tally.csv'), lines.join('\n') + '\n');

// ---------- IFC ----------
const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const guid = () => '0' + Array.from({ length: 21 }, () => B64[Math.floor(rnd() * 64)]).join('');
const f = (n) => { const s = (+n).toFixed(4); return s.includes('.') ? s : s + '.'; };
const str = (s) => `'${String(s).replace(/'/g, "''")}'`;

const out = [];
let id = 0;
const ent = (body) => { out.push(`#${++id}=${body};`); return `#${id}`; };

const pt3 = (x, y, z) => ent(`IFCCARTESIANPOINT((${f(x)},${f(y)},${f(z)}))`);
const origin = pt3(0, 0, 0);
const zDir = ent('IFCDIRECTION((0.,0.,1.))');
const xDir = ent('IFCDIRECTION((1.,0.,0.))');
const worldA2P = ent(`IFCAXIS2PLACEMENT3D(${origin},${zDir},${xDir})`);
const ctx = ent(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${worldA2P},$)`);
const lenUnit = ent('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
const units = ent(`IFCUNITASSIGNMENT((${lenUnit}))`);
const project = ent(`IFCPROJECT('${guid()}',$,'Demo Office',$,$,$,$,(${ctx}),${units})`);
const bldPl = ent(`IFCLOCALPLACEMENT($,${worldA2P})`);
const building = ent(`IFCBUILDING('${guid()}',$,'Demo Office',$,$,${bldPl},$,$,.ELEMENT.,$,$,$)`);
const storey = ent(`IFCBUILDINGSTOREY('${guid()}',$,'Level 1',$,$,${bldPl},$,$,.ELEMENT.,0.)`);
ent(`IFCRELAGGREGATES('${guid()}',$,$,$,${project},(${building}))`);
ent(`IFCRELAGGREGATES('${guid()}',$,$,$,${building},(${storey}))`);
const p2 = ent('IFCCARTESIANPOINT((0.,0.))');
const prof2 = ent(`IFCAXIS2PLACEMENT2D(${p2},$)`);

const products = [];
for (const e of els) {
  const [dx, dy, dz] = dims(e);
  const cx = (e.min[0] + e.max[0]) / 2, cy = (e.min[1] + e.max[1]) / 2;
  const pl = ent(`IFCLOCALPLACEMENT(${bldPl},${ent(`IFCAXIS2PLACEMENT3D(${pt3(cx, cy, e.min[2])},$,$)`)})`);
  const profile = ent(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${prof2},${f(dx)},${f(dy)})`);
  const solid = ent(`IFCEXTRUDEDAREASOLID(${profile},${worldA2P},${zDir},${f(dz)})`);
  const rep = ent(`IFCSHAPEREPRESENTATION(${ctx},'Body','SweptSolid',(${solid}))`);
  const pds = ent(`IFCPRODUCTDEFINITIONSHAPE($,$,(${rep}))`);
  const cls = IFC_CLASS[e.category] || 'IFCBUILDINGELEMENTPROXY';
  const ft = `${e.family}:${e.type}`;
  products.push(ent(`${cls}('${guid()}',$,${str(ft + ':' + e.elementId)},$,${str(ft)},${pl},${pds},${str(e.elementId)},$)`));
}
ent(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid()}',$,$,$,(${products.join(',')}),${storey})`);

const ifc = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
  "FILE_NAME('demo-building.ifc','2026-01-01T00:00:00',(''),(''),'tally-viewer','make-samples','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  ...out,
  'ENDSEC;',
  'END-ISO-10303-21;',
].join('\n');
writeFileSync(join(root, 'sample/demo-building.ifc'), ifc + '\n');

console.log(`${els.length} elements, ${byType.size} types -> sample/sample-tally.csv, sample/demo-building.ifc`);
