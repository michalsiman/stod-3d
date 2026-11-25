import * as THREE from 'three';
import { BRIDGE_STYLES } from './landmarks.js';

// Mosty: osy ze ZABAGED (bridges.json) – šířka a druh podle komunikace, která po mostě vede.
// Výška mostovky lineárně mezi břehy (s přesahem 4 m), stejně pro silnice (roads.js) i jízdu (drive.js).
// Typy komunikací – musí souhlasit s roads.js / build_data.py (ROAD)
const WIDTH = [8.5, 6.5, 5.0, 3.5, 3.2, 3.0, 2.6, 1.2, 4.2];
const EXT = 4;

const COL = {
  deck: new THREE.Color(0xa29f97),     // beton mostovky a pilířů
  cornice: new THREE.Color(0xc4c1b8),  // římsa
  rail: new THREE.Color(0x4e5d55),     // ocelové zábradlí
  wood: new THREE.Color(0x7a5a3c),     // dřevěné zábradlí lávek
  girder: new THREE.Color(0x4a524e),   // ocelové nosníky železničního mostu
};

function distToSeg(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1;
  const t = THREE.MathUtils.clamp(((px - a[0]) * dx + (pz - a[1]) * dz) / l2, 0, 1);
  return [Math.hypot(px - a[0] - t * dx, pz - a[1] - t * dz), t];
}

/** Rozbor mostů: co po nich vede, šířka, směr; funkce at() pro výšku mostovky. */
export function prepareBridges(bridges, roads, world) {
  const list = bridges.filter((p) => p.length >= 2).map((pts) => {
    const [ax, az] = pts[0], [bx, bz] = pts[pts.length - 1];
    const L = Math.hypot(bx - ax, bz - az) || 1;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const style = BRIDGE_STYLES.find((st) => Math.hypot(st.at[0] - mx, st.at[1] - mz) < 30) || null;
    return { pts, ax, az, bx, bz, L, ux, uz, box: [x0 - 12, x1 + 12, z0 - 12, z1 + 12], t: -1, w: 4, style };
  });
  // komunikace po mostě: body blízko osy a souběžné s ní; vyhrává ta s nejdelším souběhem
  for (const b of list) {
    const len = new Map();
    for (const r of roads) {
      for (let i = 0; i < r.p.length - 1; i++) {
        const p = r.p[i], q = r.p[i + 1];
        const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
        if (mx < b.box[0] || mx > b.box[1] || mz < b.box[2] || mz > b.box[3]) continue;
        const sl = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
        if (Math.abs(((q[0] - p[0]) * b.ux + (q[1] - p[1]) * b.uz) / sl) < 0.8) continue;
        let d = Infinity;
        for (let k = 0; k < b.pts.length - 1; k++) d = Math.min(d, distToSeg(mx, mz, b.pts[k], b.pts[k + 1])[0]);
        if (d < 3.5) len.set(r.t, (len.get(r.t) ?? 0) + sl);
      }
    }
    let best = -1, bl = 0;
    for (const [t, l] of len) if (l > bl) { best = t; bl = l; }
    b.t = best;
    b.w = best >= 0 ? WIDTH[best] : 4;
  }

  /** Výška mostovky (bez zdvihu komunikace) na staničení s ∈ ⟨−EXT, L+EXT⟩. */
  function deckAtS(b, s) {
    const ha = world.heightAt(b.ax - b.ux * EXT, b.az - b.uz * EXT);
    const hb = world.heightAt(b.bx + b.ux * EXT, b.bz + b.uz * EXT);
    return THREE.MathUtils.lerp(ha, hb, THREE.MathUtils.clamp((s + EXT) / (b.L + 2 * EXT), 0, 1)) + 0.3;
  }
  /**
   * Výška mostovky pod bodem, nebo null. dx, dz = směr komunikace v bodě (bez něj se nekontroluje):
   * cesta pod mostem (napříč) se nezvedá.
   */
  function at(x, z, w = 4, dx, dz) {
    for (const b of list) {
      if (x < b.box[0] || x > b.box[1] || z < b.box[2] || z > b.box[3]) continue;
      for (let i = 0; i < b.pts.length - 1; i++) {
        const [d] = distToSeg(x, z, b.pts[i], b.pts[i + 1]);
        if (d < Math.max(4, w, b.w / 2 + 1)) {
          if (dx !== undefined) {
            const l = Math.hypot(dx, dz) || 1;
            if (Math.abs((dx * b.ux + dz * b.uz) / l) < 0.6) break;
          }
          return deckAtS(b, (x - b.ax) * b.ux + (z - b.az) * b.uz);
        }
      }
    }
    return null;
  }
  return { list, at, deckAtS };
}

/** Builder pro World: konstrukce mostů v dlaždici (mostovka, římsy, zábradlí, pilíře, nosníky). */
export function createBridges({ info, world }) {
  const T = world.T, W = world.W, H = world.H;
  const perTile = new Map();
  for (const b of info.list) {
    const key = `${Math.floor(((b.ax + b.bx) / 2 + W / 2) / T)}_${Math.floor(((b.az + b.bz) / 2 + H / 2) / T)}`;
    if (!perTile.has(key)) perTile.set(key, []);
    perTile.get(key).push(b);
  }
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });

  return function build(tile, group) {
    const list = perTile.get(`${tile.i}_${tile.j}`);
    if (!list) return;
    const pos = [], col = [];
    const tri = (a, b, c, k) => { pos.push(...a, ...b, ...c); for (let i = 0; i < 3; i++) col.push(k.r, k.g, k.b); };
    const quad = (a, b, c, d, k) => { tri(a, b, c, k); tri(a, c, d, k); };
    // hranol mezi dvěma průřezy: p = [x, z], n = kolmice, v0..v1 příčně, y0/y1 spodek a vršek na obou koncích
    const prism = (p, q, n, v0, v1, yb0, yt0, yb1, yt1, k) => {
      const pt = (c, v, y) => [c[0] + n[0] * v, y, c[1] + n[1] * v];
      const A = pt(p, v0, yb0), B = pt(p, v1, yb0), C = pt(p, v1, yt0), D = pt(p, v0, yt0);
      const E = pt(q, v0, yb1), F = pt(q, v1, yb1), G = pt(q, v1, yt1), Hh = pt(q, v0, yt1);
      quad(D, C, G, Hh, k);   // vršek
      quad(A, E, F, B, k);    // spodek
      quad(A, D, Hh, E, k);   // strana v0
      quad(B, F, G, C, k);    // strana v1
      quad(A, B, C, D, k);    // čelo
      quad(E, Hh, G, F, k);   // čelo
    };
    // svislý sloupek / pilíř: čtverec kolem bodu
    const post = (c, u, n, su, sv, y0, y1, k) => {
      const p = [c[0] - u[0] * su / 2, c[1] - u[1] * su / 2], q = [c[0] + u[0] * su / 2, c[1] + u[1] * su / 2];
      prism(p, q, n, -sv / 2, sv / 2, y0, y1, y0, y1, k);
    };

    for (const b of list) {
      const rail = b.t === 8, foot = b.t === 7, st = b.style;
      // polovina šířky mostovky (u stylů z fotografií i s chodníky)
      const hw = b.w / 2 + (st?.sidewalk ?? st?.extra ?? (rail ? 0.9 : 0.5));
      const railCol = st?.rail !== undefined ? new THREE.Color(st.rail) : (foot ? COL.wood : COL.rail);
      const thick = b.L > 30 ? 1.3 : 0.9;
      const u = [b.ux, b.uz], n = [-b.uz, b.ux];
      // staničení s krokem ≤ 2 m, i s přesahem na břehy (napojení na silnici)
      const s0 = -1.5, s1 = b.L + 1.5, steps = Math.max(2, Math.ceil((s1 - s0) / 2));
      const S = [], P = [], Y = [];
      for (let i = 0; i <= steps; i++) {
        const s = s0 + (s1 - s0) * i / steps;
        S.push(s); P.push([b.ax + b.ux * s, b.az + b.uz * s]); Y.push(info.deckAtS(b, s));
      }
      for (let i = 0; i < steps; i++) {
        const p = P[i], q = P[i + 1], ya = Y[i], yb = Y[i + 1];
        // mostovka (vršek těsně pod vozovkou)
        prism(p, q, n, -hw, hw, ya - thick, ya + 0.28, yb - thick, yb + 0.28, COL.deck);
        for (const sgn of [-1, 1]) {
          const v0 = sgn * (hw - 0.45), v1 = sgn * (hw + 0.08);
          const [va, vb] = sgn < 0 ? [v1, v0] : [v0, v1];
          // římsa (zvýšený okraj)
          prism(p, q, n, va, vb, ya - thick - 0.05, ya + 0.5, yb - thick - 0.05, yb + 0.5, COL.cornice);
          if (st?.sidewalk) {                             // zvýšený chodník mezi vozovkou a zábradlím
            const c0 = sgn * (b.w / 2 + 0.05), c1 = sgn * (hw - 0.45);
            const [ca, cb] = sgn < 0 ? [c1, c0] : [c0, c1];
            prism(p, q, n, ca, cb, ya, ya + 0.48, yb, yb + 0.48, COL.cornice);
          }
          const vr = sgn * (hw - 0.18);
          if (rail) {
            // plnostěnný ocelový nosník podél koleje
            prism(p, q, n, vr - 0.12, vr + 0.12, ya - thick - 0.3, ya + 1.45, yb - thick - 0.3, yb + 1.45, COL.girder);
          } else {
            const k = railCol;
            // madlo a střední tyč
            prism(p, q, n, vr - 0.04, vr + 0.04, ya + 1.3, ya + 1.38, yb + 1.3, yb + 1.38, k);
            prism(p, q, n, vr - 0.02, vr + 0.02, ya + 0.9, ya + 0.94, yb + 0.9, yb + 0.94, k);
          }
        }
      }
      // sloupky zábradlí / výztuhy nosníků po ~2 m
      for (let i = 0; i <= steps; i++) {
        for (const sgn of [-1, 1]) {
          const vr = sgn * (hw - 0.18);
          const c = [P[i][0] + n[0] * vr, P[i][1] + n[1] * vr];
          if (rail) {
            if (i % 2 === 0) post(c, u, n, 0.12, 0.34, Y[i] - thick - 0.3, Y[i] + 1.45, COL.girder);
          } else {
            post(c, u, n, 0.07, 0.07, Y[i] + 0.5, Y[i] + 1.38, railCol);
          }
        }
      }
      const spans = st?.spans || (st?.span ? [st.span] : []);       // pole s obloukem (podíl délky)
      // pilíře: delší mosty po ~16 m, opěry na koncích – jen kde je pod mostovkou místo
      const supports = [0, b.L];
      const np = b.L > 20 ? Math.floor(b.L / 16) : 0;
      for (let k = 1; k <= np; k++) {
        const s = b.L * k / (np + 1);
        if (!spans.some(([a, c]) => s > a * b.L - 2 && s < c * b.L + 2)) supports.push(s);
      }
      // pilíře pod patkami oblouků (u konců mostu stačí opěra; společná patka dvou oblouků jen jednou)
      const stone = new Set();
      for (const [a, c] of spans) {
        for (const f of [a, c]) {
          const sf = f * b.L;
          if (sf < 5 || sf > b.L - 5 || supports.some((q) => Math.abs(q - sf) < 1)) continue;
          supports.push(sf);
          if (st.pier) stone.add(sf);
        }
      }
      supports.forEach((s, k) => {
        const c = [b.ax + b.ux * s, b.az + b.uz * s];
        const top = info.deckAtS(b, s) - thick;
        let g = Infinity;
        for (const v of [-hw, 0, hw]) g = Math.min(g, world.heightAt(c[0] + n[0] * v, c[1] + n[1] * v));
        if (top - g < 0.6) return;
        const end = k < 2;
        if (stone.has(s)) post(c, u, n, 3.2, 2 * hw - 0.6, g - 1.5, top, new THREE.Color(st.pier));   // kamenný pilíř
        else post(c, u, n, end ? 1.8 : 1.1, 2 * hw + (end ? 0.6 : -0.4), g - 1.5, top, COL.deck);
      });
      if (st?.type === 'arch') for (const sp of spans) archBridge(b, st, sp, hw, u, n);
      if (st?.type === 'truss') trussBridge(b, st, hw, u, n);
    }
    // ocelové oblouky se závěsy po obou stranách vozovky (silniční most přes Radbuzu)
    function archBridge(b, st, span, hw, u, n) {
      const k = new THREE.Color(st.color), s0 = span[0] * b.L, s1 = span[1] * b.L, N = 28;
      st = { ...st, rise: span[2] ?? st.rise };
      const at = (s) => [b.ax + b.ux * s, b.az + b.uz * s];
      for (const sgn of [-1, 1]) {
        const v = sgn * (b.w / 2 + 0.35);
        let prev = null;
        for (let i = 0; i <= N; i++) {
          const t = i / N, s = s0 + (s1 - s0) * t;
          const y = info.deckAtS(b, s) + 0.45 + st.rise * 4 * t * (1 - t);
          const c = at(s);
          const tw = st.network ? 0.17 : 0.28, th = st.network ? 0.2 : 0.32;
          if (prev) prism(prev.c, c, n, v - tw, v + tw, prev.y - th, prev.y + th, y - th, y + th, k);
          prev = { c, y };
        }
        // síťové závěsy (network arch): každý uzel oblouku dvěma šikmými lanky k mostovce
        if (st.network) {
          const N2 = 11, d = (s1 - s0) / 7, wk = new THREE.Color(0xeef1f2);
          for (let i = 1; i < N2; i++) {
            const t = i / N2, s = s0 + (s1 - s0) * t;
            const ya = info.deckAtS(b, s) + 0.45 + st.rise * 4 * t * (1 - t) - 0.2;
            for (const dir of [-1, 1]) {
              const sd = THREE.MathUtils.clamp(s + dir * d, s0 + 0.5, s1 - 0.5);
              prism(at(sd), at(s), n, v - 0.04, v + 0.04, info.deckAtS(b, sd) + 0.4, info.deckAtS(b, sd) + 0.48, ya - 0.04, ya + 0.04, wk);
            }
          }
          continue;
        }
        // závěsy
        for (let s = s0 + 3; s < s1 - 2; s += 3) {
          const t = (s - s0) / (s1 - s0), y = info.deckAtS(b, s) + 0.45 + st.rise * 4 * t * (1 - t);
          const c = at(s);
          post([c[0] + n[0] * v, c[1] + n[1] * v], u, n, 0.07, 0.07, info.deckAtS(b, s) + 0.4, y, k);
        }
      }
    }
    // zelená ocelová příhradová lávka s horním pásem do oblouku
    function trussBridge(b, st, hw, u, n) {
      const k = new THREE.Color(st.color), N = Math.max(6, Math.round(b.L / 2));
      const at = (s) => [b.ax + b.ux * s, b.az + b.uz * s];
      for (const sgn of [-1, 1]) {
        const v = sgn * (hw - 0.05);
        const pt = [];
        for (let i = 0; i <= N; i++) {
          const t = i / N, s = b.L * t, d = info.deckAtS(b, s);
          pt.push({ c: at(s), d, top: d + 1.3 + st.rise * 4 * t * (1 - t) });
        }
        for (let i = 0; i < N; i++) {
          const A = pt[i], B = pt[i + 1];
          prism(A.c, B.c, n, v - 0.12, v + 0.12, A.top - 0.2, A.top, B.top - 0.2, B.top, k);      // horní pás
          prism(A.c, B.c, n, v - 0.12, v + 0.12, A.d - 0.1, A.d + 0.35, B.d - 0.1, B.d + 0.35, k); // dolní pás
          const [lo, hi] = i % 2 ? [A, B] : [B, A];                                                // diagonála
          prism(lo.c, hi.c, n, v - 0.05, v + 0.05, lo.d + 0.3, lo.d + 0.45, hi.top - 0.2, hi.top - 0.05, k);
        }
        for (const P of pt) post([P.c[0] + n[0] * v, P.c[1] + n[1] * v], u, n, 0.1, 0.1, P.d, P.top, k);
      }
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, material);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  };
}
