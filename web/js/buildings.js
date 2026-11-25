import * as THREE from 'three';
import { patch } from './glsl.js';
import { NIGHT } from './night.js';
import { FACADES } from './landmarks.js';

// Fasády: krémová, světle žlutá, bílá, okrová, pískově růžová, šedá
const PLASTER = [0xf2ead8, 0xf6efdc, 0xf7f4ec, 0xeedcae, 0xe8d0b8, 0xe2dfd6, 0xf2e2c0, 0xdcd4c4]
  .map((c) => new THREE.Color(c));
const FARM = [0xc9c2b4, 0xb9b2a5, 0xd2c8b3, 0xa89c8a].map((c) => new THREE.Color(c));
const BRICK = new THREE.Color(0x8a4a38);
// druhy podle RÚIAN (způsob využití) – musí souhlasit s tools/build_data.py
const KIND = { house: 0, farm: 1, shed: 2, chimney: 3, flats: 4, civic: 5, industry: 6, garage: 7, greenhouse: 8 };
const pal = (a) => a.map((c) => new THREE.Color(c));
const PALETTE = {
  0: PLASTER, 1: FARM, 2: FARM,
  4: pal([0xe9e4d8, 0xdfe3e3, 0xf0e2c4, 0xd9dccf, 0xe8d6c6, 0xe4e8dc]),               // bytové domy
  5: pal([0xf0d68a, 0xeedcae, 0xf2ead8, 0xe6c9a8, 0xf4ecd6, 0xe8d9a0]),               // úřady, školy, obchody
  6: pal([0xbfc3c4, 0xa9b0b3, 0xc8c0ae, 0x9aa3a8, 0xd2cdc2, 0xb4b8a8]),               // haly, výroba, sklady
  7: pal([0xd8d2c4, 0xc8c2b4, 0xe2ddd2, 0xcfc8bb]),                                  // garáže
  8: pal([0xdfeae8]),                                                              // skleníky
};

const WINDOW_GLSL = /* glsl */ `
uniform float uNight, uLit;
varying vec4 vWall;   // u podél stěny [m], v nad terénem [m], délka stěny, seed
varying vec2 vInfo;   // druh budovy (KIND v buildings.js), výška okapu
// okno pod bodem fasády: x = sklo (1), y = rám (1), z = náhodné číslo okna, w = výška ve skle (0–1)
vec4 windowAt(){
  int kind = int(vInfo.x + .5);
  if (kind == 2 || kind == 3 || kind >= 7) return vec4(0.);
  float u = vWall.x, v = vWall.y, L = vWall.z, seed = vWall.w, eaveH = vInfo.y;
  // rozteč, šířka a výška okna, výška podlaží, parapet přízemí
  float spacing = 3.1, ww = 1.0, wh = 1.25, floorH = 2.85, sill0 = 1.25;
  if (kind == 1) { spacing = 4.; ww = .8; wh = .6; }
  else if (kind == 4) { spacing = 2.9; ww = 1.45; wh = 1.45; floorH = 2.8; sill0 = 1.2; }
  else if (kind == 5) { spacing = 3.3; ww = 1.15; wh = 1.85; floorH = 3.6; sill0 = 1.15; }
  else if (kind == 6) { spacing = 3.; ww = 2.5; wh = .9; }
  bool multi = kind == 0 || kind == 4 || kind == 5;
  float nf = multi ? max(1., floor((eaveH - .2) / (floorH - .25))) : 1.;
  float n = floor((L - 1.2) / spacing);
  if (n < 1. && L > 2.6) n = 1.;
  float lu = u - (L - n * spacing) * .5;
  float idx = floor(lu / spacing);
  float cx = mod(lu, spacing) - spacing * .5;
  float fl = multi ? floor((v - .3) / floorH) : 0.;
  float sill = multi ? .05 + fl * floorH + sill0 : (kind == 6 ? max(2.4, eaveH - 1.9) : 2.1);
  float cy = v - sill - wh * .5;
  if (idx < 0. || idx >= n || fl < 0. || fl >= nf || v > eaveH - .15) return vec4(0.);
  float r = hash12(vec2(idx + seed * 17., fl + seed * 3.));
  float fx = abs(cx) - ww * .5, fy = abs(cy) - wh * .5;
  if (fx > .08 || fy > .08) return vec4(0., 0., r, 0.);
  if (fx > 0. || fy > 0.) return vec4(0., 1., r, 0.);
  // příčle jako rám
  if (abs(cx) < .03 || abs(cy - wh * .15) < .025) return vec4(0., 1., r, 0.);
  return vec4(1., 0., r, cy / wh + .5);
}
// fasáda ve dne: tmavší sokl, okna se světlým rámem a sklem, které odráží oblohu
vec3 facade(vec3 base){
  int kind = int(vInfo.x + .5);
  if (kind == 3) return base;
  if (kind == 8) {                     // skleník: světlé sklo v bílém rastru
    vec2 g = abs(fract(vec2(vWall.x / 1.2, vWall.y / .9)) - .5);
    return max(g.x, g.y) > .45 ? vec3(.95) : mix(base, vec3(.62, .74, .72), .55);
  }
  if (kind == 7) {                     // garáž: vrata uprostřed kratší stěny
    float L = vWall.z, dw = min(2.6, L - .8);
    if (L > 2.2 && L < 7.5 && abs(vWall.x - L * .5) < dw * .5 && vWall.y < 2.15) {
      float rib = step(.82, fract(vWall.y / .32));
      return mix(vec3(.72, .71, .68), vec3(.55, .54, .52), rib * .6);
    }
    return base;
  }
  if ((kind <= 1 || kind == 4 || kind == 5) && vWall.y < .55) base *= .8;
  // zdálky (okno menší než pár pixelů) jen lehce ztmavená omítka, jinak moaré
  float px = max(fwidth(vWall.x), fwidth(vWall.y));
  float vis = 1. - smoothstep(.09, .3, px);
  if (vis <= 0.) return base * (kind == 0 ? .93 : .97);
  vec4 w = windowAt();
  vec3 c = base;
  if (w.y > .5) c = mix(base, vec3(.93, .92, .89), .85);
  else if (w.x > .5) {
    vec3 glass = mix(vec3(.05, .07, .09), vec3(.22, .29, .36), w.w * .8 + fract(w.z * 5.3) * .2);
    c = mix(glass, glass * .4, uNight);
  }
  return mix(base * (kind == 0 ? .93 : .97), c, vis);
}
vec3 windowGlow(){
  if (uNight < .01) return vec3(0.);
  vec4 w = windowAt();
  if (w.x < .5) return vec3(0.);
  int kind = int(vInfo.x + .5);
  float frac = (kind == 0 || kind == 4) ? uLit : uLit * .25;
  if (w.z > frac) return vec3(0.);
  vec3 c = mix(vec3(1., .72, .38), vec3(1., .85, .6), fract(w.z * 7.13));
  return c * uNight * (1.1 + .6 * fract(w.z * 3.7));
}
`;
// řady tašek na šikmých střechách (ploché střechy typ 5 bez nich)
const ROOF_GLSL = /* glsl */ `
varying vec3 vRoof;   // u podél okapu, v po spádu [m], typ krytiny
vec3 roofCourses(vec3 c){
  if (abs(vRoof.z - 5.) < .5) return c;
  float t = fract(vRoof.y / .34);
  float k = 1. - .13 * smoothstep(.78, .97, t);
  float px = fwidth(vRoof.y);
  k = mix(k, .97, smoothstep(.06, .2, px));       // zdálky jen jemně, ať to nezrní
  return c * k;
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

export function createBuildings({ buildings, world, skip }) {
  const T = world.T, WW = world.W, HH = world.H;
  const buckets = new Map();
  const bucket = (x, z) => {
    const key = `${Math.floor((x + WW / 2) / T)}_${Math.floor((z + HH / 2) / T)}`;
    if (!buckets.has(key)) buckets.set(key, { W: { pos: [], col: [], wall: [], info: [] }, R: { pos: [], roof: [] } });
    return buckets.get(key);
  };
  const P = (x, z, y) => [x, y, z];

  // barvy a tvary podle fotografií (landmarks.js FACADES): index budovy → úprava
  const ROOF_COL = [0xc45c40, 0x8c5c46, 0x585c64, 0x969694, 0xc8ccce, 0x78766f].map((c) => new THREE.Color(c));
  const facade = new Map();
  FACADES.forEach((f) => {
    buildings.forEach((b, i) => {
      const r = b.rings[0];
      let hit = pointIn(f.at[0], f.at[1], r);
      if (!hit && f.radius) {
        let cx = 0, cz = 0;
        for (const p of r) { cx += p[0]; cz += p[1]; }
        hit = Math.hypot(cx / r.length - f.at[0], cz / r.length - f.at[1]) < f.radius && (!f.kinds || f.kinds.includes(b.k));
      }
      if (hit && !facade.has(i)) {
        if (f.roof !== undefined && f.roofIdx === undefined) { f.roofIdx = ROOF_COL.length; ROOF_COL.push(new THREE.Color(f.roof)); }
        facade.set(i, f);
      }
    });
  });

  buildings.forEach((b0, idx) => {
    if (skip?.has(idx)) return;                 // nahrazeno ručním modelem (landmarks.js)
    const fc = facade.get(idx);
    const b = fc ? { ...b0, eave: fc.eave ?? b0.eave, ridge: fc.flat ? (fc.eave ?? b0.eave) + 0.2 : (fc.ridge ?? b0.ridge), shape: fc.shape ?? b0.shape } : b0;
    const rings = b.rings.map(cleanRing).filter((r) => r.length >= 3);
    if (!rings.length) return;
    const { W, R } = bucket(rings[0][0][0], rings[0][0][1]);
    const wallTri = (a, bb, c, wa, wb, wc, col, info) => {
      W.pos.push(...a, ...bb, ...c);
      W.wall.push(...wa, ...wb, ...wc);
      for (let i = 0; i < 3; i++) { W.col.push(col.r, col.g, col.b); W.info.push(...info); }
    };
    const wallQuad = (p1, p2, yb, yt, base, L, seed, col, info) => {
      // sokl / přízemí v jiné barvě (FACADES)
      if (fc?.plinth !== undefined && col !== BRICK) {
        const yp = base + fc.plinthH;
        if (yb < yp && yt > yp) {
          wallQuad(p1, p2, yb, yp, base, L, seed, plinthCol, info);
          yb = yp;
        } else if (yt <= yp) col = plinthCol;
      }
      const A = P(...p1, yb), B = P(...p2, yb), C = P(...p2, yt), D = P(...p1, yt);
      const a = [0, yb - base, L, seed], bb = [L, yb - base, L, seed];
      const c = [L, yt - base, L, seed], d = [0, yt - base, L, seed];
      wallTri(A, B, C, a, bb, c, col, info);
      wallTri(A, C, D, a, c, d, col, info);
    };
    const roofTri = (a, bb, c, ra, rb, rc) => { R.pos.push(...a, ...bb, ...c); R.roof.push(...ra, ...rb, ...rc); };

    const outer = rings[0];
    const rnd = rand(idx * 7919 + 13);
    const kind = KIND[b.k] ?? KIND.house;
    const ground = b.base;
    const base = ground - 0.4;
    const eave = ground + b.eave;
    const rise = b.ridge - b.eave;
    const palette = PALETTE[kind] ?? PLASTER;
    const pick = palette[Math.floor(rnd() * palette.length)];
    const col = fc?.wall !== undefined ? new THREE.Color(fc.wall) : pick;
    const plinthCol = fc?.plinth !== undefined ? new THREE.Color(fc.plinth) : null;
    const seed = rnd() * 100;
    const info = [kind, b.eave];
    const type = fc?.roofIdx ?? (kind === KIND.greenhouse ? 4 : (b.roof ?? 0));

    const box = orientedBox(outer);
    const fill = Math.abs(signedArea(outer)) / box.area;
    let rects = null;
    if (rise > 0.8 && box.W >= 2.5) rects = fill > 0.8 ? [box] : decompose(outer, box);
    // budovy z fotografií (FACADES): složitý půdorys → aspoň střecha nad opsaným obdélníkem
    if (fc?.roofIdx !== undefined && !fc.flat && rise > 0.8 && !rects && fill > 0.55) rects = [box];
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
        const ft = fc?.roofIdx !== undefined && !fc.flat ? fc.roofIdx : 5;
        roofTri(P(...a, wallTop), P(...bb, wallTop), P(...c, wallTop), [a[0], a[1], ft], [bb[0], bb[1], ft], [c[0], c[1], ft]);
      }
      return;
    }

    const shape = rects.length === 1 ? (b.shape || 'gable') : (b.shape === 'hip' ? 'hip' : 'gable');
    const maxW = Math.max(...rects.map((r) => r.W));
    const slope = Math.min(rise / (maxW / 2), 1.4);
    const o = (kind === KIND.shed || kind === KIND.garage || kind === KIND.greenhouse) ? 0.25 : 0.45;

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

  // stylizované plné barvy: omítka z palety, střecha podle krytiny (z ortofota), ROOF_COL viz výše
  const wm = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  // okna: ve dne sklo s rámem, v noci část svítí
  wm.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = NIGHT.night;
    sh.uniforms.uLit = NIGHT.litFrac;
    patch(sh, {
      vertHead: 'attribute vec4 aWall; attribute vec2 aInfo; varying vec4 vWall; varying vec2 vInfo;',
      vertBody: 'vWall = aWall; vInfo = aInfo;',
      fragHead: WINDOW_GLSL,
      afterColor: 'diffuseColor.rgb = facade(diffuseColor.rgb);',
    });
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n totalEmissiveRadiance += windowGlow();');
  };
  const rm = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  rm.onBeforeCompile = (sh) => {
    patch(sh, {
      vertHead: 'attribute vec3 aRoof; varying vec3 vRoof;',
      vertBody: 'vRoof = aRoof;',
      fragHead: ROOF_GLSL,
      afterColor: 'diffuseColor.rgb = roofCourses(diffuseColor.rgb);',
    });
  };
  rm.customProgramCacheKey = () => 'roof-courses';
  wm.customProgramCacheKey = () => 'walls-windows';

  const group = new THREE.Group();
  for (const { W, R } of buckets.values()) {
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(W.pos, 3));
    wg.setAttribute('color', new THREE.Float32BufferAttribute(W.col, 3));
    wg.setAttribute('aWall', new THREE.Float32BufferAttribute(W.wall, 4));
    wg.setAttribute('aInfo', new THREE.Float32BufferAttribute(W.info, 2));
    const rc = new Float32Array(R.pos.length);
    for (let i = 0; i < R.roof.length / 3; i++) {
      const c = ROOF_COL[Math.min(ROOF_COL.length - 1, Math.round(R.roof[i * 3 + 2]))];
      // mírná variace odstínu po střechách, ať to není jednotvárné
      const k = 0.94 + 0.12 * ((Math.floor(i / 6) * 0.618) % 1);
      rc[i * 3] = c.r * k; rc[i * 3 + 1] = c.g * k; rc[i * 3 + 2] = c.b * k;
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(R.pos, 3));
    rg.setAttribute('color', new THREE.BufferAttribute(rc, 3));
    rg.setAttribute('aRoof', new THREE.Float32BufferAttribute(R.roof, 3));
    for (const m of [new THREE.Mesh(wg, wm), new THREE.Mesh(rg, rm)]) {
      m.geometry.computeVertexNormals();
      m.castShadow = m.receiveShadow = true;
      group.add(m);
    }
  }
  return group;
}
