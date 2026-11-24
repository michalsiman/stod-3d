import * as THREE from 'three';
import { patch } from './glsl.js';

// Typy: 0 dřevěné laťky, 1 pletivo, 2 kovové tyče, 3 živý plot, 4 zeď (ZABAGED)
const HEIGHT = [1.2, 1.5, 1.4, 1.6, 1.8];
const THICK = { 3: 0.7, 4: 0.4 };
const SHOW_D = 380;
const C = 256;

const FENCE_GLSL = /* glsl */ `
varying vec3 vF;     // u podél [m], v výška [m], typ
float fAlpha;
void fence(inout vec3 c){
  float u = vF.x, v = vF.y; int t = int(vF.z + .5);
  float px = max(fwidth(u), fwidth(v));
  float post = 1. - step(.05, abs(fract(u / 2.5 + .5) - .5) * 2.5);
  fAlpha = 0.;
  // zdálky (vzor menší než pixel): laťky splynou v plnou plochu, pletivo a tyče zmizí
  if (t == 0) {                              // laťkový plot
    float lat = step(abs(fract(u / .14) - .5) * .14, .045);
    float top = 1.2 - abs(fract(u / .14) - .5) * .12;
    float rail = step(abs(v - .3), .04) + step(abs(v - .95), .04);
    float k = aa(.14, px);
    fAlpha = max(max(rail, post), mix(step(v, 1.14), lat * step(v, top), step(.5, k)));
    c = hexc(120, 92, 62) * (.8 + .3 * hash11(floor(u / .14))) * mix(.8, 1., k);
  } else if (t == 1) {                       // pletivo
    vec2 q = vec2(u + v, u - v) / .06;
    float wire = 1. - step(.1, min(abs(fract(q.x) - .5), abs(fract(q.y) - .5)));
    fAlpha = max(max(post, step(1.44, v)), wire * step(.05, v) * step(.5, aa(.06, px)));
    c = post > .5 ? hexc(60, 80, 60) : hexc(70, 96, 66);
  } else {                                   // kovové tyče
    float bar = step(abs(fract(u / .13) - .5) * .13, .012);
    float rail = step(abs(v - .15), .03) + step(abs(v - 1.3), .03);
    fAlpha = max(max(rail, post), bar * step(.5, aa(.13, px)));
    c = hexc(48, 50, 52);
  }
  if (fAlpha < .5) discard;
}
`;

let thinMat, solidMat;
function materials() {
  if (thinMat) return;
  thinMat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.8 });
  thinMat.onBeforeCompile = (sh) => patch(sh, {
    vertHead: 'attribute vec3 aF; varying vec3 vF;',
    vertBody: 'vF = aF;',
    fragHead: FENCE_GLSL,
    afterColor: 'fence(diffuseColor.rgb);',
  });
  solidMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
}

export function createFences({ fences, world }) {
  materials();
  const W = world.W, H = world.H;
  const perChunk = new Map();
  fences.filter((f) => f.t >= 3).forEach((f, fi) => {
    for (let i = 0; i < f.p.length - 1; i++) {
      const a = f.p[i], b = f.p[i + 1];
      const key = `${Math.floor(((a[0] + b[0]) / 2 + W / 2) / C)}_${Math.floor(((a[1] + b[1]) / 2 + H / 2) / C)}`;
      if (!perChunk.has(key)) perChunk.set(key, []);
      perChunk.get(key).push({ t: f.t, a, b, fi });
    }
  });

  const hedge = new THREE.Color(0x5f8a46), wall = new THREE.Color(0xc4bcae);

  function buildChunk(cx, cz) {
    const list = perChunk.get(`${cx}_${cz}`);
    if (!list) return null;
    const tp = [], ta = [], sp = [], sc = [];
    for (const { t, a, b, fi } of list) {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(L / 3));
      const h = HEIGHT[t];
      for (let q = 0; q < n; q++) {
        const x1 = a[0] + (b[0] - a[0]) * q / n, z1 = a[1] + (b[1] - a[1]) * q / n;
        const x2 = a[0] + (b[0] - a[0]) * (q + 1) / n, z2 = a[1] + (b[1] - a[1]) * (q + 1) / n;
        const y1 = world.heightAt(x1, z1), y2 = world.heightAt(x2, z2);
        const u1 = L * q / n + fi * 0.37, u2 = L * (q + 1) / n + fi * 0.37;
        if (t <= 2) {
          tp.push(x1, y1 - 0.1, z1, x2, y2 - 0.1, z2, x2, y2 + h, z2, x1, y1 - 0.1, z1, x2, y2 + h, z2, x1, y1 + h, z1);
          ta.push(u1, -0.1, t, u2, -0.1, t, u2, h, t, u1, -0.1, t, u2, h, t, u1, h, t);
        } else {
          // kvádr: zeď / živý plot
          const th = THICK[t] / 2, dx = (z2 - z1) / (L / n) * th, dz = -(x2 - x1) / (L / n) * th;
          const c = t === 3 ? hedge : wall;
          const P = [[x1 + dx, z1 + dz, y1], [x2 + dx, z2 + dz, y2], [x2 - dx, z2 - dz, y2], [x1 - dx, z1 - dz, y1]];
          const v = (k, top) => [P[k][0], P[k][2] + (top ? h : -0.2), P[k][1]];
          const quad = (A, B, Cc, D) => { sp.push(...A, ...B, ...Cc, ...A, ...Cc, ...D); for (let i = 0; i < 6; i++) sc.push(c.r, c.g, c.b); };
          quad(v(0, 0), v(1, 0), v(1, 1), v(0, 1));
          quad(v(2, 0), v(3, 0), v(3, 1), v(2, 1));
          quad(v(0, 1), v(1, 1), v(2, 1), v(3, 1));
          quad(v(1, 0), v(2, 0), v(2, 1), v(1, 1));
          quad(v(3, 0), v(0, 0), v(0, 1), v(3, 1));
        }
      }
    }
    const grp = new THREE.Group();
    if (tp.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3));
      g.setAttribute('aF', new THREE.Float32BufferAttribute(ta, 3));
      g.computeVertexNormals();
      grp.add(new THREE.Mesh(g, thinMat));
    }
    if (sp.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, solidMat);
      m.castShadow = m.receiveShadow = true;
      grp.add(m);
    }
    grp.userData = { x0: cx * C - W / 2, z0: cz * C - H / 2 };
    grp.visible = false;
    return grp;
  }

  return {
    build(tile, group) {
      const n = world.T / C;
      tile.fenceChunks = [];
      for (let dz = 0; dz < n; dz++) {
        for (let dx = 0; dx < n; dx++) {
          const ch = buildChunk(tile.i * n + dx, tile.j * n + dz);
          if (ch) { group.add(ch); tile.fenceChunks.push(ch); }
        }
      }
    },
    lod(tile, cam, g) {
      let changed = false;
      for (const ch of tile.fenceChunks || []) {
        const d = world.distance(cam, ch.userData.x0, ch.userData.z0, C, g);
        const vis = ch.visible ? d < SHOW_D + 60 : d < SHOW_D;
        if (ch.visible !== vis) { ch.visible = vis; changed = true; }
      }
      return changed;
    },
  };
}
