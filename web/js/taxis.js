import * as THREE from 'three';
import { VEHICLES } from './models.js';

// Stod, konec Sokolské: smyčka kolem vnitrobloku slouží jako parkoviště. Na vnitřní straně smyčky
// pás stání kolmo k ulici (asfalt navazuje na vozovku, takže je ulice širší), bílé čáry stání,
// a v nich 11 taxíků – velká sedmimístná MPV (jako Renault Scénic), bílá s žlutou šachovnicí
// a střešní cedulí TAXI. Ostatní stání zůstávají volná. Stromy ani chodník na tom pásu nejsou.

// osa smyčky (OSM Sokolská, way 31562139), od výjezdu dokola
const LOOP = [[-774.8, -1110.1], [-781.3, -1120.1], [-784.1, -1122.6], [-787.4, -1124.4], [-790.9, -1125.1],
  [-794.6, -1125.0], [-828.5, -1105.0], [-815.9, -1083.1], [-774.8, -1110.1]];
const ROAD_HW = 2.5, BAY_D = 5.2, BAY_W = 2.5, LIFT = 0.33, TAXIS = 11;

const cen = LOOP.slice(0, -1).reduce((a, p, _i, arr) => [a[0] + p[0] / arr.length, a[1] + p[1] / arr.length], [0, 0]);

// rovné úseky smyčky s pásem stání na vnitřní straně
const STRIPS = [];
for (let i = 0; i < LOOP.length - 1; i++) {
  const a = LOOP[i], b = LOOP[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L < 10) continue;
  const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
  let nx = -uz, nz = ux;
  if ((cen[0] - a[0]) * nx + (cen[1] - a[1]) * nz < 0) { nx = -nx; nz = -nz; }   // dovnitř smyčky
  const u0 = 4.5, u1 = L - 4.5;                         // u rohů nechat místo na zatočení
  STRIPS.push({ a, ux, uz, nx, nz, u0, u1, n: Math.floor((u1 - u0) / BAY_W) });
}
const P = (s, u, v) => [s.a[0] + s.ux * u + s.nx * v, s.a[1] + s.uz * u + s.nz * v];

/** Bod na pásu stání (bez chodníku a stromů). */
export function inTaxiLot(x, z, r = 0) {
  return STRIPS.some((s) => {
    const dx = x - s.a[0], dz = z - s.a[1], u = dx * s.ux + dz * s.uz, v = dx * s.nx + dz * s.nz;
    return u > s.u0 - 1 - r && u < s.u1 + 1 + r && v > ROAD_HW - 1.5 - r && v < ROAD_HW + BAY_D + 0.8 + r;
  });
}

function signTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 40;
  const g = c.getContext('2d');
  g.fillStyle = '#f5c518'; g.fillRect(0, 0, 128, 40);
  g.fillStyle = '#111'; g.font = 'bold 30px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('TAXI', 64, 22);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function checkerTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 8;
  const g = c.getContext('2d');
  for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { g.fillStyle = (i + j) % 2 ? '#111' : '#f5c518'; g.fillRect(i * 4, j * 4, 4, 4); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
}

// stání s taxíky (pevně daná): střed stání, směr dovnitř stání (nx, nz), výjezd na kraj vozovky
const BAYS = (() => {
  const spots = [];
  for (const s of STRIPS) for (let i = 0; i < s.n; i++) spots.push({ s, u: s.u0 + i * BAY_W + BAY_W / 2 });
  const step = spots.length / TAXIS, out = [];
  for (let i = 0; i < TAXIS; i++) {
    const { s, u } = spots[Math.min(spots.length - 1, Math.floor(i * step + step / 2))];
    const [x, z] = P(s, u, ROAD_HW + 0.4 + BAY_D / 2), [ex, ez] = P(s, u, ROAD_HW - 1.2);
    out.push({ x, z, nx: s.nx, nz: s.nz, ex, ez, car: null, out: false });
  }
  return out;
})();

/** Střešní cedule TAXI a šachovnice po bocích (pro taxík na cestě, karoserie je jinde). */
let extrasMats = null;
export function taxiExtras() {
  extrasMats ||= { signMat: new THREE.MeshLambertMaterial({ map: signTexture(), emissive: 0x403000 }),
    signTop: new THREE.MeshLambertMaterial({ color: 0xf5c518 }), checker: new THREE.MeshLambertMaterial({ map: checkerTexture() }) };
  const { signMat, signTop, checker } = extrasMats;
  const g = new THREE.Group();
  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.2, 0.26), [signTop, signTop, signTop, signTop, signMat, signMat]);
  sign.position.set(-0.25, 1.78, 0);
  sign.rotation.y = Math.PI / 2;
  g.add(sign);
  for (const s of [1, -1]) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.12), checker);
    strip.position.set(-0.1, 0.78, s * 0.935);
    if (s < 0) strip.rotation.y = Math.PI;
    g.add(strip);
  }
  return g;
}

export function createTaxiLot({ world }) {
  const T = world.tileAt(cen[0], cen[1]);
  const m = VEHICLES.mpv;
  const paint = new THREE.MeshLambertMaterial({ vertexColors: true, color: 0xf2f2ef });
  const fixed = new THREE.MeshLambertMaterial({ vertexColors: true });
  const lamp = new THREE.MeshBasicMaterial({ vertexColors: true });
  const signMat = new THREE.MeshLambertMaterial({ map: signTexture(), emissive: 0x403000 });
  const signTop = new THREE.MeshLambertMaterial({ color: 0xf5c518 });
  const checker = new THREE.MeshLambertMaterial({ map: checkerTexture() });
  const surf = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -12 });
  const lineMat = new THREE.MeshLambertMaterial({ color: 0xeeeeea, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -20 });
  const roofY = 1.68;

  function taxi() {
    const g = new THREE.Group();
    for (const [geo, mat] of [[m.paint0, paint], [m.paint1, paint], [m.fixed, fixed], [m.lamp, lamp]]) {
      if (!geo) continue;
      const me = new THREE.Mesh(geo, mat);
      me.castShadow = true;
      g.add(me);
    }
    // střešní cedule TAXI (popis na obou stranách)
    const sign = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.2, 0.26),
      [signTop, signTop, signTop, signTop, signMat, signMat]);
    sign.position.set(-0.25, roofY + 0.1, 0);
    sign.rotation.y = Math.PI / 2;                        // nápis na bocích auta
    g.add(sign);
    // žlutočerná šachovnice po bocích
    for (const s of [1, -1]) {
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.12), checker);
      strip.position.set(-0.1, 0.78, s * 0.935);
      if (s < 0) strip.rotation.y = Math.PI;
      g.add(strip);
    }
    return g;
  }

  const build = function build(tile, group) {
    if (!T || tile.i !== T.i || tile.j !== T.j) return;
    const pos = [], col = [], lines = [];
    const k = new THREE.Color(0x7f8186);
    const y = (x, z, up = 0) => world.heightAt(x, z) + LIFT + up;
    const quad = (p, arr, c, up = 0) => {
      const v = p.map(([x, z]) => [x, y(x, z, up), z]);
      arr.push(...v[0], ...v[1], ...v[2], ...v[0], ...v[2], ...v[3]);
      if (c) for (let i = 0; i < 6; i++) col.push(c.r, c.g, c.b);
    };
    const spots = [];
    for (const s of STRIPS) {
      // asfalt od kraje vozovky až za stání
      const v0 = ROAD_HW - 0.3, v1 = ROAD_HW + BAY_D + 0.4;
      for (let u = s.u0; u < s.u1; u += 2) {
        const u2 = Math.min(s.u1, u + 2);
        quad([P(s, u, v0), P(s, u, v1), P(s, u2, v1), P(s, u2, v0)], pos, k);
      }
      // čáry stání
      for (let i = 0; i <= s.n; i++) {
        const u = s.u0 + i * BAY_W, w = 0.06;
        quad([P(s, u - w, ROAD_HW + 0.4), P(s, u - w, ROAD_HW + BAY_D), P(s, u + w, ROAD_HW + BAY_D), P(s, u + w, ROAD_HW + 0.4)], lines, null, 0.02);
        if (i < s.n) spots.push({ s, u: u + BAY_W / 2 });
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, surf);
    mesh.receiveShadow = true;
    group.add(mesh);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    lg.computeVertexNormals();
    group.add(new THREE.Mesh(lg, lineMat));
    // taxíky: rozložené po stáních (každé druhé až třetí), čelem do stání; ten, co je zrovna na cestě, je skrytý
    for (const b of BAYS) {
      const car = taxi();
      car.position.set(b.x, y(b.x, b.z, 0.01), b.z);
      car.rotation.y = Math.atan2(-b.nz, b.nx);             // osa x (předek) dovnitř stání
      car.visible = !b.out;
      b.car = car;
      group.add(car);
    }
  };
  build.bays = BAYS;
  return build;
}
