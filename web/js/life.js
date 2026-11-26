import * as THREE from 'three';
import { buildGraph, Track } from './traffic.js';
import { personParts, deerParts, hareParts, birdParts, cyclistParts, cowParts } from './models.js';
import { SIDEWALK_TOP } from './sidewalks.js';

// Život v okolí kamery: lidé chodí po chodnících a pěšinách v obcích a čekají na zastávkách,
// srnky se pasou na okrajích lesa (a utečou, když se přiblížíte), zajíci skáčou po polích,
// nad krajinou létají hejna ptáků a krouží káně. Všechno jen do pár set metrů od místa pohledu.

const WIDTH = [8.5, 6.5, 5.0, 3.5, 3.2, 3.0, 2.6, 1.2, 4.2, 2.8];
const LIFT = [0.34, 0.34, 0.34, 0.34, 0.31, 0.3, 0.29, 0.28, 0.36, 0.32];
const WALK_TYPES = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
const C = (h) => new THREE.Color(h);
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const SHIRTS = [0x2f4e7a, 0xb13a32, 0xe2dccb, 0x3d6b45, 0x262a30, 0x8b5e9c, 0xd9a13a, 0x6d7b8a, 0xf0f0ee, 0x9c3f5d, 0x1f7a7a].map(C);
const PANTS = [0x2a3446, 0x30302f, 0x4b4f55, 0x5c4a3a, 0x1f2a44, 0x7a6a55].map(C);

function pool(scene, geo, cap, { color = false, shadow = true, both = false } = {}) {
  // stejný posun hloubky jako silnice (roads.js), jinak silnice zakrývá spodek kol / chodidla
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: both ? THREE.DoubleSide : THREE.FrontSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16 });
  const im = new THREE.InstancedMesh(geo, mat, cap);
  im.frustumCulled = false;
  im.castShadow = shadow;
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < cap; i++) im.setMatrixAt(i, zero);
  if (color) im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
  scene.add(im);
  return { im, zero, hideFrom(n) { for (let i = n; i < cap; i++) im.setMatrixAt(i, zero); } };
}

export function createLife({ roads, bridges, buildings, world, scene, meta, treesBuf, stops, bike, sidewalks, coarse }) {
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
  const NP = coarse ? 55 : 130, NW = coarse ? 14 : 28, CAP = NP + NW + 16;   // +16 utíkající řidiči (Demolice)
  const parts = personParts();
  const torso = pool(group, parts.torso, CAP, { color: true });
  const head = pool(group, parts.head, CAP);
  const legs = pool(group, parts.leg, (CAP) * 2, { color: true });
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
  // kde chodí nejvíc lidí: náměstí, cesta z náměstí na nádraží (Nádražní), nádraží, bytovky
  const HOT = [[-140, -1012, 90, 3], [-222, -1069, 70, 2], [-880, -1205, 90, 2.5]];
  for (let k = 0; k <= 6; k++) {
    const t = k / 6;
    HOT.push([-200 + (-860 + 200) * t, -1060 + (-1200 + 1060) * t, 45, 1.4]);
  }
  for (const b of buildings) {
    if (b.k !== 'flats') continue;
    const r = b.rings[0];
    const cx = r.reduce((a, p) => a + p[0], 0) / r.length, cz = r.reduce((a, p) => a + p[1], 0) / r.length;
    HOT.push([cx, cz, 45, Math.hypot(cx + 880, cz + 1205) < 600 ? 1.0 : 0.4]);
  }
  function hotPoint(fx, fz) {
    const near = HOT.filter(([x, z]) => Math.hypot(x - fx, z - fz) < 650);
    const sum = near.reduce((a, h) => a + h[3], 0);
    if (!sum) return null;
    let r = Math.random() * sum;
    for (const h of near) {
      r -= h[3];
      if (r <= 0) { const a = Math.random() * 6.28, d = Math.sqrt(Math.random()) * h[2]; return [h[0] + Math.cos(a) * d, h[1] + Math.sin(a) * d]; }
    }
    return null;
  }
  // chodci jen po chodnících (u vozovek) a po pěšinách / polních cestách; po silnici nikdy
  const walkOff = (t) => (t === 7 ? 0.25 : t <= 3 ? WIDTH[t] / 2 + 1.1 : WIDTH[t] / 2 - 0.45);
  /** Strana (1 vpravo, −1 vlevo ve směru a→b), kde se dá jít, nebo 0. */
  function walkSide(a, e, pref) {
    if (e.t >= 4) return pref;
    if (!sidewalks) return 0;
    const ax = walkG.X[a], az = walkG.Z[a], bx = walkG.X[e.to], bz = walkG.Z[e.to];
    if (bridges.at((ax + bx) / 2, (az + bz) / 2, WIDTH[e.t], bx - ax, bz - az) !== null) return pref;   // po chodníku mostu
    const L = Math.hypot(bx - ax, bz - az) || 1, nx = -(bz - az) / L, nz = (bx - ax) / L, o = walkOff(e.t);
    for (const sd of [pref, -pref]) {
      let ok = true;
      const k = Math.max(2, Math.ceil(L / 3));
      for (let q = 1; q < k; q++) {
        const f = q / k, x = ax + (bx - ax) * f + nx * o * sd, z = az + (bz - az) * f + nz * o * sd;
        if (!sidewalks.at(x, z) || sidewalks.onRoad(x, z)) { ok = false; break; }
      }
      if (ok) return sd;
    }
    return 0;
  }
  function spawnWalker(fx, fz, camPos, minCam) {
    for (let tries = 0; tries < 25; tries++) {
      const hp = Math.random() < 0.7 ? hotPoint(fx, fz) : null;
      const x = hp ? hp[0] : fx + (Math.random() * 2 - 1) * 450, z = hp ? hp[1] : fz + (Math.random() * 2 - 1) * 450;
      if (!hp && around(homes, x, z) < 5) continue;
      const a = walkG.nearest(x, z, (i) => walkG.adj[i].length > 0, 1);
      if (a < 0) continue;
      const e = rnd(walkG.adj[a]);
      if (!detailAt(walkG.X[a], walkG.Z[a])) continue;
      if (camPos && Math.hypot(walkG.X[a] - camPos.x, walkG.Z[a] - camPos.z) < minCam) continue;
      const side = walkSide(a, e, Math.random() < 0.5 ? 1 : -1);
      if (!side) continue;
      const tr = new Track();
      tr.push(walkG.X[a], walkG.Z[a], walkOff(e.t) * side, e.t);
      tr.push(walkG.X[e.to], walkG.Z[e.to], walkOff(e.t) * side, e.t);
      if (tr.len < 10) continue;
      return { tr, s: Math.random() * (tr.len - 8), prev: a, node: e.to, side, v: 1.1 + Math.random() * 0.5, phase: Math.random() * 6, pause: 0 };
    }
    return null;
  }
  function extendWalker(p) {
    while (p.tr.len - p.s < 30) {
      // přejít na druhou stranu jde jen tam, kde se dá vložit krátký přechod u křižovatky
      const n0 = p.tr.n, lastL = n0 >= 2 ? p.tr.cum[n0 - 1] - p.tr.cum[n0 - 2] : 0;
      const canCross = (e) => n0 >= 2 && p.s < p.tr.cum[n0 - 1] - 4 && lastL > 5
        && Math.hypot(walkG.X[e.to] - walkG.X[p.node], walkG.Z[e.to] - walkG.Z[p.node]) > 5;
      const opts = [];
      for (const e of walkG.adj[p.node]) {
        if (e.to === p.prev) continue;
        const sd = walkSide(p.node, e, p.side);
        if (sd && (sd === p.side || canCross(e))) opts.push([e, sd]);
      }
      let pick = opts.length ? rnd(opts) : null;
      if (!pick) {                                  // slepý konec chodníku: otočit (zůstat na stejném chodníku)
        const back = walkG.adj[p.node].find((q) => q.to === p.prev);
        const sd = back && walkSide(p.node, back, -p.side);
        if (!sd || (sd !== -p.side && !canCross(back))) return false;
        pick = [back, sd];
      }
      const [e, sd] = pick;
      const tr = p.tr, n = tr.n;
      const sameWalk = e.to === p.prev ? sd === -p.side : sd === p.side;
      if (!sameWalk && n >= 2 && p.s < tr.cum[n - 1] - 4) {
        // přejít na druhou stranu krátce u křižovatky (jako po přechodu), ne šikmo přes celý úsek
        const [px, pz] = tr.P[n - 2], [nx, nz] = tr.P[n - 1], L = Math.hypot(nx - px, nz - pz);
        const bx = walkG.X[e.to], bz = walkG.Z[e.to], M = Math.hypot(bx - nx, bz - nz);
        if (L > 5 && M > 5) {
          const oldO = tr.o[n - 2], oldT = tr.t[n - 2];
          tr.pop();
          tr.push(nx - (nx - px) / L * 2.5, nz - (nz - pz) / L * 2.5, oldO, oldT, oldO);
          tr.push(nx + (bx - nx) / M * 2.5, nz + (bz - nz) / M * 2.5, walkOff(e.t) * sd, e.t, walkOff(e.t) * sd);
        }
      }
      p.side = sd;
      p.prev = p.node; p.node = e.to;
      p.tr.push(walkG.X[e.to], walkG.Z[e.to], walkOff(e.t) * sd, e.t);
    }
    if (p.s > 200) { const d = p.tr.trim(p.s - 20); p.s -= d; }
    return true;
  }
  // sražený chodec (režim GTA): odletí, otočí se a zůstane ležet trochu „zmačkaný“
  const tq = new THREE.Quaternion(), dsc = new THREE.Vector3(1.25, 0.85, 1.2), xAx = new THREE.Vector3(1, 0, 0);
  function knockOne(p, x, y, z, yaw, hx, hz, speed) {
    const k = Math.min(1, speed / 14);
    p.down = { x, y, z, yaw, tilt: 0, vx: hx * speed * 0.55, vz: hz * speed * 0.55, vy: 2.5 + 5 * k,
      spin: (Math.random() - 0.5) * 9, roll: Math.random() < 0.5 ? 1 : -1, rest: false };
  }
  function animDown(p, dt) { animD(p.down, dt); }
  function animD(d, dt) {
    if (d.rest) return;
    d.vy -= 9.81 * dt;
    d.x += d.vx * dt; d.z += d.vz * dt; d.y += d.vy * dt;
    d.vx *= 1 - dt * 0.6; d.vz *= 1 - dt * 0.6;
    d.tilt = Math.min(Math.PI / 2, d.tilt + dt * 6);
    d.yaw += d.spin * dt;
    const g = heightAt(d.x, d.z) + (d.lift ?? 0.14);
    if (d.y <= g && d.vy < 0) { d.y = g; d.rest = true; d.tilt = Math.PI / 2; }
  }
  function setPersonDown(i, d) {
    pq.setFromAxisAngle(up, d.yaw).multiply(tq.setFromAxisAngle(ax, d.tilt * d.roll));
    pm.compose(pp.set(d.x, d.y, d.z), pq, dsc);
    torso.im.setMatrixAt(i, pm); head.im.setMatrixAt(i, pm);
    for (const [k, sgn] of [[0, 1], [1, -1]]) {
      const lq = new THREE.Quaternion().setFromAxisAngle(ax, 0.5 * sgn);
      const lm = new THREE.Matrix4().compose(new THREE.Vector3(0, 0.9, sgn * 0.1), lq, ps);
      legs.im.setMatrixAt(i * 2 + k, pm.clone().multiply(lm));
    }
  }
  /** Řidič vyskočí z nabouraného auta a utíká pryč (směr fx, fz); po chvíli zmizí. */
  function addRunner(x, z, fx, fz, walk = false) {
    if (waiting.filter((w) => w.run).length >= 16) return;
    const a = Math.atan2(fz, fx) + (Math.random() - 0.5) * 0.8, sp = walk ? 1.2 + Math.random() * 0.4 : 4.5 + Math.random() * 1.5;
    const w = { stop: null, x, z, yaw: Math.atan2(-Math.sin(a), Math.cos(a)), ph: Math.random() * 6,
      run: { vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, t: 0, hop: 0, walk, ttl: walk ? 25 : 12 } };
    waiting.push(w);
  }
  /** Po vypnutí Demolice: pryč se sraženými a utíkajícími. */
  function clearGta() {
    for (let k = people.length - 1; k >= 0; k--) if (people[k].down) people.splice(k, 1);
    for (let k = cyclists.length - 1; k >= 0; k--) if (cyclists[k].down) cyclists.splice(k, 1);
    for (const c of cows) if (c.down) { c.x = c.down.x0 ?? c.x; c.z = c.down.z0 ?? c.z; c.down = null; }
    for (let k = waiting.length - 1; k >= 0; k--) if (waiting[k].down || (waiting[k].run && !waiting[k].run.walk)) waiting.splice(k, 1);
  }
  /** Srazit lidi v dosahu úsečky a–b (auto); vrátí počet nově sražených. */
  function knock(ax0, az0, bx, bz, r, hx, hz, speed) {
    const dx = bx - ax0, dz = bz - az0, l2 = dx * dx + dz * dz || 1;
    const near = (x, z) => {
      const t = Math.max(0, Math.min(1, ((x - ax0) * dx + (z - az0) * dz) / l2));
      return Math.hypot(ax0 + dx * t - x, az0 + dz * t - z) < r;
    };
    let n = 0;
    for (const p of people) {
      if (p.down || p.y === undefined || !near(p.x, p.z)) continue;
      knockOne(p, p.x, p.y, p.z, p.yaw || 0, hx, hz, speed); n++;
    }
    for (const w of waiting) {
      if (w.ghost || w.down || !near(w.x, w.z)) continue;
      knockOne(w, w.x, heightAt(w.x, w.z), w.z, w.yaw, hx, hz, speed); n++;
    }
    // cyklista: kolo zůstane kousek za místem nárazu na boku, jezdec odletí dál
    for (const c of cyclists) {
      if (c.down || c.x === 1e9 || !near(c.x, c.z)) continue;
      const g = heightAt(c.x, c.z), yaw = c.yaw ?? 0, k = Math.min(1, speed / 14);
      c.down = { x: c.x, y: g + 0.9, z: c.z, yaw, tilt: 0, vx: hx * speed * 0.6, vz: hz * speed * 0.6, vy: 3 + 5 * k,
        spin: (Math.random() - 0.5) * 8, roll: Math.random() < 0.5 ? 1 : -1, rest: false, lift: 0.15 };
      c.bdown = { x: c.x, y: g, z: c.z, yaw: yaw + (Math.random() - 0.5) * 1.2, tilt: 0, vx: hx * speed * 0.3, vz: hz * speed * 0.3, vy: 1.5 + 2 * k,
        spin: (Math.random() - 0.5) * 6, roll: Math.random() < 0.5 ? 1 : -1, rest: false, lift: 0.05 };
      n++;
    }
    // kráva: těžká, odletí míň, spadne na bok a zůstane ležet (nohy do strany)
    let nc = 0;
    for (const c of cows) {
      if (c.down || !near(c.x, c.z)) continue;
      const k = Math.min(1, speed / 14);
      c.down = { x: c.x, y: heightAt(c.x, c.z), z: c.z, yaw: c.yaw, tilt: 0, vx: hx * speed * 0.25, vz: hz * speed * 0.25, vy: 1.5 + 2.5 * k,
        spin: (Math.random() - 0.5) * 3, roll: Math.random() < 0.5 ? 1 : -1, rest: false, lift: 0.62 };
      nc++;
    }
    return { people: n, cows: nc };
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

  // ---------------------------------------------------------- cyklisté
  // hlavně po cyklostezkách a po silnicích, kudy vede cyklotrasa (OSM), občas po ulicích a polních cestách
  const NC = coarse ? 10 : 28;
  const cp = cyclistParts();
  const cBike = pool(group, cp.bike, NC, { color: true }), cFixed = pool(group, cp.fixed, NC);
  const cTorso = pool(group, cp.torso, NC, { color: true }), cLeg = pool(group, cp.leg, NC * 2, { color: true });
  const BIKE_T = new Set([1, 2, 3, 4, 5, 6, 9]);
  const bikeG = buildGraph([...roads.filter((r) => BIKE_T.has(r.t)), ...(bike?.paths || []).map((p) => ({ t: 9, p }))], BIKE_T);
  const routeCells = new Set();
  for (const line of bike?.routes || []) {
    for (let i = 0; i < line.length - 1; i++) {
      const [ax, az] = line[i], [bx, bz] = line[i + 1], n = Math.ceil(Math.hypot(bx - ax, bz - az) / 6);
      for (let k = 0; k <= n; k++) routeCells.add(`${Math.floor((ax + (bx - ax) * k / n) / 12)},${Math.floor((az + (bz - az) * k / n) / 12)}`);
    }
  }
  const onRoute = (x, z) => {
    const cx = Math.floor(x / 12), cz = Math.floor(z / 12);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (routeCells.has(`${cx + a},${cz + b}`)) return true;
    return false;
  };
  const BPREF = [0, 0.25, 1, 1.6, 1.2, 1, 0.6, 0, 0, 10];
  const edgeW = (a, e) => {
    let w = BPREF[e.t] || 0;
    if (e.t !== 9 && onRoute((bikeG.X[a] + bikeG.X[e.to]) / 2, (bikeG.Z[a] + bikeG.Z[e.to]) / 2)) w *= 8;
    return w;
  };
  const favEdges = [], streetEdges = [];
  for (let a = 0; a < bikeG.n; a++) {
    for (const e of bikeG.adj[a]) {
      if (e.to < a) continue;
      if (edgeW(a, e) >= 5) favEdges.push([a, e]); else if (e.t === 2 || e.t === 3) streetEdges.push([a, e]);
    }
  }
  const BIKE_COLORS = [0xd12f2f, 0x1f5fbf, 0x1d1d1f, 0xf2f2f2, 0x2f9a4a, 0xf0a020, 0x8a8f96].map(C);
  const JERSEYS = [0xe23b3b, 0x2a6fd6, 0xf2c230, 0x2e9e55, 0xf2f2f2, 0x222428, 0xff7a1a, 0x7b4cc2].map(C);
  const cyclists = [];
  const laneOf = (t) => (t === 9 ? 0.6 : Math.max(0.4, WIDTH[t] / 2 - 0.7));
  function spawnCyclist(fx, fz, cam, minCam) {
    for (let tries = 0; tries < 30; tries++) {
      const list = Math.random() < 0.8 && favEdges.length ? favEdges : streetEdges;
      const [a0, e] = list[Math.floor(Math.random() * list.length)];
      let a = a0, b = e.to;
      if (Math.random() < 0.5) [a, b] = [b, a];
      const x = bikeG.X[a], z = bikeG.Z[a];
      if (Math.hypot(x - fx, z - fz) > 600 || !detailAt(x, z)) continue;
      if (cam && Math.hypot(x - cam.x, z - cam.z) < minCam) continue;
      const tr = new Track();
      tr.push(x, z, laneOf(e.t), e.t);
      tr.push(bikeG.X[b], bikeG.Z[b], laneOf(e.t), e.t);
      return { tr, s: Math.random() * tr.len, prev: a, node: b, v: 4.2 + Math.random() * 2.6, ph: Math.random() * 6,
        frame: rnd(BIKE_COLORS), shirt: rnd(JERSEYS), pants: rnd(PANTS) };
    }
    return null;
  }
  function extendCyclist(c) {
    while (c.tr.len - c.s < 40) {
      const from = c.prev, at = c.node;
      const ax = bikeG.X[at] - bikeG.X[from], az = bikeG.Z[at] - bikeG.Z[from], al = Math.hypot(ax, az) || 1;
      let sum = 0;
      const opts = [];
      for (const e of bikeG.adj[at]) {
        if (e.to === from) continue;
        const bx = bikeG.X[e.to] - bikeG.X[at], bz = bikeG.Z[e.to] - bikeG.Z[at], bl = Math.hypot(bx, bz) || 1;
        const cos = (ax * bx + az * bz) / (al * bl);
        const w = edgeW(at, e) * (0.15 + (1 + cos) ** 2);
        if (w > 0) { opts.push([e, w]); sum += w; }
      }
      let e = null;
      if (!opts.length) e = bikeG.adj[at].find((q) => q.to === from);
      else { let r = Math.random() * sum; for (const [q, w] of opts) { r -= w; if (r <= 0) { e = q; break; } } e ||= opts[opts.length - 1][0]; }
      if (!e) return false;
      c.prev = at; c.node = e.to;
      c.tr.push(bikeG.X[e.to], bikeG.Z[e.to], laneOf(e.t), e.t);
    }
    if (c.s > 300) { const d = c.tr.trim(c.s - 20); c.s -= d; }
    return true;
  }
  const CP = [0, 0, 0, 0, 0], CQ = [0, 0, 0, 0, 0];
  function updateCyclists(dt, focus, cam, near, spawn) {
    for (let k = cyclists.length - 1; k >= 0; k--) {
      const c = cyclists[k];
      if (!near || Math.hypot(c.x - focus.x, c.z - focus.z) > 800) cyclists.splice(k, 1);
    }
    if (spawn && cyclists.length < NC) {
      const first = cyclists.length < 2;
      for (let k = 0; k < (first ? 12 : 1); k++) {
        const c = spawnCyclist(focus.x, focus.z, cam, first ? 0 : 150);
        if (c && cyclists.length < NC) cyclists.push(c);
      }
    }
    let i = 0;
    for (const c of cyclists) {
      if (c.down) {
        animD(c.down, dt); animD(c.bdown, dt);
        c.x = c.bdown.x; c.z = c.bdown.z;
        if (!detailAt(c.x, c.z)) continue;
        if (c.slot !== i) {
          c.slot = i;
          cBike.im.setColorAt(i, c.frame); cTorso.im.setColorAt(i, c.shirt);
          cLeg.im.setColorAt(i * 2, c.pants); cLeg.im.setColorAt(i * 2 + 1, c.pants);
          cBike.im.instanceColor.needsUpdate = cTorso.im.instanceColor.needsUpdate = cLeg.im.instanceColor.needsUpdate = true;
        }
        const b = c.bdown, d = c.down;
        q4.setFromAxisAngle(up, b.yaw).multiply(tq.setFromAxisAngle(xAx, (Math.PI / 2) * Math.min(1, b.tilt / (Math.PI / 2)) * b.roll));
        m4.compose(v3.set(b.x, b.y, b.z), q4, s3);
        cBike.im.setMatrixAt(i, m4); cFixed.im.setMatrixAt(i, m4);
        q4.setFromAxisAngle(up, d.yaw).multiply(tq.setFromAxisAngle(ax, d.tilt * d.roll));
        m4.compose(v3.set(d.x, d.y - 0.75 * (1 - Math.min(1, d.tilt / (Math.PI / 2))), d.z), q4, s3);
        cTorso.im.setMatrixAt(i, m4);
        for (const [k, sg] of [[0, 1], [1, -1]]) {
          const lm = new THREE.Matrix4().compose(new THREE.Vector3(-0.12, 0.9, sg * 0.11), new THREE.Quaternion().setFromAxisAngle(ax, 0.9 * sg), s3);
          cLeg.im.setMatrixAt(i * 2 + k, m4.clone().multiply(lm));
        }
        i++;
        continue;
      }
      c.s += c.v * dt;
      if (!extendCyclist(c)) { c.x = 1e9; continue; }
      c.tr.at(c.s, CP); c.tr.at(c.s - 1.04, CQ);
      const lift = LIFT[CP[2]] ?? 0.32;
      const yF = (bridges.at(CP[0], CP[1], WIDTH[CP[2]], CP[3], CP[4]) ?? heightAt(CP[0], CP[1])) + lift;
      const yR = (bridges.at(CQ[0], CQ[1], WIDTH[CQ[2]], CQ[3], CQ[4]) ?? heightAt(CQ[0], CQ[1])) + lift;
      const x = (CP[0] + CQ[0]) / 2, z = (CP[1] + CQ[1]) / 2;
      c.x = x; c.z = z;
      if (!detailAt(x, z)) continue;
      const yaw = Math.atan2(-(CP[1] - CQ[1]), CP[0] - CQ[0]);
      c.yaw = yaw;
      const pitch = Math.atan2(yF - yR, 1.04);
      q4.setFromEuler(new THREE.Euler(0, yaw, pitch, 'YXZ'));
      m4.compose(v3.set(x, (yF + yR) / 2, z), q4, s3);
      if (c.slot !== i) {
        c.slot = i;
        cBike.im.setColorAt(i, c.frame); cTorso.im.setColorAt(i, c.shirt);
        cLeg.im.setColorAt(i * 2, c.pants); cLeg.im.setColorAt(i * 2 + 1, c.pants);
        cBike.im.instanceColor.needsUpdate = cTorso.im.instanceColor.needsUpdate = cLeg.im.instanceColor.needsUpdate = true;
      }
      cBike.im.setMatrixAt(i, m4); cFixed.im.setMatrixAt(i, m4); cTorso.im.setMatrixAt(i, m4);
      c.ph += dt * c.v * 1.6;
      for (const [k, sg] of [[0, 1], [1, -1]]) {
        const lm = new THREE.Matrix4().compose(new THREE.Vector3(-0.12, 0.9, sg * 0.11),
          new THREE.Quaternion().setFromAxisAngle(ax, Math.sin(c.ph + (k ? Math.PI : 0)) * 0.55 + 0.25), s3);
        cLeg.im.setMatrixAt(i * 2 + k, m4.clone().multiply(lm));
      }
      i++;
    }
    for (let k = cyclists.length - 1; k >= 0; k--) if (cyclists[k].x === 1e9) cyclists.splice(k, 1);
    cBike.hideFrom(i); cFixed.hideFrom(i); cTorso.hideFrom(i); cLeg.hideFrom(i * 2);
    for (const pl of [cBike, cFixed, cTorso, cLeg]) pl.im.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------- zvířata
  const ND = coarse ? 8 : 16, NH = coarse ? 5 : 10, NB = coarse ? 24 : 48;
  const dp = deerParts(), hp = hareParts(), bpS = birdParts(false), bpL = birdParts(true);
  const deerBody = pool(group, dp.body, ND), deerNeck = pool(group, dp.neck, ND), deerLeg = pool(group, dp.leg, ND * 4);
  const hareBody = pool(group, hp.body, NH, { shadow: false });
  const birdBody = pool(group, bpS.body, NB, { shadow: false }), birdWing = pool(group, bpS.wing, NB * 2, { shadow: false, both: true });
  const buzBody = pool(group, bpL.body, 2, { shadow: true }), buzWing = pool(group, bpL.wing, 4, { shadow: true, both: true });
  const deer = [], hares = [], flocks = [], buzzards = [];
  // krávy na pastvinách u JZD jihovýchodně od Stodu (podle ortofota): [x, z, poloměr, počet]
  const PASTURES = [[880, -260, 110, 14], [620, -60, 55, 7], [880, 160, 70, 8]];
  const COW_COAT = [[0xf2f0ea, 0x1e1d1d], [0xf2f0ea, 0x1e1d1d], [0xf0e8dc, 0x8a3e22], [0x7a4a2c, 0x5e3620]].map(([a, b]) => [C(a), C(b)]);
  const NCOW = PASTURES.reduce((a, p) => a + p[3], 0);
  const cp2 = cowParts();
  const cowBody = pool(group, cp2.body, NCOW, { color: true }), cowSpots = pool(group, cp2.spots, NCOW, { color: true });
  const cowFixed = pool(group, cp2.fixed, NCOW), cowHead = pool(group, cp2.head, NCOW, { color: true }), cowLeg = pool(group, cp2.leg, NCOW * 4, { color: true });
  const cows = [];
  PASTURES.forEach(([px, pz, pr, n], pi) => {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * 6.28, d = Math.sqrt(Math.random()) * pr * 0.8;
      const coat = rnd(COW_COAT), i = cows.length;
      cows.push({ x: px + Math.cos(a) * d, z: pz + Math.sin(a) * d, yaw: Math.random() * 6.28, state: 'graze', t: Math.random() * 10,
        v: 0, neck: -0.9, phase: Math.random() * 6, past: pi });
      cowBody.im.setColorAt(i, coat[0]); cowSpots.im.setColorAt(i, coat[Math.random() < 0.85 ? 1 : 0]); cowHead.im.setColorAt(i, coat[0]);
      for (let l = 0; l < 4; l++) cowLeg.im.setColorAt(i * 4 + l, coat[0]);
    }
  });
  for (const pl of [cowBody, cowSpots, cowHead, cowLeg]) pl.im.instanceColor.needsUpdate = true;

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
        for (let k = 0; k < (first ? 30 : 4); k++) {
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
        if (p.down) {
          animDown(p, dt);
          p.x = p.down.x; p.z = p.down.z;
          personColorsOnce(p, i);
          if (detailAt(p.x, p.z)) setPersonDown(i, p.down); else hidePerson(i);
          i++;
          continue;
        }
        if (p.pause > 0) p.pause -= dt;
        else {
          p.s += p.v * dt;
          if (Math.random() < dt * 0.02) p.pause = 2 + Math.random() * 6;     // zastaví se, rozhlédne
        }
        if (!extendWalker(p)) { p.dead = true; continue; }
        p.tr.at(p.s, P);
        const x = P[0], z = P[1];
        const br = bridges.at(x, z, 2, P[3], P[4]);
        const y = br !== null ? br + 0.5 : heightAt(x, z) + (P[2] <= 3 ? SIDEWALK_TOP : P[2] <= 6 ? 0.33 : 0.3);
        p.x = x; p.z = z; p.y = y;
        const yaw = Math.atan2(-P[4], P[3]);
        p.yaw = yaw;
        p.phase += dt * p.v * 5.2 * (p.pause > 0 ? 0 : 1);
        const swing = p.pause > 0 ? 0 : Math.sin(p.phase) * 0.42;
        personColorsOnce(p, i);
        if (detailAt(x, z)) setPerson(i, x, y, z, yaw, swing); else hidePerson(i);
        i++;
      }
      for (const w of waiting) {
        if (w.ghost) continue;
        if (i >= CAP) break;
        personColorsOnce(w, i);
        if (w.down) { animDown(w, dt); setPersonDown(i, w.down); i++; continue; }
        if (w.run) {
          // vyskočí ven (krátký skok), pak běží, ruce-nohy kmitají
          const r = w.run;
          r.t += dt;
          w.x += r.vx * dt * Math.min(1, r.t * 3); w.z += r.vz * dt * Math.min(1, r.t * 3);
          const hop = !r.walk && r.t < 0.35 ? Math.sin((r.t / 0.35) * Math.PI) * 0.6 : 0;
          w.ph += dt * (r.walk ? 6.5 : 14);
          if (r.t > r.ttl) { w.dead = true; continue; }
          setPerson(i, w.x, heightAt(w.x, w.z) + 0.02 + hop, w.z, w.yaw, Math.sin(w.ph) * (r.walk ? 0.42 : 0.75));
          i++;
          continue;
        }
        const y = heightAt(w.x, w.z) + 0.02;
        w.ph += dt;
        setPerson(i, w.x, y, w.z, w.yaw + Math.sin(w.ph * 0.3) * 0.3, 0);
        i++;
      }
      for (let k = people.length - 1; k >= 0; k--) if (people[k].dead) people.splice(k, 1);
      for (let k = waiting.length - 1; k >= 0; k--) if (waiting[k].dead) waiting.splice(k, 1);
      for (let k = i; k < CAP; k++) hidePerson(k);
      torso.im.instanceMatrix.needsUpdate = head.im.instanceMatrix.needsUpdate = legs.im.instanceMatrix.needsUpdate = true;
      updateCyclists(dt, focus, cam, near, spawn);
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

      // krávy: pasou se, občas popojdou nebo zvednou hlavu; drží se své pastviny
      const nearCows = near && PASTURES.some(([px, pz]) => Math.hypot(px - focus.x, pz - focus.z) < 1500);
      for (let ci = 0; ci < cows.length; ci++) {
        const c = cows[ci];
        if (!nearCows || !detailAt(c.x, c.z)) {
          cowBody.im.setMatrixAt(ci, cowBody.zero); cowSpots.im.setMatrixAt(ci, cowBody.zero); cowFixed.im.setMatrixAt(ci, cowBody.zero); cowHead.im.setMatrixAt(ci, cowBody.zero);
          for (let l = 0; l < 4; l++) cowLeg.im.setMatrixAt(ci * 4 + l, cowBody.zero);
          continue;
        }
        if (c.down) {
          const d = c.down;
          d.x0 ??= c.x; d.z0 ??= c.z;
          animD(d, dt);
          q4.setFromAxisAngle(up, d.yaw).multiply(tq.setFromAxisAngle(xAx, Math.min(Math.PI / 2, d.tilt) * d.roll));
          m4.compose(v3.set(d.x, d.y - 0.32 * Math.min(1, d.tilt / (Math.PI / 2)), d.z), q4, s3);
          cowBody.im.setMatrixAt(ci, m4); cowSpots.im.setMatrixAt(ci, m4); cowFixed.im.setMatrixAt(ci, m4);
          const hm = new THREE.Matrix4().compose(new THREE.Vector3(0.95, 1.3, 0), new THREE.Quaternion().setFromAxisAngle(ax, -0.3), s3);
          cowHead.im.setMatrixAt(ci, m4.clone().multiply(hm));
          [[0.7, 0.24], [0.7, -0.24], [-0.7, 0.24], [-0.7, -0.24]].forEach(([lx, lz], l) => {
            const lm = new THREE.Matrix4().compose(new THREE.Vector3(lx, 0.74, lz), new THREE.Quaternion().setFromAxisAngle(ax, 0.25), s3);
            cowLeg.im.setMatrixAt(ci * 4 + l, m4.clone().multiply(lm));
          });
          continue;
        }
        c.t -= dt;
        if (c.t <= 0) {
          const r = Math.random();
          c.state = r < 0.6 ? 'graze' : r < 0.82 ? 'walk' : 'look';
          c.t = c.state === 'walk' ? 2 + Math.random() * 4 : 5 + Math.random() * 12;
          const [px, pz, pr] = PASTURES[c.past];
          if (c.state === 'walk') {
            c.yaw += (Math.random() - 0.5) * 1.5;
            if (Math.hypot(c.x - px, c.z - pz) > pr * 0.75) c.yaw = Math.atan2(-(pz - c.z), px - c.x);   // zpátky do pastviny
          }
        }
        const sp = c.state === 'walk' ? 0.55 : 0;
        c.v += (sp - c.v) * Math.min(1, dt * 2);
        c.x += Math.cos(c.yaw) * c.v * dt; c.z -= Math.sin(c.yaw) * c.v * dt;
        c.neck += ((c.state === 'graze' ? -0.95 : c.state === 'look' ? 0.15 : -0.25) - c.neck) * Math.min(1, dt * 1.5);
        c.phase += dt * (1 + c.v * 3);
        q4.setFromAxisAngle(up, c.yaw);
        m4.compose(v3.set(c.x, heightAt(c.x, c.z), c.z), q4, s3);
        cowBody.im.setMatrixAt(ci, m4); cowSpots.im.setMatrixAt(ci, m4); cowFixed.im.setMatrixAt(ci, m4);
        const hm = new THREE.Matrix4().compose(new THREE.Vector3(0.95, 1.3, 0), new THREE.Quaternion().setFromAxisAngle(ax, c.neck), s3);
        cowHead.im.setMatrixAt(ci, m4.clone().multiply(hm));
        const amp = c.v > 0.1 ? 0.35 : 0;
        [[0.7, 0.24, 0], [0.7, -0.24, Math.PI], [-0.7, 0.24, Math.PI], [-0.7, -0.24, 0]].forEach(([lx, lz, ph], l) => {
          const lm = new THREE.Matrix4().compose(new THREE.Vector3(lx, 0.74, lz), new THREE.Quaternion().setFromAxisAngle(ax, Math.sin(c.phase + ph) * amp), s3);
          cowLeg.im.setMatrixAt(ci * 4 + l, m4.clone().multiply(lm));
        });
      }
      for (const pl of [cowBody, cowSpots, cowFixed, cowHead, cowLeg]) pl.im.instanceMatrix.needsUpdate = true;

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
    return people.length + cyclists.length + deer.length + hares.length + flocks.length > 0;
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
  const peopleMeshes = [torso.im, head.im, legs.im, cBike.im, cFixed.im, cTorso.im, cLeg.im];
  const animalMeshes = [deerBody.im, deerNeck.im, deerLeg.im, hareBody.im, birdBody.im, birdWing.im, buzBody.im, buzWing.im, cowBody.im, cowSpots.im, cowFixed.im, cowHead.im, cowLeg.im];
  return {
    group, update, knock, addRunner, clearGta,
    setPeople(v) { showPeople = v; for (const m of peopleMeshes) m.visible = v; if (!v) { people.length = 0; waiting.length = 0; cyclists.length = 0; } },
    setAnimals(v) { showAnimals = v; for (const m of animalMeshes) m.visible = v; if (!v) { deer.length = 0; hares.length = 0; flocks.length = 0; buzzards.length = 0; } },
    get active() { return showPeople || showAnimals; },
    debug: { people, deer, hares, flocks, waiting, cyclists, cows },
  };
}
