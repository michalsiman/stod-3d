import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { NIGHT } from './night.js';
import { bang, scream, createDebris, createSmoke, createSirens } from './gta.js';

// Projížďka autem: arkádová jízda po silnicích a cestách Stodska.
//   Rychlost podle povrchu (silnice, ulice, štěrk, polní cesta, mimo cestu), náklon auta podle terénu,
//   mosty, srážky s budovami, kamera za autem (C přepíná pohled), tachometr s názvem ulice,
//   zvuk motoru (WebAudio, M vypne) a na mobilu dotykové pedály.

// typy komunikací – stejné jako v roads.js (tools/build_data.py ROAD)
const WIDTH = [8.5, 6.5, 5.0, 3.5, 3.2, 3.0, 2.6, 1.2, 4.2];
const LIFT = [0.34, 0.34, 0.34, 0.34, 0.31, 0.3, 0.29, 0.28, 0.36];
const MAX_SPEED = [46, 38, 26, 25, 21, 17, 13, 8, 0];            // [m/s] na daném povrchu (železnice = mimo cestu)
const GRIP = [1, 1, 1, 1, 0.95, 0.8, 0.72, 0.7, 0.6];
const SURFACE_NAME = ['silnice I. třídy', 'silnice', 'ulice', 'asfaltová cesta', 'panelová cesta', 'štěrková cesta',
  'polní cesta', 'pěšina', 'železnice'];
const OFFROAD = { max: 16.7, grip: 0.6, rolling: 1.6 };
const CELL = 32;

// ---------------------------------------------------------------- prostorové indexy
function segIndex(lines) {
  const grid = new Map();
  const put = (k, v) => { let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(v); };
  for (const line of lines) {
    const p = line.p;
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      const pad = (line.w || 0) / 2 + 2;
      const x0 = Math.floor((Math.min(a[0], b[0]) - pad) / CELL), x1 = Math.floor((Math.max(a[0], b[0]) + pad) / CELL);
      const z0 = Math.floor((Math.min(a[1], b[1]) - pad) / CELL), z1 = Math.floor((Math.max(a[1], b[1]) + pad) / CELL);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) put(`${x},${z}`, { line, a, b });
    }
  }
  return grid;
}

function nearestSeg(grid, x, z, filter) {
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  let best = null;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (const s of grid.get(`${cx + dx},${cz + dz}`) || []) {
        if (filter && !filter(s.line)) continue;
        const ax = s.a[0], az = s.a[1], bx = s.b[0] - ax, bz = s.b[1] - az;
        const l2 = bx * bx + bz * bz || 1;
        const t = THREE.MathUtils.clamp(((x - ax) * bx + (z - az) * bz) / l2, 0, 1);
        const d = Math.hypot(x - ax - t * bx, z - az - t * bz);
        if (!best || d < best.d) best = { d, t, s, dir: Math.atan2(bz, bx) };
      }
    }
  }
  return best;
}

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function buildingIndex(buildings) {
  const grid = new Map();
  for (const b of buildings) {
    const ring = b.rings?.[0];
    if (!ring || ring.length < 3 || (b.ridge ?? 3) < 1.8) continue;          // kůlny a přístřešky projedeme
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const item = { ring, x0, x1, z0, z1 };
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const k = `${cx},${cz}`;
        let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(item);
      }
    }
  }
  return (x, z) => {
    for (const it of grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) || []) {
      if (x >= it.x0 && x <= it.x1 && z >= it.z0 && z <= it.z1 && pointInRing(x, z, it.ring)) return true;
    }
    return false;
  };
}

// ---------------------------------------------------------------- model auta
const PAINTS = [0xc8283a, 0x2f6fd6, 0xf0f0ec, 0x2b2f36, 0x2f9e6e, 0xf2b630];

function shape(pts) {
  // [x, y] nebo ['q', cx, cy, x, y] (kvadratická křivka)
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) {
    if (p[0] === 'q') s.quadraticCurveTo(p[1], p[2], p[3], p[4]);
    else s.lineTo(p[0], p[1]);
  }
  return s;
}

function extrude(sh, width, bevel, mat) {
  const g = new THREE.ExtrudeGeometry(sh, {
    depth: width - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: 3,
    curveSegments: 10,
  });
  g.translate(0, 0, -(width - 2 * bevel) / 2);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  return m;
}

/** Sloučí potomky skupiny podle materiálu do jedné sítě na materiál (méně volání kreslení). */
function mergeByMaterial(group) {
  const byMat = new Map();
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const keep = [];
  for (const o of [...group.children]) {
    if (!o.isMesh) { keep.push(o); continue; }
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal'].includes(name)) g.deleteAttribute(name);
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    if (!byMat.has(o.material)) byMat.set(o.material, []);
    byMat.get(o.material).push(g);
    group.remove(o);
  }
  for (const [mat, list] of byMat) {
    const m = new THREE.Mesh(mergeGeometries(list), mat);
    m.castShadow = true;
    group.add(m);
  }
}

/** Nízkopolygonové auto (x dopředu, y nahoru, délka 4,4 m): karoserie, prosklená kabina, střecha, kola, světla. */
export function createCarModel(paint = PAINTS[0], { lights = true, type = 'car' } = {}) {
  if (type !== 'car') return buildVehicle(type, paint, lights);
  const car = new THREE.Group();
  const body = new THREE.Group();
  car.add(body);
  const paintMat = new THREE.MeshStandardMaterial({ color: paint, roughness: 0.32, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.06, metalness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.85 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd8dbe0, roughness: 0.25, metalness: 0.9 });
  const head = new THREE.MeshStandardMaterial({ color: 0xfff6dc, emissive: 0xfff2c8, emissiveIntensity: 0.6 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x8a0f12, emissive: 0xff2020, emissiveIntensity: 0.5 });
  const W = 1.8;

  // spodní karoserie až po linii oken
  body.add(extrude(shape([
    [-2.15, 0.34], [2.05, 0.34], ['q', 2.22, 0.36, 2.22, 0.62], ['q', 2.2, 0.86, 1.95, 0.9], [0.92, 1.02],
    [-1.62, 1.05], ['q', -2.14, 1.02, -2.22, 0.8], [-2.22, 0.48], ['q', -2.22, 0.36, -2.15, 0.34],
  ]), W, 0.08, paintMat));
  // kabina ze skla
  const cabin = [[0.95, 1.0], ['q', 0.56, 1.1, 0.16, 1.43], [-1.02, 1.45], ['q', -1.34, 1.41, -1.62, 1.03], [0.95, 1.0]];
  body.add(extrude(shape(cabin), W - 0.3, 0.05, glass));
  // střecha a sloupky
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.22, 0.07, W - 0.3), paintMat);
  roof.position.set(-0.43, 1.475, 0); roof.castShadow = true; body.add(roof);
  const post = (x0, y0, x1, y1, w = 0.07) => {
    const L = Math.hypot(x1 - x0, y1 - y0);
    for (const z of [1, -1]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(L, w, 0.06), paintMat);
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, z * ((W - 0.3) / 2 + 0.01));
      m.rotation.z = Math.atan2(y1 - y0, x1 - x0);
      body.add(m);
    }
  };
  post(0.95, 1.01, 0.16, 1.44);           // A
  post(-0.42, 1.04, -0.42, 1.46, 0.09);   // B
  post(-1.02, 1.46, -1.62, 1.04, 0.1);    // C

  // světla, mřížka, nárazníky, prahy, zrcátka
  for (const z of [0.58, -0.58]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.13, 0.38), head);
    h.position.set(2.24, 0.74, z); body.add(h);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.42), tail);
    t.position.set(-2.26, 0.84, z); body.add(t);
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.11, 0.16), paintMat);
    mirror.position.set(0.78, 1.06, Math.sign(z) * (W / 2 + 0.07)); body.add(mirror);
  }
  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.15, 0.66), dark);
  grille.position.set(2.235, 0.58, 0); body.add(grille);
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.6 });
  for (const x of [2.2, -2.22]) {
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.15, W + 0.02), dark);
    bumper.position.set(x, 0.42, 0); body.add(bumper);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.11, 0.5), plateMat);
    plate.position.set(x + Math.sign(x) * 0.09, x > 0 ? 0.43 : 0.62, 0); body.add(plate);
  }
  const sill = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.1, W + 0.02), dark);
  sill.position.set(-0.05, 0.37, 0); body.add(sill);

  // kola (s podběhy)
  const tireG = new THREE.CylinderGeometry(0.35, 0.35, 0.25, 22).rotateX(Math.PI / 2);
  const rimG = new THREE.CylinderGeometry(0.22, 0.22, 0.26, 12).rotateX(Math.PI / 2);
  const hubG = new THREE.BoxGeometry(0.05, 0.38, 0.265);
  const archG = new THREE.CylinderGeometry(0.42, 0.42, 0.06, 20, 1, false, 0, Math.PI).rotateX(Math.PI / 2);
  const wheels = [];
  for (const [x, z] of [[1.38, 0.79], [1.38, -0.79], [-1.32, 0.79], [-1.32, -0.79]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.35, z);
    const spin = new THREE.Group();
    const tire = new THREE.Mesh(tireG, dark);
    tire.castShadow = true;
    spin.add(tire, new THREE.Mesh(rimG, chrome));
    for (let k = 0; k < 3; k++) { const s = new THREE.Mesh(hubG, chrome); s.rotation.z = (k * Math.PI) / 3; spin.add(s); }
    mergeByMaterial(spin);
    pivot.add(spin);
    car.add(pivot);
    const arch = new THREE.Mesh(archG, dark);
    arch.position.set(x, 0.36, Math.sign(z) * (W / 2 + 0.005));
    body.add(arch);
    wheels.push({ pivot, spin, front: x > 0 });
  }

  mergeByMaterial(body);
  // reflektory do noci (jen naše auto – světla stojí výkon)
  const beams = [];
  for (const z of lights ? [0.55, -0.55] : []) {
    const sp = new THREE.SpotLight(0xfff1d6, 0, 70, 0.45, 0.6, 1.2);
    sp.position.set(2.2, 0.76, z);
    sp.target.position.set(12, -0.6, z * 3);
    body.add(sp, sp.target);
    beams.push(sp);
  }
  return { car, body, wheels, beams, head, tail, paintMat, spec: SPECS.car };
}

// ---------------------------------------------------------------- další typy vlastního auta
// spec: nose/tail = přední a zadní hrana od středu, wb = rozvor, vmax/acc = násobky rychlosti a zrychlení,
// off = násobek rychlosti mimo cestu, cap = nejvyšší rychlost (m/s), cam = násobek vzdálenosti kamery
const SPECS = {
  car: { name: 'Osobní auto', nose: 2.25, tail: 2.25, wb: 2.6, vmax: 1, acc: 1, off: 1, cap: 50, cam: 1, hw: 0.95 },
  race: { name: 'Závoďák', nose: 2.4, tail: 2.3, wb: 2.85, vmax: 1.4, acc: 1.7, off: 0.7, cap: 75, cam: 1, hw: 1.0, grip: 1.2 },
  offroad: { name: 'Teréňák', nose: 2.4, tail: 2.45, wb: 2.9, vmax: 0.95, acc: 1, off: 1.9, cap: 45, cam: 1.15, hw: 1.0, offGrip: 1 },
  truck: { name: 'Náklaďák', nose: 3.5, tail: 3.9, wb: 4.95, vmax: 0.72, acc: 0.5, off: 0.8, cap: 25, cam: 1.6, hw: 1.25 },
  tractor: { name: 'Traktor', nose: 2.05, tail: 1.65, wb: 2.35, vmax: 1, acc: 0.55, off: 1, cap: 11.2, cam: 1.25, hw: 1.1, offGrip: 1 },
};
const CAR_TYPES = Object.keys(SPECS);

function buildVehicle(type, paint, lights) {
  const spec = SPECS[type];
  const car = new THREE.Group();
  const body = new THREE.Group();
  car.add(body);
  const paintMat = new THREE.MeshStandardMaterial({ color: paint, roughness: 0.32, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.06, metalness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.85 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd8dbe0, roughness: 0.25, metalness: 0.9 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.5 });
  const head = new THREE.MeshStandardMaterial({ color: 0xfff6dc, emissive: 0xfff2c8, emissiveIntensity: 0.6 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x8a0f12, emissive: 0xff2020, emissiveIntensity: 0.5 });
  const box = (sx, sy, sz, x, y, z, mat, parent = body) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m;
  };
  const wheels = [];
  const wheel = (x, z, r, w, front) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, r, z);
    const spin = new THREE.Group();
    spin.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 24).rotateX(Math.PI / 2), dark));
    spin.add(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.6, r * 0.6, w + 0.01, 12).rotateX(Math.PI / 2), type === 'tractor' ? white : chrome));
    for (let k = 0; k < 3; k++) { const h = new THREE.Mesh(new THREE.BoxGeometry(0.06, r * 1.1, w + 0.015), dark); h.rotation.z = (k * Math.PI) / 3; spin.add(h); }
    if (r > 0.6) for (let k = 0; k < 12; k++) {                 // vzorek traktorové pneumatiky
      const a = (k / 12) * Math.PI * 2, l = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, w * 0.9), dark);
      l.position.set(Math.cos(a) * r, Math.sin(a) * r, 0); l.rotation.z = a; spin.add(l);
    }
    spin.children.forEach((c) => { c.castShadow = true; });
    mergeByMaterial(spin);
    pivot.add(spin);
    car.add(pivot);
    wheels.push({ pivot, spin, front, r });
  };
  let headPos = [], tailPos = [];
  if (type === 'race') {
    const W = 1.96;
    body.add(extrude(shape([[-2.25, 0.18], [2.25, 0.18], ['q', 2.42, 0.2, 2.42, 0.36], ['q', 2.32, 0.5, 1.6, 0.6], [0.55, 0.74],
      [-1.75, 0.82], ['q', -2.3, 0.82, -2.3, 0.56], [-2.3, 0.3], ['q', -2.3, 0.18, -2.25, 0.18]]), W, 0.08, paintMat));
    body.add(extrude(shape([[0.62, 0.72], ['q', 0.05, 0.8, -0.35, 1.1], [-0.95, 1.12], ['q', -1.35, 1.08, -1.72, 0.8], [0.62, 0.72]]), W - 0.5, 0.05, glass));
    box(0.42, 0.05, W, -2.05, 1.12, 0, paintMat);                            // spoiler
    for (const z of [0.6, -0.6]) box(0.12, 0.34, 0.05, -2.05, 0.95, z, dark);
    box(4.5, 0.02, 0.26, 0, 0.64, 0.25, white); box(4.5, 0.02, 0.26, 0, 0.64, -0.25, white);   // pruhy přes kapotu
    for (const z of [W / 2 + 0.01, -W / 2 - 0.01]) box(1.4, 0.12, 0.02, -0.3, 0.42, z, white);
    box(0.2, 0.1, W + 0.04, 2.36, 0.2, 0, dark);
    wheel(1.5, 0.86, 0.33, 0.3, true); wheel(1.5, -0.86, 0.33, 0.3, true);
    wheel(-1.35, 0.88, 0.35, 0.34, false); wheel(-1.35, -0.88, 0.35, 0.34, false);
    headPos = [2.38, 0.42, 0.62]; tailPos = [-2.31, 0.58, 0.68];
  } else if (type === 'offroad') {
    const W = 1.95;
    body.add(extrude(shape([[-2.25, 0.62], [2.22, 0.62], [2.32, 0.76], [2.32, 1.2], [2.15, 1.3], [0.95, 1.36], [-2.22, 1.38], [-2.32, 1.26], [-2.32, 0.72]]), W, 0.06, paintMat));
    body.add(extrude(shape([[0.97, 1.34], [0.55, 1.98], [-2.1, 2.0], [-2.24, 1.37]]), W - 0.16, 0.04, glass));
    box(2.75, 0.08, W - 0.1, -0.78, 2.03, 0, paintMat);
    for (const x of [-1.8, -1.1, -0.4, 0.3]) box(0.06, 0.06, W - 0.2, x, 2.13, 0, dark);   // střešní nosič
    for (const z of [0.85, -0.85]) box(2.4, 0.06, 0.06, -0.75, 2.16, z, dark);
    box(0.12, 0.42, W - 0.3, 2.42, 0.92, 0, dark);                          // ochranný rám
    box(0.16, 0.14, W + 0.04, 2.36, 0.66, 0, dark); box(0.16, 0.14, W + 0.04, -2.36, 0.66, 0, dark);
    const spare = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.28, 20).rotateZ(Math.PI / 2), dark);
    spare.position.set(-2.5, 1.12, 0); body.add(spare);
    for (const z of [W / 2 + 0.03, -W / 2 - 0.03]) box(4.3, 0.18, 0.04, 0, 0.7, z, dark);   // lemy
    wheel(1.45, 0.92, 0.46, 0.34, true); wheel(1.45, -0.92, 0.46, 0.34, true);
    wheel(-1.45, 0.92, 0.46, 0.34, false); wheel(-1.45, -0.92, 0.46, 0.34, false);
    headPos = [2.34, 1.04, 0.66]; tailPos = [-2.34, 1.0, 0.8];
  } else if (type === 'truck') {
    const W = 2.4;
    box(7.2, 0.3, 1.2, -0.25, 0.82, 0, dark);                                 // rám
    body.add(extrude(shape([[1.6, 0.95], [3.45, 0.95], [3.45, 2.2], [3.3, 2.95], [1.6, 3.0]]), W, 0.06, paintMat));   // kabina
    box(0.05, 0.75, W - 0.3, 3.4, 2.5, 0, glass);
    for (const z of [W / 2 - 0.2, -W / 2 + 0.2]) box(0.9, 0.55, 0.05, 2.75, 2.35, z * 1.02 + Math.sign(z) * 0.04, glass);
    box(5.3, 2.35, W + 0.05, -1.25, 2.2, 0, white);                           // skříň
    box(5.32, 0.12, W + 0.07, -1.25, 1.06, 0, paintMat);
    box(0.2, 0.25, W + 0.05, 3.5, 0.78, 0, dark);
    wheel(2.5, 1.02, 0.52, 0.42, true); wheel(2.5, -1.02, 0.52, 0.42, true);
    for (const x of [-1.9, -3.05]) { wheel(x, 1.02, 0.52, 0.42, false); wheel(x, -1.02, 0.52, 0.42, false); }
    headPos = [3.47, 1.15, 0.85]; tailPos = [-3.92, 1.15, 1.0];
  } else {                                                                   // traktor
    box(3.4, 0.35, 0.7, 0.3, 0.75, 0, dark);
    body.add(extrude(shape([[0.15, 0.75], [1.95, 0.75], [2.05, 0.9], [2.05, 1.3], [1.9, 1.42], [0.15, 1.48]]), 0.86, 0.05, paintMat));   // kapota
    box(0.04, 0.4, 0.6, 2.06, 1.08, 0, dark);                                 // maska
    box(1.6, 1.25, 1.3, -0.65, 1.87, 0, glass);                               // kabina
    box(1.85, 0.12, 1.5, -0.65, 2.55, 0, paintMat);
    for (const [x, z] of [[0.13, 0.66], [0.13, -0.66], [-1.43, 0.66], [-1.43, -0.66]]) box(0.07, 1.3, 0.07, x, 1.88, z, dark);
    for (const z of [0.86, -0.86]) box(1.5, 0.08, 0.55, -0.85, 1.66, z, paintMat);   // blatníky
    box(1.6, 0.3, 1.1, -0.65, 1.2, 0, paintMat);
    const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 10), dark);
    ex.position.set(1.55, 1.95, 0.3); body.add(ex);
    wheel(1.4, 0.72, 0.45, 0.3, true); wheel(1.4, -0.72, 0.45, 0.3, true);
    wheel(-0.85, 0.86, 0.8, 0.5, false); wheel(-0.85, -0.86, 0.8, 0.5, false);
    headPos = [2.07, 1.2, 0.3]; tailPos = [-1.48, 1.55, 0.6];
  }
  for (const z of [headPos[2], -headPos[2]]) box(0.06, 0.14, 0.34, headPos[0], headPos[1], z, head);
  for (const z of [tailPos[2], -tailPos[2]]) box(0.06, 0.16, 0.36, tailPos[0], tailPos[1], z, tail);
  mergeByMaterial(body);
  const beams = [];
  for (const z of lights ? [0.55, -0.55] : []) {
    const sp = new THREE.SpotLight(0xfff1d6, 0, 70, 0.45, 0.6, 1.2);
    sp.position.set(headPos[0], headPos[1], z);
    sp.target.position.set(headPos[0] + 10, -0.6, z * 3);
    body.add(sp, sp.target);
    beams.push(sp);
  }
  return { car, body, wheels, beams, head, tail, paintMat, spec };
}

// ---------------------------------------------------------------- zvuk motoru
function createEngineSound() {
  let ctx = null, osc1, osc2, filt, gain, muted = false;
  try { muted = localStorage.getItem('stod3d.sound') === '0'; } catch { /* ignorovat */ }
  function start() {
    if (ctx || muted) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    osc1 = ctx.createOscillator(); osc1.type = 'sawtooth';
    osc2 = ctx.createOscillator(); osc2.type = 'square';
    filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 420; filt.Q.value = 3;
    gain = ctx.createGain(); gain.gain.value = 0;
    const g2 = ctx.createGain(); g2.gain.value = 0.35;
    osc1.connect(filt); osc2.connect(g2).connect(filt); filt.connect(gain).connect(ctx.destination);
    osc1.start(); osc2.start();
  }
  function update(rpm, load) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const f = 28 + rpm * 95;
    osc1.frequency.setTargetAtTime(f, t, 0.05);
    osc2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    filt.frequency.setTargetAtTime(260 + rpm * 520 + load * 500, t, 0.08);
    gain.gain.setTargetAtTime(muted ? 0 : 0.035 + load * 0.045, t, 0.08);
  }
  function stop() { if (ctx) { gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05); ctx.close(); ctx = null; } }
  function toggle() {
    muted = !muted;
    try { localStorage.setItem('stod3d.sound', muted ? '0' : '1'); } catch { /* ignorovat */ }
    if (muted) stop(); else start();
    return !muted;
  }
  return { start, update, stop, toggle, get on() { return !muted; } };
}

// ---------------------------------------------------------------- jízda
export function createDrive({ roads, bridges, buildings, streets, pois, world, scene, camera, onExit, onGta, obstacles = [] }) {
  const lines = roads.map((r) => ({ t: r.t, w: WIDTH[r.t], p: r.p }));
  const roadGrid = segIndex(lines);
  const streetGrid = segIndex((streets || []).flatMap((s) => s.paths.map((p) => ({ name: s.name, p, w: 10 }))));
  const hitsBuilding = buildingIndex(buildings);
  // sloupy (lampy, elektrické vedení, patníky): [x, z, poloměr] v mřížce 20 m
  const poleGrid = new Map();
  for (const o of obstacles) {
    const k = `${Math.floor(o[0] / 20)},${Math.floor(o[1] / 20)}`;
    let a = poleGrid.get(k); if (!a) poleGrid.set(k, a = []); a.push(o);
  }
  const segD = (px, pz, ax, az, bx, bz) => {
    const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
    return Math.hypot(ax + dx * t - px, az + dz * t - pz);
  };
  /** Sloup, do kterého auto (úsečka ±2 m podél osy, poloviční šířka 0,95 m) vjede při posunu z (x0,z0,h0) na (x1,z1,h1). */
  function poleHit(x0, z0, h0, x1, z1, h1) {
    const L = (model.spec.nose + model.spec.tail) / 2 - 0.25;
    const c1 = Math.cos(h1) * L, s1 = Math.sin(h1) * L, c0 = Math.cos(h0) * L, s0 = Math.sin(h0) * L;
    const cx = Math.floor(x1 / 20), cz = Math.floor(z1 / 20);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const o of poleGrid.get(`${cx + a},${cz + b}`) || []) {
        const d1 = segD(o[0], o[1], x1 - c1, z1 - s1, x1 + c1, z1 + s1);
        if (d1 > o[2] + model.spec.hw) continue;
        if (d1 < segD(o[0], o[1], x0 - c0, z0 - s0, x0 + c0, z0 + s0) - 1e-4) return o;
      }
    }
    return null;
  }
  // napojí main.js (doprava a lidé vznikají až po autě)
  const hooks = { traffic: null, life: null };
  const debris = createDebris(scene, world);
  const smoke = createSmoke(scene);
  const sirens = createSirens();
  let emergency = false;

  let paintIdx = 0;
  try { paintIdx = +(localStorage.getItem('stod3d.paint') || 0) % PAINTS.length; } catch { /* ignorovat */ }
  let carType = 'car';
  try { const t = localStorage.getItem('stod3d.carType'); if (SPECS[t]) carType = t; } catch { /* ignorovat */ }
  let model = createCarModel(PAINTS[paintIdx], { type: carType });
  model.car.visible = false;
  scene.add(model.car);
  const sound = createEngineSound();

  const st = {
    x: 0, z: 0, y: 0, heading: 0, v: 0, steer: 0, pitch: 0, roll: 0, active: false,
    view: 0, camPos: new THREE.Vector3(), camLook: new THREE.Vector3(), odo: 0, surface: -1,
  };
  const VIEWS = ['za autem', 'zdálky', 'z kabiny'];
  let lastLabel = '';

  // HUD
  const hud = document.createElement('div');
  hud.id = 'drive-hud';
  hud.hidden = true;
  hud.innerHTML = `
    <canvas class="dh-map" width="360" height="360"></canvas>
    <div class="dh-goal" hidden></div>
    <div class="dh-speed"><b>0</b><span>km/h</span></div>
    <div class="dh-where"><div class="dh-street">–</div><div class="dh-surface"></div></div>
    <div class="dh-tools">
      <button data-act="goal" title="Cíl jízdy – náhodná zajímavost v okolí (T)">🎯</button>
      <button data-act="view" title="Pohled (C)">🎥</button>
      <button data-act="type" title="Typ auta – osobní, závoďák, teréňák, náklaďák, traktor (K)">🚙</button>
      <button data-act="paint" title="Barva auta (P)">🎨</button>
      <button data-act="sound" title="Zvuk (M)">🔊</button>
      <button data-act="gta" title="Demolice – nárazy naostro, jen pro legraci (G)">💥</button>
      <button data-act="exit" title="Vystoupit (Esc / O)">✕</button>
    </div>
    <div class="dh-help">↑/W plyn · ↓/S brzda a couvání · ←/→ zatáčení · mezerník ruční brzda · C pohled</div>`;
  document.body.appendChild(hud);
  // mapka a cíl mimo HUD (ten má transform, uvnitř by „fixed“ neplatilo k oknu)
  const mapEl = hud.querySelector('.dh-map'), goalEl = hud.querySelector('.dh-goal');
  mapEl.hidden = true;
  const scoreEl = document.createElement('div');
  scoreEl.className = 'dh-score';
  scoreEl.hidden = true;
  document.body.append(mapEl, goalEl, scoreEl);
  const touch = document.createElement('div');
  touch.id = 'drive-touch';
  touch.hidden = true;
  // telefon: volant vlevo dole (jeden prst – otáčení jako skutečným volantem, puštěný se vrátí rovně),
  // vpravo velký plyn (puštěný = auto rychle zabrzdí) a menší tlačítko couvání
  const WHEEL_SVG = `<svg viewBox="-50 -50 100 100" aria-hidden="true">
    <circle r="44" fill="none" stroke="currentColor" stroke-width="9"/>
    <circle r="11" fill="currentColor"/>
    <path d="M-42 -4 L-11 -4 L-6 9 L-4 42 L4 42 L6 9 L11 -4 L42 -4" fill="none" stroke="currentColor" stroke-width="8" stroke-linejoin="round"/>
    <rect x="-3" y="-50" width="6" height="12" rx="2" fill="#e8b04a"/></svg>`;
  touch.innerHTML = `<div class="dt-left">
      <button class="dt-mode" title="Přepnout volant / šipky">◀ ▶</button>
      <div class="dt-wheel" title="Volant">${WHEEL_SVG}</div>
      <div class="dt-arrows" hidden><button data-k="ArrowLeft" title="Doleva">◀</button><button data-k="ArrowRight" title="Doprava">▶</button></div>
    </div>
    <div class="dt-pedals"><button data-k="ArrowDown" class="brake" title="Couvání">R</button>
      <button data-k="ArrowUp" class="gas" title="Plyn"><span>PLYN</span></button></div>`;
  document.body.appendChild(touch);
  const touchKeys = new Set();
  touch.querySelectorAll('button[data-k]').forEach((b) => {
    const on = (e) => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch { /* bez zachycení */ } touchKeys.add(b.dataset.k); b.classList.add('on'); sound.start(); };
    const off = (e) => { e.preventDefault(); touchKeys.delete(b.dataset.k); b.classList.remove('on'); };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off); b.addEventListener('lostpointercapture', off);
  });
  // volant, nebo šipky ◀ ▶ (přepínač nad nimi, volba se pamatuje)
  const wheel = touch.querySelector('.dt-wheel'), arrows = touch.querySelector('.dt-arrows'), modeBtn = touch.querySelector('.dt-mode');
  let useArrows = false;
  try { useArrows = localStorage.getItem('stod3d.steer') === 'arrows'; } catch { /* bez úložiště */ }
  const showMode = () => {
    wheel.hidden = useArrows; arrows.hidden = !useArrows;
    modeBtn.textContent = useArrows ? '🎡 volant' : '◀ ▶ šipky';
  };
  modeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    useArrows = !useArrows;
    try { localStorage.setItem('stod3d.steer', useArrows ? 'arrows' : 'wheel'); } catch { /* bez úložiště */ }
    wheelId = null; wheelAng = 0; st.touchSteer = 0; showWheel();
    touchKeys.delete('ArrowLeft'); touchKeys.delete('ArrowRight');
    showMode();
  });
  // volant: úhel prstu kolem středu volantu oproti místu, kde se ho prst chytil; ±200° = plný rejd,
  // kolem středu jemněji (mírná křivka), aby malé pohyby prstu auto jen lehce natočily
  const WHEEL_MAX = 200;
  const wheelSteer = () => { const x = -wheelAng / WHEEL_MAX; return Math.sign(x) * Math.abs(x) ** 1.35; };
  let wheelId = null, grabAng = 0, wheelBase = 0, wheelAng = 0;
  st.touchSteer = 0;
  const angAt = (e) => {
    const r = wheel.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
  };
  const showWheel = () => { wheel.firstElementChild.style.transform = `rotate(${wheelAng}deg)`; };
  wheel.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    wheelId = e.pointerId;
    try { wheel.setPointerCapture(e.pointerId); } catch { /* bez zachycení */ }
    grabAng = angAt(e); wheelBase = wheelAng;
    wheel.classList.add('on'); sound.start();
  });
  wheel.addEventListener('pointermove', (e) => {
    if (e.pointerId !== wheelId) return;
    let d = angAt(e) - grabAng;
    d = ((d + 540) % 360) - 180;                              // přes ±180° bez skoku
    if (Math.abs(d) > 120) { grabAng += d; wheelBase += d; d = 0; }  // dlouhé otáčení: chytit znovu
    wheelAng = THREE.MathUtils.clamp(wheelBase + d, -WHEEL_MAX, WHEEL_MAX);
    st.touchSteer = wheelSteer();                             // doprava (po směru hodin) = zatáčet doprava
    showWheel();
  });
  const wheelOff = (e) => {
    if (e.pointerId !== wheelId) return;
    wheelId = null; wheel.classList.remove('on');
  };
  wheel.addEventListener('pointerup', wheelOff);
  wheel.addEventListener('pointercancel', wheelOff);
  wheel.addEventListener('lostpointercapture', wheelOff);
  // puštěný volant se sám vrací rovně (jako u auta)
  const wheelReturn = (dt) => {
    if (wheelId !== null || !wheelAng) return;
    wheelAng = Math.abs(wheelAng) < 2 ? 0 : wheelAng - Math.sign(wheelAng) * Math.min(Math.abs(wheelAng), 420 * dt);
    st.touchSteer = wheelSteer();
    showWheel();
  };
  showMode();
  const $ = (s) => hud.querySelector(s);
  hud.querySelector('[data-act=view]').onclick = () => cycleView();
  hud.querySelector('[data-act=goal]').onclick = () => newGoal();
  hud.querySelector('[data-act=paint]').onclick = () => repaint();
  hud.querySelector('[data-act=type]').onclick = () => changeType();
  hud.querySelector('[data-act=sound]').onclick = () => toggleSound();
  hud.querySelector('[data-act=exit]').onclick = () => onExit?.();
  const soundBtn = hud.querySelector('[data-act=sound]');
  soundBtn.textContent = sound.on ? '🔊' : '🔇';

  function cycleView() { st.view = (st.view + 1) % VIEWS.length; flash(`Pohled: ${VIEWS[st.view]}`); }
  function repaint() {
    paintIdx = (paintIdx + 1) % PAINTS.length;
    model.paintMat.color.setHex(PAINTS[paintIdx]);
    try { localStorage.setItem('stod3d.paint', String(paintIdx)); } catch { /* ignorovat */ }
  }
  // typ auta: postaví nový model (barva zůstane), promáčkliny se tím opraví
  function changeType() {
    carType = CAR_TYPES[(CAR_TYPES.indexOf(carType) + 1) % CAR_TYPES.length];
    try { localStorage.setItem('stod3d.carType', carType); } catch { /* ignorovat */ }
    const vis = model.car.visible;
    scene.remove(model.car);
    model.car.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    model = createCarModel(PAINTS[paintIdx], { type: carType });
    model.car.visible = vis;
    scene.add(model.car);
    orig.clear(); dents = 0;
    flash(`Auto: ${model.spec.name}`);
  }
  function toggleSound() { soundBtn.textContent = sound.toggle() ? '🔊' : '🔇'; }

  // ---------------------------------------------------------------- režim GTA
  // nárazy do lidí, aut a domů naostro: rána nebo výkřik, sražení lidé zůstanou ležet, auta zmačkaná,
  // u domů díra a trosky, vlastní auto se postupně mačká; počítá se skóre
  const gtaBtn = hud.querySelector('[data-act=gta]');
  let gta = false, gtaCool = 0;
  const score = { people: 0, cars: 0, houses: 0, poles: 0 };
  function showScore() {
    const n = score.people + score.cars + score.houses + score.poles;
    // po prvním nárazu někdo zavolá policii a záchranku: po městě začnou jezdit s majáky a houkat
    if (n > 0 && !emergency) {
      emergency = true;
      hooks.traffic?.setEmergency(true);
      setTimeout(() => { if (gta) flash('Někdo volal policii a záchranku! 🚓🚑'); }, 1600);
    }
    scoreEl.innerHTML = `<b>💥 ${n}</b> <span>nárazů</span> · 🚶 ${score.people} · 🚗 ${score.cars} · 🏠 ${score.houses} · 🚦 ${score.poles}`;
  }
  function setGta(on) {
    if (gta === on) return;
    gta = on;
    gtaBtn.classList.toggle('on', on);
    scoreEl.hidden = !on || !st.active;
    if (on) { Object.keys(score).forEach((k) => { score[k] = 0; }); showScore(); flash('Demolice zapnuta – jen pro legraci!'); }
    else {
      // všechno zmizí: zmačkaná auta, ležící a utíkající lidé, trosky, kouř, promáčkliny
      model.body.scale.set(1, 1, 1); model.body.rotation.y = 0; repair();
      hooks.traffic?.clearWrecks(); hooks.life?.clearGta(); debris.clear(); smoke.clear(); ownSmoke = false;
      hooks.traffic?.setEmergency(false); sirens.clear(); emergency = false;
      if (st.active) flash('Demolice vypnuta');
    }
    onGta?.(on);
  }
  gtaBtn.onclick = () => setGta(!gta);
  // vlastní auto se mačká: body karoserie u místa nárazu se promáčknou dovnitř (s „vlnkami“ plechu),
  // každá rána přidá další; po vypnutí Demolice je auto zase celé
  const orig = new Map();
  let dents = 0, ownSmoke = false;
  // z nabouraného auta se kouří a vyskočí řidič, křičí a utíká pryč
  function afterWreck(o) {
    const pos = () => (o.p ? [o.p[0], o.p[1]] : [o.x, o.z]);
    smoke.add(() => {
      if (o.gone || !o.wreck) return null;
      const [x, z] = pos();
      return [x, world.heightAt(x, z) + 1.2, z];
    }, 9);
    if (o.p && Math.random() > 0.35) return;            // zaparkované auto bývá prázdné
    setTimeout(() => {
      if (!gta || o.gone || !o.wreck || !hooks.life) return;
      const [x, z] = pos();
      let fx = x - st.x, fz = z - st.z;
      const l = Math.hypot(fx, fz) || 1; fx /= l; fz /= l;
      const side = Math.random() < 0.5 ? 1 : -1;
      hooks.life.addRunner(x - fz * side * 1.6, z + fx * side * 1.6, fx * 0.6 - fz * side, fz * 0.6 + fx * side);
      scream(); setTimeout(scream, 900 + Math.random() * 500);
    }, 650);
  }
  const hash = (x, y, z, sd) => { const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + sd) * 43758.5453; return h - Math.floor(h); };
  function crumple(lx, ly, lz, nx, nz, depth, R) {
    const sd = Math.random() * 100;
    for (const m of model.body.children) {
      if (!m.isMesh) continue;
      const pa = m.geometry.attributes.position, a = pa.array;
      if (!orig.has(m)) orig.set(m, a.slice());
      let moved = false;
      for (let i = 0; i < a.length; i += 3) {
        const x = a[i], y = a[i + 1], z = a[i + 2];
        const d = Math.hypot(x - lx, (y - ly) * 1.3, z - lz);
        if (d > R) continue;
        const f = (1 - d / R) ** 1.6 * depth * (0.45 + hash(Math.round(x * 20), Math.round(y * 20), Math.round(z * 20), sd));
        a[i] += nx * f; a[i + 2] += nz * f; a[i + 1] -= f * 0.3;
        moved = true;
      }
      if (moved) { pa.needsUpdate = true; m.geometry.computeVertexNormals(); }
    }
  }
  function dent(k, where = 'front', lat = 0) {
    if (dents++ > 60) return;
    if (dents >= 7 && !ownSmoke) {                      // hodně zmačkané auto se kouří z kapoty
      ownSmoke = true;
      smoke.add(() => {
        if (!gta || !st.active) { ownSmoke = false; return null; }
        return [st.x + Math.cos(st.heading) * (model.spec.nose - 0.7), st.y + 1.1 * model.spec.cam, st.z + Math.sin(st.heading) * (model.spec.nose - 0.7)];
      }, 6);
    }
    const b = model.body;
    b.scale.y = Math.max(0.92, b.scale.y - 0.004 * k);
    b.rotation.y = THREE.MathUtils.clamp(b.rotation.y + (Math.random() - 0.5) * 0.02 * k, -0.05, 0.05);
    const depth = 0.1 + 0.28 * k, R = 0.6 + 0.6 * k, z = THREE.MathUtils.clamp(lat + (Math.random() - 0.5) * 0.8, -0.85, 0.85);
    const sp = model.spec, big = sp.cam;
    if (where === 'back') crumple(-sp.tail, (0.55 + Math.random() * 0.4) * big, z * big, 1, -z * 0.2, depth, R * big);
    else crumple(sp.nose, (0.55 + Math.random() * 0.4) * big, z * big, -1, -z * 0.2, depth, R * big);
    if (k > 0.6 && Math.random() < 0.5) crumple(0.3 * (Math.random() - 0.5), 1.5, z * 0.5, 0, 0, 0.12 * k, 1.1);   // promáčklá střecha
  }
  function repair() {
    for (const [m, a] of orig) { m.geometry.attributes.position.array.set(a); m.geometry.attributes.position.needsUpdate = true; m.geometry.computeVertexNormals(); }
    orig.clear(); dents = 0;
  }
  let flashT = 0;
  function flash(text) { $('.dh-surface').textContent = text; flashT = 1.5; }

  // ---------------------------------------------------------------- cíl jízdy
  const goalBox = goalEl;
  let goal = null, reached = 0;
  const fmtDist = (d) => (d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`);
  const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  function newGoal() {
    const list = (pois || []).filter((p) => {
      const d = Math.hypot(p.x - st.x, p.z - st.z);
      return d > 250 && d < 2600 && Math.abs(p.x) < world.W / 2 - 50 && Math.abs(p.z) < world.H / 2 - 50;
    });
    if (!list.length) { flash('Žádná zajímavost v dosahu'); return; }
    const p = list[Math.floor(Math.random() * list.length)];
    goal = { name: p.name, x: p.x, z: p.z, t0: performance.now() };
    goalBox.hidden = false;
    flash('Nový cíl – sledujte šipku na mapce');
  }
  function updateGoal() {
    if (!goal) return;
    const elapsed = (performance.now() - goal.t0) / 1000;
    const d = Math.hypot(goal.x - st.x, goal.z - st.z);
    if (d < 35) {
      reached++;
      goalBox.innerHTML = `🏁 <b>${goal.name}</b> · za ${fmtTime(elapsed)} · cílů: ${reached}`;
      flash('Cíl! Další dá 🎯');
      goal = null;
      return;
    }
    goalBox.innerHTML = `🎯 <b>${goal.name}</b> · ${fmtDist(d)} · ${fmtTime(elapsed)}`;
  }

  // ---------------------------------------------------------------- mapka (natočená po směru jízdy)
  const mapCanvas = mapEl;
  const mctx = mapCanvas.getContext('2d');
  const MAP_COL = ['#f4f1ea', '#f4f1ea', '#e7e3da', '#d9d4c8', '#cfc7b4', '#c9b993', '#b49a72', '#a88f6c', '#6c6158'];
  const MAP_W = [7, 6, 4.5, 3.5, 3.2, 3, 2.6, 1.5, 2];
  let mapT = 0;
  function drawMap() {
    const S = mapCanvas.width, c = S / 2, R = 260, k = c / R;
    const ch = Math.cos(st.heading), sh = Math.sin(st.heading);
    const tx = (x, z) => {
      const dx = x - st.x, dz = z - st.z;
      const f = dx * ch + dz * sh, r = -dx * sh + dz * ch;
      return [c + r * k, c - f * k];
    };
    mctx.clearRect(0, 0, S, S);
    mctx.save();
    mctx.beginPath(); mctx.arc(c, c, c - 2, 0, Math.PI * 2); mctx.clip();
    mctx.fillStyle = 'rgba(40, 58, 46, 0.9)'; mctx.fillRect(0, 0, S, S);
    const seen = new Set();
    const cx0 = Math.floor((st.x - R) / CELL), cx1 = Math.floor((st.x + R) / CELL);
    const cz0 = Math.floor((st.z - R) / CELL), cz1 = Math.floor((st.z + R) / CELL);
    mctx.lineCap = 'round';
    for (let pass = 8; pass >= 0; pass--) {
      mctx.strokeStyle = MAP_COL[pass]; mctx.lineWidth = MAP_W[pass] * k * 1.6 + 1.2;
      mctx.beginPath();
      for (let gx = cx0; gx <= cx1; gx++) {
        for (let gz = cz0; gz <= cz1; gz++) {
          for (const sg of roadGrid.get(`${gx},${gz}`) || []) {
            if (sg.line.t !== pass || seen.has(sg)) continue;
            seen.add(sg);
            const [ax, ay] = tx(sg.a[0], sg.a[1]), [bx, by] = tx(sg.b[0], sg.b[1]);
            mctx.moveTo(ax, ay); mctx.lineTo(bx, by);
          }
        }
      }
      mctx.stroke();
    }
    mctx.fillStyle = '#9ad1ff';
    for (const bot of bots) {
      if (!bot.line) continue;
      const [bx, by] = tx(bot.x, bot.z);
      mctx.beginPath(); mctx.arc(bx, by, 8, 0, Math.PI * 2); mctx.fill();
    }
    if (goal) {
      let [gx, gy] = tx(goal.x, goal.z);
      const dx = gx - c, dy = gy - c, d = Math.hypot(dx, dy);
      const out = d > c - 18;
      if (out) { gx = c + (dx / d) * (c - 18); gy = c + (dy / d) * (c - 18); }
      mctx.fillStyle = '#ffb547'; mctx.strokeStyle = '#3a2a10'; mctx.lineWidth = 3;
      mctx.beginPath();
      if (out) {
        const a = Math.atan2(dy, dx);
        mctx.moveTo(gx + Math.cos(a) * 14, gy + Math.sin(a) * 14);
        mctx.lineTo(gx + Math.cos(a + 2.4) * 12, gy + Math.sin(a + 2.4) * 12);
        mctx.lineTo(gx + Math.cos(a - 2.4) * 12, gy + Math.sin(a - 2.4) * 12);
      } else mctx.arc(gx, gy, 10, 0, Math.PI * 2);
      mctx.closePath(); mctx.stroke(); mctx.fill();
    }
    mctx.restore();
    // auto uprostřed, sever
    mctx.fillStyle = '#ff5a4f'; mctx.strokeStyle = '#fff'; mctx.lineWidth = 3;
    mctx.beginPath(); mctx.moveTo(c, c - 16); mctx.lineTo(c + 11, c + 12); mctx.lineTo(c, c + 6); mctx.lineTo(c - 11, c + 12);
    mctx.closePath(); mctx.stroke(); mctx.fill();
    const [nx, ny] = tx(st.x, st.z - 1000);
    const na = Math.atan2(ny - c, nx - c);
    mctx.fillStyle = '#fff'; mctx.font = 'bold 22px system-ui, sans-serif'; mctx.textAlign = 'center'; mctx.textBaseline = 'middle';
    mctx.fillText('S', c + Math.cos(na) * (c - 16), c + Math.sin(na) * (c - 16));
  }

  // ---------------------------------------------------------------- provoz: auta na silnicích a ulicích v okolí
  const TRAFFIC = matchMedia('(pointer: coarse)').matches ? 6 : 12;
  const trafficLines = lines.filter((l) => l.t <= 2).map((l) => {
    const cum = [0];
    for (let i = 1; i < l.p.length; i++) cum.push(cum[i - 1] + Math.hypot(l.p[i][0] - l.p[i - 1][0], l.p[i][1] - l.p[i - 1][1]));
    return { ...l, cum, L: cum[cum.length - 1] };
  }).filter((l) => l.L > 80);
  const bots = [];
  for (let i = 0; i < TRAFFIC; i++) {
    const m = createCarModel(PAINTS[(i * 3 + 1) % PAINTS.length], { lights: false });
    m.car.visible = false;
    scene.add(m.car);
    bots.push({ m, line: null, s: 0, dir: 1, v: 0, vMax: 0, heading: 0, x: 0, z: 0, y: 0 });
  }
  function pointOn(l, s) {
    let i = 1;
    while (i < l.cum.length - 1 && l.cum[i] < s) i++;
    const a = l.p[i - 1], b = l.p[i], seg = l.cum[i] - l.cum[i - 1] || 1, t = (s - l.cum[i - 1]) / seg;
    return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dir: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  }
  function spawn(bot, far) {
    for (let tries = 0; tries < 40; tries++) {
      const l = trafficLines[Math.floor(Math.random() * trafficLines.length)];
      const s0 = Math.random() * l.L;
      const p = pointOn(l, s0);
      const d = Math.hypot(p.x - st.x, p.z - st.z);
      if (d > 700 || d < (far ? 160 : 25)) continue;
      Object.assign(bot, { line: l, s: s0, dir: Math.random() < 0.5 ? 1 : -1, v: 0,
        vMax: [17, 14, 10][l.t] * (0.75 + Math.random() * 0.35) });
      bot.m.car.visible = true;
      return true;
    }
    bot.line = null;
    bot.m.car.visible = false;
    return false;
  }
  function updateTraffic(dt) {
    const night = NIGHT.night.value;
    for (const bot of bots) {
      if (!bot.line || Math.hypot(bot.x - st.x, bot.z - st.z) > 900) { if (!spawn(bot, !!bot.line)) continue; }
      const l = bot.line;
      // zpomalit za naším autem nebo před ním
      const ahead = pointOn(l, THREE.MathUtils.clamp(bot.s + bot.dir * 9, 0, l.L));
      const blocked = Math.hypot(ahead.x - st.x, ahead.z - st.z) < 5;
      const want = blocked ? 0 : bot.vMax;
      bot.v += THREE.MathUtils.clamp(want - bot.v, -9 * dt, 3 * dt);
      bot.s += bot.dir * bot.v * dt;
      if (bot.s <= 0 || bot.s >= l.L) { bot.dir = -bot.dir; bot.s = THREE.MathUtils.clamp(bot.s, 0, l.L); }   // na konci otočí
      const p = pointOn(l, bot.s);
      const h = bot.dir > 0 ? p.dir : p.dir + Math.PI;
      const lane = Math.min(1.6, l.w / 4);
      bot.x = p.x - Math.sin(h) * lane;
      bot.z = p.z + Math.cos(h) * lane;
      const dh = Math.atan2(Math.sin(h - bot.heading), Math.cos(h - bot.heading));
      bot.heading += dh * Math.min(1, dt * 6);
      const y = surfaceAt(bot.x, bot.z).y;
      bot.y += (y - bot.y) * (bot.m.car.visible && Math.abs(y - bot.y) < 5 ? Math.min(1, dt * 10) : 1);
      const car = bot.m.car;
      car.position.set(bot.x, bot.y, bot.z);
      car.rotation.set(0, -bot.heading, 0);
      for (const w of bot.m.wheels) w.spin.rotation.z -= (bot.v * dt) / 0.35;
      bot.m.head.emissiveIntensity = 0.3 + night * 2.2;
      bot.m.tail.emissiveIntensity = (bot.v < want - 1 ? 1.4 : 0.35) + night * 0.8;
      // ťuknutí do našeho auta
      if (Math.hypot(bot.x - st.x, bot.z - st.z) < 3.2 && Math.abs(st.v) > 1.5) {
        st.v = -st.v * 0.3;
        flash('Ťuk! Pozor na ostatní auta');
      }
    }
  }
  function hideTraffic() { for (const bot of bots) { bot.line = null; bot.m.car.visible = false; } }
  // vlastní jednoduchá auta jen tehdy, když neběží celková doprava (traffic.js)
  let botsOn = true;
  function setBots(v) { botsOn = v; if (!v) hideTraffic(); }

  /** Povrch pod bodem: typ komunikace (nebo -1 mimo cestu) a výška jízdní plochy. */
  function surfaceAt(x, z) {
    const n = nearestSeg(roadGrid, x, z, (l) => l.t !== 8);
    const on = n && n.d <= n.s.line.w / 2 + 0.4 ? n.s.line.t : -1;
    const br = on >= 0 ? bridges.at(x, z, n.s.line.w, n.s.b[0] - n.s.a[0], n.s.b[1] - n.s.a[1]) : null;
    const y = (br ?? world.heightAt(x, z)) + (on >= 0 ? LIFT[on] : 0.02);
    return { type: on, y, seg: n };
  }

  function start(x, z, heading) {
    // na nejbližší silnici nebo cestu (do 400 m) ve směru, kterým se díváme
    const n = nearestSeg(roadGrid, x, z, (l) => l.t <= 6);
    let hx = x, hz = z, h = heading;
    if (n && n.d < 400) {
      const s = n.s;
      hx = s.a[0] + (s.b[0] - s.a[0]) * n.t; hz = s.a[1] + (s.b[1] - s.a[1]) * n.t;
      const d = n.dir;
      const diff = Math.atan2(Math.sin(heading - d), Math.cos(heading - d));
      h = Math.abs(diff) < Math.PI / 2 ? d : d + Math.PI;
      // na pravý jízdní pruh
      const off = Math.min(1.6, s.line.w / 4);
      hx += -Math.sin(h) * off; hz += Math.cos(h) * off;          // vpravo od středu cesty
    }
    Object.assign(st, { x: hx, z: hz, heading: h, v: 0, steer: 0, active: true });
    st.y = surfaceAt(hx, hz).y;
    model.car.visible = true;
    hud.hidden = false;
    mapEl.hidden = false;
    scoreEl.hidden = !gta;
    goalEl.hidden = !goal && !reached;
    touch.hidden = !matchMedia('(pointer: coarse)').matches;
    placeCamera(true);
    sound.start();
  }

  function stop() {
    setGta(false);                                     // po vystoupení z auta Demolice končí a vše se uklidí
    st.active = false;
    model.car.visible = false;
    hideTraffic();
    hud.hidden = true;
    mapEl.hidden = true;
    scoreEl.hidden = true;
    goalEl.hidden = true;
    touch.hidden = true;
    touchKeys.clear();
    wheelId = null; wheelAng = 0; st.touchSteer = 0; showWheel();
    sound.stop();
    return { x: st.x, y: st.y, z: st.z, heading: st.heading };
  }

  const fwd = new THREE.Vector3(), tmpV = new THREE.Vector3();
  function placeCamera(instant, dt = 0.016) {
    // kamera se za autem stáčí se zpožděním: v zatáčce je auto vidět trochu z boku (z kabiny bez zpoždění)
    if (instant || st.camYaw === undefined || st.view === 2) st.camYaw = st.heading;
    else {
      const d = Math.atan2(Math.sin(st.heading - st.camYaw), Math.cos(st.heading - st.camYaw));
      st.camYaw += THREE.MathUtils.clamp(d * Math.min(1, dt * 2.2), -Math.abs(d), Math.abs(d));
      const maxLag = 0.55;                                   // nejvýš ~30° z boku
      const lag = Math.atan2(Math.sin(st.heading - st.camYaw), Math.cos(st.heading - st.camYaw));
      if (Math.abs(lag) > maxLag) st.camYaw = st.heading - Math.sign(lag) * maxLag;
    }
    const cx = Math.cos(st.camYaw), cz = Math.sin(st.camYaw);
    const cm = model.spec.cam;
    const [back, up, ahead] = st.view === 0 ? [8.2 * cm, 3.4 * cm, 5] : st.view === 1 ? [17 * cm, 9 * cm, 6]
      : [{ truck: -2.6, tractor: 0.65 }[carType] ?? -0.2, { truck: 2.55, tractor: 2.25, offroad: 1.75 }[carType] ?? 1.32, 20];
    const want = tmpV.set(st.x - cx * back, st.y + up, st.z - cz * back);
    if (st.view !== 2) want.y = Math.max(want.y, world.heightAt(want.x, want.z) + 1.2);
    const look = fwd.set(st.x + cx * ahead, st.y + (st.view === 2 ? 1.2 : 1.1), st.z + cz * ahead);
    const k = instant || st.view === 2 ? 1 : 1 - Math.exp(-dt * 6);
    st.camPos.lerp(want, k);
    if (instant) st.camPos.copy(want);
    st.camLook.lerp(look, instant ? 1 : 1 - Math.exp(-dt * 10));
    if (instant) st.camLook.copy(look);
    camera.position.copy(st.camPos);
    camera.lookAt(st.camLook);
  }

  addEventListener('keydown', (e) => {
    if (!st.active || e.repeat) return;
    if (e.code === 'KeyC') cycleView();
    if (e.code === 'KeyT') newGoal();
    if (e.code === 'KeyP') repaint();
    if (e.code === 'KeyK') changeType();
    if (e.code === 'KeyM') toggleSound();
    if (e.code === 'KeyG') setGta(!gta);
    if (e.code === 'Space') e.preventDefault();
  });

  function update(dt, keys) {
    if (!st.active) return false;
    const k = (...c) => c.some((x) => keys.has(x) || touchKeys.has(x));
    const gas = k('KeyW', 'ArrowUp') ? 1 : 0;
    const brake = k('KeyS', 'ArrowDown') ? 1 : 0;
    const touchOn = !touch.hidden;
    if (touchOn) wheelReturn(dt);
    const keySteer = (k('KeyA', 'ArrowLeft') ? 1 : 0) - (k('KeyD', 'ArrowRight') ? 1 : 0);
    const steerIn = keySteer || (touchOn ? st.touchSteer : 0);
    const hand = k('Space');

    const surf = surfaceAt(st.x, st.z);
    const type = surf.type;
    const spec = model.spec;
    const maxV = Math.min(spec.cap, type >= 0 ? MAX_SPEED[type] * spec.vmax : OFFROAD.max * spec.off);
    const grip = (type >= 0 ? GRIP[type] : spec.offGrip ?? OFFROAD.grip) * (spec.grip || 1);
    const rolling = type >= 0 ? 0.25 + (type >= 5 ? 0.6 : 0) : OFFROAD.rolling;

    // podélně: plyn, brzda/couvání, odpor, svah
    let v = st.v;
    // rozjezd dvakrát svižnější než dřív (4,2 → 8,4 m/s²)
    if (gas) v += (v < 0 ? 12 : 8.4 * spec.acc * (1 - Math.max(0, v) / (maxV * 1.15))) * dt;
    if (brake) v -= (v > 0.3 ? 9 : 4.5) * dt;
    if (!brake && v < 0 && !gas) v = Math.min(0, v + (touchOn ? 9 : 3) * dt);
    // telefon: puštěný plyn = auto rychle zabrzdí (ne na místě, ~1 s z 30 km/h)
    if (touchOn && !gas && !brake && v > 0) v = Math.max(0, v - 7.5 * dt);
    if (hand) v -= Math.sign(v) * Math.min(Math.abs(v), 10 * dt);
    v -= Math.sign(v) * Math.min(Math.abs(v), (rolling + 0.0016 * v * v) * dt);
    v -= 9.81 * Math.sin(st.pitch) * dt * 0.6;
    if (v > maxV) v -= (v - maxV) * 2 * dt;
    v = THREE.MathUtils.clamp(v, -8, spec.cap);
    if (!gas && !brake && Math.abs(v) < 0.05) v = 0;

    // řízení: menší rejd ve vyšší rychlosti
    const maxSteer = 0.58 / (1 + Math.abs(v) / 11);
    st.steer += (steerIn * maxSteer - st.steer) * Math.min(1, dt * 6);
    const yawRate = (v * Math.tan(st.steer)) / spec.wb * (hand ? 1.25 : grip);
    const newHeading = st.heading - yawRate * dt;

    const nx = st.x + Math.cos(newHeading) * v * dt, nz = st.z + Math.sin(newHeading) * v * dt;
    // srážka s budovou: předek / zadek auta
    const dir = Math.sign(v) || 1;
    const reach = (dir > 0 ? spec.nose : spec.tail) - 0.15;
    const px = nx + Math.cos(newHeading) * reach * dir, pz = nz + Math.sin(newHeading) * reach * dir;
    const lim = world.W / 2 - 5, limZ = world.H / 2 - 5;
    const hx = Math.cos(newHeading) * dir, hz = Math.sin(newHeading) * dir, spd = Math.abs(v), sk = Math.min(1, spd / 14);
    gtaCool -= dt;
    // vozidla: střed a rohy přídě (nebo zádi při couvání)
    // proti zaseknutí: blokuje jen náraz, kterým se auto do překážky teprve dostává (když už v ní je,
    // smí z ní ven), a když se auto se stisknutým plynem/couváním přes sekundu nehne, chvíli překážky ignoruje
    const cpx = st.x + Math.cos(st.heading) * reach * dir, cpz = st.z + Math.sin(st.heading) * reach * dir;
    if ((gas || brake) && spd < 0.4) st.stuck = (st.stuck || 0) + dt; else st.stuck = 0;
    if (st.stuck > 1.0) {
      st.stuck = 0;
      // jen když auto opravdu vězí v něčem (jiné auto přes nás, dům), ne když tlačí do zdi zvenku
      const tr = hooks.traffic?.enabled ? hooks.traffic : null;
      const back = st.x - Math.cos(st.heading) * reach * dir, backZ = st.z - Math.sin(st.heading) * reach * dir;
      if (hitsBuilding(st.x, st.z) || tr?.hitAt(st.x, st.z) || tr?.hitAt(cpx, cpz) || tr?.hitAt(back, backZ)
        || (hitsBuilding(cpx, cpz) && hitsBuilding(back, backZ))) st.ghost = 1.5;
    }
    if (st.ghost > 0) st.ghost -= dt;
    const ghost = st.ghost > 0;
    let veh = null, hitSide = 0;
    if (hooks.traffic?.enabled && !ghost) {
      for (const sd of [0, 0.85, -0.85]) {
        veh = hooks.traffic.hitAt(px - hz * sd * spec.hw / 0.95, pz + hx * sd * spec.hw / 0.95);
        if (veh) { hitSide = sd * dir; break; }
      }
      if (veh) {
        for (const sd of [0, 0.85, -0.85]) {
          if (hooks.traffic.hitAt(cpx - hz * sd * spec.hw / 0.95, cpz + hx * sd * spec.hw / 0.95) === veh) { veh = null; break; }
        }
      }
    }
    const pole = veh || ghost ? null : poleHit(st.x, st.z, st.heading, nx, nz, newHeading);
    const house = !ghost && hitsBuilding(px, pz) && !hitsBuilding(cpx, cpz);
    if (house || Math.abs(nx) > lim || Math.abs(nz) > limZ) {
      v = -v * 0.25;
      if (gta && spd > 3 && gtaCool <= 0 && house) {
        gtaCool = 0.7; score.houses++; showScore();
        bang('house', sk); debris.add(px, pz, hx, hz, sk); dent(sk, dir > 0 ? 'front' : 'back');
        st.spinV = (Math.random() - 0.5) * 2.4 * sk;
      } else if (Math.abs(st.v) > 4 && !gta) flash('Bum! Pozor na domy');
    } else if (veh) {
      const hit = gta && spd > 2 ? hooks.traffic.wreck(veh, hx, hz, spd) : false;
      if (hit) {
        score.cars++; showScore(); bang('car', sk); dent(sk, dir > 0 ? 'front' : 'back', hitSide);
        if (hit === 'first') afterWreck(veh);
        v = -v * (0.25 + 0.2 * sk);                   // obě auta od sebe odletí
        st.spinV = (hitSide ? -Math.sign(hitSide) * dir : (Math.random() < 0.5 ? -1 : 1)) * (1 + 2 * Math.random()) * sk;
      } else {
        v = -v * 0.25;
        if (spd > 2) { if (gta) { if (gtaCool <= 0) { bang('car', sk * 0.5); gtaCool = 0.5; } } else flash('Ťuk! Pozor na ostatní auta'); }
      }
    } else if (pole) {
      v = -v * 0.25;
      if (gta && spd > 3 && gtaCool <= 0) { gtaCool = 0.6; score.poles++; showScore(); bang('pole', sk); dent(sk * 0.7, dir > 0 ? 'front' : 'back'); }
      else if (spd > 3 && !gta) flash('Bum! Pozor na sloup');
    } else {
      st.x = nx; st.z = nz;
      st.odo += Math.abs(v * dt);
    }
    st.heading = newHeading;
    st.v = v;
    // po nárazu se auto ještě chvíli otáčí (smyk)
    if (st.spinV) {
      st.heading += st.spinV * dt;
      st.spinV *= Math.max(0, 1 - dt * 2.2);
      if (Math.abs(st.spinV) < 0.02) st.spinV = 0;
    }
    // GTA: sražení lidé
    if (gta && spd > 1.5 && hooks.life) {
      const ch0 = Math.cos(st.heading) * spec.nose, sh0 = Math.sin(st.heading) * spec.nose;
      const n = hooks.life.knock(st.x - ch0, st.z - sh0, st.x + ch0, st.z + sh0, spec.hw + 0.3, hx, hz, spd);
      if (n) {
        score.people += n; showScore();
        for (let i = 0; i < Math.min(2, n); i++) setTimeout(scream, i * 140);
        bang('pole', 0.15);
        st.v *= 0.9;
        dent(0.25, dir > 0 ? 'front' : 'back');
      }
    }

    // výška, náklon podle terénu pod koly
    const ch = Math.cos(st.heading), sh = Math.sin(st.heading);
    const hF = surfaceAt(st.x + ch * 1.3, st.z + sh * 1.3).y, hB = surfaceAt(st.x - ch * 1.3, st.z - sh * 1.3).y;
    const hL = surfaceAt(st.x + sh * 0.8, st.z - ch * 0.8).y, hR = surfaceAt(st.x - sh * 0.8, st.z + ch * 0.8).y;
    const targetY = (hF + hB + hL + hR) / 4;
    st.y += (targetY - st.y) * Math.min(1, dt * 14);
    st.pitch += (Math.atan2(hF - hB, 2.6) - st.pitch) * Math.min(1, dt * 10);
    st.roll += (Math.atan2(hL - hR, 1.6) - st.roll) * Math.min(1, dt * 10);

    // model
    const car = model.car;
    car.position.set(st.x, st.y, st.z);
    car.rotation.order = 'YZX';
    car.rotation.set(st.roll, -st.heading, st.pitch);
    // lehké naklonění karoserie v zatáčce a při brzdění
    // náklon karoserie do strany v zatáčce (výraznější, plynulý)
    const lean = THREE.MathUtils.clamp(-yawRate * v * 0.011, -0.1, 0.1);
    model.body.rotation.x += (lean - model.body.rotation.x) * Math.min(1, dt * 6);
    model.body.rotation.z = THREE.MathUtils.clamp((brake && v > 1 ? -0.025 : 0) + (gas ? 0.012 : 0), -0.04, 0.03);
    for (const w of model.wheels) {
      w.spin.rotation.z -= (v * dt) / (w.r || 0.35);
      if (w.front) w.pivot.rotation.y = st.steer;
    }
    const night = NIGHT.night.value;
    for (const b of model.beams) b.intensity = night * 60;
    model.head.emissiveIntensity = 0.3 + night * 2.2;
    model.tail.emissiveIntensity = (brake ? 1.6 : 0.35) + night * 0.8;

    placeCamera(false, dt);
    smoke.update(dt, camera, innerHeight);
    sirens.update(emergency && hooks.traffic?.enabled ? hooks.traffic.emergencyList() : [], camera.position, gta && sound.on);
    if (botsOn) updateTraffic(dt);
    updateGoal();
    mapT -= dt;
    if (mapT <= 0) { mapT = 0.08; drawMap(); }

    // tachometr a místo (název ulice jen občas)
    $('.dh-speed b').textContent = Math.round(Math.abs(v) * 3.6);
    if (flashT > 0) flashT -= dt;
    else {
      const sn = nearestSeg(streetGrid, st.x, st.z);
      const street = sn && sn.d < 14 ? sn.s.line.name : '';
      const label = (street || (type >= 0 ? SURFACE_NAME[type] : 'mimo cestu')) + '|' + (type >= 0 ? SURFACE_NAME[type] : 'mimo cestu');
      if (label !== lastLabel) {
        lastLabel = label;
        const [a, b] = label.split('|');
        $('.dh-street').textContent = a;
        $('.dh-surface').textContent = a === b ? '' : b;
      }
    }
    const rpmBase = Math.abs(v) / Math.max(8, maxV);
    sound.update(0.15 + (rpmBase * 3) % 1 * 0.6 + rpmBase * 0.4, gas ? 1 : 0.2);
    return true;
  }

  return { start, stop, update, setBots, hooks, setGta, debugDent: (k, w) => dent(k, w), get active() { return st.active; }, get gta() { return gta; }, state: st, bots };
}
