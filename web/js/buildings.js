import * as THREE from 'three';
import { patch } from './glsl.js';
import { NIGHT } from './night.js';

// Fasády: krémová, světle žlutá, bílá, okrová, pískově růžová, šedá
const PLASTER = [0xf2ead8, 0xf6efdc, 0xf7f4ec, 0xeedcae, 0xe8d0b8, 0xe2dfd6, 0xf2e2c0, 0xdcd4c4]
  .map((c) => new THREE.Color(c));
const FARM = [0xc9c2b4, 0xb9b2a5, 0xd2c8b3, 0xa89c8a].map((c) => new THREE.Color(c));
const BRICK = new THREE.Color(0x8a4a38);
const KIND = { house: 0, farm: 1, shed: 2, chimney: 3 };

const WINDOW_GLSL = /* glsl */ `
uniform float uNight, uLit;
varying vec4 vWall;   // u podél stěny [m], v nad terénem [m], délka stěny, seed
varying vec2 vInfo;   // typ budovy (0 dům, 1 hospodářská, 2 kůlna, 3 komín), výška okapu
vec3 windowGlow(){
  if (uNight < .01) return vec3(0.);
  int kind = int(vInfo.x + .5);
  if (kind >= 2) return vec3(0.);
  float u = vWall.x, v = vWall.y, L = vWall.z, seed = vWall.w, eaveH = vInfo.y;
  float spacing = kind == 0 ? 3.1 : 4.;
  float ww = kind == 0 ? 1.0 : .8, wh = kind == 0 ? 1.25 : .6;
  float floorH = 2.85;
  float nf = kind == 0 ? max(1., floor((eaveH - .2) / 2.6)) : 1.;
  float n = floor((L - 1.2) / spacing);
  if (n < 1. && L > 2.6) n = 1.;
  float lu = u - (L - n * spacing) * .5;
  float idx = floor(lu / spacing);
  float cx = mod(lu, spacing) - spacing * .5;
  float fl = kind == 0 ? floor((v - .3) / floorH) : 0.;
  float sill = kind == 0 ? .3 + fl * floorH + .95 : 2.1;
  float cy = v - sill - wh * .5;
  if (idx < 0. || idx >= n || fl < 0. || fl >= nf || v > eaveH - .15) return vec3(0.);
  if (abs(cx) > ww * .5 || abs(cy) > wh * .5) return vec3(0.);
  float r = hash12(vec2(idx + seed * 17., fl + seed * 3.));
  float frac = kind == 0 ? uLit : uLit * .25;
  if (r > frac) return vec3(0.);
  // teplé světlo, každé okno trochu jinak; příčle
  vec3 c = mix(vec3(1., .72, .38), vec3(1., .85, .6), fract(r * 7.13));
  if (abs(cx) < .03 || abs(cy - wh * .15) < .025) c *= .25;
  return c * uNight * (1.1 + .6 * fract(r * 3.7));
}
`;

/** Nejmenší orientovaný obdélník; a = podélná osa. */
function orientedBox(pts) {
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 0.5) continue;
    const ax = (x2 - x1) / len, ay = (y2 - y1) / len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of pts) {
      const u = x * ax + y * ay, v = -x * ay + y * ax;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ax, ay, u0, u1, v0, v1 };
  }
  const { ax, ay, u0, u1, v0, v1, area } = best;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const cx = cu * ax - cv * ay, cy = cu * ay + cv * ax;
  let L = u1 - u0, W = v1 - v0, a = [ax, ay], b = [-ay, ax];
  if (W > L) { [L, W] = [W, L]; [a, b] = [b, [-a[0], -a[1]]]; }
  return { area, a, b, L, W, cx, cy };
}

const signedArea = (r) => r.reduce((s, p, i) => {
  const q = r[(i + 1) % r.length];
  return s + p[0] * q[1] - q[0] * p[1];
}, 0) / 2;

function cleanRing(r) {
  const out = r.slice();
  const f = out[0], l = out[out.length - 1];
  if (f[0] === l[0] && f[1] === l[1]) out.pop();
  return out;
}

function rand(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}


const pointIn = (x, y, r) => {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > y) !== (r[j][1] > y) && x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
  }
  return inside;
};

/**
 * Rozklad pravoúhlého půdorysu (L, T, U…) na obdélníková křídla.
 * Vrací [{cx, cy, a, b, L, W}] (a = podélná osa křídla) nebo null.
 */
function decompose(outer, box) {
  const loc = outer.map(([x, z]) => {
    const dx = x - box.cx, dz = z - box.cy;
    return [dx * box.a[0] + dz * box.a[1], dx * box.b[0] + dz * box.b[1]];
  });
  const snap = (vals) => {
    const out = [];
    for (const v of vals.sort((p, q) => p - q)) {
      if (!out.length || v - out[out.length - 1] > 0.8) out.push(v);
    }
    return out;
  };
  const us = snap(loc.map((p) => p[0])), vs = snap(loc.map((p) => p[1]));
  if (us.length > 9 || vs.length > 9 || us.length < 2 || vs.length < 2) return null;
  const nu = us.length - 1, nv = vs.length - 1;
  const inside = [], used = [];
  for (let i = 0; i < nu; i++) {
    inside.push([]); used.push([]);
    for (let j = 0; j < nv; j++) {
      inside[i].push(pointIn((us[i] + us[i + 1]) / 2, (vs[j] + vs[j + 1]) / 2, loc));
      used[i].push(false);
    }
  }
  const rects = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      if (!inside[i][j] || used[i][j]) continue;
      let i1 = i;
      while (i1 + 1 < nu && inside[i1 + 1][j] && !used[i1 + 1][j]) i1++;
      let j1 = j;
      const rowOk = (jj) => { for (let q = i; q <= i1; q++) if (!inside[q][jj] || used[q][jj]) return false; return true; };
      while (j1 + 1 < nv && rowOk(j1 + 1)) j1++;
      for (let q = i; q <= i1; q++) for (let r = j; r <= j1; r++) used[q][r] = true;
      const u0 = us[i], u1 = us[i1 + 1], v0 = vs[j], v1 = vs[j1 + 1];
      const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
      const cx = box.cx + box.a[0] * uc + box.b[0] * vc, cy = box.cy + box.a[1] * uc + box.b[1] * vc;
      const du = u1 - u0, dv = v1 - v0;
      rects.push(du >= dv ? { cx, cy, a: box.a, b: box.b, L: du, W: dv }
        : { cx, cy, a: box.b, b: [-box.a[0], -box.a[1]], L: dv, W: du });
    }
  }
  return rects.length <= 6 ? rects : null;
}

export function createBuildings({ buildings, world }) {
  const T = world.T, WW = world.W, HH = world.H;
  const buckets = new Map();
  const bucket = (x, z) => {
    const key = `${Math.floor((x + WW / 2) / T)}_${Math.floor((z + HH / 2) / T)}`;
    if (!buckets.has(key)) buckets.set(key, { W: { pos: [], col: [], wall: [], info: [] }, R: { pos: [], roof: [] } });
    return buckets.get(key);
  };
  const P = (x, z, y) => [x, y, z];

  buildings.forEach((b, idx) => {
    const rings = b.rings.map(cleanRing).filter((r) => r.length >= 3);
    if (!rings.length) return;
    const { W, R } = bucket(rings[0][0][0], rings[0][0][1]);
    const wallTri = (a, bb, c, wa, wb, wc, col, info) => {
      W.pos.push(...a, ...bb, ...c);
      W.wall.push(...wa, ...wb, ...wc);
      for (let i = 0; i < 3; i++) { W.col.push(col.r, col.g, col.b); W.info.push(...info); }
    };
    const wallQuad = (p1, p2, yb, yt, base, L, seed, col, info) => {
      const A = P(...p1, yb), B = P(...p2, yb), C = P(...p2, yt), D = P(...p1, yt);
      const a = [0, yb - base, L, seed], bb = [L, yb - base, L, seed];
      const c = [L, yt - base, L, seed], d = [0, yt - base, L, seed];
      wallTri(A, B, C, a, bb, c, col, info);
      wallTri(A, C, D, a, c, d, col, info);
    };
    const roofTri = (a, bb, c, ra, rb, rc) => { R.pos.push(...a, ...bb, ...c); R.roof.push(...ra, ...rb, ...rc); };

    const outer = rings[0];
    const rnd = rand(idx * 7919 + 13);
    const kind = KIND[{ house: 'house', farm: 'farm', shed: 'shed' }[b.k] ?? 'house'];
    const ground = b.base;
    const base = ground - 0.4;
    const eave = ground + b.eave;
    const rise = b.ridge - b.eave;
    const col = (kind === 0 ? PLASTER : FARM)[Math.floor(rnd() * (kind === 0 ? PLASTER.length : FARM.length))];
    const seed = rnd() * 100;
    const info = [kind, b.eave];
    const type = b.roof ?? 0;

    const box = orientedBox(outer);
    const fill = Math.abs(signedArea(outer)) / box.area;
    let rects = null;
    if (rise > 0.8 && box.W >= 2.5) rects = fill > 0.8 ? [box] : decompose(outer, box);
    const pitched = rects && rects.every((r) => r.W >= 2.5 && r.W < 26);
    const wallTop = pitched ? eave : eave + Math.max(0, rise) * 0.35;

    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const p1 = ring[i], p2 = ring[(i + 1) % ring.length];
        const L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
        if (L > 0.05) wallQuad(p1, p2, base, wallTop, ground, L, seed + i * 1.37, col, info);
      }
    }

    if (!pitched) {
      const toV2 = (r) => r.map(([x, z]) => new THREE.Vector2(x, z));
      const tris = THREE.ShapeUtils.triangulateShape(toV2(outer), rings.slice(1).map(toV2));
      const all = [...outer, ...rings.slice(1).flat()];
      for (const [i, j, k] of tris) {
        const [a, bb, c] = [all[i], all[j], all[k]];
        roofTri(P(...a, wallTop), P(...bb, wallTop), P(...c, wallTop), [a[0], a[1], 5], [bb[0], bb[1], 5], [c[0], c[1], 5]);
      }
      return;
    }

    const shape = rects.length === 1 ? (b.shape || 'gable') : (b.shape === 'hip' ? 'hip' : 'gable');
    const maxW = Math.max(...rects.map((r) => r.W));
    const slope = Math.min(rise / (maxW / 2), 1.4);
    const o = kind === 2 ? 0.25 : 0.45;

    rects.forEach((r, ri) => {
      const hw = r.W / 2, hl = r.L / 2;
      const ridge = eave + slope * hw;
      const eo = eave - o * slope;
      const k = Math.hypot(1, slope);
      const pt = (u, v) => [r.cx + r.a[0] * u + r.b[0] * v, r.cy + r.a[1] * u + r.b[1] * v];
      const Rp = (u, v, y) => P(...pt(u, v), y);
      const gableWall = (s, profile) => {      // štít: profil [[v, y], …] od -hw do +hw
        for (let q = 0; q < profile.length - 2; q++) {
          const [v0, y0] = profile[0], [v1, y1] = profile[q + 1], [v2, y2] = profile[q + 2];
          wallTri(Rp(s * hl, v0, y0), Rp(s * hl, v1, y1), Rp(s * hl, v2, y2),
            [v0 + hw, y0 - ground, r.W, seed], [v1 + hw, y1 - ground, r.W, seed], [v2 + hw, y2 - ground, r.W, seed], col, info);
        }
      };

      if (shape === 'hip') {
        const rl = Math.max(0, hl - hw);           // délka hřebene / 2 (valba 45° v půdorysu)
        const top = (hw + o) * k;
        for (const s of [-1, 1]) {
          const A = Rp(-hl - o, s * (hw + o), eo), B = Rp(hl + o, s * (hw + o), eo);
          const C = Rp(rl, 0, ridge), D = Rp(-rl, 0, ridge);
          roofTri(A, B, C, [0, 0, type], [r.L + 2 * o, 0, type], [hl + o + rl, top, type]);
          roofTri(A, C, D, [0, 0, type], [hl + o + rl, top, type], [hl + o - rl, top, type]);
          // valba na konci
          const E = Rp(s * (hl + o), -(hw + o), eo), F = Rp(s * (hl + o), hw + o, eo), G = Rp(s * rl, 0, ridge);
          roofTri(E, F, G, [0, 0, type], [r.W + 2 * o, 0, type], [hw + o, top, type]);
        }
      } else if (shape === 'gambrel') {
        // lomená: strmá spodní část do 55 % šířky, mírná horní
        const bv = hw * 0.55, by = eave + (ridge - eave) * 0.72;
        const s1 = (by - eave) / (hw - bv);
        const eo2 = eave - o * s1;
        const k1 = Math.hypot(hw - bv + o, by - eo2), k2 = Math.hypot(bv, ridge - by);
        for (const s of [-1, 1]) {
          const A = Rp(-hl - o, s * (hw + o), eo2), B = Rp(hl + o, s * (hw + o), eo2);
          const C = Rp(hl + o, s * bv, by), D = Rp(-hl - o, s * bv, by);
          const E = Rp(hl + o, 0, ridge), F = Rp(-hl - o, 0, ridge);
          const L2 = r.L + 2 * o;
          roofTri(A, B, C, [0, 0, type], [L2, 0, type], [L2, k1, type]);
          roofTri(A, C, D, [0, 0, type], [L2, k1, type], [0, k1, type]);
          roofTri(D, C, E, [0, k1, type], [L2, k1, type], [L2, k1 + k2, type]);
          roofTri(D, E, F, [0, k1, type], [L2, k1 + k2, type], [0, k1 + k2, type]);
          gableWall(s, [[-hw, eave], [-bv, by], [0, ridge], [bv, by], [hw, eave]]);
        }
      } else {
        const top = (hw + o) * k;
        for (const s of [-1, 1]) {
          const A = Rp(-hl - o, s * (hw + o), eo), B = Rp(hl + o, s * (hw + o), eo);
          const C = Rp(hl + o, 0, ridge), D = Rp(-hl - o, 0, ridge);
          const L2 = r.L + 2 * o;
          roofTri(A, B, C, [0, 0, type], [L2, 0, type], [L2, top, type]);
          roofTri(A, C, D, [0, 0, type], [L2, top, type], [0, top, type]);
          gableWall(s, [[-hw, eave], [0, ridge], [hw, eave]]);
        }
      }
      if (kind === 0 && ri === 0) {                 // komín
        const [cx, cz] = pt((rnd() - 0.5) * r.L * 0.5, 0);
        const hs = 0.28, y0 = ridge - 1.2, y1 = ridge + 0.9;
        const pts = [[cx - hs, cz - hs], [cx + hs, cz - hs], [cx + hs, cz + hs], [cx - hs, cz + hs]];
        for (let i = 0; i < 4; i++) wallQuad(pts[i], pts[(i + 1) % 4], y0, y1, y0, hs * 2, seed, BRICK, [KIND.chimney, 0]);
        const top = pts.map(([x, z]) => P(x, z, y1));
        const z0 = [0, 0, 0, 0];
        wallTri(top[0], top[1], top[2], z0, z0, z0, BRICK, [KIND.chimney, 0]);
        wallTri(top[0], top[2], top[3], z0, z0, z0, BRICK, [KIND.chimney, 0]);
      }
    });
  });

  // stylizované plné barvy: omítka z palety, střecha podle krytiny (z ortofota)
  const ROOF_COL = [0xc45c40, 0x8c5c46, 0x585c64, 0x969694, 0xc8ccce, 0x78766f].map((c) => new THREE.Color(c));
  const wm = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  // v noci svítí část oken (ve dne se okna nekreslí – stylizovaný vzhled)
  wm.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = NIGHT.night;
    sh.uniforms.uLit = NIGHT.litFrac;
    patch(sh, {
      vertHead: 'attribute vec4 aWall; attribute vec2 aInfo; varying vec4 vWall; varying vec2 vInfo;',
      vertBody: 'vWall = aWall; vInfo = aInfo;',
      fragHead: WINDOW_GLSL,
    });
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n totalEmissiveRadiance += windowGlow();');
  };
  const rm = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });

  const group = new THREE.Group();
  for (const { W, R } of buckets.values()) {
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(W.pos, 3));
    wg.setAttribute('color', new THREE.Float32BufferAttribute(W.col, 3));
    wg.setAttribute('aWall', new THREE.Float32BufferAttribute(W.wall, 4));
    wg.setAttribute('aInfo', new THREE.Float32BufferAttribute(W.info, 2));
    const rc = new Float32Array(R.pos.length);
    for (let i = 0; i < R.roof.length / 3; i++) {
      const c = ROOF_COL[Math.min(5, Math.round(R.roof[i * 3 + 2]))];
      // mírná variace odstínu po střechách, ať to není jednotvárné
      const k = 0.94 + 0.12 * ((Math.floor(i / 6) * 0.618) % 1);
      rc[i * 3] = c.r * k; rc[i * 3 + 1] = c.g * k; rc[i * 3 + 2] = c.b * k;
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(R.pos, 3));
    rg.setAttribute('color', new THREE.BufferAttribute(rc, 3));
    for (const m of [new THREE.Mesh(wg, wm), new THREE.Mesh(rg, rm)]) {
      m.geometry.computeVertexNormals();
      m.castShadow = m.receiveShadow = true;
      group.add(m);
    }
  }
  return group;
}
