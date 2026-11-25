import * as THREE from 'three';
import { personParts } from './models.js';
import { NIGHT } from './night.js';
import { SEASON } from './season.js';

// Fotbal na stadionu: dva týmy po 11 (brankář, 4 obránci, 4 záložníci, 2 útočníci), rozhodčí a míč.
// Jednoduchá hra: nejbližší hráč každého týmu běží k míči, ostatní drží rozestavení posunuté za míčem;
// u míče hráč přihraje spoluhráči blíž k cizí brance nebo vystřelí; gól → výkop ze středu.
// Hraje se ve dne (ne v noci, ne na sněhu), jen když je zapnuto „Lidé“ a kamera je blízko.

const C = (c) => new THREE.Color(c);
const TEAMS = [
  { shirt: C(0xc8322c), shorts: C(0xf2f2ee), keeper: C(0x2f9e4f) },   // domácí: červená / bílé trenýrky
  { shirt: C(0x2a5bb3), shorts: C(0x1d2433), keeper: C(0xe0b83a) },   // hosté: modrá
];
// rozestavení: [podíl délky od vlastní brány (0 = branková čára, 1 = půlka), podíl šířky −1…1]
const FORM = [[0.04, 0], [0.32, -0.62], [0.28, -0.22], [0.28, 0.22], [0.32, 0.62],
  [0.62, -0.6], [0.58, -0.2], [0.58, 0.2], [0.62, 0.6], [0.9, -0.25], [0.9, 0.25]];
const RUN = 6.2, JOG = 3.4, BALL_FRICTION = 2.6, G = 9.81;

export function createFootball({ pitch, world, scene }) {
  const group = new THREE.Group();
  scene.add(group);
  if (!pitch) return { update: () => false, set: () => {} };
  const o = pitch, A = o.ha - 1.5, B = o.hb - 1.5;        // hrací plocha (jako čáry v sports.js)
  const toWorld = (a, b) => [o.cx + o.ux * a - o.uz * b, o.cz + o.uz * a + o.ux * b];
  const parts = personParts();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const N = 23;                                            // 22 hráčů + rozhodčí
  const mk = (geo, n) => {
    const im = new THREE.InstancedMesh(geo, mat, n);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
    im.castShadow = true; im.frustumCulled = false;
    group.add(im);
    return im;
  };
  const torso = mk(parts.torso, N), head = mk(parts.head, N), legs = mk(parts.leg, N * 2);
  const ballMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 1), new THREE.MeshLambertMaterial({ color: 0xf6f6f2, flatShading: true }));
  ballMesh.castShadow = true;
  group.add(ballMesh);

  const players = [];
  for (let t = 0; t < 2; t++) {
    for (let k = 0; k < 11; k++) {
      players.push({ team: t, role: k, a: 0, b: 0, va: 0, vb: 0, phase: Math.random() * 6, cool: 0, yaw: 0 });
      const i = players.length - 1;
      torso.setColorAt(i, k === 0 ? TEAMS[t].keeper : TEAMS[t].shirt);
      legs.setColorAt(i * 2, TEAMS[t].shorts); legs.setColorAt(i * 2 + 1, TEAMS[t].shorts);
    }
  }
  players.push({ team: -1, role: -1, a: 0, b: -B * 0.4, va: 0, vb: 0, phase: 0, cool: 0, yaw: 0 });   // rozhodčí
  torso.setColorAt(22, C(0x1b1b1b)); legs.setColorAt(44, C(0x1b1b1b)); legs.setColorAt(45, C(0x1b1b1b));
  const ball = { a: 0, b: 0, y: 0, va: 0, vb: 0, vy: 0, last: 0 };
  const dirOf = (t) => (t === 0 ? 1 : -1);                 // tým 0 útočí na +a

  function kickoff(team) {
    Object.assign(ball, { a: 0, b: 0, y: 0, va: 0, vb: 0, vy: 0, last: team });
    players.forEach((p) => {
      if (p.team < 0) return;
      const [f, w] = FORM[p.role], d = dirOf(p.team);
      p.a = -d * A * (1 - Math.min(f, 0.92)); p.b = w * B * 0.8; p.va = p.vb = 0;
    });
    const taker = players.find((p) => p.team === team && p.role === 9);
    taker.a = -dirOf(team) * 0.6; taker.b = 0;
  }
  kickoff(0);

  function kick(p) {
    const d = dirOf(p.team);
    const goalDist = Math.abs(A * d - p.a);
    let ta, tb, power;
    if (goalDist < 22 && Math.random() < 0.6) {              // střela na bránu
      ta = A * d + d * 2; tb = (Math.random() - 0.5) * 9; power = 1;
    } else {
      // přihrávka spoluhráči, který je víc vpředu (občas i dozadu)
      const mates = players.filter((q) => q.team === p.team && q !== p && q.role > 0);
      const ahead = mates.filter((q) => (q.a - p.a) * d > -4);
      const q = (ahead.length ? ahead : mates)[Math.floor(Math.random() * (ahead.length || mates.length))];
      ta = q.a + d * 3; tb = q.b; power = 0;
    }
    const da = ta - ball.a, db = tb - ball.b, L = Math.hypot(da, db) || 1;
    const v = Math.min(power ? 24 : 18, Math.sqrt(2 * BALL_FRICTION * L) * 1.15 + (power ? 6 : 1));
    ball.va = da / L * v; ball.vb = db / L * v;
    ball.vy = L > 25 || power ? 3 + Math.random() * 3 : 0;   // dlouhé míče a střely letí obloukem
    ball.last = p.team;
    p.cool = 0.7;
  }

  let enabled = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), ax = new THREE.Vector3(0, 0, 1);
  const one = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
  function place(i, p) {
    const [x, z] = toWorld(p.a, p.b);
    q.setFromAxisAngle(up, p.yaw);
    m.compose(pos.set(x, world.heightAt(x, z) + 0.36, z), q, one);
    torso.setMatrixAt(i, m); head.setMatrixAt(i, m);
    const swing = Math.sin(p.phase) * Math.min(0.6, Math.hypot(p.va, p.vb) * 0.11);
    for (const [k, s] of [[0, 1], [1, -1]]) {
      const lm = new THREE.Matrix4().compose(new THREE.Vector3(0, 0.9, s * 0.1), new THREE.Quaternion().setFromAxisAngle(ax, swing * s), one);
      legs.setMatrixAt(i * 2 + k, m.clone().multiply(lm));
    }
  }

  function step(dt) {
    // míč
    ball.a += ball.va * dt; ball.b += ball.vb * dt;
    if (ball.y > 0 || ball.vy > 0) { ball.vy -= G * dt; ball.y += ball.vy * dt; if (ball.y < 0) { ball.y = 0; ball.vy = Math.abs(ball.vy) > 1.5 ? -ball.vy * 0.45 : 0; } }
    const sp = Math.hypot(ball.va, ball.vb);
    if (ball.y <= 0 && sp > 0) { const k = Math.max(0, sp - BALL_FRICTION * dt) / sp; ball.va *= k; ball.vb *= k; }
    // gól / aut
    if (Math.abs(ball.a) > A) {
      if (Math.abs(ball.b) < 3.66 && ball.y < 2.44) { kickoff(ball.a > 0 ? 1 : 0); return; }
      ball.a = Math.sign(ball.a) * (A - 5); ball.b *= 0.6; ball.va = ball.vb = ball.vy = 0; ball.y = 0;   // odkop od brány
    }
    if (Math.abs(ball.b) > B) { ball.b = Math.sign(ball.b) * (B - 0.5); ball.va = ball.vb = ball.vy = 0; ball.y = 0; }   // aut

    // kdo běží k míči: nejbližší z každého týmu (brankář jen ve vápně)
    const chaser = [null, null];
    for (const p of players) {
      if (p.team < 0) continue;
      const d = Math.hypot(p.a - ball.a, p.b - ball.b);
      if (p.role === 0 && Math.abs(ball.a - dirOf(p.team) * -A) > 16) continue;
      if (!chaser[p.team] || d < chaser[p.team].d) chaser[p.team] = { p, d };
    }
    for (const p of players) {
      p.cool = Math.max(0, p.cool - dt);
      let ta, tb, v;
      if (p.team < 0) {                                       // rozhodčí sleduje hru z dálky
        ta = ball.a * 0.85; tb = ball.b * 0.5 + (ball.b > 0 ? -12 : 12); v = JOG;
      } else if (chaser[p.team]?.p === p) {
        ta = ball.a - dirOf(p.team) * 0.4; tb = ball.b; v = RUN;
      } else if (p.role === 0) {
        ta = -dirOf(p.team) * (A - 1.5); tb = THREE.MathUtils.clamp(ball.b * 0.3, -3, 3); v = JOG;
      } else {
        const [f, w] = FORM[p.role], d = dirOf(p.team);
        const shift = THREE.MathUtils.clamp(ball.a * 0.55, -A * 0.4, A * 0.4);
        ta = -d * A * (1 - f) * 0.95 + shift + d * 6; tb = w * B * 0.85 + (ball.b - w * B * 0.85) * 0.25; v = JOG;
      }
      const da = ta - p.a, db = tb - p.b, L = Math.hypot(da, db);
      const want = L > 0.3 ? Math.min(v, L * 1.5) : 0;
      const wa = L ? da / L * want : 0, wb = L ? db / L * want : 0;
      const k = Math.min(1, dt * 3);
      p.va += (wa - p.va) * k; p.vb += (wb - p.vb) * k;
      p.a += p.va * dt; p.b += p.vb * dt;
      const s = Math.hypot(p.va, p.vb);
      p.phase += s * dt * 2.4;
      // natočení: ve směru běhu, stojící k míči
      const fa = s > 0.4 ? p.va : ball.a - p.a, fb = s > 0.4 ? p.vb : ball.b - p.b;
      const [wx, wz] = [o.ux * fa - o.uz * fb, o.uz * fa + o.ux * fb];
      p.yaw = Math.atan2(-wz, wx);
      // u míče: rána
      if (p.team >= 0 && p.cool <= 0 && ball.y < 0.6 && Math.hypot(p.a - ball.a, p.b - ball.b) < 0.75) kick(p);
    }
  }

  let shown = false;
  return {
    debug: { ball, players },
    set(v) { enabled = v; if (!v) { group.visible = false; shown = false; } },
    /** Vrací true, když se něco pohnulo (překreslit). */
    update(dt, focus) {
      const day = NIGHT.night.value < 0.5 && SEASON.snow.value < 0.5;
      const near = Math.hypot(focus.x - o.cx, focus.z - o.cz) < 900;
      const on = enabled && day && near;
      if (on !== shown) { group.visible = on; shown = on; if (!on) return true; }
      if (!on) return false;
      dt = Math.min(dt, 0.05);
      step(dt);
      players.forEach((p, i) => place(i, p));
      torso.instanceMatrix.needsUpdate = head.instanceMatrix.needsUpdate = legs.instanceMatrix.needsUpdate = true;
      const [x, z] = toWorld(ball.a, ball.b);
      ballMesh.position.set(x, world.heightAt(x, z) + 0.36 + 0.16 + ball.y, z);
      ballMesh.rotation.x += Math.hypot(ball.va, ball.vb) * dt * 3;
      return true;
    },
  };
}
