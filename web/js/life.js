import * as THREE from 'three';
import { buildGraph, Track } from './traffic.js';
import { personParts, deerParts, hareParts, birdParts } from './models.js';

// Život v okolí kamery: lidé chodí po chodnících a pěšinách v obcích a čekají na zastávkách,
// srnky se pasou na okrajích lesa (a utečou, když se přiblížíte), zajíci skáčou po polích,
// nad krajinou létají hejna ptáků a krouží káně. Všechno jen do pár set metrů od místa pohledu.

const WIDTH = [8.5, 6.5, 5.0, 3.5, 3.2, 3.0, 2.6, 1.2, 4.2];
const WALK_TYPES = new Set([1, 2, 3, 4, 7]);
const C = (h) => new THREE.Color(h);
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const SHIRTS = [0x2f4e7a, 0xb13a32, 0xe2dccb, 0x3d6b45, 0x262a30, 0x8b5e9c, 0xd9a13a, 0x6d7b8a, 0xf0f0ee, 0x9c3f5d, 0x1f7a7a].map(C);
const PANTS = [0x2a3446, 0x30302f, 0x4b4f55, 0x5c4a3a, 0x1f2a44, 0x7a6a55].map(C);

function pool(scene, geo, cap, { color = false, shadow = true, both = false } = {}) {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: both ? THREE.DoubleSide : THREE.FrontSide });
  const im = new THREE.InstancedMesh(geo, mat, cap);
  im.frustumCulled = false;
  im.castShadow = shadow;
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < cap; i++) im.setMatrixAt(i, zero);
  if (color) im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
  scene.add(im);
  return { im, zero, hideFrom(n) { for (let i = n; i < cap; i++) im.setMatrixAt(i, zero); } };
}

export function createLife({ roads, bridges, buildings, world, scene, meta, treesBuf, stops, coarse }) {
  const group = new THREE.Group();
  scene.add(group);
  const heightAt = (x, z) => world.heightAt(x, z);
  const detailAt = (x, z) => !!world.tileAt(x, z)?.detail;

  // ---------------------------------------------------------- prostorové pomůcky
  const homes = new Map();                 // buňky 50 m → počet domů
  const bcell = new Map();                 // buňky 50 m → budovy (kvůli zvířatům)
  for (const b of buildings) {
    const p = b.rings[0][0], k = `${Math.floor(p[0] / 50)},${Math.floor(p[1] / 50)}`;
    bcell.set(k, (bcell.get(k) || 0) + 1);
    if (b.k === 'house' || b.k === 'flats' || b.k === 'civic') homes.set(k, (homes.get(k) || 0) + 1);
  }
  const around = (m, x, z, r = 1) => {
    let n = 0;
    const cx = Math.floor(x / 50), cz = Math.floor(z / 50);
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) n += m.get(`${cx + a},${cz + b}`) || 0;
    return n;
  };
  // stromy (stejný formát jako trees.js)
  const u16 = new Uint16Array(treesBuf), CH = meta.chunk, ncx = meta.width / CH, ncz = meta.height / CH;
  const treesNear = (x, z, R) => {
    const out = [];
    const c0 = Math.floor((x - R + meta.width / 2) / CH), c1 = Math.floor((x + R + meta.width / 2) / CH);
    const r0 = Math.floor((z - R + meta.height / 2) / CH), r1 = Math.floor((z + R + meta.height / 2) / CH);
    for (let cz = Math.max(0, r0); cz <= Math.min(ncz - 1, r1); cz++) {
      for (let cx = Math.max(0, c0); cx <= Math.min(ncx - 1, c1); cx++) {
        const k = cz * ncx + cx, a = meta.tree_chunks[k], b = meta.tree_chunks[k + 1];
        for (let i = a; i < b; i++) {
          const tx = u16[i * 4] * 0.2 - meta.width / 2, tz = u16[i * 4 + 1] * 0.2 - meta.height / 2;
          if (Math.abs(tx - x) < R && Math.abs(tz - z) < R) out.push([tx, tz]);
        }
      }
    }
    return out;
  };
  const roadG = buildGraph(roads, new Set([0, 1, 2, 3, 4, 5, 6]));
  const nearRoad = (x, z, d) => {
    const i = roadG.nearest(x, z, () => true, 1);
    return i >= 0 && Math.hypot(roadG.X[i] - x, roadG.Z[i] - z) < d;
  };

  // ---------------------------------------------------------- lidé
  const NP = coarse ? 24 : 55, NW = coarse ? 12 : 24;
  const parts = personParts();
  const torso = pool(group, parts.torso, NP + NW, { color: true });
  const head = pool(group, parts.head, NP + NW);
  const legs = pool(group, parts.leg, (NP + NW) * 2, { color: true });
  const walkG = buildGraph(roads, WALK_TYPES);
  const people = [];          // chodci
  const waiting = [];         // čekající na zastávkách
  const busStops = stops?.bus || [];
  const pm = new THREE.Matrix4(), pq = new THREE.Quaternion(), pp = new THREE.Vector3(), ps = new THREE.Vector3(1, 1, 1);
  const ax = new THREE.Vector3(0, 0, 1), up = new THREE.Vector3(0, 1, 0);
  const P = [0, 0, 0, 0, 0];

  function personColors(i, p) {
    p.shirt ||= rnd(SHIRTS); p.pants ||= rnd(PANTS);
    torso.im.setColorAt(i, p.shirt);
    const pc = p.pants;
    legs.im.setColorAt(i * 2, pc); legs.im.setColorAt(i * 2 + 1, pc);
    torso.im.instanceColor.needsUpdate = legs.im.instanceColor.needsUpdate = true;
  }
  function spawnWalker(fx, fz, camPos, minCam) {
    for (let tries = 0; tries < 20; tries++) {
      const x = fx + (Math.random() * 2 - 1) * 450, z = fz + (Math.random() * 2 - 1) * 450;
      if (around(homes, x, z) < 5) continue;
      const a = walkG.nearest(x, z, (i) => walkG.adj[i].length > 0, 1);
      if (a < 0) continue;
      const e = rnd(walkG.adj[a]);
      if (!detailAt(walkG.X[a], walkG.Z[a])) continue;
      if (camPos && Math.hypot(walkG.X[a] - camPos.x, walkG.Z[a] - camPos.z) < minCam) continue;
      const side = Math.random() < 0.5 ? 1 : -1;
      const off = (t) => (t === 7 ? 0.25 : WIDTH[t] / 2 + 0.8) * side;
      const tr = new Track();
      tr.push(walkG.X[a], walkG.Z[a], off(e.t), e.t);
      tr.push(walkG.X[e.to], walkG.Z[e.to], off(e.t), e.t);
      return { tr, s: Math.random() * tr.len, prev: a, node: e.to, side, off, v: 1.1 + Math.random() * 0.5, phase: Math.random() * 6, pause: 0 };
    }
    return null;
  }
  function extendWalker(p) {
    while (p.tr.len - p.s < 30) {
      const opts = walkG.adj[p.node].filter((e) => e.to !== p.prev && around(homes, walkG.X[e.to], walkG.Z[e.to]) >= 3);
      const e = opts.length ? rnd(opts) : walkG.adj[p.node].find((q) => q.to === p.prev);
      if (!e) return false;
      if (!opts.length) p.side = -p.side;           // slepá ulice: otočit a jít po druhé straně
      p.prev = p.node; p.node = e.to;
      p.tr.push(walkG.X[e.to], walkG.Z[e.to], p.off(e.t), e.t);
    }
    if (p.s > 200) { const d = p.tr.trim(p.s - 20); p.s -= d; }
    return true;
  }
  function setPerson(i, x, y, z, yaw, swing) {
    pq.setFromAxisAngle(up, yaw);
    pm.compose(pp.set(x, y, z), pq, ps);
    torso.im.setMatrixAt(i, pm); head.im.setMatrixAt(i, pm);
    for (const [k, sgn] of [[0, 1], [1, -1]]) {
      const lq = new THREE.Quaternion().setFromAxisAngle(ax, swing * sgn);
      const lm = new THREE.Matrix4().compose(new THREE.Vector3(0, 0.9, sgn * 0.1), lq, ps);
      legs.im.setMatrixAt(i * 2 + k, pm.clone().multiply(lm));
    }
  }

  // ---------------------------------------------------------- zvířata
  const ND = coarse ? 8 : 16, NH = coarse ? 5 : 10, NB = coarse ? 24 : 48;
  const dp = deerParts(), hp = hareParts(), bpS = birdParts(false), bpL = birdParts(true);
  const deerBody = pool(group, dp.body, ND), deerNeck = pool(group, dp.neck, ND), deerLeg = pool(group, dp.leg, ND * 4);
  const hareBody = pool(group, hp.body, NH, { shadow: false });
  const birdBody = pool(group, bpS.body, NB, { shadow: false }), birdWing = pool(group, bpS.wing, NB * 2, { shadow: false, both: true });
  const buzBody = pool(group, bpL.body, 2, { shadow: true }), buzWing = pool(group, bpL.wing, 4, { shadow: true, both: true });
  const deer = [], hares = [], flocks = [], buzzards = [];

  function openSpot(x, z, { trees = 22, build = 0 } = {}) {
    if (around(bcell, x, z, 1) > build) return false;
    if (nearRoad(x, z, 12)) return false;
    return treesNear(x, z, trees).length === 0;
  }
  function spawnDeerGroup(fx, fz, cam) {
    for (let tries = 0; tries < 30; tries++) {
      const x = fx + (Math.random() * 2 - 1) * 650, z = fz + (Math.random() * 2 - 1) * 650;
      if (!detailAt(x, z) || Math.hypot(x - cam.x, z - cam.z) < 120) continue;
      const tr = treesNear(x, z, 45);
      if (tr.length < 25 || !openSpot(x, z, { trees: 9 })) continue;     // u lesa, ale na volném místě
      if (around(bcell, x, z, 2) > 0) continue;
      // směr k lesu (útěk)
      let lx = 0, lz = 0;
      for (const [tx, tz] of tr) { lx += tx - x; lz += tz - z; }
      const l = Math.hypot(lx, lz) || 1;
      const n = 2 + Math.floor(Math.random() * 3);
      const out = [];
      for (let k = 0; k < n && deer.length + out.length < ND; k++) {
        out.push({ x: x + (Math.random() - 0.5) * 12, z: z + (Math.random() - 0.5) * 12, yaw: Math.random() * 6.28,
          state: 'graze', t: Math.random() * 6, v: 0, neck: 0, phase: Math.random() * 6, fx: lx / l, fz: lz / l, flee: false });
      }
      deer.push(...out);
      return true;
    }
    return false;
  }
  function spawnHare(fx, fz, cam) {
    for (let tries = 0; tries < 20; tries++) {
      const x = fx + (Math.random() * 2 - 1) * 450, z = fz + (Math.random() * 2 - 1) * 450;
      if (!detailAt(x, z) || Math.hypot(x - cam.x, z - cam.z) < 60) continue;
      if (!openSpot(x, z, { trees: 30, build: 0 }) || around(bcell, x, z, 2) > 0) continue;
      hares.push({ x, z, yaw: Math.random() * 6.28, hop: 0, t: Math.random() * 3, n: 0, flee: 0 });
      return true;
    }
    return false;
  }
  function spawnFlock(fx, fz) {
    const ang = Math.random() * 6.28, d = 500;
    const dir = ang + Math.PI + (Math.random() - 0.5) * 0.8;
    const n = 5 + Math.floor(Math.random() * 8);
    const cx = fx + Math.cos(ang) * d, cz = fz + Math.sin(ang) * d;
    const alt = 25 + Math.random() * 50;
    const birds = [];
    for (let k = 0; k < n; k++) birds.push({ ox: (Math.random() - 0.5) * 18, oz: (Math.random() - 0.5) * 18, oy: (Math.random() - 0.5) * 6, ph: Math.random() * 6 });
    flocks.push({ x: cx, z: cz, dir, v: 11 + Math.random() * 4, alt, birds, wob: Math.random() * 6 });
  }

  // ---------------------------------------------------------- aktualizace
  let showPeople = true, showAnimals = true, spawnT = 0, time = 0;
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), v3 = new THREE.Vector3(), s3 = new THREE.Vector3(1, 1, 1);

  function update(dt, focus, camera) {
    if (!showPeople && !showAnimals) return false;
    dt = Math.min(dt, 0.1);
    time += dt;
    const cam = camera.position;
    const camH = cam.y - heightAt(cam.x, cam.z);
    const near = camH < 900;
    spawnT -= dt;
    const spawn = spawnT <= 0 && near;
    if (spawn) spawnT = 0.4;

    // ---- lidé
    if (showPeople) {
      for (const p of [...people]) if (!near || Math.hypot(p.x - focus.x, p.z - focus.z) > 650) people.splice(people.indexOf(p), 1);
      if (spawn && people.length < NP) {
        const first = people.length < 3;
        for (let k = 0; k < (first ? 12 : 2); k++) {
          const p = spawnWalker(focus.x, focus.z, cam, first ? 0 : 120);
          if (p && people.length < NP) people.push(p);
        }
      }
      // čekající na zastávkách (do 400 m)
      for (const w of [...waiting]) if (!near || Math.hypot(w.x - focus.x, w.z - focus.z) > 500) waiting.splice(waiting.indexOf(w), 1);
      if (spawn && waiting.length < NW) {
        for (const b of busStops) {
          if (waiting.length >= NW) break;
          if (Math.hypot(b.x - focus.x, b.z - focus.z) > 400 || waiting.some((w) => w.stop === b)) continue;
          const n = Math.floor(Math.random() * 3) + (b.sh ? 1 : 0);
          for (let k = 0; k < n && waiting.length < NW; k++) {
            waiting.push({ stop: b, x: b.x + (Math.random() - 0.5) * 3, z: b.z + (Math.random() - 0.5) * 2, yaw: Math.random() * 6.28, ph: Math.random() * 6 });
          }
          if (!n) waiting.push({ stop: b, x: 0, z: 0, ghost: true });
        }
      }
      let i = 0;
      for (const p of people) {
        if (p.pause > 0) p.pause -= dt;
        else {
          p.s += p.v * dt;
          if (Math.random() < dt * 0.02) p.pause = 2 + Math.random() * 6;     // zastaví se, rozhlédne
        }
        if (!extendWalker(p)) { p.dead = true; continue; }
        p.tr.at(p.s, P);
        const x = P[0], z = P[1];
        const y = (bridges.at(x, z, 2, P[3], P[4]) ?? heightAt(x, z)) + 0.06;
        p.x = x; p.z = z;
        const yaw = Math.atan2(-P[4], P[3]);
        p.phase += dt * p.v * 5.2 * (p.pause > 0 ? 0 : 1);
        const swing = p.pause > 0 ? 0 : Math.sin(p.phase) * 0.42;
        personColorsOnce(p, i);
        if (detailAt(x, z)) setPerson(i, x, y, z, yaw, swing); else hidePerson(i);
        i++;
      }
      for (const w of waiting) {
        if (w.ghost) continue;
        personColorsOnce(w, i);
        const y = heightAt(w.x, w.z) + 0.02;
        w.ph += dt;
        setPerson(i, w.x, y, w.z, w.yaw + Math.sin(w.ph * 0.3) * 0.3, 0);
        i++;
      }
      for (let k = people.length - 1; k >= 0; k--) if (people[k].dead) people.splice(k, 1);
      for (let k = i; k < NP + NW; k++) hidePerson(k);
      torso.im.instanceMatrix.needsUpdate = head.im.instanceMatrix.needsUpdate = legs.im.instanceMatrix.needsUpdate = true;
    }

    // ---- zvířata
    if (showAnimals) {
      // srnky
      for (const d of [...deer]) if (!near || Math.hypot(d.x - focus.x, d.z - focus.z) > 900) deer.splice(deer.indexOf(d), 1);
      if (spawn && deer.length < ND - 2 && Math.random() < 0.3) spawnDeerGroup(focus.x, focus.z, cam);
      let di = 0;
      for (const d of deer) {
        const dc = Math.hypot(cam.x - d.x, cam.z - d.z, Math.max(0, camH - 3) * 0.5);
        if (dc < 45 && !d.flee) { d.flee = true; d.state = 'run'; d.yaw = Math.atan2(-d.fz, d.fx) + (Math.random() - 0.5) * 0.6; }
        d.t -= dt;
        if (!d.flee && d.t <= 0) {
          const r = Math.random();
          if (d.state === 'graze') { d.state = r < 0.5 ? 'look' : 'walk'; d.t = 2 + Math.random() * 4; if (d.state === 'walk') d.yaw += (Math.random() - 0.5) * 1.6; }
          else { d.state = 'graze'; d.t = 4 + Math.random() * 8; }
        }
        const speed = d.state === 'run' ? 9 : d.state === 'walk' ? 0.7 : 0;
        d.v += (speed - d.v) * Math.min(1, dt * 3);
        d.x += Math.cos(d.yaw) * d.v * dt;
        d.z -= Math.sin(d.yaw) * d.v * dt;
        if (d.flee && Math.hypot(cam.x - d.x, cam.z - d.z) > 260) d.gone = true;
        const neckWant = d.state === 'graze' ? -1.1 : d.state === 'run' ? 0.2 : 0;
        d.neck += (neckWant - d.neck) * Math.min(1, dt * 2.5);
        d.phase += dt * (1.5 + d.v * 2.2);
        const y = heightAt(d.x, d.z);
        q4.setFromAxisAngle(up, d.yaw);
        const bob = d.state === 'run' ? Math.abs(Math.sin(d.phase)) * 0.18 : 0;
        m4.compose(v3.set(d.x, y + bob, d.z), q4, s3);
        const show = detailAt(d.x, d.z);
        if (!show) { deerBody.im.setMatrixAt(di, deerBody.zero); deerNeck.im.setMatrixAt(di, deerBody.zero); for (let k = 0; k < 4; k++) deerLeg.im.setMatrixAt(di * 4 + k, deerBody.zero); di++; continue; }
        deerBody.im.setMatrixAt(di, m4);
        const nm = new THREE.Matrix4().compose(new THREE.Vector3(0.45, 1.05, 0), new THREE.Quaternion().setFromAxisAngle(ax, d.neck), s3);
        deerNeck.im.setMatrixAt(di, m4.clone().multiply(nm));
        const amp = d.v > 0.2 ? Math.min(0.7, 0.25 + d.v * 0.06) : 0;
        [[0.38, 0.11, 0], [0.38, -0.11, Math.PI], [-0.38, 0.11, Math.PI], [-0.38, -0.11, 0]].forEach(([lx, lz, ph], k) => {
          const lm = new THREE.Matrix4().compose(new THREE.Vector3(lx, 0.72, lz), new THREE.Quaternion().setFromAxisAngle(ax, Math.sin(d.phase + ph) * amp), s3);
          deerLeg.im.setMatrixAt(di * 4 + k, m4.clone().multiply(lm));
        });
        di++;
      }
      for (let k = deer.length - 1; k >= 0; k--) if (deer[k].gone) deer.splice(k, 1);
      deerBody.hideFrom(di); deerNeck.hideFrom(di); deerLeg.hideFrom(di * 4);
      deerBody.im.instanceMatrix.needsUpdate = deerNeck.im.instanceMatrix.needsUpdate = deerLeg.im.instanceMatrix.needsUpdate = true;

      // zajíci
      for (const h of [...hares]) if (!near || Math.hypot(h.x - focus.x, h.z - focus.z) > 600) hares.splice(hares.indexOf(h), 1);
      if (spawn && hares.length < NH && Math.random() < 0.4) spawnHare(focus.x, focus.z, cam);
      let hi = 0;
      for (const h of hares) {
        const dc = Math.hypot(cam.x - h.x, cam.z - h.z, Math.max(0, camH - 2) * 0.5);
        if (dc < 25 && h.flee <= 0) { h.flee = 4; h.yaw = Math.atan2(-(h.z - cam.z), h.x - cam.x); h.n = 12; h.t = 0; }
        if (h.flee > 0) h.flee -= dt;
        let lift = 0;
        if (h.hop > 0) {
          h.hop -= dt;
          const k = 1 - h.hop / (h.flee > 0 ? 0.28 : 0.38);
          const len = h.flee > 0 ? 2.6 : 1.0;
          h.x += Math.cos(h.yaw) * len * dt / (h.flee > 0 ? 0.28 : 0.38);
          h.z -= Math.sin(h.yaw) * len * dt / (h.flee > 0 ? 0.28 : 0.38);
          lift = Math.sin(Math.PI * Math.min(1, k)) * (h.flee > 0 ? 0.45 : 0.22);
        } else {
          h.t -= dt;
          if (h.t <= 0) {
            if (h.n > 0) { h.n--; h.hop = h.flee > 0 ? 0.28 : 0.38; h.t = h.flee > 0 ? 0.02 : 0.15; }
            else { h.n = 1 + Math.floor(Math.random() * 5); h.yaw += (Math.random() - 0.5) * 2; h.t = 1.5 + Math.random() * 5; }
          }
        }
        if (!detailAt(h.x, h.z)) { hareBody.im.setMatrixAt(hi++, hareBody.zero); continue; }
        q4.setFromAxisAngle(up, h.yaw);
        m4.compose(v3.set(h.x, heightAt(h.x, h.z) + lift, h.z), q4, s3);
        hareBody.im.setMatrixAt(hi++, m4);
      }
      hareBody.hideFrom(hi);
      hareBody.im.instanceMatrix.needsUpdate = true;

      // ptáci
      for (const f of [...flocks]) if (Math.hypot(f.x - focus.x, f.z - focus.z) > 900 || camH > 1500) flocks.splice(flocks.indexOf(f), 1);
      if (flocks.length < (coarse ? 2 : 4) && camH < 1500 && Math.random() < dt * 0.3) spawnFlock(focus.x, focus.z);
      let bi = 0;
      for (const f of flocks) {
        f.wob += dt * 0.4;
        f.dir += Math.sin(f.wob) * dt * 0.15;
        f.x += Math.cos(f.dir) * f.v * dt;
        f.z += Math.sin(f.dir) * f.v * dt;
        const g = heightAt(f.x, f.z);
        for (const b of f.birds) {
          if (bi >= NB) break;
          b.ph += dt * 13;
          const flap = Math.sin(b.ph) * 0.7;
          const yaw = -f.dir;
          q4.setFromAxisAngle(up, yaw);
          const ox = b.ox * Math.cos(f.dir) - b.oz * Math.sin(f.dir), oz = b.ox * Math.sin(f.dir) + b.oz * Math.cos(f.dir);
          m4.compose(v3.set(f.x + ox, g + f.alt + b.oy + Math.sin(b.ph * 0.15) * 0.8, f.z + oz), q4, s3);
          birdBody.im.setMatrixAt(bi, m4);
          for (const [k, sg] of [[0, 1], [1, -1]]) {
            const wm = new THREE.Matrix4().compose(new THREE.Vector3(0, 0, 0), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), flap * sg), new THREE.Vector3(1, 1, sg));
            birdWing.im.setMatrixAt(bi * 2 + k, m4.clone().multiply(wm));
          }
          bi++;
        }
      }
      birdBody.hideFrom(bi); birdWing.hideFrom(bi * 2);
      birdBody.im.instanceMatrix.needsUpdate = birdWing.im.instanceMatrix.needsUpdate = true;

      // káně: krouží nad loukami
      if (!buzzards.length && camH < 1200) buzzards.push({ cx: focus.x + (Math.random() - 0.5) * 300, cz: focus.z + (Math.random() - 0.5) * 300, r: 35 + Math.random() * 30, a: 0, alt: 70 + Math.random() * 40, ph: 0 });
      for (const b of [...buzzards]) if (Math.hypot(b.cx - focus.x, b.cz - focus.z) > 1000 || camH > 1500) buzzards.splice(buzzards.indexOf(b), 1);
      let zi = 0;
      for (const b of buzzards) {
        b.a += dt * 0.28; b.ph += dt;
        const x = b.cx + Math.cos(b.a) * b.r, z = b.cz + Math.sin(b.a) * b.r;
        const dir = b.a + Math.PI / 2;
        q4.setFromEuler(new THREE.Euler(0.25, -dir, 0, 'YXZ'));
        m4.compose(v3.set(x, heightAt(x, z) + b.alt, z), q4, s3);
        buzBody.im.setMatrixAt(zi, m4);
        const flap = (Math.sin(b.ph * 0.5) > 0.85 ? Math.sin(b.ph * 9) * 0.5 : 0.12);
        for (const [k, sg] of [[0, 1], [1, -1]]) {
          const wm = new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), flap * sg), new THREE.Vector3(1, 1, sg));
          buzWing.im.setMatrixAt(zi * 2 + k, m4.clone().multiply(wm));
        }
        zi++;
      }
      buzBody.hideFrom(zi); buzWing.hideFrom(zi * 2);
      buzBody.im.instanceMatrix.needsUpdate = buzWing.im.instanceMatrix.needsUpdate = true;
    }
    return people.length + deer.length + hares.length + flocks.length > 0;
  }

  function personColorsOnce(p, i) {
    if (p.slot === i) return;
    p.slot = i;
    personColors(i, p);
  }
  function hidePerson(i) {
    torso.im.setMatrixAt(i, torso.zero); head.im.setMatrixAt(i, torso.zero);
    legs.im.setMatrixAt(i * 2, torso.zero); legs.im.setMatrixAt(i * 2 + 1, torso.zero);
  }
  const peopleMeshes = [torso.im, head.im, legs.im];
  const animalMeshes = [deerBody.im, deerNeck.im, deerLeg.im, hareBody.im, birdBody.im, birdWing.im, buzBody.im, buzWing.im];
  return {
    group, update,
    setPeople(v) { showPeople = v; for (const m of peopleMeshes) m.visible = v; if (!v) { people.length = 0; waiting.length = 0; } },
    setAnimals(v) { showAnimals = v; for (const m of animalMeshes) m.visible = v; if (!v) { deer.length = 0; hares.length = 0; flocks.length = 0; buzzards.length = 0; } },
    get active() { return showPeople || showAnimals; },
    debug: { people, deer, hares, flocks, waiting },
  };
}
