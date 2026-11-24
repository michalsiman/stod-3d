import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Venkovní vedení VN: betonové sloupy ~11 m s konzolí, tři vodiče s průvěsem.
const POLE_H = 11;
const ARM = 1.2;

let poleGeo, poleMat, wireMat;
function shared() {
  if (poleGeo) return;
  const pole = new THREE.CylinderGeometry(0.12, 0.2, POLE_H, 6).translate(0, POLE_H / 2, 0);
  const arm = new THREE.BoxGeometry(ARM * 2 + 0.2, 0.12, 0.12).translate(0, POLE_H - 0.6, 0);
  const ins = [-ARM, 0, ARM].map((x) => new THREE.CylinderGeometry(0.05, 0.05, 0.35, 5)
    .translate(x, POLE_H - 0.6 + 0.2 + (x === 0 ? 0.5 : 0), 0));
  const top = new THREE.CylinderGeometry(0.06, 0.06, 0.6, 5).translate(0, POLE_H + 0.1, 0);
  poleGeo = mergeGeometries([pole, arm, ...ins, top].map((g) => { g.deleteAttribute('uv'); return g.toNonIndexed(); }));
  poleGeo.computeVertexNormals();
  poleMat = new THREE.MeshLambertMaterial({ color: 0xa8a6a0 });
  wireMat = new THREE.LineBasicMaterial({ color: 0x3a3d40, transparent: true, opacity: 0.45 });
}

export function createPower({ power, world }) {
  shared();
  const W = world.W, H = world.H, T = world.T;
  const perTile = new Map();
  for (const line of power) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const key = `${Math.floor((a[0] + W / 2) / T)}_${Math.floor((a[1] + H / 2) / T)}`;
      if (!perTile.has(key)) perTile.set(key, []);
      // směr ramene: kolmo na průměrný směr vedení v bodě
      const prev = line[Math.max(0, i - 1)], next = line[i + 1];
      perTile.get(key).push({ a, b: next, prev, last: i === line.length - 2, after: line[Math.min(line.length - 1, i + 2)] });
    }
  }

  const q = new THREE.Quaternion(), m = new THREE.Matrix4(), one = new THREE.Vector3(1, 1, 1);
  const yawAt = (p, n1, n2) => Math.atan2(-(n2[1] - n1[1]), n2[0] - n1[0]) + Math.PI / 2;

  return function build(tile, group) {
    const list = perTile.get(`${tile.i}_${tile.j}`);
    if (!list) return;
    const poles = [], wires = [];
    const armOffset = (yaw) => [Math.cos(yaw), -Math.sin(yaw)];
    for (const { a, b, prev, last, after } of list) {
      const ya = yawAt(a, prev, b), yb = yawAt(b, a, after);
      const ha = world.heightAt(a[0], a[1]), hb = world.heightAt(b[0], b[1]);
      poles.push([a, ha, ya]);
      if (last) poles.push([b, hb, yb]);
      const [ax, az] = armOffset(ya), [bx, bz] = armOffset(yb);
      const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const sag = Math.min(2.5, span * 0.012);
      for (const k of [-1, 0, 1]) {
        const lift = POLE_H - 0.6 + 0.4 + (k === 0 ? 0.5 : 0);
        const p0 = [a[0] + ax * ARM * k, ha + lift, a[1] + az * ARM * k];
        const p1 = [b[0] + bx * ARM * k, hb + lift, b[1] + bz * ARM * k];
        const N = 10;
        for (let s = 0; s < N; s++) {
          for (const t of [s / N, (s + 1) / N]) {
            wires.push(p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t - sag * 4 * t * (1 - t), p0[2] + (p1[2] - p0[2]) * t);
          }
        }
      }
    }
    const im = new THREE.InstancedMesh(poleGeo, poleMat, poles.length);
    poles.forEach(([p, h, yaw], i) => {
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
      im.setMatrixAt(i, m.compose(new THREE.Vector3(p[0], h - 0.3, p[1]), q, one));
    });
    im.castShadow = true;
    im.computeBoundingSphere();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
    group.add(im, new THREE.LineSegments(g, wireMat));
  };
}
