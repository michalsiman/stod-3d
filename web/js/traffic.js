import * as THREE from 'three';
import { NIGHT } from './night.js';
import { VEHICLES, box, cyl, merge } from './models.js';
import { ROUNDABOUTS } from './landmarks.js';

// Doprava: auta, dodávky, náklaďáky, kamiony a traktory jezdí po silniční síti v okolí kamery
// (vpravo, zpomalují v zatáčkách a v obcích, drží odstup, dávají přednost), autobusy jezdí po linkách
// mezi zastávkami a stojí na nich, vlaky (osobní P3 a rychlík Ex6) po trati a staví v zastávkách.
// Zastávky (označníky, přístřešky, nástupiště) z data/stops.json (tools/build_transit.py).

const WIDTH = [8.5, 6.5, 5.0, 3.5, 3.2, 3.0, 2.6, 1.2, 4.2];
const LIFT = [0.34, 0.34, 0.34, 0.34, 0.31, 0.3, 0.29, 0.28, 0.36];
const RAIL_TOP = 0.36 + 0.06 + 0.16;
const VMAX = [24, 19, 13.5, 12, 9, 8, 6, 3];                 // [m/s] podle typu cesty
const VTOWN = 14;                                            // silnice v obci (50 km/h)
const ROAD_TYPES = new Set([0, 1, 2, 3, 4, 5, 6]);

// ---------------------------------------------------------------- graf sítě
/** Kruhové objezdy: uzavřené linie (silnice, ulice) s poloměrem do 30 m → [cx, cz, R]. */
function findRings(roads) {
  const out = [];
  const ends = new Map();
  for (const r of roads) {
    if (r.t > 3 || r.p.length < 2) continue;
    const p = r.p;
    // uzavřená linie, nebo oblouk, který leží na kružnici (objezd rozdělený na úseky)
    let cx = 0, cz = 0;
    for (const q of p) { cx += q[0]; cz += q[1]; }
    cx /= p.length; cz /= p.length;
    if (Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 1 && p.length > 6) {
      const R = p.reduce((a, q) => a + Math.hypot(q[0] - cx, q[1] - cz), 0) / p.length;
      if (R > 6 && R < 30 && p.every((q) => Math.abs(Math.hypot(q[0] - cx, q[1] - cz) - R) < 2)) out.push([cx, cz, R]);
    }
    void ends;
  }
  // objezdy zadané ručně (landmarks.js), i když jsou v datech rozdělené na oblouky
  for (const ra of ROUNDABOUTS) out.push([ra.at[0], ra.at[1], ra.apron + ra.road / 2]);
  return out;
}

export function buildGraph(roads, types, cars = false) {
  const ids = new Map(), X = [], Z = [], adj = [];
  const node = (p) => {
    const k = `${Math.round(p[0])},${Math.round(p[1])}`;
    let i = ids.get(k);
    if (i === undefined) { i = X.length; ids.set(k, i); X.push(p[0]); Z.push(p[1]); adj.push([]); }
    return i;
  };
  // kruhové objezdy: jednosměrně proti směru hodinových ručiček (při pohledu shora, sever nahoře)
  const rings = cars ? findRings(roads) : [];
  const ringOf = (ax, az, bx, bz) => rings.find(([cx, cz, R]) => Math.abs(Math.hypot(ax - cx, az - cz) - R) < 4
    && Math.abs(Math.hypot(bx - cx, bz - cz) - R) < 4);
  for (const r of roads) {
    if (!types.has(r.t) || (cars && r.nc)) continue;      // nc = jen pro pěší a kola
    let a = node(r.p[0]);
    for (let i = 1; i < r.p.length; i++) {
      const b = node(r.p[i]);
      if (b !== a && !adj[a].some((e) => e.to === b)) {
        const L = Math.hypot(X[b] - X[a], Z[b] - Z[a]);
        const ring = ringOf(X[a], Z[a], X[b], Z[b]);
        // osa z míří na jih: proti směru hodinových ručiček na mapě ⇔ rx·dz − rz·dx < 0
        const ccw = ring ? (X[a] - ring[0]) * (Z[b] - Z[a]) - (Z[a] - ring[1]) * (X[b] - X[a]) < 0 : null;
        if (ccw !== false) adj[a].push({ to: b, L, t: r.t, oneway: ring ? 1 : 0, svc: r.svc });
        if (ccw !== true) adj[b].push({ to: a, L, t: r.t, oneway: ring ? 1 : 0, svc: r.svc });
      }
      a = b;
    }
  }
  const CELL = 60, grid = new Map();
  const key = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  for (let i = 0; i < X.length; i++) {
    const k = key(X[i], Z[i]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  function nearest(x, z, ok = () => true, R = 3) {
    let best = -1, bd = Infinity;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
      for (const i of grid.get(`${cx + dx},${cz + dz}`) || []) {
        if (!ok(i)) continue;
        const d = Math.hypot(X[i] - x, Z[i] - z);
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  }
  return { X, Z, adj, nearest, n: X.length };
}

/** Nejlevnější cesta (Dijkstra s binární haldou); cost(edge) = cena hrany. */
function shortest(G, from, to, cost) {
  const dist = new Float64Array(G.n).fill(Infinity), prev = new Int32Array(G.n).fill(-1);
  const heap = [[0, from]];
  dist[from] = 0;
  const push = (it) => {
    heap.push(it);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (u === to) break;
    if (d > dist[u]) continue;
    for (const e of G.adj[u]) {
      const nd = d + cost(e);
      if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; push([nd, e.to]); }
    }
  }
  if (prev[to] < 0 && from !== to) return null;
  const path = [to];
  while (path[path.length - 1] !== from) path.push(prev[path[path.length - 1]]);
  return path.reverse();
}

// ---------------------------------------------------------------- dráha vozidla (osa jízdního pruhu)
// body P[i], úsek i = P[i] → P[i+1] s posunem do pruhu o[i] (vpravo) a typem t[i]; Q[i] = posunutý bod (pokos)
export class Track {
  constructor() { this.P = []; this.o = []; this.t = []; this.cum = []; this.Q = []; this.pin = []; }
  get len() { return this.cum.length ? this.cum[this.cum.length - 1] : 0; }
  get n() { return this.P.length; }
  /** pin = pevné odsazení právě tohoto bodu (jinak průměr sousedních úseků) – např. začátek a konec přechodu. */
  push(x, z, o = 0, t = 0, pin = null) {
    const n = this.P.length;
    if (n) {
      const [px, pz] = this.P[n - 1];
      const L = Math.hypot(x - px, z - pz);
      if (L < 0.05) return;
      this.o[n - 1] = o; this.t[n - 1] = t;
      this.cum.push(this.cum[n - 1] + L);
    } else this.cum.push(0);
    this.P.push([x, z]);
    this.o.push(o); this.t.push(t); this.pin.push(pin);
    this.Q.push(null);
    const m = this.P.length;
    if (m >= 2) { this.Q[m - 2] = this.miter(m - 2); this.Q[m - 1] = this.miter(m - 1); }
  }
  /** Odebere poslední bod (ještě neprojetý). */
  pop() {
    for (const a of [this.P, this.o, this.t, this.cum, this.Q, this.pin]) a.pop();
    const m = this.P.length;
    if (m >= 1) this.Q[m - 1] = this.miter(m - 1);
  }
  normal(i) {        // jednotková normála vpravo úseku i
    const [ax, az] = this.P[i], [bx, bz] = this.P[i + 1];
    const L = Math.hypot(bx - ax, bz - az) || 1;
    return [-(bz - az) / L, (bx - ax) / L];
  }
  miter(i) {
    const n = this.P.length, [x, z] = this.P[i];
    const hasPrev = i > 0, hasNext = i < n - 1;
    if (!hasPrev && !hasNext) return [x, z];
    const nc = hasNext ? this.normal(i) : this.normal(i - 1);
    const np = hasPrev ? this.normal(i - 1) : nc;
    const o = this.pin[i] !== null && this.pin[i] !== undefined ? this.pin[i]
      : hasPrev && hasNext ? (this.o[i - 1] + this.o[i]) / 2 : hasNext ? this.o[i] : this.o[i - 1];
    // otočka zpět po stejné cestě: zůstat na straně, kde vozidlo / chodec přijel
    if (hasPrev && hasNext && nc[0] * np[0] + nc[1] * np[1] < -0.9) return [x + np[0] * this.o[i - 1], z + np[1] * this.o[i - 1]];
    let mx = nc[0] + np[0], mz = nc[1] + np[1];
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml; mz /= ml;
    const k = o / Math.max(0.5, mx * nc[0] + mz * nc[1]);
    return [x + mx * k, z + mz * k];
  }
  seg(s) {
    const c = this.cum;
    let lo = 0, hi = c.length - 2;
    if (s <= 0) return 0;
    if (s >= c[hi + 1]) return Math.max(0, hi);
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (c[mid] <= s) lo = mid; else hi = mid - 1; }
    return lo;
  }
  /** Bod na ose pruhu ve vzdálenosti s: out = [x, z, typ, směr x, směr z]. */
  at(s, out) {
    const i = this.seg(s), L = this.cum[i + 1] - this.cum[i] || 1;
    const t = THREE.MathUtils.clamp((s - this.cum[i]) / L, 0, 1);
    const a = this.Q[i], b = this.Q[i + 1] || a;
    out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out[2] = this.t[i];
    const [px, pz] = this.P[i], [qx, qz] = this.P[i + 1] || this.P[i];
    const l = Math.hypot(qx - px, qz - pz) || 1;
    out[3] = (qx - px) / l; out[4] = (qz - pz) / l;
    return out;
  }
  /** Odstraní body před vzdáleností s (ponechá jeden úsek); vrátí, o kolik se posunuly vzdálenosti. */
  trim(s) {
    let k = this.seg(s) - 1;
    if (k < 8) return 0;
    const d = this.cum[k];
    for (const a of [this.P, this.o, this.t, this.Q, this.cum, this.pin]) a.splice(0, k);
    for (let i = 0; i < this.cum.length; i++) this.cum[i] -= d;
    return d;
  }
  /** Úhel zatočení ve vrcholu i [rad]. */
  turn(i) {
    if (i <= 0 || i >= this.P.length - 1) return 0;
    const [ax, az] = this.P[i - 1], [bx, bz] = this.P[i], [cx, cz] = this.P[i + 1];
    const a1 = Math.atan2(bz - az, bx - ax), a2 = Math.atan2(cz - bz, cx - bx);
    return Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
  }
}

const laneOffset = (t) => Math.min(WIDTH[t] / 4, 1.9);

// ---------------------------------------------------------------- vykreslení: instance po druzích
const BEAM_KINDS = new Set(['car', 'hatch', 'suv', 'combi', 'van', 'truck', 'semi', 'bus', 'tractor']);

function createPools(scene, caps, { lamps = true } = {}) {
  const mats = {
    // stejný posun hloubky jako silnice (roads.js), jinak silnice zakrývá spodek kol
    paint: new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16 }),
    fixed: new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16 }),
    lamp: new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16 }),
    // kužel světla: průhledný, sčítá se, slábne do dálky (atribut alpha); síla podle noci (uniform)
    beam: new THREE.ShaderMaterial({
      uniforms: { k: { value: 0 } },
      vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.); }',
      fragmentShader: 'uniform float k; varying float vA; void main(){ gl_FragColor = vec4(vec3(1., .93, .75) * vA * vA * vA * k, 1.); }',
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -24,
    }),
  };
  const pools = {};
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (const [kind, cap] of Object.entries(caps)) {
    const m = VEHICLES[kind];
    const meshes = [];
    for (const [k, mat] of [['paint0', mats.paint], ['paint1', mats.paint], ['fixed', mats.fixed], ['lamp', mats.lamp]]) {
      if (!m[k] || (k === 'lamp' && !lamps)) continue;
      const im = new THREE.InstancedMesh(m[k], mat, cap);
      im.frustumCulled = false;
      im.castShadow = k !== 'lamp';
      im.receiveShadow = k !== 'lamp';
      im.userData.slot = k;
      for (let i = 0; i < cap; i++) im.setMatrixAt(i, zero);
      if (k.startsWith('paint')) im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      scene.add(im);
      meshes.push(im);
    }
    // světelný kužel reflektorů na silnici před vozidlem (v noci)
    if (lamps && BEAM_KINDS.has(kind)) {
      const L = kind === 'tractor' ? 10 : 18, x0 = m.nose - 0.2;
      const g = new THREE.BufferGeometry();
      const pos = [x0, 0.06, -0.8, x0 + L, 0.06, -3.2, x0 + L, 0.06, 3.2, x0, 0.06, -0.8, x0 + L, 0.06, 3.2, x0, 0.06, 0.8];
      const al = [1, 0, 0, 1, 0, 1];
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('alpha', new THREE.Float32BufferAttribute(al, 1));
      const im = new THREE.InstancedMesh(g, mats.beam, cap);
      im.frustumCulled = false;
      im.userData.slot = 'beam';
      for (let i = 0; i < cap; i++) im.setMatrixAt(i, zero);
      scene.add(im);
      meshes.push(im);
    }
    pools[kind] = { model: m, meshes, free: Array.from({ length: cap }, (_, i) => cap - 1 - i), dirty: true };
  }
  const take = (kind, colors) => {
    const p = pools[kind];
    const i = p.free.pop();
    if (i === undefined) return -1;
    for (const im of p.meshes) {
      if (im.userData.slot === 'paint0') im.setColorAt(i, colors[0]);
      if (im.userData.slot === 'paint1') im.setColorAt(i, colors[1] || colors[0]);
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    return i;
  };
  const release = (kind, i) => {
    const p = pools[kind];
    for (const im of p.meshes) im.setMatrixAt(i, zero);
    p.free.push(i); p.dirty = true;
  };
  const set = (kind, i, mat) => { const p = pools[kind]; for (const im of p.meshes) im.setMatrixAt(i, mat); p.dirty = true; };
  const flush = () => {
    for (const p of Object.values(pools)) {
      if (!p.dirty) continue;
      for (const im of p.meshes) im.instanceMatrix.needsUpdate = true;
      p.dirty = false;
    }
  };
  const setVisible = (v) => { for (const p of Object.values(pools)) for (const im of p.meshes) im.visible = v; };
  return { pools, take, release, set, flush, setVisible, mats, zero };
}

// ---------------------------------------------------------------- barvy
const C = (h) => new THREE.Color(h);
const CAR_COLORS = [0xf2f2f2, 0xf2f2f2, 0x1d1e22, 0x1d1e22, 0x9ea3a8, 0x9ea3a8, 0x5b6066, 0x5b6066, 0x24407a,
  0x7d1d1d, 0xb52b25, 0x2f5a3a, 0xc8b89a, 0x3c5f88, 0xd9d4c8, 0x6a4a35, 0x1f6b6e, 0xe3a21a].map(C);
const VAN_COLORS = [0xf4f4f4, 0xf4f4f4, 0xf4f4f4, 0xb5b9bd, 0x2a4f8f, 0xc23a2b].map(C);
const CAB_COLORS = [0xf2f2f2, 0x1f4e9a, 0xb3241d, 0x2f6d3d, 0xe8e2d0, 0x30353b, 0xe5a313].map(C);
const CARGO_COLORS = [0xe9e9e6, 0xc8ccd0, 0x5d7d9c, 0xd6c8a6, 0x7c8b5a, 0xa33a2e, 0x2e4d7a, 0xd9d9d9].map(C);
const TRACTOR_COLORS = [[0x2e7d32, 0x2e7d32], [0x367c2b, 0x367c2b], [0xc62828, 0xc62828], [0xe2611f, 0xe2611f], [0x1d5aa0, 0x1d5aa0]];
const BUS_COLORS = [[0xf1f1ef, 0x1d5fa8], [0xf1f1ef, 0x2a8a4a], [0xf4efe4, 0xd23a2a]];

const rnd = (a) => a[Math.floor(Math.random() * a.length)];

// ---------------------------------------------------------------- zastávky (modely)
function stopTexture(name, rail) {
  const c = document.createElement('canvas');
  const H = 128;
  let ctx = c.getContext('2d');
  const font = `700 ${H * 0.4}px "Inter", "Segoe UI", Arial, sans-serif`;
  ctx.font = font;
  const w = rail ? Math.max(H * 3, Math.ceil(ctx.measureText(name).width + H * 0.8)) : H * 2;
  c.width = w; c.height = rail ? H : H * 2;
  ctx = c.getContext('2d');
  if (rail) {
    ctx.fillStyle = '#1d4f91'; ctx.fillRect(0, 0, w, H);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.strokeRect(8, 8, w - 16, H - 16);
    ctx.font = font; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(name, w / 2, H * 0.54);
  } else {
    // označník: bílá tabule s černým okrajem a autobusem, pod ní název zastávky
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, H * 2);
    ctx.strokeStyle = '#111'; ctx.lineWidth = 10; ctx.strokeRect(5, 5, w - 10, H * 1.3 - 10);
    ctx.fillStyle = '#111';
    const bx = w * 0.2, by = H * 0.32, bw = w * 0.6, bh = H * 0.55;
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 10); ctx.fill();
    ctx.fillStyle = '#fff';
    for (let k = 0; k < 4; k++) ctx.fillRect(bx + 12 + k * (bw - 24) / 4, by + 10, (bw - 24) / 4 - 8, bh * 0.38);
    ctx.fillStyle = '#111';
    for (const x of [bx + bw * 0.22, bx + bw * 0.78]) { ctx.beginPath(); ctx.arc(x, by + bh, 14, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#1d3b8f'; ctx.fillRect(0, H * 1.3, w, H * 0.7);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const short = name.replace(/^(Chotěšov|Stod),\s*/, '');
    let size = H * 0.3;
    ctx.font = `700 ${size}px "Inter", Arial, sans-serif`;
    while (ctx.measureText(short).width > w - 16 && size > 12) { size -= 2; ctx.font = `700 ${size}px "Inter", Arial, sans-serif`; }
    ctx.fillText(short, w / 2, H * 1.65);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return { tex: t, aspect: c.width / c.height };
}

function shelterGeo(rail) {
  const L = rail ? 6 : 3.6, D = 1.5, Hh = 2.4;
  const metal = 0x5d6670, glass = 0x9fc2d4;
  return {
    solid: merge([
      box(L + 0.3, 0.1, D + 0.4, 0, Hh + 0.05, 0.1, rail ? 0x6d7883 : 0x3d4650),
      ...[-L / 2, L / 2].flatMap((x) => [box(0.08, Hh, 0.08, x, Hh / 2, -D / 2, metal), box(0.08, Hh, 0.08, x, Hh / 2, D / 2, metal)]),
      box(L * 0.7, 0.06, 0.4, 0, 0.47, -D / 2 + 0.3, 0x8a6a48), box(L * 0.7, 0.45, 0.06, 0, 0.25, -D / 2 + 0.3, metal),
    ]),
    glass: merge([box(L, Hh - 0.3, 0.03, 0, (Hh - 0.3) / 2 + 0.2, -D / 2, glass),
      box(0.03, Hh - 0.3, D * 0.8, -L / 2, (Hh - 0.3) / 2 + 0.2, -D * 0.1, glass),
      box(0.03, Hh - 0.3, D * 0.8, L / 2, (Hh - 0.3) / 2 + 0.2, -D * 0.1, glass)]),
  };
}

// ---------------------------------------------------------------- hlavní objekt
export function createTraffic({ roads, bridges, buildings, world, scene, stops, parking, coarse, drive }) {
  const group = new THREE.Group();
  scene.add(group);
  const G = buildGraph(roads, ROAD_TYPES, true);
  const R = buildGraph(roads, new Set([8]));
  const W2 = world.W / 2 - 25, H2 = world.H / 2 - 25;
  const inside = (x, z) => Math.abs(x) < W2 && Math.abs(z) < H2;

  // obce: mřížka 100 m s počtem domů (v obci se jezdí pomaleji)
  const town = new Map();
  for (const b of buildings) {
    if (b.k !== 'house' && b.k !== 'flats' && b.k !== 'civic') continue;
    const p = b.rings[0][0], k = `${Math.floor(p[0] / 100)},${Math.floor(p[1] / 100)}`;
    town.set(k, (town.get(k) || 0) + 1);
  }
  const inTown = (x, z) => {
    let n = 0;
    const cx = Math.floor(x / 100), cz = Math.floor(z / 100);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) n += town.get(`${cx + dx},${cz + dz}`) || 0;
    return n >= 6;
  };

  // výška povrchu pod bodem (most / terén) + posun nad terén
  const surfaceY = (x, z, t, dx, dz) => (bridges.at(x, z, WIDTH[t], dx, dz) ?? world.heightAt(x, z)) + (t === 8 ? RAIL_TOP : LIFT[t]);
  const detailAt = (x, z) => !!world.tileAt(x, z)?.detail;

  // ---------------------------------------------------------- pozice / matice
  const P1 = [0, 0, 0, 0, 0], P2 = [0, 0, 0, 0, 0];
  const vF = new THREE.Vector3(), vR = new THREE.Vector3(), fwd = new THREE.Vector3(), up = new THREE.Vector3(), side = new THREE.Vector3();
  const mat = new THREE.Matrix4();
  /** Matice pro vozidlo / vůz s oporami ve vzdálenostech sF (přední) a sR (zadní) na dráze tr. */
  function pose(tr, sF, sR, out) {
    tr.at(sF, P1); tr.at(sR, P2);
    vF.set(P1[0], surfaceY(P1[0], P1[1], P1[2], P1[3], P1[4]), P1[1]);
    vR.set(P2[0], surfaceY(P2[0], P2[1], P2[2], P2[3], P2[4]), P2[1]);
    fwd.subVectors(vF, vR);
    if (fwd.lengthSq() < 1e-4) fwd.set(P1[3], 0, P1[4]);
    fwd.normalize();
    up.set(0, 1, 0).addScaledVector(fwd, -fwd.y).normalize();
    side.crossVectors(fwd, up);
    out.makeBasis(fwd, up, side).setPosition((vF.x + vR.x) / 2, (vF.y + vR.y) / 2, (vF.z + vR.z) / 2);
    return out;
  }

  // ---------------------------------------------------------- vozidla
  const caps = coarse
    ? { car: 32, hatch: 14, suv: 12, combi: 12, van: 8, truck: 6, semi: 6, trailer: 6, tractor: 3, wagon: 3, bus: 10, unit: 4, loco: 2, coach: 10 }
    : { car: 70, hatch: 30, suv: 24, combi: 24, van: 18, truck: 12, semi: 12, trailer: 12, tractor: 6, wagon: 6, bus: 10, unit: 4, loco: 2, coach: 10 };
  const pool = createPools(group, caps);
  const vehicles = [];          // auta v okolí + autobusy
  const RADIUS = coarse ? 550 : 750;
  const MIX = [['car', 0.36], ['hatch', 0.16], ['suv', 0.12], ['combi', 0.12], ['van', 0.1], ['truck', 0.05], ['semi', 0.05], ['tractor', 0.04]];
  const target = Object.fromEntries(MIX.map(([k, f]) => [k, Math.round(f * (coarse ? 60 : 125))]));
  target.tractor = Math.min(target.tractor, caps.tractor);

  // preference cest podle druhu vozidla (váha při výběru odbočky a místa vzniku)
  const PREF = {
    // auta jen po silnicích a asfaltu (0 silnice I., 1 II./III., 2 ulice, 3 asfaltová cesta), ne po panelech,
    // štěrku, polních a lesních cestách; náklaďáky a kamiony jen po silnicích; traktory i po polních cestách
    car: [6, 4, 2.2, 0.35, 0, 0, 0], truck: [9, 4, 0, 0, 0, 0, 0], semi: [12, 3, 0, 0, 0, 0, 0],
    tractor: [0.4, 1.2, 0.5, 1.5, 2, 2.5, 2.5], van: [5, 4, 2.5, 0.35, 0, 0, 0],
  };
  // průjezdná doprava po hlavním tahu (I/26 Plzeň – Stod – Holýšov): drží se silnice I. třídy
  const MAIN_PREF = [60, 1.5, 0.15, 0.02, 0, 0, 0];
  const MAIN_MIX = [['car', 0.4], ['hatch', 0.12], ['suv', 0.12], ['combi', 0.12], ['van', 0.1], ['truck', 0.06], ['semi', 0.08]];
  const MAIN_N = coarse ? 16 : 36;
  // denní doba: ve špičce (6–9, 14–18 h) plno, přes den hodně, večer míň, v noci málo
  const rush = () => {
    const h = new Date().getHours() + new Date().getMinutes() / 60;
    if ((h >= 6 && h < 9) || (h >= 14 && h < 18)) return 1;
    if (h >= 9 && h < 14) return 0.8;
    if (h >= 18 && h < 22) return 0.55;
    return 0.25;
  };
  const prefOf = (kind, main) => (main ? MAIN_PREF : PREF[kind] || PREF.car);

  // hrany v buňkách 150 m pro vznik vozidel v okolí
  const ECELL = 150, ecells = new Map();
  for (let a = 0; a < G.n; a++) {
    for (const e of G.adj[a]) {
      if (e.to < a && !e.oneway) continue;
      const x = (G.X[a] + G.X[e.to]) / 2, z = (G.Z[a] + G.Z[e.to]) / 2;
      if (!inside(x, z)) continue;
      const k = `${Math.floor(x / ECELL)},${Math.floor(z / ECELL)}`;
      if (!ecells.has(k)) ecells.set(k, []);
      ecells.get(k).push([a, e]);
    }
  }

  function chooseNext(v) {
    const from = v.prev, at = v.node;
    const ax = G.X[at] - G.X[from], az = G.Z[at] - G.Z[from], al = Math.hypot(ax, az) || 1;
    const pref = prefOf(v.kind, v.main);
    let sum = 0;
    const opts = [];
    for (const e of G.adj[at]) {
      if (e.to === from) continue;
      const bx = G.X[e.to] - G.X[at], bz = G.Z[e.to] - G.Z[at], bl = Math.hypot(bx, bz) || 1;
      const cos = (ax * bx + az * bz) / (al * bl);
      if (cos < -0.5 && (v.kind !== 'car' || v.main)) continue;            // ostré otočení jen osobní auto
      let w = (pref[e.t] || 0) * (0.25 + (1 + cos) ** 2);
      if (v.kind === 'tractor' && e.t <= 2 && inTown(G.X[e.to], G.Z[e.to])) w *= 0.03;   // traktor do města skoro nezajíždí
      if (!inside(G.X[e.to], G.Z[e.to])) w *= 0.05;
      if (w <= 0) continue;
      opts.push([e, w]); sum += w;
    }
    if (!opts.length) return G.adj[at].find((e) => e.to === from) || null;     // slepá cesta → otočit
    let r = Math.random() * sum;
    for (const [e, w] of opts) { r -= w; if (r <= 0) return e; }
    return opts[opts.length - 1][0];
  }

  function extend(v) {
    while (v.track.len - v.s < 140) {
      const e = chooseNext(v);
      if (!e) return false;
      v.prev = v.node; v.node = e.to;
      v.track.push(G.X[e.to], G.Z[e.to], laneOffset(e.t), e.t);
    }
    return true;
  }

  function addVehicle(kind, track, extra = {}) {
    const colors = kind === 'bus' ? rnd(BUS_COLORS).map(C)
      : kind === 'van' ? [rnd(VAN_COLORS)]
        : kind === 'truck' ? [rnd(CAB_COLORS), rnd(CARGO_COLORS)]
          : kind === 'semi' ? [rnd(CAB_COLORS)]
            : kind === 'tractor' ? rnd(TRACTOR_COLORS).map(C) : [rnd(CAR_COLORS)];
    const slot = pool.take(kind, colors);
    if (slot < 0) return null;
    const m = VEHICLES[kind];
    const v = { kind, slot, track, s: 0, v: 0, m, x: 0, z: 0, dx: 1, dz: 0, stopT: 0, wait: 0, trailer: null, ...extra };
    if (kind === 'semi' || (kind === 'tractor' && Math.random() < 0.45)) {
      const tk = kind === 'semi' ? 'trailer' : 'wagon';
      const ts = pool.take(tk, [kind === 'semi' ? rnd(CARGO_COLORS) : C(rnd([0xa83a2a, 0x2f6d3d, 0x6f7a84]))]);
      if (ts >= 0) v.trailer = { kind: tk, slot: ts, m: VEHICLES[tk] };
    }
    vehicles.push(v);
    return v;
  }
  function removeVehicle(v) {
    v.gone = true;
    pool.release(v.kind, v.slot);
    if (v.trailer) pool.release(v.trailer.kind, v.trailer.slot);
    vehicles.splice(vehicles.indexOf(v), 1);
  }

  function spawnNear(kind, fx, fz, cam, minCam, main = false) {
    const pref = prefOf(kind, main);
    const cells = [];
    const r = Math.ceil(RADIUS / ECELL), cx = Math.floor(fx / ECELL), cz = Math.floor(fz / ECELL);
    for (let i = 0; i < 12; i++) {
      const k = `${cx + Math.floor((Math.random() * 2 - 1) * r)},${cz + Math.floor((Math.random() * 2 - 1) * r)}`;
      if (ecells.has(k)) cells.push(ecells.get(k));
    }
    let sum = 0;
    const cand = [];
    for (const list of cells) {
      for (let i = 0; i < 6; i++) {
        const it = list[Math.floor(Math.random() * list.length)];
        const w = (pref[it[1].t] || 0) * Math.min(it[1].L, 80);
        if (w > 0) { cand.push([it, w]); sum += w; }
      }
    }
    if (!sum) return null;
    let pick = Math.random() * sum, it = cand[0][0];
    for (const [c, w] of cand) { pick -= w; if (pick <= 0) { it = c; break; } }
    let [a, e] = it;
    let b = e.to;
    if (Math.random() < 0.5 && G.adj[b].some((q) => q.to === a)) [a, b] = [b, a];
    const x = (G.X[a] + G.X[b]) / 2, z = (G.Z[a] + G.Z[b]) / 2;
    if (Math.hypot(x - fx, z - fz) > RADIUS || !detailAt(x, z)) return null;
    if (kind === 'tractor' && inTown(x, z)) return null;            // traktory jen mimo město
    if (cam && Math.hypot(x - cam.x, z - cam.z) < minCam) return null;
    // volno?
    for (const o of vehicles) if (Math.hypot(o.x - x, o.z - z) < 25) return null;
    const tr = new Track();
    tr.push(G.X[a], G.Z[a], laneOffset(e.t), e.t);
    tr.push(G.X[b], G.Z[b], laneOffset(e.t), e.t);
    const v = addVehicle(kind, tr, { prev: a, node: b, roam: true, main });
    if (!v) return null;
    v.s = tr.len * Math.random();
    extend(v);
    v.v = vlimit(v) * 0.7;
    return v;
  }

  // ---------------------------------------------------------- jízda
  const spatial = new Map();
  const SC = 40;
  function index() {
    spatial.clear();
    const add = (o) => {
      const k = `${Math.floor(o.x / SC)},${Math.floor(o.z / SC)}`;
      if (!spatial.has(k)) spatial.set(k, []);
      spatial.get(k).push(o);
    };
    for (const v of vehicles) { add(v); if (v.trailer) add(v.trailer); }
    const d = drive?.state;
    if (drive?.active && d) add({ x: d.x, z: d.z, dx: Math.cos(d.heading), dz: Math.sin(d.heading), v: Math.abs(d.v || 0), len: 4.4, m: { nose: 2.2, tail: 2.2 }, user: true, t: 1 });
    for (const tr of trains) for (const c of tr.cars) add(c);
  }

  function vlimit(v) {
    v.track.at(v.s, P1);
    const t = P1[2];
    let lim = VMAX[t] ?? 8;
    if (t <= 1 && inTown(P1[0], P1[1])) lim = Math.min(lim, VTOWN);
    if (v.kind === 'tractor') lim = Math.min(lim, 8.5);
    if (v.kind === 'truck' || v.kind === 'semi') lim = Math.min(lim, 21);
    if (v.kind === 'bus') lim = Math.min(lim, 19);
    return lim * (v.mood || 1);
  }

  function step(v, dt) {
    if (v.wreck) { v.v = 0; v.braking = true; return; }        // nabourané stojí
    let want = vlimit(v);
    const tr = v.track;
    // zatáčky před vozidlem
    const look = 12 + v.v * v.v / 4;
    for (let i = tr.seg(v.s) + 1; i < tr.n - 1 && tr.cum[i] - v.s < look; i++) {
      const a = tr.turn(i);
      if (a < 0.25) continue;
      const vt = a > 2.6 ? 2.5 : Math.max(4, 17 - a * 9);
      const d = Math.max(0, tr.cum[i] - v.s - 3);
      want = Math.min(want, Math.sqrt(vt * vt + 2 * 2.2 * d));
    }
    // zastávka (autobus)
    if (v.stops && v.next < v.stops.length) {
      const d = v.stops[v.next].s - v.s;
      if (d < 0.6) {
        if (v.stopT <= 0 && v.v < 0.4) v.stopT = 14 + Math.random() * 10;
        want = 0;
        if (v.stopT > 0) {
          v.stopT -= dt;
          if (v.stopT <= 0) { v.next++; v.stopT = 0; }
        }
      } else want = Math.min(want, Math.sqrt(2 * 1.4 * Math.max(0, d - 0.5)) + 0.3);
    }
    // vozidla před námi
    const fx = v.dx, fz = v.dz;
    let yieldTo = false;
    const cx = Math.floor(v.x / SC), cz = Math.floor(v.z / SC);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const o of spatial.get(`${cx + a},${cz + b}`) || []) {
        if (o === v || (v.trailer && o === v.trailer)) continue;
        const rx = o.x - v.x, rz = o.z - v.z;
        const along = rx * fx + rz * fz;
        if (along <= 0 || along > 45) continue;
        const lat = Math.abs(rx * fz - rz * fx);
        const dot = o.dx * fx + o.dz * fz;
        if (o.rail) {                                  // přejezd: počkat, než vlak projede
          if (lat < 5 && along < 30 && Math.abs(dot) < 0.7) want = Math.min(want, Math.max(0, (along - 10) / 2));
          continue;
        }
        if (dot > 0.35 && lat < 1.9) {
          const gap = along - (v.m.nose || 2) - (o.m?.tail || 2.2);
          want = Math.min(want, Math.max(0, (gap - 3) / 1.3));
        } else if (Math.abs(dot) < 0.6 && lat < 3.2 && along < 14 && o.v > 0.5 && v.wait < 5) {
          yieldTo = true;                              // křižující vozidlo těsně před námi
        }
      }
    }
    if (yieldTo) { want = Math.min(want, 0); v.wait += dt; } else v.wait = Math.max(0, v.wait - dt * 0.5);
    if (v.wait > 7) v.wait = 0;
    const acc = want > v.v ? (v.kind === 'car' || v.kind === 'hatch' || v.kind === 'combi' || v.kind === 'suv' ? 2.4 : 1.2) : -7;
    v.v = Math.max(0, v.v + THREE.MathUtils.clamp(want - v.v, -7 * dt, Math.abs(acc) * dt));
    v.s += v.v * dt;
    v.braking = want < v.v - 0.5 || v.v < 0.3;
  }

  function place(v) {
    const tr = v.track;
    if (v.wreck?.b) {
      const w = v.wreck, m = deform(w.b, w);
      v.x = m.elements[12]; v.z = m.elements[14];
      const l = Math.hypot(m.elements[0], m.elements[2]) || 1;
      v.dx = m.elements[0] / l; v.dz = m.elements[2] / l;
      const show = detailAt(v.x, v.z);
      pool.set(v.kind, v.slot, show ? m : pool.zero);
      if (v.trailer && w.tm) pool.set(v.trailer.kind, v.trailer.slot, show ? w.tm : pool.zero);
      return;
    }
    pose(tr, v.s, v.s - v.m.wb, mat);
    v.x = mat.elements[12]; v.z = mat.elements[14]; v.y = mat.elements[13];
    v.dx = mat.elements[0]; v.dz = mat.elements[2];
    const l = Math.hypot(v.dx, v.dz) || 1; v.dx /= l; v.dz /= l;
    const show = detailAt(v.x, v.z);
    pool.set(v.kind, v.slot, show ? mat : pool.zero);
    if (v.trailer) {
      const t = v.trailer;
      const hitch = v.s - v.m.wb - (v.kind === 'semi' ? -0.25 : 1.6);
      pose(tr, hitch, hitch - t.m.wb, mat);
      t.x = mat.elements[12]; t.z = mat.elements[14]; t.dx = v.dx; t.dz = v.dz; t.v = v.v;
      pool.set(t.kind, t.slot, show ? mat : pool.zero);
      if (v.wreck) v.wreck.tm = mat.clone();
    }
    if (v.wreck) { v.wreck.b = mat.clone().setPosition(v.x, v.y, v.z); place(v); }
  }

  // ---------------------------------------------------------- srážky s autem hráče
  const BIG = new Set(['truck', 'semi', 'trailer', 'bus', 'tractor', 'wagon', 'van']);
  const base = new THREE.Matrix4(), dq = new THREE.Quaternion(), de = new THREE.Euler(), dsv = new THREE.Vector3(), dm = new THREE.Matrix4();
  function inBox(o, m, kind, x, z, pad) {
    const rx = x - o.x, rz = z - o.z;
    const a = rx * o.dx + rz * o.dz, l = Math.abs(rz * o.dx - rx * o.dz);
    return a < m.nose + pad && a > -m.tail - pad && l < (BIG.has(kind) ? 1.3 : 1.0) + pad;
  }
  /** Vozidlo (jedoucí nebo zaparkované), do kterého patří bod x, z. */
  function hitAt(x, z, pad = 0.15) {
    if (!enabled) return null;
    for (const v of vehicles) {
      if (Math.abs(v.x - x) > 14 || Math.abs(v.z - z) > 14) continue;
      if (inBox(v, v.m, v.kind, x, z, pad)) return v;
      if (v.trailer && v.trailer.x !== undefined && inBox(v.trailer, v.trailer.m, v.trailer.kind, x, z, pad)) return v;
    }
    for (const c of parked) {
      if (c.slot < 0 || Math.abs(c.p[0] - x) > 6 || Math.abs(c.p[1] - z) > 6) continue;
      c.x = c.p[0]; c.z = c.p[1]; c.dx = c.d[0]; c.dz = c.d[1];
      if (inBox(c, VEHICLES[c.kind], c.kind, x, z, pad)) return c;
    }
    return null;
  }
  // zmačkaná karoserie: odhozená ve směru nárazu (během w.e 0 → 1 odletí, poskočí a dotočí se), nižší a kratší
  const ease = (e) => 1 - (1 - e) ** 3;
  function deform(m, w) {
    const e = ease(Math.min(1, w.e));
    de.set(w.roll * e, w.yaw * e, w.pitch * e);
    dm.compose(dsv.set(0, 0, 0), dq.setFromEuler(de), new THREE.Vector3(...w.sc));
    const out = m.clone().multiply(dm);
    out.elements[12] += w.sx * e; out.elements[14] += w.sz * e;
    out.elements[13] += Math.sin(Math.PI * Math.min(1, w.e)) * w.hop;
    return out;
  }
  const flying = [];                                   // zaparkovaná auta, která právě letí
  function animWrecks(dt) {
    for (const v of vehicles) if (v.wreck && v.wreck.e < 1) v.wreck.e = Math.min(1, v.wreck.e + dt / 0.7);
    for (let i = flying.length - 1; i >= 0; i--) {
      const o = flying[i], w = o.wreck;
      w.e = Math.min(1, w.e + dt / 0.7);
      w.m = deform(w.b, w);
      ppool.set(o.kind, o.slot, w.m);
      if (w.e >= 1) { o.p = [w.m.elements[12], w.m.elements[14]]; o.d = [w.m.elements[0], w.m.elements[2]]; flying.splice(i, 1); }
    }
  }
  function darken(p, slot) {
    const c = new THREE.Color();
    for (const im of p.meshes) {
      if (!im.instanceColor) continue;
      im.getColorAt(slot, c); im.setColorAt(slot, c.multiplyScalar(0.72)); im.instanceColor.needsUpdate = true;
    }
  }
  /** Po vypnutí Demolice: nabouraná auta pryč, zaparkovaná zpátky celá na místo. */
  function clearWrecks() {
    for (const b of buses) if (b.v?.wreck) b.v = null;
    for (const v of [...vehicles]) if (v.wreck) removeVehicle(v);
    flying.length = 0;
    const c3 = new THREE.Color();
    for (const c of parked) {
      if (!c.wreck) continue;
      c.p = c.wreck.p0; c.d = c.wreck.d0;
      for (const im of ppool.pools[c.kind].meshes) {
        if (!im.instanceColor) continue;
        im.getColorAt(c.slot, c3); im.setColorAt(c.slot, c3.multiplyScalar(1 / 0.72)); im.instanceColor.needsUpdate = true;
      }
      c.wreck = null;
    }
    refreshParked();
    pool.flush();
  }
  /** Nabourat vozidlo (režim GTA); false, když už nabourané je. */
  function wreck(o, hx, hz, speed) {
    // každý další náraz do už nabouraného auta ho znovu kus odhodí (a trochu víc zmačká);
    // vrací 'first' (první náraz), 'again' (další) nebo false (těsně po předchozím nárazu)
    const now = performance.now(), old = o.wreck;
    if (old && (now - old.at < 450 || (!old.b && !o.p))) return false;
    const hits = (old?.hits || 0) + 1;
    const k = Math.min(1, speed / 14), side = Math.random() < 0.5 ? -1 : 1;
    const push = old ? Math.min(5, 0.8 + speed * 0.25) : Math.min(6, 1 + speed * 0.32);
    const w = { sx: hx * push, sz: hz * push, yaw: side * (old ? 0.2 + Math.random() * 0.5 : 0.4 + Math.random() * 0.9) * k,
      roll: (Math.random() - 0.5) * (old ? 0.08 : 0.25) * k, pitch: (Math.random() - 0.5) * (old ? 0.05 : 0.14) * k,
      sc: old ? (hits < 7 ? [0.97, 0.96, 1.01] : [1, 1, 1]) : [0.86 - 0.08 * k * Math.random(), 0.8 - 0.1 * k, 0.94 + 0.1 * k],
      hop: (old ? 0.15 : 0.25) + 0.5 * k, e: 0, b: null, m: null, p0: old ? old.p0 : o.p, d0: old ? old.d0 : o.d, hits, at: now };
    if (o.p) {                                         // zaparkované
      if (old) w.b = old.m || deform(old.b, old);
      else {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-o.d[1], o.d[0]));
        w.b = base.compose(new THREE.Vector3(o.p[0], world.heightAt(o.p[0], o.p[1]) + 0.04, o.p[1]), q, new THREE.Vector3(1, 1, 1)).clone();
        darken(ppool.pools[o.kind], o.slot);
      }
      o.wreck = w;
      w.m = deform(w.b, w);
      if (!flying.includes(o)) flying.push(o);
    } else {
      if (old) { w.b = deform(old.b, old); w.tm = old.tm; }
      o.wreck = w;
      o.v = 0;
      if (!old) {
        darken(pool.pools[o.kind], o.slot);
        if (o.trailer) darken(pool.pools[o.trailer.kind], o.trailer.slot);
      }
    }
    return old ? 'again' : 'first';
  }

  // ---------------------------------------------------------- linky autobusů
  const busStops = stops?.bus || [];
  const groups = new Map();       // název → středy nástupišť
  for (const b of busStops) {
    if (!groups.has(b.n)) groups.set(b.n, []);
    groups.get(b.n).push(b);
  }
  // autobusy po hlavních silnicích: zastávka se přichytí k silnici (I.–III. tř.), do ulic jen když to jinak nejde
  const stopNode = (name) => {
    const g = groups.get(name);
    if (!g) return -1;
    const x = g.reduce((s, b) => s + b.x, 0) / g.length, z = g.reduce((s, b) => s + b.z, 0) / g.length;
    const main = G.nearest(x, z, (i) => G.adj[i].some((e) => e.t <= 1), 3);
    if (main >= 0 && Math.hypot(G.X[main] - x, G.Z[main] - z) < 120) return main;
    const street = G.nearest(x, z, (i) => G.adj[i].some((e) => e.t <= 2));
    return street >= 0 ? street : G.nearest(x, z, (i) => G.adj[i].some((e) => e.t <= 3), 6);
  };
  const busCost = (e) => e.L * [1, 1.1, 8, 20, 200, 300, 500, 5000][e.t];
  // linky (podle zastávek; trasa = nejlevnější cesta po silnicích mezi nimi, začátek/konec na kraji mapy)
  const LINES = [
    ['Plzeň – Chotěšov – Stod – Holýšov', [[3978, -4052], 'Chotěšov, u hřbitova', 'Chotěšov, nám.', 'Chotěšov, u školy', 'Stod', [-5683, 3251]], 2],
    ['Stod – Lelov – Líšina', ['Stod, žel.st.', 'Stod, Nádražní', 'Stod', 'Stod, Lelov', 'Líšina', [254, 5875]], 1],
    ['Stod – Střelice – Hradec', ['Stod', 'Stod, u nemocnice', 'Střelice', 'Hradec', [-7324, -2136]], 1],
    ['Chotěšov – Mantov – Losina', ['Chotěšov, žel. st.', 'Chotěšov, nám.', 'Chotěšov, Mantov, U Kovárny', 'Chotěšov, Mantov, hor.kolonie', 'Chotěšov, Losina', [4690, 2000]], 1],
    ['Stod – Ves Touškov', ['Stod, Nádražní', 'Stod', 'Ves Touškov', [-3049, -4116]], 1],
    ['Chotěšov – Týnec', ['Chotěšov, nám.', 'Chotěšov, statek', 'Týnec', [2489, -4552]], 1],
  ];
  const lines = [];
  for (const [name, via, count] of LINES) {
    const nodes = via.map((w) => (typeof w === 'string' ? stopNode(w) : G.nearest(w[0], w[1], () => true, 6)));
    if (nodes.some((n) => n < 0)) { console.warn('linka', name, 'nemá všechny zastávky'); continue; }
    let path = [nodes[0]];
    const stopIdx = [];
    let ok = true;
    for (let i = 1; i < nodes.length; i++) {
      const p = shortest(G, nodes[i - 1], nodes[i], busCost);
      if (!p) { ok = false; break; }
      path = path.concat(p.slice(1));
      if (typeof via[i] === 'string') stopIdx.push([path.length - 1, via[i]]);
    }
    if (typeof via[0] === 'string') stopIdx.unshift([0, via[0]]);
    if (!ok) { console.warn('linka', name, 'nemá spojení'); continue; }
    // ořez na území
    const make = (pth, sIdx) => {
      let a = 0, b = pth.length - 1;
      while (a < b && !inside(G.X[pth[a]], G.Z[pth[a]])) a++;
      while (b > a && !inside(G.X[pth[b]], G.Z[pth[b]])) b--;
      const tr = new Track();
      for (let i = a; i <= b; i++) {
        const nx = pth[Math.min(i + 1, b)];
        const e = G.adj[pth[i]].find((q) => q.to === nx) || G.adj[pth[i]][0];
        tr.push(G.X[pth[i]], G.Z[pth[i]], laneOffset(e.t), e.t);
      }
      const st = sIdx.filter(([i]) => i >= a && i <= b).map(([i, n]) => ({ s: Math.max(0, tr.cum[i - a] - 4), name: n }));
      return { tr, stops: st, edgeA: a > 0 || !groups.has(via[0]), edgeB: b < pth.length - 1 };
    };
    const fw = make(path, stopIdx);
    const bw = make([...path].reverse(), stopIdx.map(([i, n]) => [path.length - 1 - i, n]).reverse());
    lines.push({ name, dirs: [fw, bw], count });
  }
  const buses = [];
  function startBus(b, anywhere = false) {
    const d = b.line.dirs[b.dir];
    const tr = d.tr;
    if (b.v) removeVehicle(b.v);
    b.v = addVehicle('bus', tr, { stops: d.stops, next: 0, line: b.line.name, mood: 1 });
    if (!b.v) return;
    // po načtení mapy už jsou autobusy rozmístěné po trase
    b.v.s = anywhere ? b.v.m.wb + Math.random() * (tr.len - b.v.m.wb - 30) : b.v.m.wb + 0.5;
    while (b.v.next < d.stops.length && d.stops[b.v.next].s < b.v.s) b.v.next++;
    b.v.v = anywhere ? 8 : 0;
  }
  for (const line of lines) {
    for (let k = 0; k < line.count; k++) {
      const b = { line, dir: k % 2, v: null, pause: 0 };
      buses.push(b);
      startBus(b, true);
    }
  }
  function updateBuses(dt) {
    for (const b of buses) {
      if (!b.v) {
        b.pause -= dt;
        if (b.pause <= 0) startBus(b);
        continue;
      }
      if (b.v.s >= b.v.track.len - 0.5) {       // konečná → obrátit (z kraje mapy po přestávce)
        const d = b.line.dirs[b.dir];
        removeVehicle(b.v); b.v = null;
        b.dir = 1 - b.dir;
        b.pause = d.edgeB ? 40 + Math.random() * 60 : 25;
      }
    }
  }

  // ---------------------------------------------------------- vlaky
  const trains = [];
  const railStops = stops?.rail || [];
  let railTrack = null, railStopS = [];
  {
    // trať z kraje na kraj: nejdelší nejkratší cesta mezi koncovými uzly na hraně mapy
    const ends = [];
    for (let i = 0; i < R.n; i++) if (R.adj[i].length === 1 && !inside(R.X[i], R.Z[i])) ends.push(i);
    // konce sloučit: preferovat trať přes stanice (Stod) – vyber dvojici s nejvíc stanicemi blízko
    let best = null;
    for (let a = 0; a < ends.length; a++) for (let b = a + 1; b < ends.length; b++) {
      const p = shortest(R, ends[a], ends[b], (e) => e.L * (!e.svc || e.svc === 'main' ? 1 : 6));   // po hlavní koleji
      if (!p) continue;
      let hits = 0;
      for (const st of railStops) if (p.some((i) => Math.hypot(R.X[i] - st.x, R.Z[i] - st.z) < 120)) hits++;
      let L = 0;
      for (let i = 1; i < p.length; i++) L += Math.hypot(R.X[p[i]] - R.X[p[i - 1]], R.Z[p[i]] - R.Z[p[i - 1]]);
      const score = hits * 1e5 + L;
      if (!best || score > best.score) best = { p, score };
    }
    if (best) {
      const p = best.p;
      let a = 0, b = p.length - 1;
      while (a < b && !inside(R.X[p[a]], R.Z[p[a]])) a++;
      while (b > a && !inside(R.X[p[b]], R.Z[p[b]])) b--;
      railTrack = new Track();
      for (let i = Math.max(0, a - 1); i <= Math.min(p.length - 1, b + 1); i++) railTrack.push(R.X[p[i]], R.Z[p[i]], 0, 8);
      // zastávky: průmět na trať
      for (const st of railStops) {
        let bs = 0, bd = Infinity;
        for (let i = 0; i < railTrack.n - 1; i++) {
          const [ax, az] = railTrack.P[i], [bx, bz] = railTrack.P[i + 1];
          const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
          const t = THREE.MathUtils.clamp(((st.x - ax) * dx + (st.z - az) * dz) / l2, 0, 1);
          const d = Math.hypot(ax + dx * t - st.x, az + dz * t - st.z);
          if (d < bd) { bd = d; bs = railTrack.cum[i] + Math.sqrt(l2) * t; }
        }
        // střed nástupiště (pokud je)
        if (st.pl?.length) {
          let sx = 0, sz = 0, n = 0;
          for (const pl of st.pl) for (const q of pl) { sx += q[0]; sz += q[1]; n++; }
          sx /= n; sz /= n;
          let bd2 = Infinity;
          for (let i = 0; i < railTrack.n - 1; i++) {
            const [ax, az] = railTrack.P[i], [bx, bz] = railTrack.P[i + 1];
            const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
            const t = THREE.MathUtils.clamp(((sx - ax) * dx + (sz - az) * dz) / l2, 0, 1);
            const d = Math.hypot(ax + dx * t - sx, az + dz * t - sz);
            if (d < bd2) { bd2 = d; if (d < 60) bs = railTrack.cum[i] + Math.sqrt(l2) * t; }
          }
        }
        if (bd < 150) railStopS.push({ s: bs, name: st.n });
      }
      railStopS.sort((p, q) => p.s - q.s);
    }
  }
  // jednokolejná trať: vlaky se střídají (osobní tam, rychlík zpět, osobní zpět, rychlík tam…)
  const SERVICES = [
    { name: 'Os P3', cars: ['unit', 'unit'], colors: [[0xf3f4f5, 0x1d5fa8]], vmax: 25, stops: true },
    { name: 'Ex6', cars: ['loco', 'coach', 'coach', 'coach', 'coach', 'coach'], colors: [[0x1d4f9c, 0xf0f2f4], [0xf0f2f4, 0x1d4f9c]], vmax: 33, stops: false },
  ];
  let trainCycle = Math.floor(Math.random() * 4), trainPause = 0, first = true;
  const trainTracks = railTrack ? [railTrack, reverseTrack(railTrack)] : [];
  const trainStops = railTrack ? [railStopS, railStopS.map((s) => ({ s: railTrack.len - s.s, name: s.name })).reverse()] : [];
  function reverseTrack(tr) {
    const r = new Track();
    for (let i = tr.n - 1; i >= 0; i--) r.push(tr.P[i][0], tr.P[i][1], 0, 8);
    return r;
  }
  function startTrain() {
    const svc = SERVICES[trainCycle % 2];
    const dir = Math.floor(trainCycle / 2) % 2 ^ (trainCycle % 2);
    trainCycle++;
    const tr = trainTracks[dir];
    const cars = [];
    let off = 0;
    for (let i = 0; i < svc.cars.length; i++) {
      const kind = svc.cars[i];
      const colors = (kind === 'loco' ? svc.colors[0] : svc.colors[svc.colors.length - 1]).map(C);
      const slot = pool.take(kind, colors);
      if (slot < 0) continue;
      const m = VEHICLES[kind];
      // vůz natočený dozadu u druhého článku jednotky (kabina na konci)
      cars.push({ kind, slot, m, off: off + m.nose, x: 0, z: 0, dx: 1, dz: 0, v: 0, rail: true, flip: kind === 'unit' && i > 0 });
      off += m.nose + m.tail + 0.6;
    }
    const length = off;
    const s0 = first ? length + Math.random() * (tr.len * 0.7) : length + 2;
    first = false;
    const t = { svc, tr, cars, s: s0, v: svc.vmax * 0.8, len: length, stops: svc.stops ? trainStops[dir] : [], next: 0, stopT: 0 };
    while (t.next < t.stops.length && t.stops[t.next].s + t.len / 2 < t.s) t.next++;
    trains.push(t);
  }
  const flipM = new THREE.Matrix4().makeRotationY(Math.PI);
  function updateTrains(dt) {
    if (!railTrack) return;
    if (!trains.length) { trainPause -= dt; if (trainPause <= 0) { startTrain(); trainPause = 15 + Math.random() * 25; } }
    for (const t of [...trains]) {
      let want = t.svc.vmax;
      if (t.next < t.stops.length) {
        const stopAt = t.stops[t.next].s + t.len / 2;          // střed vlaku u středu nástupiště
        const d = stopAt - t.s;
        if (d < 0.5) {
          if (t.stopT <= 0 && t.v < 0.3) t.stopT = 25;
          want = 0;
          if (t.stopT > 0) { t.stopT -= dt; if (t.stopT <= 0) { t.next++; t.stopT = 0; } }
        } else want = Math.min(want, Math.sqrt(2 * 0.7 * Math.max(0, d - 0.3)) + 0.2);
      }
      t.v = Math.max(0, t.v + THREE.MathUtils.clamp(want - t.v, -1.0 * dt, 0.6 * dt));
      t.s += t.v * dt;
      for (const c of t.cars) {
        const centre = t.s - c.off;
        pose(t.tr, centre + c.m.front, centre + c.m.rear, mat);
        if (c.flip) mat.multiply(flipM);
        c.x = mat.elements[12]; c.z = mat.elements[14];
        c.dx = P1[3]; c.dz = P1[4]; c.v = t.v;
        pool.set(c.kind, c.slot, detailAt(c.x, c.z) ? mat : pool.zero);
      }
      if (t.s - t.len > t.tr.len) {
        for (const c of t.cars) pool.release(c.kind, c.slot);
        trains.splice(trains.indexOf(t), 1);
      }
    }
  }

  // ---------------------------------------------------------- modely zastávek
  const stopGroup = new THREE.Group();
  group.add(stopGroup);
  {
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x6b7178 });
    const shelter = { bus: shelterGeo(false), rail: shelterGeo(true) };
    const sMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const gMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false });
    const placeAt = (o, x, z) => { o.userData.ground = [x, z]; o.position.set(x, world.heightAt(x, z), z); stopGroup.add(o); };
    for (const b of busStops) {
      // natočení: čelem k nejbližší silnici
      const n = G.nearest(b.x, b.z, (i) => G.adj[i].some((e) => e.t <= 3));
      let fx = 0, fz = 1;
      if (n >= 0) {
        // nejbližší bod na hranách uzlu
        let best = null;
        for (const e of G.adj[n]) {
          const ax = G.X[n], az = G.Z[n], dx = G.X[e.to] - ax, dz = G.Z[e.to] - az, l2 = dx * dx + dz * dz || 1;
          const t = THREE.MathUtils.clamp(((b.x - ax) * dx + (b.z - az) * dz) / l2, 0, 1);
          const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(px - b.x, pz - b.z);
          if (!best || d < best.d) best = { d, px, pz, e };
        }
        if (best && best.d > 0.5) { fx = (best.px - b.x) / best.d; fz = (best.pz - b.z) / best.d; }
        // nástupiště moc daleko od silnice → posunout k okraji
        if (best && best.d > WIDTH[best.e.t] / 2 + 4) {
          const k = best.d - (WIDTH[best.e.t] / 2 + 1.5);
          b.x += fx * k; b.z += fz * k;
        } else if (best && best.d < WIDTH[best.e.t] / 2 + 0.6) {
          const k = best.d - (WIDTH[best.e.t] / 2 + 1.0);
          b.x += fx * k; b.z += fz * k;
        }
      }
      const yaw = Math.atan2(fx, fz);
      const g = new THREE.Group();
      const { tex, aspect } = stopTexture(b.n, false);
      const sm = new THREE.MeshLambertMaterial({ map: tex });
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5 / aspect), sm);
      sign.position.set(0, 2.45, 0.04);
      const sign2 = sign.clone(); sign2.rotation.y = Math.PI; sign2.position.z = -0.04;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.8, 6), poleMat);
      pole.position.y = 1.4;
      // označník kolmo k silnici (čitelný z obou směrů jízdy)
      const flag = new THREE.Group();
      flag.add(sign, sign2);
      flag.rotation.y = Math.PI / 2;
      const tt = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.5, 0.06), new THREE.MeshLambertMaterial({ color: 0xe9e9e4 }));
      tt.position.set(0, 1.35, 0.06);
      g.add(pole, flag, tt);
      if (b.sh) {
        const s1 = new THREE.Mesh(shelter.bus.solid, sMat), s2 = new THREE.Mesh(shelter.bus.glass, gMat);
        for (const s of [s1, s2]) { s.position.set(2.6, 0, -1.0); g.add(s); }
        s1.castShadow = true;
      } else if (b.be) {
        const bench = new THREE.Mesh(merge([box(1.6, 0.06, 0.4, 0, 0.45, 0, 0x8a6a48), box(1.6, 0.4, 0.05, 0, 0.7, -0.18, 0x8a6a48),
          box(0.06, 0.45, 0.35, -0.7, 0.22, 0, 0x555555), box(0.06, 0.45, 0.35, 0.7, 0.22, 0, 0x555555)]), sMat);
        bench.position.set(1.8, 0, -0.6);
        g.add(bench);
      }
      g.rotation.y = yaw;
      placeAt(g, b.x, b.z);
    }
    // vlaková nástupiště
    const platMat = new THREE.MeshLambertMaterial({ color: 0xb9b5ab });
    const edgeMat = new THREE.MeshLambertMaterial({ color: 0xf2f2ee });
    for (const st of railStops) {
      for (const pl of st.pl || []) {
        const closed = pl.length > 3 && Math.hypot(pl[0][0] - pl[pl.length - 1][0], pl[0][1] - pl[pl.length - 1][1]) < 0.5;
        let y0 = Infinity;
        for (const [x, z] of pl) y0 = Math.min(y0, world.heightAt(x, z));
        const top = 0.55 + RAIL_TOP;
        let geo;
        if (closed) {
          const shape = new THREE.Shape(pl.map(([x, z]) => new THREE.Vector2(x, -z)));
          geo = new THREE.ExtrudeGeometry(shape, { depth: top + 1, bevelEnabled: false }).rotateX(-Math.PI / 2);
        } else {
          const parts = [];
          for (let i = 0; i < pl.length - 1; i++) {
            const [ax, az] = pl[i], [bx, bz] = pl[i + 1], L = Math.hypot(bx - ax, bz - az);
            const g = new THREE.BoxGeometry(L + 1.5, top + 1, 3.0).rotateY(-Math.atan2(bz - az, bx - ax))
              .translate((ax + bx) / 2, (top + 1) / 2, (az + bz) / 2);
            g.deleteAttribute('uv');
            parts.push(g.index ? g.toNonIndexed() : g);
          }
          geo = merge(parts);
        }
        const m = new THREE.Mesh(geo, platMat);
        m.receiveShadow = true;
        m.position.y = y0 - 1;
        m.userData.ground = null;
        stopGroup.add(m);
        // bílá hrana a cedule s názvem, přístřešek uprostřed
        const mid = pl[Math.floor(pl.length / 2)], prev = pl[Math.max(0, Math.floor(pl.length / 2) - 1)];
        const yaw = -Math.atan2(mid[1] - prev[1], mid[0] - prev[0]);
        const name = st.n;
        const { tex, aspect } = stopTexture(name, true);
        const bm = new THREE.MeshLambertMaterial({ map: tex });
        for (const k of [0.2, 0.8]) {
          const q = pl[Math.min(pl.length - 1, Math.floor(pl.length * k))];
          const sg = new THREE.Group();
          const board = new THREE.Mesh(new THREE.PlaneGeometry(0.55 * aspect, 0.55), bm);
          board.position.y = 2.7;
          const back = board.clone(); back.rotation.y = Math.PI;
          for (const sx of [-0.27 * aspect, 0.27 * aspect]) {
            const p = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 3.0, 6), poleMat);
            p.position.set(sx, 1.5, -0.03); sg.add(p);
          }
          sg.add(board, back);
          sg.position.set(q[0], y0 + top, q[1]);
          sg.rotation.y = yaw;
          stopGroup.add(sg);
        }
        const s1 = new THREE.Mesh(shelter.rail.solid, sMat), s2 = new THREE.Mesh(shelter.rail.glass, gMat);
        for (const s of [s1, s2]) { s.position.set(mid[0], y0 + top, mid[1]); s.rotation.y = yaw; stopGroup.add(s); }
        void edgeMat;
      }
    }
  }
  const refreshStops = () => {
    for (const o of stopGroup.children) if (o.userData.ground) o.position.y = world.heightAt(...o.userData.ground);
  };

  // ---------------------------------------------------------- zaparkovaná auta (parkoviště z OSM)
  // kolmé stání v řadách (5 m stání, 6 m ulička), na úzkých plochách podélně; obsazenost podle místa
  const BUSY_SPOTS = [[-955, -830, 160, 0.92], [-140, -1012, 120, 0.85], [-222, -1069, 80, 0.85], [-315, -1307, 80, 0.8], [-880, -1205, 120, 0.8]];
  const PARK_KINDS = ['car', 'car', 'hatch', 'hatch', 'suv', 'combi', 'van'];
  const parked = [];
  // vozovky (silnice, ulice, asfaltové cesty) v buňkách 20 m – na nich se neparkuje
  const rgrid = new Map();
  for (const rd of roads) {
    if (rd.t > 3) continue;
    for (let i = 0; i < rd.p.length - 1; i++) {
      const a = rd.p[i], b = rd.p[i + 1];
      for (let cx = Math.floor((Math.min(a[0], b[0]) - 6) / 20); cx <= Math.floor((Math.max(a[0], b[0]) + 6) / 20); cx++) {
        for (let cz = Math.floor((Math.min(a[1], b[1]) - 6) / 20); cz <= Math.floor((Math.max(a[1], b[1]) + 6) / 20); cz++) {
          const k = `${cx},${cz}`;
          if (!rgrid.has(k)) rgrid.set(k, []);
          rgrid.get(k).push([a, b, WIDTH[rd.t] / 2 + 0.4]);
        }
      }
    }
  }
  const onRoad = (x, z) => (rgrid.get(`${Math.floor(x / 20)},${Math.floor(z / 20)}`) || []).some(([a, b, hw]) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
    return Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z) < hw;
  });
  {
    const pin = (x, z, r) => {
      let ins = false;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        if ((r[i][1] > z) !== (r[j][1] > z) && x < (r[j][0] - r[i][0]) * (z - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) ins = !ins;
      }
      return ins;
    };
    for (const lot of parking || []) {
      const r = lot.p;
      if (!inside(r[0][0], r[0][1])) continue;
      let ux = 1, uz = 0, best = 0;
      for (let i = 0; i < r.length - 1; i++) {
        const dx = r[i + 1][0] - r[i][0], dz = r[i + 1][1] - r[i][1], L = Math.hypot(dx, dz);
        if (L > best) { best = L; ux = dx / L; uz = dz / L; }
      }
      const vx = -uz, vz = ux;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const [x, z] of r) {
        const u = x * ux + z * uz, v = x * vx + z * vz;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      let busy = lot.busy ?? 0.6;
      const [cx, cz] = r.reduce((a, q) => [a[0] + q[0] / r.length, a[1] + q[1] / r.length], [0, 0]);
      for (const [bx, bz, br, bb] of BUSY_SPOTS) if (Math.hypot(cx - bx, cz - bz) < br) busy = Math.max(busy, bb);
      const at = (u, v) => [u * ux + v * vx, u * uz + v * vz];
      // celé stání uvnitř parkoviště a mimo vozovku (ne ve vjezdu ani na silnici)
      const fits = (u, v, hu, hv) => [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]].every(([a, b]) => {
        const q = at(u + a * hu, v + b * hv);
        return pin(q[0], q[1], r) && !onRoad(q[0], q[1]);
      });
      const narrow = v1 - v0 < 9;
      if (narrow) {                               // podélné stání
        const v = (v0 + v1) / 2;
        for (let u = u0 + 3.5; u < u1 - 3; u += 6.2) {
          if (fits(u, v, 2.4, 1.0) && Math.random() < busy) parked.push({ p: at(u, v), d: Math.random() < 0.5 ? [ux, uz] : [-ux, -uz] });
        }
      } else {
        for (let v = v0 + 2.8, row = 0; v < v1 - 2.3; row++) {
          for (let u = u0 + 1.6; u < u1 - 1.4; u += 2.6) {
            if (fits(u, v, 0.95, 2.3) && Math.random() < busy) parked.push({ p: at(u + (Math.random() - 0.5) * 0.25, v + (Math.random() - 0.5) * 0.3), d: (row % 2 ? -1 : 1) * (Math.random() < 0.85 ? 1 : -1) > 0 ? [vx, vz] : [-vx, -vz] });
          }
          v += row % 2 ? 5.2 : 5.2 + 6.0;          // dvě řady čelem k sobě, mezi dvojicemi ulička
        }
      }
    }
  }
  const parkCaps = {};
  for (const c of parked) { c.kind = rnd(PARK_KINDS); parkCaps[c.kind] = (parkCaps[c.kind] || 0) + 1; }
  const ppool = createPools(group, parkCaps, { lamps: false });    // zaparkovaná auta nesvítí
  for (const c of parked) c.slot = ppool.take(c.kind, c.kind === 'van' ? [rnd(VAN_COLORS)] : [rnd(CAR_COLORS)]);
  const refreshParked = () => {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up3 = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
    for (const c of parked) {
      if (c.slot < 0) continue;
      if (c.wreck) { ppool.set(c.kind, c.slot, c.wreck.m); continue; }
      q.setFromAxisAngle(up3, Math.atan2(-c.d[1], c.d[0]));
      m.compose(pos.set(c.p[0], world.heightAt(c.p[0], c.p[1]) + 0.04, c.p[1]), q, one);
      ppool.set(c.kind, c.slot, m);
    }
    ppool.flush();
  };
  refreshParked();

  // ---------------------------------------------------------- řízení
  let enabled = true;
  let roamT = 0;
  function update(dt, focus, camera) {
    if (!enabled) return false;
    dt = Math.min(dt, 0.1);
    const camH = camera.position.y - world.heightAt(camera.position.x, camera.position.z);
    const near = camH < 2200;
    // auta v okolí
    for (const v of [...vehicles]) {
      if (v.roam && (Math.hypot(v.x - focus.x, v.z - focus.z) > RADIUS * 1.3 || !near)) removeVehicle(v);
    }
    roamT -= dt;
    if (near && roamT <= 0) {
      roamT = 0.25;
      const fresh = vehicles.length < 4;
      const f = rush();
      for (const [kind] of MIX) {
        const have = vehicles.filter((v) => v.kind === kind && v.roam && !v.main).length;
        if (have < target[kind] * (0.4 + 0.6 * f)) {
          for (let k = 0; k < (fresh ? 8 : 2); k++) spawnNear(kind, focus.x, focus.z, camera.position, fresh ? 0 : 220);
        }
      }
      const mains = vehicles.filter((v) => v.main).length;
      if (mains < MAIN_N * f) {
        let r = Math.random(), kind = 'car';
        for (const [k, w] of MAIN_MIX) { r -= w; if (r <= 0) { kind = k; break; } }
        for (let k = 0; k < (fresh ? 10 : 2); k++) spawnNear(kind, focus.x, focus.z, camera.position, fresh ? 0 : 220, true);
      }
    }
    updateBuses(dt);
    index();
    for (const v of vehicles) step(v, dt);
    for (const v of [...vehicles]) {
      if (v.roam) {
        if (!extend(v)) { removeVehicle(v); continue; }
        if (v.s > 400) { const d = v.track.trim(v.s - 60); v.s -= d; }
      }
      place(v);
    }
    updateTrains(dt);
    animWrecks(dt);
    ppool.flush();
    // světla: ve dne tlumená, v noci svítí
    const night = NIGHT.night.value;
    pool.mats.lamp.color.setScalar(0.75 + 0.25 * night);          // světla svítí i ve dne, v noci naplno
    pool.mats.beam.uniforms.k.value = Math.min(1, night * 1.4) * 0.38;
    pool.flush();
    return true;
  }
  function setEnabled(v) {
    enabled = v;
    pool.setVisible(v);
    ppool.setVisible(v);
    if (!v) {
      for (const veh of [...vehicles]) removeVehicle(veh);
      for (const b of buses) { b.v = null; b.pause = Math.random() * 20; }
      for (const t of trains) for (const c of t.cars) pool.release(c.kind, c.slot);
      trains.length = 0;
      pool.flush();
    }
  }
  return {
    group, update, setEnabled, refreshStops, refreshParked, hitAt, wreck, clearWrecks, get enabled() { return enabled; },
    debug: { vehicles, trains, lines, buses, railStopS, G, parked },
  };
}
