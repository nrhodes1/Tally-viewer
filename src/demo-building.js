// A small procedural demo building: 4-story mass-timber office with a concrete
// core, steel transfer beams, a glazed ground-floor storefront and a couple of
// hempcrete walls. Every element is an axis-aligned box in Revit-style Z-up
// meters, tagged with the Category / Family / Type a Revit model would carry.
//
// Shared by the browser viewer (demo mode) and tools/make-samples.mjs (which
// writes sample/demo-building.ifc and sample/sample-tally.csv from it).

export const IFC_CLASS = {
  'Walls': 'IFCWALL',
  'Floors': 'IFCSLAB',
  'Roofs': 'IFCROOF',
  'Structural Columns': 'IFCCOLUMN',
  'Structural Framing': 'IFCBEAM',
  'Structural Foundations': 'IFCFOOTING',
  'Curtain Panels': 'IFCPLATE',
  'Curtain Wall Mullions': 'IFCMEMBER',
};

export function buildDemoElements() {
  const els = [];
  let nextId = 310000;
  const add = (category, family, type, x0, y0, z0, x1, y1, z1) => {
    els.push({
      elementId: String(nextId++),
      category, family, type,
      min: [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)],
      max: [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)],
    });
  };

  const W = 24, D = 16, H = 3.6, LEVELS = 4;
  const gx = [0, 6, 12, 18, 24];
  const gy = [0, 8, 16];

  // Foundations + slab on grade
  for (const x of gx) for (const y of gy)
    add('Structural Foundations', 'Footing-Rectangular', 'Footing - Concrete 2000x2000x600',
      x - 1, y - 1, -0.8, x + 1, y + 1, -0.2);
  add('Floors', 'Floor', 'Slab on Grade - Concrete 200', -0.2, -0.2, -0.2, W + 0.2, D + 0.2, 0);

  for (let L = 0; L < LEVELS; L++) {
    const z0 = L * H, z1 = z0 + H;
    const slabT = 0.225;

    // Glulam columns
    for (const x of gx) for (const y of gy)
      add('Structural Columns', 'Glulam Column', 'GL24h 300x300',
        x - 0.15, y - 0.15, z0, x + 0.15, y + 0.15, z1 - slabT - 0.6);

    // Glulam beams along X on each grid line (under the slab above)
    for (const y of gy) for (let i = 0; i < gx.length - 1; i++)
      add('Structural Framing', 'Glulam Beam', 'GL28h 240x600',
        gx[i] + 0.15, y - 0.12, z1 - slabT - 0.6, gx[i + 1] - 0.15, y + 0.12, z1 - slabT);

    // Steel transfer beams along Y, first suspended level only
    if (L === 0) for (const x of gx) for (let j = 0; j < gy.length - 1; j++)
      add('Structural Framing', 'W-Wide Flange', 'W360x51 Steel',
        x - 0.09, gy[j] + 0.15, z1 - slabT - 0.36, x + 0.09, gy[j + 1] - 0.15, z1 - slabT);

    // Suspended CLT floor (or roof at top) per 6x8 bay
    for (let i = 0; i < gx.length - 1; i++) for (let j = 0; j < gy.length - 1; j++) {
      if (L === LEVELS - 1)
        add('Roofs', 'Basic Roof', 'CLT 200 + Wood Fiber 200 + EPDM',
          gx[i], gy[j], z1 - 0.2, gx[i + 1], gy[j + 1], z1 + 0.25);
      else
        add('Floors', 'Floor', 'CLT 5-ply 175 + Concrete Topping 50',
          gx[i], gy[j], z1 - slabT, gx[i + 1], gy[j + 1], z1);
    }

    // Concrete core (lift + stair) in the middle bay
    const cx0 = 9, cx1 = 15, cy0 = 5.5, cy1 = 10.5, t = 0.3;
    add('Walls', 'Basic Wall', 'Core - Concrete 300', cx0, cy0, z0, cx1, cy0 + t, z1);
    add('Walls', 'Basic Wall', 'Core - Concrete 300', cx0, cy1 - t, z0, cx1, cy1, z1);
    add('Walls', 'Basic Wall', 'Core - Concrete 300', cx0, cy0 + t, z0, cx0 + t, cy1 - t, z1);
    add('Walls', 'Basic Wall', 'Core - Concrete 300', cx1 - t, cy0 + t, z0, cx1, cy1 - t, z1);

    // Long facades (south y=0, north y=D)
    for (let i = 0; i < gx.length - 1; i++) {
      const xa = gx[i] + 0.15, xb = gx[i + 1] - 0.15;
      // South
      if (L === 0) {
        // Storefront: two glazed panels + mullions per bay
        const zt = z1 - slabT;
        const xm = (xa + xb) / 2;
        add('Curtain Panels', 'System Panel', 'Glazed - Triple IGU', xa + 0.05, -0.36, z0 + 0.05, xm - 0.025, -0.33, zt - 0.05);
        add('Curtain Panels', 'System Panel', 'Glazed - Triple IGU', xm + 0.025, -0.36, z0 + 0.05, xb - 0.05, -0.33, zt - 0.05);
        for (const xx of [xa, xm, xb])
          add('Curtain Wall Mullions', 'Rectangular Mullion', 'Aluminum 50x150',
            xx - 0.025, -0.42, z0, xx + 0.025, -0.27, zt);
        add('Curtain Wall Mullions', 'Rectangular Mullion', 'Aluminum 50x150', xa, -0.42, zt - 0.05, xb, -0.27, zt);
        add('Curtain Wall Mullions', 'Rectangular Mullion', 'Aluminum 50x150', xa, -0.42, z0, xb, -0.27, z0 + 0.05);
      } else {
        add('Walls', 'Basic Wall', 'Ext - CLT 120 + Wood Fiber 160', gx[i], -0.47, z0, gx[i + 1], -0.15, z1);
      }
      // North
      add('Walls', 'Basic Wall', 'Ext - CLT 120 + Wood Fiber 160', gx[i], D + 0.15, z0, gx[i + 1], D + 0.47, z1);
    }
    // Short facades (west x=0, east x=W) - brick veneer on steel stud
    for (let j = 0; j < gy.length - 1; j++) {
      add('Walls', 'Basic Wall', 'Ext - Brick Veneer + Steel Stud', -0.45, gy[j], z0, -0.15, gy[j + 1], z1);
      add('Walls', 'Basic Wall', 'Ext - Brick Veneer + Steel Stud', W + 0.15, gy[j], z0, W + 0.45, gy[j + 1], z1);
    }

    // Interior partitions
    const zt = z1 - slabT;
    add('Walls', 'Basic Wall', 'Int - Gypsum on Wood Stud 150', 3, 12, z0, 9, 12.15, zt);
    add('Walls', 'Basic Wall', 'Int - Gypsum on Wood Stud 150', 15, 12, z0, 21, 12.15, zt);
    add('Walls', 'Basic Wall', 'Int - Gypsum on Wood Stud 150', 3, 4, z0, 9, 4.15, zt);
    if (L === 0) {
      add('Walls', 'Basic Wall', 'Int - Hempcrete 300', 15, 3.5, z0, 21, 3.8, zt);
      add('Walls', 'Basic Wall', 'Int - Hempcrete 300', 18, 3.8, z0, 18.3, 8, zt);
    } else {
      add('Walls', 'Basic Wall', 'Int - Gypsum on Wood Stud 150', 15, 4, z0, 21, 4.15, zt);
    }
  }
  return els;
}

// Per-type material build-ups used to synthesize the sample Tally export.
// basis: 'area' -> values per m2 of face area, 'volume' -> per m3.
// Each material: [name, massPerUnit kg, A1-A3, A4, B2-B5, C2-C4, D, biogenic]
export const DEMO_ASSEMBLIES = {
  'Footing - Concrete 2000x2000x600': { basis: 'volume', materials: [
    ['Ready-mix concrete, 30 MPa', 2400, 285, 9, 0, 14, -4, 0],
    ['Reinforcing steel', 90, 105, 2, 0, 1, -38, 0],
  ]},
  'Slab on Grade - Concrete 200': { basis: 'area', materials: [
    ['Ready-mix concrete, 25 MPa', 480, 52, 1.8, 0, 2.7, -0.8, 0],
    ['Welded wire mesh', 4, 6.2, 0.1, 0, 0.1, -2.1, 0],
    ['XPS insulation 50mm', 1.6, 9.4, 0.2, 0, 0.6, 0, 0],
    ['Polyethylene vapor barrier', 0.2, 0.6, 0, 0, 0.1, 0, 0],
  ]},
  'GL24h 300x300': { basis: 'volume', materials: [
    ['Glulam, softwood', 470, 168, 14, 0, 22, -95, -812],
  ]},
  'GL28h 240x600': { basis: 'volume', materials: [
    ['Glulam, softwood', 480, 171, 14, 0, 22, -96, -829],
    ['Steel connectors', 8, 21, 0.2, 0, 0.1, -7, 0],
  ]},
  'W360x51 Steel': { basis: 'volume', materials: [
    // per m3 of bounding box (a W360x51 fills ~10% of its box)
    ['Hot-rolled structural steel', 787, 945, 12, 0, 9, -430, 0],
    ['Intumescent coating', 6, 38, 0.3, 22, 0.5, 0, 0],
  ]},
  'CLT 5-ply 175 + Concrete Topping 50': { basis: 'area', materials: [
    ['Cross-laminated timber, 175mm', 82, 23.1, 2.4, 0, 3.6, -13.2, -138],
    ['Concrete topping 50mm', 120, 14.6, 0.5, 0, 0.7, -0.2, 0],
    ['Acoustic underlayment', 1.5, 2.1, 0.1, 1.2, 0.2, 0, 0],
  ]},
  'CLT 200 + Wood Fiber 200 + EPDM': { basis: 'area', materials: [
    ['Cross-laminated timber, 200mm', 94, 26.4, 2.7, 0, 4.1, -15.1, -158],
    ['Wood fiber insulation board', 30, 17.8, 0.9, 0, 1.2, -6.4, -47],
    ['EPDM membrane', 1.9, 6.8, 0.1, 6.8, 0.4, 0, 0],
  ]},
  'Core - Concrete 300': { basis: 'volume', materials: [
    ['Ready-mix concrete, 35 MPa', 2400, 318, 9, 0, 14, -4, 0],
    ['Reinforcing steel', 130, 152, 3, 0, 1.5, -55, 0],
  ]},
  'Ext - CLT 120 + Wood Fiber 160': { basis: 'area', materials: [
    ['Cross-laminated timber, 120mm', 56, 15.8, 1.6, 0, 2.5, -9, -95],
    ['Wood fiber insulation board', 24, 14.2, 0.7, 0, 1, -5.1, -38],
    ['Timber cladding, larch', 11, 2.9, 0.3, 2.9, 0.4, -1.8, -18],
    ['Breather membrane', 0.2, 0.9, 0, 0, 0.1, 0, 0],
  ]},
  'Ext - Brick Veneer + Steel Stud': { basis: 'area', materials: [
    ['Clay brick', 175, 42, 3.1, 0, 1.6, -0.5, 0],
    ['Light-gauge steel stud', 6.2, 16.4, 0.1, 0, 0.1, -5.8, 0],
    ['Mineral wool insulation', 6.0, 7.8, 0.3, 0, 0.3, 0, 0],
    ['Gypsum board, 2 layers', 20, 5.2, 0.3, 0, 0.9, 0, 0],
    ['Gypsum sheathing', 9, 2.6, 0.1, 0, 0.4, 0, 0],
  ]},
  'Glazed - Triple IGU': { basis: 'area', materials: [
    ['Float glass, 3 panes', 30, 46, 1.6, 46, 0.9, -3, 0],
    ['IGU spacers + sealant', 1.2, 9.5, 0.1, 9.5, 0.2, 0, 0],
  ]},
  'Aluminum 50x150': { basis: 'volume', materials: [
    // per m3 of bounding box (hollow section)
    ['Extruded aluminum, anodized', 540, 5600, 22, 0, 15, -2250, 0],
    ['Thermal break, polyamide', 25, 175, 1, 0, 2.5, 0, 0],
  ]},
  'Int - Gypsum on Wood Stud 150': { basis: 'area', materials: [
    ['Gypsum board, 2 layers', 20, 5.2, 0.3, 0, 0.9, 0, 0],
    ['Softwood stud', 5, 1.4, 0.2, 0, 0.3, -0.9, -8.6],
    ['Mineral wool insulation', 4, 5.2, 0.2, 0, 0.2, 0, 0],
  ]},
  'Int - Hempcrete 300': { basis: 'area', materials: [
    ['Hempcrete block', 99, 24, 1.1, 0, 1.4, -1.2, -66],
    ['Lime plaster, both sides', 30, 6.1, 0.3, 0, 0.4, 0, 0],
  ]},
};

export const DEMO_STAGES = ['A1-A3', 'A4', 'B2-B5', 'C2-C4', 'D'];
