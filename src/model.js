// Geometry: builds one THREE.Mesh per model element, either from the procedural
// demo building or from an IFC file (via web-ifc), and measures each element's
// volume and approximate face area from its mesh.
import * as THREE from 'three';
import { buildDemoElements } from './demo-building.js';

const WEB_IFC_VERSION = '0.0.77';
const WEB_IFC_BASE = `https://cdn.jsdelivr.net/npm/web-ifc@${WEB_IFC_VERSION}/`;

// IFC class -> Revit category (what Revit's IFC exporter maps each category to).
const IFC_TO_CATEGORY = {
  IFCWALL: 'Walls', IFCWALLSTANDARDCASE: 'Walls', IFCWALLELEMENTEDCASE: 'Walls',
  IFCSLAB: 'Floors', IFCSLABSTANDARDCASE: 'Floors', IFCROOF: 'Roofs',
  IFCCOLUMN: 'Structural Columns', IFCBEAM: 'Structural Framing',
  IFCFOOTING: 'Structural Foundations', IFCPILE: 'Structural Foundations',
  IFCWINDOW: 'Windows', IFCDOOR: 'Doors', IFCCURTAINWALL: 'Curtain Walls',
  IFCPLATE: 'Curtain Panels', IFCMEMBER: 'Curtain Wall Mullions', IFCCOVERING: 'Ceilings',
  IFCSTAIR: 'Stairs', IFCSTAIRFLIGHT: 'Stairs', IFCRAILING: 'Railings', IFCRAMP: 'Ramps',
  IFCRAMPFLIGHT: 'Ramps', IFCFURNISHINGELEMENT: 'Furniture', IFCFURNITURE: 'Furniture',
  IFCBUILDINGELEMENTPROXY: 'Generic Models', IFCREINFORCINGBAR: 'Structural Rebar',
};
const SKIP_CLASSES = new Set(['IFCSPACE', 'IFCOPENINGELEMENT', 'IFCANNOTATION', 'IFCGRID', 'IFCVIRTUALELEMENT']);

/** Element record: {uid, mesh, category, family, type, elementId, ifcClass, volume, area} */
function makeElement(geometry, info) {
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const { volume, area } = measure(geometry);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color: 0xcccccc }));
  const el = { uid: 0, mesh, volume, area, ...info };
  mesh.userData.element = el;
  return el;
}

// Volume via signed tetrahedra; face area = the largest group of coplanar-
// direction triangles (opposite faces merged), i.e. a wall's or slab's face.
export function measure(geometry) {
  const pos = geometry.attributes.position;
  const idx = geometry.index;
  const n = idx ? idx.count : pos.count;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), cr = new THREE.Vector3();
  let vol = 0;
  const buckets = new Map();
  for (let i = 0; i < n; i += 3) {
    const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    vol += a.dot(cr.crossVectors(b, c)) / 6;
    ab.subVectors(b, a); ac.subVectors(c, a); cr.crossVectors(ab, ac);
    const twiceArea = cr.length();
    if (twiceArea < 1e-12) continue;
    cr.divideScalar(twiceArea);
    // Canonical direction so opposite faces share a bucket.
    if (cr.x < -1e-6 || (Math.abs(cr.x) <= 1e-6 && (cr.y < -1e-6 || (Math.abs(cr.y) <= 1e-6 && cr.z < 0)))) cr.negate();
    const k = `${Math.round(cr.x * 20)},${Math.round(cr.y * 20)},${Math.round(cr.z * 20)}`;
    buckets.set(k, (buckets.get(k) || 0) + twiceArea / 2);
  }
  let maxBucket = 0;
  for (const v of buckets.values()) maxBucket = Math.max(maxBucket, v);
  return { volume: Math.abs(vol), area: maxBucket / 2 };
}

// Revit Z-up (x, y, z) -> three.js Y-up (x, z, -y)
const toYUp = (x, y, z) => [x, z, -y];

export function loadDemoModel() {
  const elements = [];
  for (const e of buildDemoElements()) {
    const [x0, y0, z0] = toYUp(e.min[0], e.min[1], e.min[2]);
    const [x1, y1, z1] = toYUp(e.max[0], e.max[1], e.max[2]);
    const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    elements.push(makeElement(g, {
      category: e.category, family: e.family, type: e.type, elementId: e.elementId,
      ifcClass: null, name: `${e.family}: ${e.type}`,
    }));
  }
  return { elements, name: 'Demo building' };
}

let ifcApiPromise = null;
async function getIfcApi() {
  if (!ifcApiPromise) ifcApiPromise = (async () => {
    const WebIFC = await import(/* @vite-ignore */ WEB_IFC_BASE + 'web-ifc-api.js');
    const api = new WebIFC.IfcAPI();
    api.SetWasmPath(WEB_IFC_BASE, true);
    await api.Init(undefined, true);
    return { api, WebIFC };
  })();
  return ifcApiPromise;
}

const val = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);

function splitFamilyType(s) {
  s = String(s || '').trim();
  const i = s.indexOf(':');
  return i < 0 ? { family: '', type: s } : { family: s.slice(0, i).trim(), type: s.slice(i + 1).trim() };
}

export async function loadIfcModel(file, onProgress = () => {}) {
  onProgress('Loading IFC engine…');
  const { api, WebIFC } = await getIfcApi();
  onProgress('Parsing IFC…');
  const data = new Uint8Array(await file.arrayBuffer());
  const modelID = api.OpenModel(data, { COORDINATE_TO_ORIGIN: true });

  // Element -> type object (IfcRelDefinesByType), for type names when ObjectType is empty.
  const typeOf = new Map();
  const rels = api.GetLineIDsWithType(modelID, WebIFC.IFCRELDEFINESBYTYPE);
  for (let i = 0; i < rels.size(); i++) {
    const rel = api.GetLine(modelID, rels.get(i));
    const t = val(rel.RelatingType);
    for (const o of rel.RelatedObjects || []) typeOf.set(val(o), t);
  }

  const elements = [];
  const tmpM = new THREE.Matrix4(), tmpN = new THREE.Matrix3();
  const v = new THREE.Vector3(), nrm = new THREE.Vector3();
  let count = 0;

  api.StreamAllMeshes(modelID, (flat) => {
    const expressID = flat.expressID;
    const cls = String(api.GetNameFromTypeCode(api.GetLineType(modelID, expressID)) || '').toUpperCase();
    if (SKIP_CLASSES.has(cls)) return;
    const positions = [], normals = [], indices = [];
    for (let g = 0; g < flat.geometries.size(); g++) {
      const pg = flat.geometries.get(g);
      const geom = api.GetGeometry(modelID, pg.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      tmpM.fromArray(pg.flatTransformation);
      tmpN.getNormalMatrix(tmpM);
      const base = positions.length / 3;
      for (let k = 0; k < verts.length; k += 6) {
        v.set(verts[k], verts[k + 1], verts[k + 2]).applyMatrix4(tmpM);
        nrm.set(verts[k + 3], verts[k + 4], verts[k + 5]).applyMatrix3(tmpN).normalize();
        positions.push(v.x, v.y, v.z);
        normals.push(nrm.x, nrm.y, nrm.z);
      }
      for (let k = 0; k < idx.length; k++) indices.push(idx[k] + base);
      geom.delete?.();
    }
    if (!indices.length) return;

    const line = api.GetLine(modelID, expressID);
    let ft = splitFamilyType(val(line.ObjectType));
    const typeId = typeOf.get(expressID);
    if (!ft.type && typeId) {
      const t = api.GetLine(modelID, typeId);
      ft = { family: val(t.ElementType) || '', type: val(t.Name) || '' };
    }
    if (!ft.type) {
      // Revit names instances "Family:Type:ElementId"
      const nm = String(val(line.Name) || '').replace(/:\d+$/, '');
      ft = splitFamilyType(nm);
    }
    let category = IFC_TO_CATEGORY[cls] || cls.replace(/^IFC/, '');
    if (cls.startsWith('IFCSLAB') && /ROOF/i.test(String(val(line.PredefinedType) || ''))) category = 'Roofs';

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    g.setIndex(indices);
    elements.push(makeElement(g, {
      category, family: ft.family, type: ft.type,
      elementId: String(val(line.Tag) ?? '') || null,
      globalId: val(line.GlobalId) || null,
      ifcClass: cls, name: val(line.Name) || `${ft.family}: ${ft.type}`,
    }));
    if (++count % 200 === 0) onProgress(`Building meshes… ${count}`);
  });

  api.CloseModel(modelID);
  return { elements, name: file.name };
}
