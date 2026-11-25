import * as THREE from 'three';
import { NIGHT } from './night.js';

// Noční světla viditelná z dálky a z výšky (detailní osvětlení v nightglow.js / lamps.js je jen
// v dlaždicích zblízka): záře zástavby podle hustoty lamp a obydlených domů (mřížka 25 m, rozmazaná),
// světelný „smog“ nad městem a body světel lamp a oken. Zblízka (do ~600 m) se plynule ztrácí.

const CELL = 25;

export function createFarLights({ lamps, buildings, world }) {
  const group = new THREE.Group();
  const W = world.W, H = world.H, nx = Math.ceil(W / CELL) + 1, nz = Math.ceil(H / CELL) + 1;
  const grid = new Float32Array(nx * nz);
  const addAt = (x, z, w) => {
    const c = Math.round((x + W / 2) / CELL), r = Math.round((z + H / 2) / CELL);
    if (c >= 0 && r >= 0 && c < nx && r < nz) grid[r * nx + c] += w;
  };
  for (const [x, z] of lamps || []) addAt(x, z, 1);
  const homePts = [];
  let seed = 3;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (const b of buildings) {
    const w = b.k === 'flats' ? 0.9 : b.k === 'civic' ? 0.5 : b.k === 'house' ? 0.35 : 0;
    if (!w) continue;
    const r = b.rings[0];
    let cx = 0, cz = 0;
    for (const [x, z] of r) { cx += x; cz += z; }
    cx /= r.length; cz /= r.length;
    addAt(cx, cz, w);
    homePts.push([cx, cz, b.base + Math.min(b.eave, 8) * 0.6, rnd()]);
  }
  const blur = (src, n) => {
    let a = src;
    for (let k = 0; k < n; k++) {
      const b = new Float32Array(a.length);
      for (let r = 1; r < nz - 1; r++) {
        for (let c = 1; c < nx - 1; c++) {
          let s = 0;
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) s += a[(r + dr) * nx + c + dc];
          b[r * nx + c] = s / 9;
        }
      }
      a = b;
    }
    return a;
  };
  const ground = blur(grid, 1), haze = blur(grid, 6);

  const mat = (strength) => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -60,
    uniforms: { night: NIGHT.night, k: { value: strength } },
    vertexShader: `
      attribute float glow; varying float vG; varying vec3 vW;
      void main(){ vG = glow; vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform float night, k; varying float vG; varying vec3 vW;
      void main(){
        float fade = smoothstep(450., 1100., distance(vW, cameraPosition));
        float a = 1. - exp(-vG * .9);
        gl_FragColor = vec4(vec3(1., .74, .42) * a * k * night * fade, 1.);
      }`,
  });
  // síť jen v buňkách se světlem
  const sheet = (vals, lift, strength, min) => {
    const pos = [], gl = [], idx = [];
    const vid = new Int32Array(nx * nz).fill(-1);
    const vert = (r, c) => {
      const k = r * nx + c;
      if (vid[k] < 0) {
        const x = -W / 2 + c * CELL, z = -H / 2 + r * CELL;
        vid[k] = pos.length / 3;
        pos.push(x, world.farHeightAt(x, z) + lift, z);
        gl.push(vals[k]);
      }
      return vid[k];
    };
    for (let r = 0; r < nz - 1; r++) {
      for (let c = 0; c < nx - 1; c++) {
        const m = Math.max(vals[r * nx + c], vals[r * nx + c + 1], vals[(r + 1) * nx + c], vals[(r + 1) * nx + c + 1]);
        if (m < min) continue;
        const a = vert(r, c), b = vert(r, c + 1), d = vert(r + 1, c), e = vert(r + 1, c + 1);
        idx.push(a, d, b, b, d, e);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('glow', new THREE.Float32BufferAttribute(gl, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat(strength));
    m.renderOrder = 3;
    m.frustumCulled = false;
    group.add(m);
  };
  sheet(ground, 3, 0.8, 0.03);            // záře ulic a zástavby
  sheet(haze, 70, 0.15, 0.04);            // světelný opar nad městem

  // body světel: lampy (jasnější) a okna (podle podílu rozsvícených)
  const pts = [], att = [];
  for (const [x, z, ang] of lamps || []) {
    const hx = x + Math.cos(ang) * 1.35, hz = z + Math.sin(ang) * 1.35;
    pts.push(hx, world.farHeightAt(hx, hz) + 6.6, hz); att.push(1, -1);
  }
  for (const [x, z, y, h] of homePts) { pts.push(x, Math.max(y, world.farHeightAt(x, z)) + 2, z); att.push(0.55, h); }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  pg.setAttribute('a', new THREE.Float32BufferAttribute(att, 2));
  const pm = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { night: NIGHT.night, lit: NIGHT.litFrac },
    vertexShader: `
      attribute vec2 a; uniform float lit; varying float vB; varying float vF;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.);
        float d = -mv.z;
        float on = a.y < 0. ? 1. : step(a.y, lit * 1.3);
        vB = a.x * on;
        vF = smoothstep(350., 900., d);
        gl_PointSize = clamp(2600. / d, 1.6, 7.) * (a.y < 0. ? 1. : .75);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float night; varying float vB; varying float vF;
      void main(){ float r = length(gl_PointCoord - .5) * 2.; float a = pow(max(0., 1. - r), 1.6);
        gl_FragColor = vec4(vec3(1., .82, .55) * a * vB * vF * night * 1.2, 1.); }`,
  });
  const points = new THREE.Points(pg, pm);
  points.frustumCulled = false;
  points.renderOrder = 4;
  group.add(points);
  return group;
}
