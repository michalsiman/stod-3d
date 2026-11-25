import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Směrové sloupky (patníky) podél silnic mimo obce: bílý sloupek s černým pruhem, z pohledu řidiče
// vpravo oranžová obdélníková odrazka, vlevo dvě bílé kulaté. Po 50 m, v obloucích hustěji;
// ne v obci (budovy do 70 m), na mostech (zábradlí) a u křižovatek.
const ROAD_TYPES = [0, 1];                       // silnice I. a II./III. třídy
const WIDTH = [8.5, 6.5];
const STEP = 50, STEP_CURVE = 25, NEAR_BUILDING = 70, NEAR_JUNCTION = 18;

let bodyGeo, reflGeo, bodyMat, reflMat;
function shared() {
  if (bodyGeo) return;
  const col = (g, c) => {
    g.deleteAttribute('uv');
    const n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g.toNonIndexed();
  };
  const white = new THREE.Color(0xf2f2ee), black = new THREE.Color(0x1c1c1c);
  // sloupek 1,2 m nad terénem (+0,3 m do země kvůli nerovnostem), lehce zúžený
  const body = new THREE.CylinderGeometry(0.06, 0.075, 1.05, 4, 1).rotateY(Math.PI / 4).translate(0, 0.225, 0);
  const band = new THREE.CylinderGeometry(0.062, 0.062, 0.25, 4, 1).rotateY(Math.PI / 4).translate(0, 0.875, 0);
  const cap = new THREE.ConeGeometry(0.062, 0.08, 4, 1).rotateY(Math.PI / 4).translate(0, 1.04, 0);
  bodyGeo = mergeGeometries([col(body, white), col(band, black), col(cap, white)]);
  bodyGeo.computeVertexNormals();
  // odrazky na černém pruhu: +z oranžová (vpravo), −z dvě bílé (vlevo)
  const orange = new THREE.Color(0xff8a1c), refl = new THREE.Color(0xf4f4f0);
  const o = new THREE.PlaneGeometry(0.045, 0.16).translate(0, 0.875, 0.046);
  const w1 = new THREE.CircleGeometry(0.022, 8).rotateY(Math.PI).translate(0, 0.92, -0.046);
  const w2 = new THREE.CircleGeometry(0.022, 8).rotateY(Math.PI).translate(0, 0.83, -0.046);
  reflGeo = mergeGeometries([col(o, orange), col(w1, refl), col(w2, refl)]);
  bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  // odrazky svítí samy (v noci je vidět jejich řada podél silnice)
  reflMat = new THREE.MeshBasicMaterial({ vertexColors: true });
}

export function createPosts({ roads, buildings, bridges, world }) {
  shared();
  const W = world.W, H = world.H, T = world.T;
  // obec = blízko budov: mřížka 35 m s budovami (rohy půdorysů)
  const C = 35, built = new Set();
  for (const b of buildings) for (const [x, z] of b.rings[0]) built.add(`${Math.floor(x / C)},${Math.floor(z / C)}`);
  const r = Math.ceil(NEAR_BUILDING / C);
  const inVillage = (x, z) => {
    const cx = Math.floor(x / C), cz = Math.floor(z / C);
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      if (built.has(`${cx + i},${cz + j}`) && Math.hypot(i * C, j * C) <= NEAR_BUILDING + C) return true;
    }
    return false;
  };
  // křižovatky: konce úseků, kde se nesbíhají právě dva úseky (pokračování silnice)
  const deg = new Map();
  const key = ([x, z]) => `${Math.round(x)},${Math.round(z)}`;
  for (const rd of roads) {
    if (rd.t > 6 || rd.p.length < 2) continue;
    for (const p of [rd.p[0], rd.p[rd.p.length - 1]]) {
      const k = key(p);
      const e = deg.get(k) || { p, n: 0 };
      e.n++; deg.set(k, e);
    }
  }
  const junctions = [...deg.values()].filter((e) => e.n !== 2).map((e) => e.p);
  const JC = 64, jgrid = new Map();
  for (const p of junctions) {
    const k = `${Math.floor(p[0] / JC)},${Math.floor(p[1] / JC)}`;
    if (!jgrid.has(k)) jgrid.set(k, []);
    jgrid.get(k).push(p);
  }
  const nearJunction = (x, z) => {
    const cx = Math.floor(x / JC), cz = Math.floor(z / JC);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const p of jgrid.get(`${cx + i},${cz + j}`) || []) if (Math.hypot(p[0] - x, p[1] - z) < NEAR_JUNCTION) return true;
    }
    return false;
  };

  // rozmístění: [x, z, směr oranžové odrazky (yaw)] po dlaždicích
  const perTile = new Map();
  for (const rd of roads) {
    const ti = ROAD_TYPES.indexOf(rd.t);
    if (ti < 0) continue;
    const off = WIDTH[ti] / 2 + 0.7;
    const p = rd.p;
    let next = STEP / 2, s = 0;
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.01) continue;
      const dx = (bx - ax) / L, dz = (bz - az) / L;
      // oblouk: změna směru k dalšímu úseku
      let curve = false;
      if (i + 2 < p.length) {
        const [cx, cz] = p[i + 2], L2 = Math.hypot(cx - bx, cz - bz) || 1;
        curve = (dx * (cx - bx) + dz * (cz - bz)) / L2 < 0.985;
      }
      while (next <= s + L) {
        const t = next - s, x = ax + dx * t, z = az + dz * t;
        next += curve ? STEP_CURVE : STEP;
        if (inVillage(x, z) || nearJunction(x, z) || bridges.at(x, z, 8) !== null) continue;
        const rx = -dz, rz = dx;                 // vpravo ve směru úseku
        for (const side of [1, -1]) {
          const px = x + rx * off * side, pz = z + rz * off * side;
          // vpravo (side 1): oranžová k protijedoucím ve směru d, tj. proti směru (−d); vlevo naopak
          const fx = -dx * side, fz = -dz * side;
          const k = `${Math.floor((px + W / 2) / T)}_${Math.floor((pz + H / 2) / T)}`;
          if (!perTile.has(k)) perTile.set(k, []);
          perTile.get(k).push([px, pz, Math.atan2(fx, fz)]);
        }
      }
      s += L;
    }
  }

  const q = new THREE.Quaternion(), m = new THREE.Matrix4(), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
  return function build(tile, group) {
    const list = perTile.get(`${tile.i}_${tile.j}`);
    if (!list) return;
    const body = new THREE.InstancedMesh(bodyGeo, bodyMat, list.length);
    const refl = new THREE.InstancedMesh(reflGeo, reflMat, list.length);
    list.forEach(([x, z, yaw], i) => {
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
      m.compose(v.set(x, world.heightAt(x, z) - 0.05, z), q, one);
      body.setMatrixAt(i, m);
      refl.setMatrixAt(i, m);
    });
    body.castShadow = true;
    body.computeBoundingSphere();
    refl.computeBoundingSphere();
    group.add(body, refl);
  };
}
