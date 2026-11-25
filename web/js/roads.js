import * as THREE from 'three';

// Typy – musí souhlasit s tools/build_data.py (ROAD)
//  0 silnice I. tř., 1 silnice II./III. tř., 2 ulice, 3 asfaltová cesta, 4 panely,
//  5 štěrková cesta, 6 polní cesta, 7 pěšina, 8 železnice
const WIDTH = [8.5, 6.5, 5.0, 3.5, 3.2, 3.0, 2.6, 1.2, 4.2];
// výrazně nad terénem (jinak terén mezi uzly prosvítá); železnice / zpevněné nad nezpevněnými
const LIFT = [0.34, 0.34, 0.34, 0.34, 0.31, 0.3, 0.29, 0.28, 0.36];

// stylizované ploché barvy podle typu
const COLOR = [0x7a7c82, 0x7a7c82, 0x7a7c82, 0x7a7c82, 0xb8b4aa, 0xcdc2a8, 0xb89c74, 0xc4ad88, 0x7a6e64]
  .map((c) => new THREE.Color(c));

// koleje: dvě ocelové kolejnice (rozchod 1435 mm) na betonových pražcích po 0,6 m
const RAIL_COL = new THREE.Color(0x5b5650), SLEEPER_COL = new THREE.Color(0x9a958c);
const GAUGE = 1.435 + 0.07, RAIL_W = 0.07, RAIL_H = 0.16, SLEEPER = [2.6, 0.26, 0.6], SLEEPER_H = 0.06;

function rails(pts, C, pos, attr) {
  const n = pts.length;
  const box = (cx, cy, cz, ux, uz, hl, hw, h, top, typ) => {
    // kvádr bez spodku: ux,uz = směr podél, hl = půl délky, hw = půl šířky
    const vx = -uz, vz = ux;
    const P = (a, b, y) => [cx + ux * a + vx * b, y, cz + uz * a + vz * b];
    const y0 = cy, y1 = cy + h;
    const c = [P(-hl, -hw, y1), P(hl, -hw, y1), P(hl, hw, y1), P(-hl, hw, y1)];
    const f = [P(-hl, -hw, y0), P(hl, -hw, y0), P(hl, hw, y0), P(-hl, hw, y0)];
    const q = (a, b, cc, d) => { pos.push(...a, ...b, ...cc, ...a, ...cc, ...d); for (let k = 0; k < 6; k++) attr.push(0, 0, typ, 0); };
    q(c[0], c[3], c[2], c[1]);                       // vršek
    if (!top) { q(c[0], c[1], f[1], f[0]); q(c[2], c[3], f[3], f[2]); q(c[1], c[2], f[2], f[1]); q(c[3], c[0], f[0], f[3]); }
  };
  let acc = 0;
  for (let i = 0; i < n - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.01) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L, vx = -uz, vz = ux;
    const ya = C[i][1], yb = C[i + 1][1];
    // pražce
    for (; acc < L; acc += SLEEPER[2]) {
      const f = acc / L;
      box(ax + (bx - ax) * f, ya + (yb - ya) * f, az + (bz - az) * f, ux, uz, SLEEPER[1] / 2, SLEEPER[0] / 2, SLEEPER_H, true, -2);
    }
    acc -= L;
    // kolejnice – šikmý kvádr mezi body (výška na koncích podle terénu)
    for (const side of [-1, 1]) {
      const o = side * GAUGE / 2, hw = RAIL_W / 2, y = SLEEPER_H;
      const P = (x, z, yy, s) => [x + vx * (o + s * hw), yy, z + vz * (o + s * hw)];
      const a0 = P(ax, az, ya + y, -1), a1 = P(ax, az, ya + y, 1), b0 = P(bx, bz, yb + y, -1), b1 = P(bx, bz, yb + y, 1);
      const a0t = [a0[0], a0[1] + RAIL_H, a0[2]], a1t = [a1[0], a1[1] + RAIL_H, a1[2]];
      const b0t = [b0[0], b0[1] + RAIL_H, b0[2]], b1t = [b1[0], b1[1] + RAIL_H, b1[2]];
      const q = (a, b, cc, d) => { pos.push(...a, ...b, ...cc, ...a, ...cc, ...d); for (let k = 0; k < 6; k++) attr.push(0, 0, -1, 0); };
      q(a0t, a1t, b1t, b0t);
      q(a0, a0t, b0t, b0);
      q(a1, b1, b1t, a1t);
    }
  }
}

let material;
function roadMaterial() {
  if (!material) {
    material = new THREE.MeshLambertMaterial({
      vertexColors: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16,
    });
  }
  return material;
}

/** Rozdělí všechny úseky do dlaždic podle středu segmentu; vrátí builder pro World.
 *  bridges = prepareBridges(…) z bridges.js */
export function createRoads({ roads, bridges, world }) {
  const T = world.T, W = world.W, H = world.H;
  const perTile = new Map();
  for (const r of roads) {
    // převzorkovat na max. 3 m
    const pts = [];
    for (let i = 0; i < r.p.length; i++) {
      const [x, z] = r.p[i];
      if (i > 0) {
        const [px, pz] = r.p[i - 1];
        const L = Math.hypot(x - px, z - pz), k = Math.ceil(L / 3);
        for (let q = 1; q < k; q++) pts.push([px + (x - px) * q / k, pz + (z - pz) * q / k]);
      }
      pts.push([x, z]);
    }
    if (pts.length < 2) continue;
    // dlouhé linie (trať, silnice přes několik km) rozdělit po dlaždicích podle středu segmentu,
    // jinak by se vykreslily jen s dlaždicí, ve které leží jejich střed
    const tileOf = (a, b) => `${Math.floor(((a[0] + b[0]) / 2 + W / 2) / T)}_${Math.floor(((a[1] + b[1]) / 2 + H / 2) / T)}`;
    let key = tileOf(pts[0], pts[1]), piece = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const k = tileOf(pts[i - 1], pts[i]);
      if (k !== key) {
        if (piece.length >= 2) {
          if (!perTile.has(key)) perTile.set(key, []);
          perTile.get(key).push({ t: r.t, pts: piece });
        }
        key = k; piece = [pts[i - 1]];
      }
      piece.push(pts[i]);
    }
    if (!perTile.has(key)) perTile.set(key, []);
    perTile.get(key).push({ t: r.t, pts: piece });
  }

  return function build(tile, group) {
    const list = perTile.get(`${tile.i}_${tile.j}`);
    if (!list) return;
    const pos = [], attr = [];
    for (const { t, pts } of list) {
      const w = WIDTH[t], hw = w / 2, lift = LIFT[t];
      const n = pts.length;
      // normály s pokosem (miter) v lomech
      const L = [], R = [], C = [], S = [];
      let s = 0;
      for (let i = 0; i < n; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
        let dx = b[0] - a[0], dz = b[1] - a[1];
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
        let nx = -dz, nz = dx, k = 1;
        if (i > 0 && i < n - 1) {
          const sx = pts[i + 1][0] - pts[i][0], sz = pts[i + 1][1] - pts[i][1];
          const sl = Math.hypot(sx, sz) || 1;
          k = 1 / Math.max(0.5, Math.abs(nx * (-sz / sl) + nz * (sx / sl)));
        }
        nx *= hw * k; nz *= hw * k;
        if (i > 0) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        const [x, z] = pts[i];
        const br = bridges.at(x, z, w, dx, dz);
        const y = (px, pz) => (br ?? world.heightAt(px, pz)) + lift;
        L.push([x + nx, y(x + nx, z + nz), z + nz]);
        C.push([x, y(x, z), z]);
        R.push([x - nx, y(x - nx, z - nz), z - nz]);
        S.push(s);
      }
      for (let i = 0; i < n - 1; i++) {
        const quad = (a, b, c, d, ua, ub) => {
          // a,b = začátek (strana ua→ub), c,d = konec
          pos.push(...a, ...c, ...b, ...b, ...c, ...d);
          const at = (uu, ss) => attr.push(uu, ss, t, w);
          at(ua, S[i]); at(ua, S[i + 1]); at(ub, S[i]); at(ub, S[i]); at(ua, S[i + 1]); at(ub, S[i + 1]);
        };
        quad(L[i], C[i], L[i + 1], C[i + 1], 1, 0);
        quad(C[i], R[i], C[i + 1], R[i + 1], 0, -1);
      }
      if (t === 8) rails(pts, C, pos, attr);
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const col = new Float32Array(pos.length);
    for (let i = 0; i < attr.length / 4; i++) {
      const c = COLOR[attr[i * 4 + 2]];
      if (!c) continue;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    for (let i = 0; i < attr.length / 4; i++) {
      if (attr[i * 4 + 2] < 0) {                     // kolejnice / pražce (záporný typ = vlastní barva)
        const c = attr[i * 4 + 2] === -1 ? RAIL_COL : SLEEPER_COL;
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, roadMaterial());
    m.receiveShadow = true;
    group.add(m);
  };
}
