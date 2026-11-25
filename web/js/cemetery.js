import * as THREE from 'three';

// Hřbitovy (data/cemetery.json z OSM): hroby v řadách podle delší osy hřbitova – obruba hrobu
// (kamenný rámeček), uvnitř štěrk nebo tráva, náhrobní kámen v čele (žula šedá / černá / červenohnědá,
// různá výška, některé s křížem). Mezi řadami ulička, hroby se vyhýbají cestám, budovám (kaple)
// a okraji (zeď). Židovský hřbitov: jen stojící kameny (macevy), bez obrub, nepravidelně.

const ROW = 3.4, COL = 1.45, EDGE = 2.5, PATH_GAP = 1.8;
const GRANITE = [0x4a4a4c, 0x2a2a2c, 0x6e6a66, 0x8a8680, 0x6b4a40, 0x5a5552, 0x9a968e].map((c) => new THREE.Color(c));
const SAND = [0xb8b2a6, 0x9c9890, 0x7a756e].map((c) => new THREE.Color(c));
const INSIDE = [0xc9c2b2, 0x8f8a80, 0x5f7f4a, 0x6c6a64].map((c) => new THREE.Color(c));

function inPoly(x, z, r) {
  let ins = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > z) !== (r[j][1] > z) && x < (r[j][0] - r[i][0]) * (z - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) ins = !ins;
  }
  return ins;
}
function distSeg(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
  return Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z);
}
const edgeDist = (x, z, r) => { let d = Infinity; for (let i = 0; i < r.length - 1; i++) d = Math.min(d, distSeg(x, z, r[i], r[i + 1])); return d; };

/** Delší osa obrysu (nejdelší hrana). */
function axis(r) {
  let best = 0, ux = 1, uz = 0;
  for (let i = 0; i < r.length - 1; i++) {
    const dx = r[i + 1][0] - r[i][0], dz = r[i + 1][1] - r[i][1], L = Math.hypot(dx, dz);
    if (L > best) { best = L; ux = dx / L; uz = dz / L; }
  }
  return [ux, uz];
}

export function createCemeteries({ cemeteries, roads, buildings, world }) {
  if (!cemeteries?.length) return () => {};
  // cesty a budovy u každého hřbitova (jen jednou)
  const items = cemeteries.map((c) => {
    const xs = c.p.map((q) => q[0]), zs = c.p.map((q) => q[1]);
    const box = [Math.min(...xs) - 5, Math.max(...xs) + 5, Math.min(...zs) - 5, Math.max(...zs) + 5];
    const inBox = (x, z) => x > box[0] && x < box[1] && z > box[2] && z < box[3];
    const segs = [];
    for (const r of roads) {
      if (r.t > 7) continue;
      for (let i = 0; i < r.p.length - 1; i++) if (inBox(...r.p[i]) || inBox(...r.p[i + 1])) segs.push([r.p[i], r.p[i + 1]]);
    }
    const blds = buildings.filter((b) => b.rings[0].some(([x, z]) => inBox(x, z))).map((b) => b.rings[0]);
    return { ...c, box, segs, blds, tile: world.tileAt((box[0] + box[1]) / 2, (box[2] + box[3]) / 2) };
  });

  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });   // barva z instance
  const unit = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  // kříž na náhrobku: svislé a vodorovné rameno (jednotkové, škáluje se celek)
  const crossGeo = (() => {
    const a = new THREE.BoxGeometry(0.06, 0.42, 0.06).translate(0, 0.21, 0);
    const b = new THREE.BoxGeometry(0.26, 0.06, 0.06).translate(0, 0.28, 0);
    const g = new THREE.BufferGeometry();
    const pos = [...a.toNonIndexed().attributes.position.array, ...b.toNonIndexed().attributes.position.array];
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  })();

  return function build(tile, group) {
    for (const c of items) {
      if (!c.tile || c.tile.i !== tile.i || c.tile.j !== tile.j) continue;
      const jewish = c.r === 'jewish';
      const [ux, uz] = axis(c.p), vx = -uz, vz = ux;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, z] of c.p) { const a = x * ux + z * uz, b = x * vx + z * vz; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
      let seed = Math.round(Math.abs(c.p[0][0] * 13 + c.p[0][1] * 7));
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
      const graves = [];
      for (let b = b0 + EDGE; b < b1 - EDGE; b += ROW) {
        for (let a = a0 + EDGE; a < a1 - EDGE; a += COL) {
          const ja = jewish ? (rnd() - 0.5) * 0.8 : 0, jb = jewish ? (rnd() - 0.5) * 1.2 : 0;
          const x = (a + ja) * ux + (b + jb) * vx, z = (a + ja) * uz + (b + jb) * vz;
          if (!inPoly(x, z, c.p) || edgeDist(x, z, c.p) < EDGE) continue;
          if (c.segs.some(([p, q]) => distSeg(x, z, p, q) < PATH_GAP + 1.2)) continue;
          if (c.blds.some((r) => inPoly(x, z, r) || edgeDist(x, z, r) < 2)) continue;
          if (rnd() < (jewish ? 0.35 : 0.12)) continue;           // tu a tam volné místo
          graves.push([x, z]);
        }
      }
      if (!graves.length) continue;
      const yaw = Math.atan2(-vz, vx);                          // místní osa x = osa b (délka hrobu), z = osa a
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const m = new THREE.Matrix4(), s = new THREE.Vector3(), p = new THREE.Vector3();
      const nFrame = jewish ? 0 : graves.length;
      const frame = new THREE.InstancedMesh(unit, mat, Math.max(1, nFrame));
      const fill = new THREE.InstancedMesh(unit, mat, Math.max(1, nFrame));
      const stone = new THREE.InstancedMesh(unit, mat, graves.length);
      const cross = new THREE.InstancedMesh(crossGeo, mat, graves.length);
      let nc = 0;
      graves.forEach(([x, z], i) => {
        const y = world.heightAt(x, z) + 0.02;
        const g = GRANITE[Math.floor(rnd() * GRANITE.length)];
        if (!jewish) {
          // obruba 1,0 × 2,1 m a výplň (štěrk / tráva / kamenná deska)
          frame.setMatrixAt(i, m.compose(p.set(x, y, z), q, s.set(2.1, 0.16, 1.0)));
          frame.setColorAt(i, rnd() < 0.6 ? g : SAND[Math.floor(rnd() * SAND.length)]);
          fill.setMatrixAt(i, m.compose(p.set(x, y + 0.01, z), q, s.set(1.92, 0.17, 0.82)));
          fill.setColorAt(i, rnd() < 0.35 ? g : INSIDE[Math.floor(rnd() * INSIDE.length)]);
        }
        // náhrobek v čele hrobu
        const h = jewish ? 0.6 + rnd() * 0.7 : 0.55 + rnd() * 0.6, w = jewish ? 0.5 + rnd() * 0.25 : 0.7 + rnd() * 0.25;
        const off = jewish ? 0 : -1.0;
        const sx = x + vx * off, sz = z + vz * off;
        const tilt = jewish ? new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.18, yaw + (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.1, 'YXZ')) : q;
        stone.setMatrixAt(i, m.compose(p.set(sx, y, sz), tilt, s.set(0.14, h, w)));
        stone.setColorAt(i, jewish ? SAND[Math.floor(rnd() * SAND.length)] : g);
        if (!jewish && rnd() < 0.25) {
          cross.setMatrixAt(nc, m.compose(p.set(sx, y + h, sz), q, s.set(1, 1, 1)));
          cross.setColorAt(nc, rnd() < 0.5 ? new THREE.Color(0x2a2a2c) : new THREE.Color(0xb39a5c));
          nc++;
        }
      });
      cross.count = nc;
      for (const im of nFrame ? [frame, fill, stone, cross] : [stone, cross]) {
        im.castShadow = im.receiveShadow = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.computeBoundingSphere();
        group.add(im);
      }
    }
  };
}
