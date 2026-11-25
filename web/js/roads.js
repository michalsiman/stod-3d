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
    const mid = pts[Math.floor(pts.length / 2)];
    const ti = Math.floor((mid[0] + W / 2) / T), tj = Math.floor((mid[1] + H / 2) / T);
    const key = `${ti}_${tj}`;
    if (!perTile.has(key)) perTile.set(key, []);
    perTile.get(key).push({ t: r.t, pts });
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
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const col = new Float32Array(pos.length);
    for (let i = 0; i < attr.length / 4; i++) {
      const c = COLOR[attr[i * 4 + 2]];
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, roadMaterial());
    m.receiveShadow = true;
    group.add(m);
  };
}
