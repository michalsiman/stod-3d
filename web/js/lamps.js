import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { NIGHT } from './night.js';

// Pouliční lampy: sloup s ramenem, v noci svítící hlava, záře a světlý kruh na zemi.
// Kreslí se s detailem dlaždice (do ~700 m). Svit řídí NIGHT.night (sun.js).

const H = 7;
let geo, poleMat, headMat, poolMat, glowMat;

function shared() {
  if (geo) return;
  const pole = new THREE.CylinderGeometry(0.07, 0.11, H, 6).translate(0, H / 2, 0);
  const arm = new THREE.BoxGeometry(1.4, 0.08, 0.08).translate(0.7, H - 0.15, 0);
  const g = mergeGeometries([pole, arm].map((x) => { x.deleteAttribute('uv'); return x.toNonIndexed(); }));
  g.computeVertexNormals();
  geo = {
    pole: g,
    head: new THREE.BoxGeometry(0.55, 0.14, 0.28).translate(1.35, H - 0.26, 0),
    pool: new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2),
  };
  poleMat = new THREE.MeshLambertMaterial({ color: 0x5a5f63 });
  headMat = new THREE.MeshLambertMaterial({ color: 0x3a3d40, emissive: 0xffc77a, emissiveIntensity: 0 });
  // světelný kruh na zemi: radiální přechod, sčítání barev
  poolMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
    uniforms: { night: NIGHT.night },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xz; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.); }',
    fragmentShader: 'uniform float night; varying vec2 vUv; void main(){ float r = length(vUv); float a = (1. - smoothstep(0., 1., r)); gl_FragColor = vec4(vec3(1., .78, .45) * a * a * .55 * night, 1.); }',
  });
  // záře kolem hlavy lampy (body s přechodem, velikost podle vzdálenosti)
  glowMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { night: NIGHT.night, scale: { value: 900 } },
    vertexShader: 'uniform float scale; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.); gl_PointSize = scale * 2.2 / -mv.z; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform float night; void main(){ float r = length(gl_PointCoord - .5) * 2.; float a = pow(max(0., 1. - r), 2.5); gl_FragColor = vec4(vec3(1., .82, .55) * a * night, 1.); }',
  });
}

/** Volat po změně času – rozsvítí / zhasne hlavy lamp. */
export function updateLamps() {
  if (headMat) headMat.emissiveIntensity = NIGHT.night.value * 2.5;
}

export function createLamps({ lamps, world }) {
  shared();
  const per = new Map();
  for (const l of lamps) {
    const t = world.tileAt(l[0], l[1]);
    if (!t) continue;
    const k = `${t.i}_${t.j}`;
    if (!per.has(k)) per.set(k, []);
    per.get(k).push(l);
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0);

  return function build(tile, group) {
    const list = per.get(`${tile.i}_${tile.j}`);
    if (!list) return;
    const n = list.length;
    const poles = new THREE.InstancedMesh(geo.pole, poleMat, n);
    const heads = new THREE.InstancedMesh(geo.head, headMat, n);
    const pools = new THREE.InstancedMesh(geo.pool, poolMat, n);
    const glow = new Float32Array(n * 3);
    list.forEach(([x, z, ang], i) => {
      const g = world.heightAt(x, z);
      q.setFromAxisAngle(up, -ang);
      m.compose(p.set(x, g - 0.2, z), q, s.set(1, 1, 1));
      poles.setMatrixAt(i, m);
      heads.setMatrixAt(i, m);
      // hlava je 1,35 m od sloupu ve směru ramene
      const hx = x + Math.cos(ang) * 1.35, hz = z + Math.sin(ang) * 1.35;
      glow.set([hx, g + H - 0.35, hz], i * 3);
      m.compose(p.set(hx, world.heightAt(hx, hz) + 0.15, hz), q.identity(), s.set(8, 1, 8));
      pools.setMatrixAt(i, m);
    });
    poles.castShadow = true;
    for (const im of [poles, heads, pools]) im.computeBoundingSphere();
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(glow, 3));
    const pts = new THREE.Points(pg, glowMat);
    pools.renderOrder = 1;
    pts.renderOrder = 2;
    group.add(poles, heads, pools, pts);
    // v noci viditelné, ve dne skryté (ať nestojí výkon)
    pools.userData.nightOnly = pts.userData.nightOnly = true;
  };
}
