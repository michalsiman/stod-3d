import * as THREE from 'three';

// Chodníky podél silnic a ulic v obcích: z obou stran pás 1,85 m z betonové dlažby s obrubníkem 12 cm.
// Jen v zástavbě (domy v okolí), přerušené na křižovatkách, na mostech (ty mají vlastní chodník),
// u budov a tam, kde by zasáhly do jiné silnice.

const WIDTH = [8.5, 6.5, 5.0, 3.5, 3.2, 3.0, 2.6, 1.2, 4.2];
const LIFT = 0.34, CURB = 0.12, IN = 0.15, OUT = 2.0;
export const SIDEWALK_TOP = LIFT + CURB;
const TYPES = new Set([0, 1, 2, 3]);
const STEP = 2.5;

export function createSidewalks({ roads, buildings, bridges, world, blocked = null }) {
  const T = world.T, W = world.W, H = world.H;
  // zástavba: buňky 50 m s počtem domů
  const homes = new Map();
  for (const b of buildings) {
    if (b.k !== 'house' && b.k !== 'flats' && b.k !== 'civic') continue;
    const p = b.rings[0][0], k = `${Math.floor(p[0] / 50)},${Math.floor(p[1] / 50)}`;
    homes.set(k, (homes.get(k) || 0) + 1);
  }
  // most pod bodem osy silnice: jen mezi konci mostu (ne s rezervou jako bridges.at)
  const onBridge = (x, z) => {
    for (const b of bridges.list) {
      const s = (x - b.ax) * b.ux + (z - b.az) * b.uz, lat = Math.abs(-(x - b.ax) * b.uz + (z - b.az) * b.ux);
      if (s > 0.5 && s < b.L - 0.5 && lat < b.w / 2 + 1) return b;
    }
    return null;
  };
  const townCount = (x, z) => {
    let n = 0;
    const cx = Math.floor(x / 50), cz = Math.floor(z / 50);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) n += homes.get(`${cx + a},${cz + b}`) || 0;
    return n;
  };
  const inTown = (x, z) => {
    let n = 0;
    const cx = Math.floor(x / 50), cz = Math.floor(z / 50);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) n += homes.get(`${cx + a},${cz + b}`) || 0;
    return n >= 2;
  };
  // budovy v buňkách 30 m
  const bgrid = new Map();
  for (const b of buildings) {
    const r = b.rings[0];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    for (let cx = Math.floor(x0 / 30); cx <= Math.floor(x1 / 30); cx++) {
      for (let cz = Math.floor(z0 / 30); cz <= Math.floor(z1 / 30); cz++) {
        const k = `${cx},${cz}`;
        if (!bgrid.has(k)) bgrid.set(k, []);
        bgrid.get(k).push(r);
      }
    }
  }
  const pin = (x, z, r) => {
    let ins = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i][1] > z) !== (r[j][1] > z) && x < (r[j][0] - r[i][0]) * (z - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) ins = !ins;
    }
    return ins;
  };
  const inBuilding = (x, z) => (bgrid.get(`${Math.floor(x / 30)},${Math.floor(z / 30)}`) || []).some((r) => pin(x, z, r));
  // úseky silnic v buňkách 20 m (kontrola, že chodník nezasahuje do jiné silnice)
  const sgrid = new Map();
  roads.forEach((r, id) => {
    if (r.t > 3) return;                      // jen vozovky (pěšiny a polní cesty chodníku nevadí)
    for (let i = 0; i < r.p.length - 1; i++) {
      const a = r.p[i], b = r.p[i + 1];
      const x0 = Math.min(a[0], b[0]) - 6, x1 = Math.max(a[0], b[0]) + 6, z0 = Math.min(a[1], b[1]) - 6, z1 = Math.max(a[1], b[1]) + 6;
      for (let cx = Math.floor(x0 / 20); cx <= Math.floor(x1 / 20); cx++) {
        for (let cz = Math.floor(z0 / 20); cz <= Math.floor(z1 / 20); cz++) {
          const k = `${cx},${cz}`;
          if (!sgrid.has(k)) sgrid.set(k, []);
          sgrid.get(k).push([a, b, WIDTH[r.t] / 2, id, i]);
        }
      }
    }
  });
  const nearOther = (x, z, id, margin, seg = -99) => {
    for (const [a, b, hw, rid, si] of sgrid.get(`${Math.floor(x / 20)},${Math.floor(z / 20)}`) || []) {
      if (rid === id && Math.abs(si - seg) <= 1) continue;        // vlastní úsek (ne vzdálená část téže silnice)
      const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
      if (Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z) < hw + margin) return true;
    }
    return false;
  };
  // konce linií, kde se potkává víc silnic (křižovatky) → chodník zkrátit
  const ends = new Map();
  for (const r of roads) {
    if (r.t > 6) continue;
    for (const p of [r.p[0], r.p[r.p.length - 1]]) {
      const k = `${Math.round(p[0])},${Math.round(p[1])}`;
      ends.set(k, (ends.get(k) || 0) + 1);
    }
  }
  const isJunction = (p) => (ends.get(`${Math.round(p[0])},${Math.round(p[1])}`) || 0) >= 2;

  // čtyřúhelníky chodníků po dlaždicích: [vnitřní1, vnější1, vnitřní2, vnější2] (x, z)
  const perTile = new Map();
  const cells = new Set();          // buňky 3 m s chodníkem (pro chodce)
  roads.forEach((r, id) => {
    if (!TYPES.has(r.t) || r.p.length < 2) return;
    const pts = [], segOf = [];
    for (let i = 0; i < r.p.length; i++) {
      const [x, z] = r.p[i];
      if (i > 0) {
        const [px, pz] = r.p[i - 1];
        const L = Math.hypot(x - px, z - pz), k = Math.ceil(L / STEP);
        for (let q = 1; q < k; q++) { pts.push([px + (x - px) * q / k, pz + (z - pz) * q / k]); segOf.push(i - 1); }
      }
      pts.push([x, z]); segOf.push(Math.max(0, i - 1));
    }
    const n = pts.length;
    const cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[n - 1];
    const trimA = isJunction(r.p[0]) ? 1.5 : 0, trimB = isJunction(r.p[r.p.length - 1]) ? 1.5 : 0;
    const strong = r.t === 3 ? 5 : 2;            // asfaltové cesty jen v hustší zástavbě
    const hw = WIDTH[r.t] / 2;
    const N = pts.map((_, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      return [-dz / l, dx / l];
    });
    for (const side of [1, -1]) {
      const ok = pts.map(([x, z], i) => {
        if (cum[i] < trimA || cum[i] > total - trimB) return false;
        const mx = x + N[i][0] * side * (hw + 1.1), mz = z + N[i][1] * side * (hw + 1.1);
        if (townCount(mx, mz) < strong) return false;
        // na mostě jen tam, kde má most vlastní chodník (jinak by visel vedle zábradlí)
        if (onBridge(x, z)) return false;       // most má vlastní chodník / zábradlí; chodník končí u mostu
        if (inBuilding(mx, mz)) return false;
        if (blocked && blocked(mx, mz)) return false;      // místo chodníku stání (taxíky u Sokolské)
        return !nearOther(mx, mz, id, 0.4, segOf[i]);
      });
      for (let i = 0; i < n - 1; i++) {
        if (!ok[i] || !ok[i + 1]) continue;
        const P = (k, o) => [pts[k][0] + N[k][0] * side * (hw + o), pts[k][1] + N[k][1] * side * (hw + o)];
        const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1];
        const q = [P(i, IN), P(i, OUT), P(i + 1, IN), P(i + 1, OUT), side, pts[i], pts[i + 1], WIDTH[r.t], dx, dz];
        const mx = (pts[i][0] + pts[i + 1][0]) / 2, mz = (pts[i][1] + pts[i + 1][1]) / 2;
        const key = `${Math.floor((mx + W / 2) / T)}_${Math.floor((mz + H / 2) / T)}`;
        if (!perTile.has(key)) perTile.set(key, []);
        perTile.get(key).push(q);
        for (const f of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
          const c = [P(i, 1.1)[0] * (1 - f) + P(i + 1, 1.1)[0] * f, P(i, 1.1)[1] * (1 - f) + P(i + 1, 1.1)[1] * f];
          cells.add(`${Math.floor(c[0])},${Math.floor(c[1])}`);
        }
      }
    }
  });

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16 });
  const PAVE = new THREE.Color(0xc2beb5), CURBC = new THREE.Color(0xdedbd4), SIDE = new THREE.Color(0x9a978f);
  const build = (tile, group) => {
    const list = perTile.get(`${tile.i}_${tile.j}`);
    if (!list) return;
    const pos = [], col = [];
    const y = (x, z) => world.heightAt(x, z);
    const tri = (a, b, c, k) => { pos.push(...a, ...b, ...c); for (let i = 0; i < 3; i++) col.push(k.r, k.g, k.b); };
    for (const [i1, o1, i2, o2, side, c1, c2, w, dx, dz] of list) {
      // výška jako vozovka vedle (na mostě mostovka), jinak terén
      const b1 = bridges.at(c1[0], c1[1], w, dx, dz), b2 = bridges.at(c2[0], c2[1], w, dx, dz);
      const yy = (p, k) => { const b = k ? b2 : b1; return b !== null ? b : y(p[0], p[1]); };
      const top = (p, k) => [p[0], yy(p, k) + LIFT + CURB, p[1]];
      const low = (p, k) => [p[0], yy(p, k) + LIFT - 0.02, p[1]];
      const A = top(i1, 0), B = top(o1, 0), Cc = top(i2, 1), D = top(o2, 1);
      const k = PAVE.clone().multiplyScalar(0.94 + Math.random() * 0.1);
      // plocha (orientace nahoru podle strany)
      if (side > 0) { tri(A, Cc, B, k); tri(B, Cc, D, k); } else { tri(A, B, Cc, k); tri(B, D, Cc, k); }
      // obrubník (svislá hrana k vozovce) a světlý pruh nahoře
      const a0 = low(i1, 0), c0 = low(i2, 1);
      tri(a0, A, c0, SIDE); tri(A, Cc, c0, SIDE);
      const e1 = [A[0] + (B[0] - A[0]) * 0.1, A[1] + 0.003, A[2] + (B[2] - A[2]) * 0.1];
      const e2 = [Cc[0] + (D[0] - Cc[0]) * 0.1, Cc[1] + 0.003, Cc[2] + (D[2] - Cc[2]) * 0.1];
      if (side > 0) { tri(A, Cc, e1, CURBC); tri(e1, Cc, e2, CURBC); } else { tri(A, e1, Cc, CURBC); tri(e1, e2, Cc, CURBC); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16 }));
    m.receiveShadow = true;
    group.add(m);
  };
  void mat;
  /** Je v bodě chodník? (buňky 3 m podél osy chodníku) */
  const at = (x, z) => {                       // přesnost ~1,5 m
    const cx = Math.floor(x), cz = Math.floor(z);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (cells.has(`${cx + a},${cz + b}`)) return true;
    return false;
  };
  void inTown;
  /** Leží bod na vozovce (kterékoli silnici, ulici nebo asfaltové cestě)? */
  const onRoad = (x, z) => nearOther(x, z, -1, -0.1);
  return { build, at, onRoad };
}
