import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Nízkopolygonové modely pro dopravu, lidi a zvířata. Každý model = sada sloučených geometrií
// s barvami vrcholů rozdělená podle materiálu:
//   paint0 / paint1  – lak (barva vrcholu × barva instance, dvě barvy na vozidlo)
//   fixed            – pevné barvy (sklo, kola, podvozek)
//   lamp             – světla (bez stínování, v noci jasná)
// Osa x = dopředu, y = nahoru, z = do strany; počátek = uprostřed mezi nápravami na zemi
// (u přívěsu / vagonu mezi oporami: front = čep / přední podvozek, rear = zadní náprava / podvozek).

const GLASS = 0x2b3642, TYRE = 0x1b1b1d, DARK = 0x2c2d30, GREY = 0x8c8f93, CHROME = 0xc9ccd0;

function colorize(g, c) {
  const col = new THREE.Color(c), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = col.r; a[i * 3 + 1] = col.g; a[i * 3 + 2] = col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  return g.index ? g.toNonIndexed() : g;
}
export const box = (lx, ly, lz, x, y, z, c = 0xffffff) => colorize(new THREE.BoxGeometry(lx, ly, lz).translate(x, y, z), c);
export const cyl = (r, w, x, y, z, c = TYRE, seg = 10) =>
  colorize(new THREE.CylinderGeometry(r, r, w, seg).rotateX(Math.PI / 2).translate(x, y, z), c);
const vcyl = (r, h, x, y, z, c, seg = 8) => colorize(new THREE.CylinderGeometry(r, r, h, seg).translate(x, y + h / 2, z), c);
// šikmá deska (např. čelní sklo): délka l ve směru x, sklon a [rad]
const slab = (lx, ly, lz, x, y, z, a, c) => colorize(new THREE.BoxGeometry(lx, ly, lz).rotateZ(a).translate(x, y, z), c);

export function merge(list) {
  const g = list.length ? mergeGeometries(list) : null;
  if (g) g.computeBoundingSphere();
  return g;
}
const wheels = (xs, r, w, half, c = TYRE) => xs.flatMap((x) => [cyl(r, w, x, r, half), cyl(r, w, x, r, -half)]);
const pair = (f) => [f(1), f(-1)];

/** Hotový model: posun tak, aby počátek byl mezi oporami. */
function model(parts, front, rear, len) {
  const mid = (front + rear) / 2;
  const out = { wb: front - rear, len, front: front - mid, rear: rear - mid, nose: len / 2 };
  for (const [k, list] of Object.entries(parts)) {
    const g = merge(list);
    if (g) { g.translate(-mid, 0, 0); out[k] = g; }
  }
  // přední a zadní hrana vůči počátku (pro rozestupy)
  const bb = new THREE.Box3();
  for (const k of ['paint0', 'paint1', 'fixed']) if (out[k]) { out[k].computeBoundingBox(); bb.union(out[k].boundingBox); }
  out.nose = bb.max.x; out.tail = -bb.min.x;
  return out;
}

// ---------------------------------------------------------------- silniční vozidla
function car({ len = 4.3, h = 1.45, w = 1.78, wb = 2.6, hatch = false } = {}) {
  const fx = wb / 2 + 0.05, rx = -wb / 2 + 0.05, r = 0.32 * (h / 1.45);
  const roofL = hatch ? len * 0.5 : len * 0.44, roofX = hatch ? -len * 0.12 : -len * 0.08;
  return model({
    paint0: [
      box(len, 0.55 * h / 1.45, w, 0, 0.6 * h / 1.45, 0),
      box(roofL, 0.07, w - 0.26, roofX, h - 0.035, 0),
      slab(len * 0.24, 0.12, w - 0.02, len * 0.33, 0.86 * h / 1.45, 0, -0.12, 0xffffff),
    ],
    fixed: [
      box(roofL + 0.5, h - 0.92 * h / 1.45 - 0.07, w - 0.2, roofX + 0.05, (h + 0.88 * h / 1.45) / 2 - 0.03, 0, GLASS),
      ...wheels([fx, rx], r, 0.22, w / 2 - 0.1),
      box(0.14, 0.18, w + 0.02, len / 2 - 0.05, 0.4, 0, DARK), box(0.14, 0.18, w + 0.02, -len / 2 + 0.05, 0.42, 0, DARK),
    ],
    lamp: [
      ...pair((s) => box(0.04, 0.11, 0.32, len / 2 + 0.005, 0.72 * h / 1.45, s * (w / 2 - 0.3), 0xfff4d6)),
      ...pair((s) => box(0.04, 0.13, 0.3, -len / 2 - 0.005, 0.82 * h / 1.45, s * (w / 2 - 0.28), 0xd01818)),
    ],
  }, fx, rx, len);
}

function van() {
  const W = 2.0;
  return model({
    paint0: [box(4.1, 1.95, W, -0.6, 1.33, 0), box(1.15, 0.6, W - 0.04, 2.02, 0.8, 0), slab(0.7, 0.1, W - 0.06, 1.75, 1.13, 0, -0.35, 0xffffff)],
    fixed: [
      box(0.08, 0.72, W - 0.16, 1.46, 1.72, 0, GLASS), box(0.9, 0.6, W + 0.02, 0.95, 1.74, 0, GLASS),
      ...wheels([1.65, -1.75], 0.36, 0.24, W / 2 - 0.1), box(0.16, 0.22, W + 0.02, 2.6, 0.45, 0, DARK),
      box(0.12, 0.2, W + 0.02, -2.66, 0.48, 0, DARK),
    ],
    lamp: [
      ...pair((s) => box(0.04, 0.14, 0.3, 2.605, 0.92, s * 0.72, 0xfff4d6)),
      ...pair((s) => box(0.04, 0.3, 0.16, -2.665, 1.0, s * 0.9, 0xd01818)),
    ],
  }, 1.65, -1.75, 5.3);
}

function truck() {
  const W = 2.45;
  return model({
    paint0: [box(2.2, 2.45, W, 3.0, 1.78, 0)],
    paint1: [box(6.1, 2.75, 2.5, -1.15, 2.45, 0)],
    fixed: [
      box(8.2, 0.35, 1.0, 0, 0.82, 0, DARK),
      box(0.08, 1.0, W - 0.2, 4.11, 2.35, 0, GLASS), box(0.9, 0.8, W + 0.02, 3.45, 2.4, 0, GLASS),
      ...wheels([3.0, -1.7, -3.0], 0.5, 0.36, 1.0), box(0.2, 0.35, W + 0.04, 4.1, 0.75, 0, DARK),
    ],
    lamp: [...pair((s) => box(0.04, 0.16, 0.36, 4.115, 1.05, s * 0.9, 0xfff4d6)), ...pair((s) => box(0.04, 0.18, 0.3, -4.21, 1.0, s * 1.0, 0xd01818))],
  }, 3.0, -2.35, 8.4);
}

function semiTractor() {
  const W = 2.5;
  return model({
    paint0: [box(2.3, 2.9, W, 1.85, 2.05, 0), box(1.6, 0.5, W - 0.3, 1.95, 3.7, 0)],
    fixed: [
      box(5.8, 0.4, 1.0, -0.1, 0.85, 0, DARK), box(0.08, 1.15, W - 0.2, 3.01, 2.65, 0, GLASS),
      box(0.8, 0.8, W + 0.02, 2.55, 2.75, 0, GLASS), ...pair((s) => cyl(0.3, 1.0, 0.0, 0.75, s * 0.95, GREY, 8).rotateZ(0)),
      ...wheels([2.2, -1.4, -2.7], 0.52, 0.38, 1.0), box(0.22, 0.4, W + 0.04, 3.0, 0.75, 0, DARK),
    ],
    lamp: [...pair((s) => box(0.04, 0.18, 0.4, 3.02, 1.05, s * 0.95, 0xfff4d6))],
  }, 2.2, -2.05, 6.0);
}

function semiTrailer() {
  return model({
    paint0: [box(13.6, 2.95, 2.55, 0, 2.68, 0)],
    fixed: [box(13.0, 0.35, 1.1, 0, 1.0, 0, DARK), ...wheels([-4.6, -5.9, -7.2].map((x) => x + 1.3), 0.5, 0.36, 1.0)],
    lamp: [...pair((s) => box(0.04, 0.2, 0.3, -6.81, 1.05, s * 1.05, 0xd01818))],
  }, 5.8, -4.6, 13.6);
}

function bus() {
  const W = 2.55;
  return model({
    paint0: [box(12, 2.6, W, 0, 1.75, 0)],
    paint1: [box(12.02, 0.32, W + 0.02, 0, 1.02, 0), box(0.4, 2.0, W + 0.02, 5.85, 1.95, 0)],
    fixed: [
      box(10.3, 1.0, W + 0.03, -0.75, 2.3, 0, GLASS), box(0.06, 1.55, W - 0.2, 6.01, 2.05, 0, GLASS),
      box(3.2, 0.3, 1.6, -1.5, 3.2, 0, GREY), ...wheels([3.4, -2.6], 0.5, 0.36, 1.05),
      box(0.9, 2.05, W + 0.035, 4.6, 1.5, 0, 0x3a4048), box(1.4, 2.05, 0.03, -0.3, 1.5, W / 2 + 0.01, 0x3a4048),
    ],
    lamp: [
      box(0.04, 0.3, 1.8, 6.03, 2.85, 0, 0xffa62b),
      ...pair((s) => box(0.04, 0.16, 0.36, 6.02, 0.78, s * 0.95, 0xfff4d6)),
      ...pair((s) => box(0.04, 0.4, 0.2, -6.02, 1.1, s * 1.05, 0xd01818)),
    ],
  }, 3.4, -2.6, 12);
}

function tractor() {
  return model({
    paint0: [
      box(1.9, 0.95, 0.95, 0.95, 1.35, 0), box(1.6, 0.12, 1.45, -0.75, 2.92, 0),
      ...pair((s) => box(1.3, 0.14, 0.55, -1.0, 1.78, s * 0.85)), ...pair((s) => box(0.9, 0.1, 0.35, 1.25, 1.06, s * 0.72)),
    ],
    fixed: [
      box(1.45, 1.1, 1.35, -0.75, 2.3, 0, GLASS), box(3.0, 0.55, 0.8, 0.2, 0.95, 0, DARK),
      ...pair((s) => cyl(0.85, 0.48, -1.0, 0.85, s * 0.86, TYRE, 14)), ...pair((s) => cyl(0.52, 0.3, 1.3, 0.52, s * 0.74, TYRE, 12)),
      vcyl(0.05, 1.2, 1.5, 1.8, 0.35, DARK, 6), box(0.08, 0.5, 0.85, 1.92, 1.3, 0, DARK),
    ],
    lamp: [...pair((s) => box(0.04, 0.12, 0.18, 1.92, 1.55, s * 0.3, 0xfff4d6)), ...pair((s) => box(0.06, 0.1, 0.1, -1.55, 1.6, s * 0.7, 0xd01818))],
  }, 1.3, -1.0, 4.2);
}

function wagon() {
  return model({
    paint0: [box(5.0, 1.25, 2.3, 0, 1.75, 0)],
    fixed: [box(4.6, 0.3, 1.0, 0, 1.0, 0, DARK), box(1.8, 0.12, 0.12, 3.3, 0.95, 0, DARK), ...wheels([1.5, -1.5], 0.48, 0.3, 0.9)],
    lamp: [...pair((s) => box(0.04, 0.12, 0.16, -2.52, 1.3, s * 1.0, 0xd01818))],
  }, 4.2, -1.5, 5.6);
}

// ---------------------------------------------------------------- vlaky (výška 0 = temeno kolejnice)
const bogies = (xs) => xs.flatMap((x) => [box(2.8, 0.55, 2.3, x, 0.5, 0, DARK), ...wheels([x - 0.95, x + 0.95], 0.45, 0.15, 0.72, 0x3a3b3e)]);

function unitCar() {      // článek regionální jednotky
  const L = 26;
  return model({
    paint0: [box(L, 3.1, 2.9, 0, 2.45, 0)],
    paint1: [box(L + 0.02, 0.62, 2.92, 0, 1.32, 0), box(L + 0.02, 0.12, 2.92, 0, 3.25, 0)],
    fixed: [
      box(L - 3, 0.95, 2.93, 0, 2.62, 0, GLASS), box(L - 1, 0.28, 2.4, 0, 4.14, 0, GREY),
      ...pair((s) => box(0.06, 1.15, 2.4, s * (L / 2 + 0.01), 2.85, 0, GLASS)),
      ...pair((s) => box(1.2, 2.1, 2.94, s * 6.5, 1.95, 0, 0x6b7179)),
      ...bogies([9.5, -9.5]), box(L - 6, 0.5, 2.6, 0, 0.95, 0, DARK),
    ],
    lamp: [...[1, -1].flatMap((e) => pair((s) => box(0.04, 0.14, 0.3, e * (L / 2 + 0.03), 1.45, s * 1.0, 0xfff4d6)))],
  }, 9.5, -9.5, L);
}

function loco() {
  const L = 19;
  return model({
    paint0: [box(L, 3.15, 3.0, 0, 2.55, 0)],
    paint1: [box(L + 0.02, 0.5, 3.02, 0, 1.4, 0), ...pair((s) => box(1.4, 3.16, 3.02, s * (L / 2 - 0.68), 2.55, 0))],
    fixed: [
      ...pair((s) => box(0.06, 1.0, 2.6, s * (L / 2 + 0.01), 3.25, 0, GLASS)), box(12, 0.3, 2.2, 0, 4.25, 0, GREY),
      ...pair((s) => slab(2.0, 0.07, 0.07, s * 3.2, 4.9, 0, s * 0.45, DARK)), ...pair((s) => box(0.2, 0.05, 1.8, s * 2.4, 5.35, 0, DARK)),
      ...bogies([5.5, -5.5]), box(L - 4, 0.5, 2.6, 0, 0.95, 0, DARK),
    ],
    lamp: [...[1, -1].flatMap((e) => pair((s) => box(0.04, 0.16, 0.3, e * (L / 2 + 0.03), 1.55, s * 1.05, 0xfff4d6)))],
  }, 5.5, -5.5, L);
}

function coach() {
  const L = 26.4;
  return model({
    paint0: [box(L, 2.95, 2.85, 0, 2.55, 0)],
    paint1: [box(L + 0.02, 1.0, 2.87, 0, 1.55, 0)],
    fixed: [
      box(L - 3, 0.85, 2.88, 0, 2.85, 0, GLASS), box(L - 0.6, 0.32, 2.5, 0, 4.17, 0, GREY),
      ...pair((s) => box(0.9, 2.05, 2.89, s * (L / 2 - 1.2), 2.05, 0, 0x5d6168)), ...bogies([9.5, -9.5]),
      box(L - 6, 0.5, 2.5, 0, 0.95, 0, DARK),
    ],
  }, 9.5, -9.5, L);
}

export const VEHICLES = {
  car: car(), hatch: car({ len: 4.0, hatch: true, wb: 2.5 }), suv: car({ len: 4.6, h: 1.7, w: 1.88, wb: 2.75 }),
  combi: car({ len: 4.7, hatch: true, wb: 2.7 }),
  van: van(), truck: truck(), semi: semiTractor(), trailer: semiTrailer(), bus: bus(), tractor: tractor(), wagon: wagon(),
  unit: unitCar(), loco: loco(), coach: coach(),
};

// ---------------------------------------------------------------- lidé (výška 1,75 m), počátek u nohou
export function personParts() {
  const skin = 0xe6c3a0;
  return {
    torso: merge([box(0.24, 0.6, 0.42, 0, 1.18, 0), ...pair((s) => box(0.14, 0.58, 0.11, 0, 1.17, s * 0.27))]),  // tričko + ruce
    head: merge([box(0.2, 0.24, 0.19, 0, 1.62, 0, skin), box(0.22, 0.07, 0.21, -0.01, 1.75, 0, 0x4a3426)]),
    leg: merge([box(0.15, 0.86, 0.16, 0, -0.43, 0), box(0.24, 0.08, 0.15, 0.04, -0.84, 0, 0x2a2a2a)]),   // od kyčle dolů
  };
}

// ---------------------------------------------------------------- zvířata
export function deerParts() {
  const c = 0x9a6a42, light = 0xe9dcc8;
  return {
    body: merge([box(1.05, 0.42, 0.34, 0, 0.92, 0, c), box(0.2, 0.22, 0.3, -0.5, 0.95, 0, light)]),
    neck: merge([slab(0.5, 0.17, 0.16, 0.18, 0.12, 0, 0.95, c), box(0.32, 0.17, 0.15, 0.36, 0.38, 0, c),
      box(0.1, 0.06, 0.13, 0.54, 0.36, 0, 0x2a1d15), ...pair((s) => slab(0.06, 0.16, 0.05, 0.24, 0.52, s * 0.08, 0.3, c))]),  // od kořene krku
    leg: merge([box(0.07, 0.72, 0.07, 0, -0.36, 0, 0x7d5636), box(0.08, 0.05, 0.08, 0, -0.7, 0, 0x222222)]),
  };
}

export function hareParts() {
  const c = 0x8b7356;
  return {
    body: merge([box(0.38, 0.2, 0.17, 0, 0.17, 0, c), box(0.16, 0.14, 0.13, 0.22, 0.27, 0, c),
      ...pair((s) => slab(0.05, 0.2, 0.035, 0.18, 0.43, s * 0.035, 0.25, 0x6e5a42)), box(0.07, 0.07, 0.07, -0.21, 0.2, 0, 0xf2efe8),
      ...pair((s) => box(0.22, 0.09, 0.05, -0.08, 0.06, s * 0.07, c))]),
  };
}

export function birdParts(big = false) {
  const k = big ? 2.6 : 1, c = big ? 0x6a5340 : 0x2d2d33;
  return {
    body: merge([box(0.26 * k, 0.07 * k, 0.07 * k, 0, 0, 0, c), box(0.06 * k, 0.015 * k, 0.12 * k, -0.15 * k, 0, 0, c)]),
    wing: merge([box(0.13 * k, 0.012 * k, 0.32 * k, 0.02 * k, 0, 0.16 * k, c)]),    // od ramene do +z
  };
}

// ---------------------------------------------------------------- cyklista (x = dopředu, počátek na zemi pod středem kola)
export function cyclistParts() {
  const skin = 0xe6c3a0, tyre = 0x1d1d1f, metal = 0x9aa0a6;
  return {
    bike: merge([                                            // rám (barva instance)
      slab(0.58, 0.05, 0.05, 0.15, 0.84, 0, 0.05), slab(0.62, 0.05, 0.05, 0.22, 0.53, 0, 0.77),
      slab(0.52, 0.045, 0.045, -0.07, 0.57, 0, 1.84), box(0.52, 0.04, 0.04, -0.26, 0.33, 0),
      slab(0.62, 0.04, 0.04, -0.33, 0.58, 0, 0.9),
    ]),
    fixed: merge([
      cyl(0.34, 0.05, 0.52, 0.34, 0, tyre, 14), cyl(0.34, 0.05, -0.52, 0.34, 0, tyre, 14),
      cyl(0.08, 0.06, 0.52, 0.34, 0, metal, 6), cyl(0.08, 0.06, -0.52, 0.34, 0, metal, 6),
      slab(0.42, 0.04, 0.04, 0.48, 0.55, 0, 1.38, metal), box(0.06, 0.04, 0.52, 0.42, 0.92, 0, 0x222222),
      box(0.22, 0.05, 0.12, -0.14, 0.86, 0, 0x222222),        // sedlo
      box(0.18, 0.2, 0.18, 0.33, 1.6, 0, skin), box(0.26, 0.11, 0.22, 0.31, 1.74, 0, 0x2f6fb5),   // hlava, helma
    ]),
    torso: merge([slab(0.62, 0.32, 0.36, 0.05, 1.18, 0, 0.9),             // předkloněný trup
      ...pair((s) => slab(0.53, 0.08, 0.08, 0.33, 1.17, s * 0.18, -1.24))]),  // ruce k řídítkům
    leg: merge([box(0.13, 0.62, 0.14, 0, -0.31, 0)]),           // od sedla k pedálu
  };
}

// ---------------------------------------------------------------- kráva (x dopředu, počátek na zemi)
export function cowParts() {
  return {
    body: merge([box(1.9, 0.78, 0.72, 0, 1.12, 0), box(0.3, 0.6, 0.6, -1.0, 1.15, 0)]),         // barva instance (srst)
    spots: merge([box(0.6, 0.5, 0.74, 0.35, 1.2, 0), box(0.45, 0.4, 0.74, -0.55, 1.05, 0), box(0.3, 0.3, 0.73, 0.85, 1.3, 0)]),  // skvrny
    fixed: merge([
      box(0.32, 0.16, 0.3, -0.55, 0.66, 0, 0xe8b4b0),                                    // vemeno
      box(0.05, 0.7, 0.05, -1.1, 0.95, 0, 0x2a2420),                                      // ocas
    ]),
    head: merge([box(0.5, 0.36, 0.34, 0.45, 0.02, 0), box(0.18, 0.2, 0.3, 0.72, -0.08, 0, 0xd9b9a8),   // od kořene krku
      ...pair((s) => box(0.06, 0.16, 0.06, 0.38, 0.24, s * 0.16, 0xe8e2d0)), ...pair((s) => box(0.1, 0.08, 0.14, 0.32, 0.12, s * 0.22))]),
    leg: merge([box(0.14, 0.74, 0.14, 0, -0.37, 0), box(0.15, 0.07, 0.15, 0, -0.74, 0, 0x2a2420)]),
  };
}
