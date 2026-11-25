import * as THREE from 'three';
import { NIGHT } from './night.js';

// Noční osvětlení okolí: teplé kruhy světla pod lampami (16 m) a slabší záře kolem domů
// s rozsvícenými okny. Plochy kopírují terén a leží nad vozovkou i chodníkem (sčítání barev),
// takže se v noci rozsvítí ulice. Podíl svítících domů sleduje NIGHT.litFrac (jako okna).

const LIFT = 0.5;                       // nad vozovkou (0,34) i chodníkem (0,46)
const RINGS = 5, SEG = 20;

let mat;
function material() {
  if (mat) return mat;
  mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -40,
    uniforms: { night: NIGHT.night, lit: NIGHT.litFrac },
    vertexShader: `
      attribute vec3 glow;          // r (0 střed … 1 okraj), síla, los (domy: svítí, když los < podíl)
      varying vec3 vG;
      void main(){ vG = glow; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: `
      uniform float night, lit; varying vec3 vG;
      void main(){
        float a = 1. - smoothstep(0., 1., vG.x);
        float on = vG.z < 0. ? 1. : step(vG.z, lit * 1.4);
        gl_FragColor = vec4(vec3(1., .78, .46) * a * a * vG.y * night * on, 1.);
      }`,
  });
  return mat;
}

export function createNightGlow({ lamps, buildings, world, spots = [] }) {
  material();
  const per = new Map();
  const add = (x, z, item) => {
    const t = world.tileAt(x, z);
    if (!t) return;
    const k = `${t.i}_${t.j}`;
    if (!per.has(k)) per.set(k, []);
    per.get(k).push(item);
  };
  const H = 7;
  for (const [x, z, ang] of lamps || []) {
    const hx = x + Math.cos(ang) * 1.35, hz = z + Math.sin(ang) * 1.35;
    add(hx, hz, [hx, hz, 16, 0.85, -1]);
    void H;
  }
  for (const { at: [x, z], r, k } of spots) add(x, z, [x, z, r, k, -1]);   // nasvícené stavby
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (const b of buildings) {
    if (b.k !== 'house' && b.k !== 'flats' && b.k !== 'civic') continue;
    const r = b.rings[0];
    let cx = 0, cz = 0;
    for (const [x, z] of r) { cx += x; cz += z; }
    cx /= r.length; cz /= r.length;
    let rad = 0;
    for (const [x, z] of r) rad = Math.max(rad, Math.hypot(x - cx, z - cz));
    const strength = b.k === 'flats' ? 0.42 : 0.3;
    add(cx, cz, [cx, cz, rad + 7, strength, rnd()]);
  }

  return function build(tile, group) {
    const list = per.get(`${tile.i}_${tile.j}`);
    if (!list) return;
    const pos = [], gl = [], idx = [];
    for (const [cx, cz, R, s, h] of list) {
      const base = pos.length / 3;
      pos.push(cx, world.heightAt(cx, cz) + LIFT, cz);
      gl.push(0, s, h);
      for (let k = 1; k <= RINGS; k++) {
        const rr = (k / RINGS) * R;
        for (let j = 0; j < SEG; j++) {
          const a = (j / SEG) * Math.PI * 2, x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
          pos.push(x, world.heightAt(x, z) + LIFT, z);
          gl.push(k / RINGS, s, h);
        }
      }
      for (let j = 0; j < SEG; j++) idx.push(base, base + 1 + j, base + 1 + (j + 1) % SEG);
      for (let k = 1; k < RINGS; k++) {
        const r0 = base + 1 + (k - 1) * SEG, r1 = base + 1 + k * SEG;
        for (let j = 0; j < SEG; j++) {
          const j1 = (j + 1) % SEG;
          idx.push(r0 + j, r1 + j, r1 + j1, r0 + j, r1 + j1, r0 + j1);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('glow', new THREE.Float32BufferAttribute(gl, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.renderOrder = 1;
    m.userData.nightOnly = true;
    group.add(m);
  };
}
