import * as THREE from 'three';
import { NIGHT } from './night.js';

// Projížďka autem: arkádová jízda po silnicích a cestách Stodska.
//   Rychlost podle povrchu (silnice, ulice, štěrk, polní cesta, mimo cestu), náklon auta podle terénu,
//   mosty, srážky s budovami, kamera za autem (C přepíná pohled), tachometr s názvem ulice,
//   zvuk motoru (WebAudio, M vypne) a na mobilu dotykové pedály.

// typy komunikací – stejné jako v roads.js (tools/build_data.py ROAD)
const WIDTH = [8.5, 6.5, 5.0, 3.5, 3.2, 3.0, 2.6, 1.2, 4.2];
const LIFT = [0.34, 0.34, 0.34, 0.34, 0.31, 0.3, 0.29, 0.28, 0.36];
const MAX_SPEED = [30, 25, 16, 16, 13, 11, 9, 5, 0];            // [m/s] na daném povrchu (železnice = mimo cestu)
const GRIP = [1, 1, 1, 1, 0.95, 0.8, 0.72, 0.7, 0.6];
const SURFACE_NAME = ['silnice I. třídy', 'silnice', 'ulice', 'asfaltová cesta', 'panelová cesta', 'štěrková cesta',
  'polní cesta', 'pěšina', 'železnice'];
const OFFROAD = { max: 7, grip: 0.6, rolling: 1.6 };
const CELL = 32;
const WHEELBASE = 2.6;

// ---------------------------------------------------------------- prostorové indexy
function segIndex(lines) {
  const grid = new Map();
  const put = (k, v) => { let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(v); };
  for (const line of lines) {
    const p = line.p;
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      const pad = (line.w || 0) / 2 + 2;
      const x0 = Math.floor((Math.min(a[0], b[0]) - pad) / CELL), x1 = Math.floor((Math.max(a[0], b[0]) + pad) / CELL);
      const z0 = Math.floor((Math.min(a[1], b[1]) - pad) / CELL), z1 = Math.floor((Math.max(a[1], b[1]) + pad) / CELL);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) put(`${x},${z}`, { line, a, b });
    }
  }
  return grid;
}

function nearestSeg(grid, x, z, filter) {
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  let best = null;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (const s of grid.get(`${cx + dx},${cz + dz}`) || []) {
        if (filter && !filter(s.line)) continue;
        const ax = s.a[0], az = s.a[1], bx = s.b[0] - ax, bz = s.b[1] - az;
        const l2 = bx * bx + bz * bz || 1;
        const t = THREE.MathUtils.clamp(((x - ax) * bx + (z - az) * bz) / l2, 0, 1);
        const d = Math.hypot(x - ax - t * bx, z - az - t * bz);
        if (!best || d < best.d) best = { d, t, s, dir: Math.atan2(bz, bx) };
      }
    }
  }
  return best;
}

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function buildingIndex(buildings) {
  const grid = new Map();
  for (const b of buildings) {
    const ring = b.rings?.[0];
    if (!ring || ring.length < 3 || (b.ridge ?? 3) < 1.8) continue;          // kůlny a přístřešky projedeme
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const item = { ring, x0, x1, z0, z1 };
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const k = `${cx},${cz}`;
        let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(item);
      }
    }
  }
  return (x, z) => {
    for (const it of grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) || []) {
      if (x >= it.x0 && x <= it.x1 && z >= it.z0 && z <= it.z1 && pointInRing(x, z, it.ring)) return true;
    }
    return false;
  };
}

// ---------------------------------------------------------------- model auta
const PAINTS = [0xc8283a, 0x2f6fd6, 0xf0f0ec, 0x2b2f36, 0x2f9e6e, 0xf2b630];

function shape(pts) {
  // [x, y] nebo ['q', cx, cy, x, y] (kvadratická křivka)
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) {
    if (p[0] === 'q') s.quadraticCurveTo(p[1], p[2], p[3], p[4]);
    else s.lineTo(p[0], p[1]);
  }
  return s;
}

function extrude(sh, width, bevel, mat) {
  const g = new THREE.ExtrudeGeometry(sh, {
    depth: width - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: 3,
    curveSegments: 10,
  });
  g.translate(0, 0, -(width - 2 * bevel) / 2);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  return m;
}

/** Nízkopolygonové auto (x dopředu, y nahoru, délka 4,4 m): karoserie, prosklená kabina, střecha, kola, světla. */
export function createCarModel(paint = PAINTS[0]) {
  const car = new THREE.Group();
  const body = new THREE.Group();
  car.add(body);
  const paintMat = new THREE.MeshStandardMaterial({ color: paint, roughness: 0.32, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.06, metalness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.85 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd8dbe0, roughness: 0.25, metalness: 0.9 });
  const head = new THREE.MeshStandardMaterial({ color: 0xfff6dc, emissive: 0xfff2c8, emissiveIntensity: 0.6 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x8a0f12, emissive: 0xff2020, emissiveIntensity: 0.5 });
  const W = 1.8;

  // spodní karoserie až po linii oken
  body.add(extrude(shape([
    [-2.15, 0.34], [2.05, 0.34], ['q', 2.22, 0.36, 2.22, 0.62], ['q', 2.2, 0.86, 1.95, 0.9], [0.92, 1.02],
    [-1.62, 1.05], ['q', -2.14, 1.02, -2.22, 0.8], [-2.22, 0.48], ['q', -2.22, 0.36, -2.15, 0.34],
  ]), W, 0.08, paintMat));
  // kabina ze skla
  const cabin = [[0.95, 1.0], ['q', 0.56, 1.1, 0.16, 1.43], [-1.02, 1.45], ['q', -1.34, 1.41, -1.62, 1.03], [0.95, 1.0]];
  body.add(extrude(shape(cabin), W - 0.3, 0.05, glass));
  // střecha a sloupky
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.22, 0.07, W - 0.3), paintMat);
  roof.position.set(-0.43, 1.475, 0); roof.castShadow = true; body.add(roof);
  const post = (x0, y0, x1, y1, w = 0.07) => {
    const L = Math.hypot(x1 - x0, y1 - y0);
    for (const z of [1, -1]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(L, w, 0.06), paintMat);
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, z * ((W - 0.3) / 2 + 0.01));
      m.rotation.z = Math.atan2(y1 - y0, x1 - x0);
      body.add(m);
    }
  };
  post(0.95, 1.01, 0.16, 1.44);           // A
  post(-0.42, 1.04, -0.42, 1.46, 0.09);   // B
  post(-1.02, 1.46, -1.62, 1.04, 0.1);    // C

  // světla, mřížka, nárazníky, prahy, zrcátka
  for (const z of [0.58, -0.58]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.13, 0.38), head);
    h.position.set(2.24, 0.74, z); body.add(h);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.42), tail);
    t.position.set(-2.26, 0.84, z); body.add(t);
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.11, 0.16), paintMat);
    mirror.position.set(0.78, 1.06, Math.sign(z) * (W / 2 + 0.07)); body.add(mirror);
  }
  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.15, 0.66), dark);
  grille.position.set(2.235, 0.58, 0); body.add(grille);
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.6 });
  for (const x of [2.2, -2.22]) {
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.15, W + 0.02), dark);
    bumper.position.set(x, 0.42, 0); body.add(bumper);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.11, 0.5), plateMat);
    plate.position.set(x + Math.sign(x) * 0.09, x > 0 ? 0.43 : 0.62, 0); body.add(plate);
  }
  const sill = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.1, W + 0.02), dark);
  sill.position.set(-0.05, 0.37, 0); body.add(sill);

  // kola (s podběhy)
  const tireG = new THREE.CylinderGeometry(0.35, 0.35, 0.25, 22).rotateX(Math.PI / 2);
  const rimG = new THREE.CylinderGeometry(0.22, 0.22, 0.26, 12).rotateX(Math.PI / 2);
  const hubG = new THREE.BoxGeometry(0.05, 0.38, 0.265);
  const archG = new THREE.CylinderGeometry(0.42, 0.42, 0.06, 20, 1, false, 0, Math.PI).rotateX(Math.PI / 2);
  const wheels = [];
  for (const [x, z] of [[1.38, 0.79], [1.38, -0.79], [-1.32, 0.79], [-1.32, -0.79]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.35, z);
    const spin = new THREE.Group();
    const tire = new THREE.Mesh(tireG, dark);
    tire.castShadow = true;
    spin.add(tire, new THREE.Mesh(rimG, chrome));
    for (let k = 0; k < 3; k++) { const s = new THREE.Mesh(hubG, chrome); s.rotation.z = (k * Math.PI) / 3; spin.add(s); }
    pivot.add(spin);
    car.add(pivot);
    const arch = new THREE.Mesh(archG, dark);
    arch.position.set(x, 0.36, Math.sign(z) * (W / 2 + 0.005));
    body.add(arch);
    wheels.push({ pivot, spin, front: x > 0 });
  }

  // reflektory do noci
  const beams = [];
  for (const z of [0.55, -0.55]) {
    const sp = new THREE.SpotLight(0xfff1d6, 0, 70, 0.45, 0.6, 1.2);
    sp.position.set(2.2, 0.76, z);
    sp.target.position.set(12, -0.6, z * 3);
    body.add(sp, sp.target);
    beams.push(sp);
  }
  return { car, body, wheels, beams, head, tail, paintMat };
}

// ---------------------------------------------------------------- zvuk motoru
function createEngineSound() {
  let ctx = null, osc1, osc2, filt, gain, muted = false;
  try { muted = localStorage.getItem('stod3d.sound') === '0'; } catch { /* ignorovat */ }
  function start() {
    if (ctx || muted) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    osc1 = ctx.createOscillator(); osc1.type = 'sawtooth';
    osc2 = ctx.createOscillator(); osc2.type = 'square';
    filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 420; filt.Q.value = 3;
    gain = ctx.createGain(); gain.gain.value = 0;
    const g2 = ctx.createGain(); g2.gain.value = 0.35;
    osc1.connect(filt); osc2.connect(g2).connect(filt); filt.connect(gain).connect(ctx.destination);
    osc1.start(); osc2.start();
  }
  function update(rpm, load) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const f = 28 + rpm * 95;
    osc1.frequency.setTargetAtTime(f, t, 0.05);
    osc2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    filt.frequency.setTargetAtTime(260 + rpm * 520 + load * 500, t, 0.08);
    gain.gain.setTargetAtTime(muted ? 0 : 0.035 + load * 0.045, t, 0.08);
  }
  function stop() { if (ctx) { gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05); ctx.close(); ctx = null; } }
  function toggle() {
    muted = !muted;
    try { localStorage.setItem('stod3d.sound', muted ? '0' : '1'); } catch { /* ignorovat */ }
    if (muted) stop(); else start();
    return !muted;
  }
  return { start, update, stop, toggle, get on() { return !muted; } };
}

// ---------------------------------------------------------------- jízda
export function createDrive({ roads, bridges, buildings, streets, pois, world, scene, camera, onExit }) {
  const lines = roads.map((r) => ({ t: r.t, w: WIDTH[r.t], p: r.p }));
  const roadGrid = segIndex(lines);
  const streetGrid = segIndex((streets || []).flatMap((s) => s.paths.map((p) => ({ name: s.name, p, w: 10 }))));
  const bridgeGrid = segIndex(bridges.map((p) => ({ bridge: p, p, w: 8 })));
  const hitsBuilding = buildingIndex(buildings);

  let paintIdx = 0;
  try { paintIdx = +(localStorage.getItem('stod3d.paint') || 0) % PAINTS.length; } catch { /* ignorovat */ }
  const model = createCarModel(PAINTS[paintIdx]);
  model.car.visible = false;
  scene.add(model.car);
  const sound = createEngineSound();

  const st = {
    x: 0, z: 0, y: 0, heading: 0, v: 0, steer: 0, pitch: 0, roll: 0, active: false,
    view: 0, camPos: new THREE.Vector3(), camLook: new THREE.Vector3(), odo: 0, surface: -1,
  };
  const VIEWS = ['za autem', 'zdálky', 'z kabiny'];
  let lastLabel = '';

  // HUD
  const hud = document.createElement('div');
  hud.id = 'drive-hud';
  hud.hidden = true;
  hud.innerHTML = `
    <canvas class="dh-map" width="360" height="360"></canvas>
    <div class="dh-goal" hidden></div>
    <div class="dh-speed"><b>0</b><span>km/h</span></div>
    <div class="dh-where"><div class="dh-street">–</div><div class="dh-surface"></div></div>
    <div class="dh-tools">
      <button data-act="goal" title="Cíl jízdy – náhodná zajímavost v okolí (T)">🎯</button>
      <button data-act="view" title="Pohled (C)">🎥</button>
      <button data-act="paint" title="Barva auta (P)">🎨</button>
      <button data-act="sound" title="Zvuk (M)">🔊</button>
      <button data-act="exit" title="Vystoupit (Esc / O)">✕</button>
    </div>
    <div class="dh-help">↑/W plyn · ↓/S brzda a couvání · ←/→ zatáčení · mezerník ruční brzda · C pohled</div>`;
  document.body.appendChild(hud);
  // mapka a cíl mimo HUD (ten má transform, uvnitř by „fixed“ neplatilo k oknu)
  const mapEl = hud.querySelector('.dh-map'), goalEl = hud.querySelector('.dh-goal');
  mapEl.hidden = true;
  document.body.append(mapEl, goalEl);
  const touch = document.createElement('div');
  touch.id = 'drive-touch';
  touch.hidden = true;
  touch.innerHTML = `<div class="dt-steer"><button data-k="ArrowLeft">◀</button><button data-k="ArrowRight">▶</button></div>
    <div class="dt-pedals"><button data-k="ArrowDown" class="brake">▼</button><button data-k="ArrowUp" class="gas">▲</button></div>`;
  document.body.appendChild(touch);
  const touchKeys = new Set();
  touch.querySelectorAll('button').forEach((b) => {
    const on = (e) => { e.preventDefault(); touchKeys.add(b.dataset.k); b.classList.add('on'); sound.start(); };
    const off = (e) => { e.preventDefault(); touchKeys.delete(b.dataset.k); b.classList.remove('on'); };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off); b.addEventListener('pointerleave', off);
  });
  const $ = (s) => hud.querySelector(s);
  hud.querySelector('[data-act=view]').onclick = () => cycleView();
  hud.querySelector('[data-act=goal]').onclick = () => newGoal();
  hud.querySelector('[data-act=paint]').onclick = () => repaint();
  hud.querySelector('[data-act=sound]').onclick = () => toggleSound();
  hud.querySelector('[data-act=exit]').onclick = () => onExit?.();
  const soundBtn = hud.querySelector('[data-act=sound]');
  soundBtn.textContent = sound.on ? '🔊' : '🔇';

  function cycleView() { st.view = (st.view + 1) % VIEWS.length; flash(`Pohled: ${VIEWS[st.view]}`); }
  function repaint() {
    paintIdx = (paintIdx + 1) % PAINTS.length;
    model.paintMat.color.setHex(PAINTS[paintIdx]);
    try { localStorage.setItem('stod3d.paint', String(paintIdx)); } catch { /* ignorovat */ }
  }
  function toggleSound() { soundBtn.textContent = sound.toggle() ? '🔊' : '🔇'; }
  let flashT = 0;
  function flash(text) { $('.dh-surface').textContent = text; flashT = 1.5; }

  // ---------------------------------------------------------------- cíl jízdy
  const goalBox = goalEl;
  let goal = null, reached = 0;
  const fmtDist = (d) => (d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`);
  const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  function newGoal() {
    const list = (pois || []).filter((p) => {
      const d = Math.hypot(p.x - st.x, p.z - st.z);
      return d > 250 && d < 2600 && Math.abs(p.x) < world.W / 2 - 50 && Math.abs(p.z) < world.H / 2 - 50;
    });
    if (!list.length) { flash('Žádná zajímavost v dosahu'); return; }
    const p = list[Math.floor(Math.random() * list.length)];
    goal = { name: p.name, x: p.x, z: p.z, t0: performance.now() };
    goalBox.hidden = false;
    flash('Nový cíl – sledujte šipku na mapce');
  }
  function updateGoal() {
    if (!goal) return;
    const elapsed = (performance.now() - goal.t0) / 1000;
    const d = Math.hypot(goal.x - st.x, goal.z - st.z);
    if (d < 35) {
      reached++;
      goalBox.innerHTML = `🏁 <b>${goal.name}</b> · za ${fmtTime(elapsed)} · cílů: ${reached}`;
      flash('Cíl! Další dá 🎯');
      goal = null;
      return;
    }
    goalBox.innerHTML = `🎯 <b>${goal.name}</b> · ${fmtDist(d)} · ${fmtTime(elapsed)}`;
  }

  // ---------------------------------------------------------------- mapka (natočená po směru jízdy)
  const mapCanvas = mapEl;
  const mctx = mapCanvas.getContext('2d');
  const MAP_COL = ['#f4f1ea', '#f4f1ea', '#e7e3da', '#d9d4c8', '#cfc7b4', '#c9b993', '#b49a72', '#a88f6c', '#6c6158'];
  const MAP_W = [7, 6, 4.5, 3.5, 3.2, 3, 2.6, 1.5, 2];
  let mapT = 0;
  function drawMap() {
    const S = mapCanvas.width, c = S / 2, R = 260, k = c / R;
    const ch = Math.cos(st.heading), sh = Math.sin(st.heading);
    const tx = (x, z) => {
      const dx = x - st.x, dz = z - st.z;
      const f = dx * ch + dz * sh, r = -dx * sh + dz * ch;
      return [c + r * k, c - f * k];
    };
    mctx.clearRect(0, 0, S, S);
    mctx.save();
    mctx.beginPath(); mctx.arc(c, c, c - 2, 0, Math.PI * 2); mctx.clip();
    mctx.fillStyle = 'rgba(40, 58, 46, 0.9)'; mctx.fillRect(0, 0, S, S);
    const seen = new Set();
    const cx0 = Math.floor((st.x - R) / CELL), cx1 = Math.floor((st.x + R) / CELL);
    const cz0 = Math.floor((st.z - R) / CELL), cz1 = Math.floor((st.z + R) / CELL);
    mctx.lineCap = 'round';
    for (let pass = 8; pass >= 0; pass--) {
      mctx.strokeStyle = MAP_COL[pass]; mctx.lineWidth = MAP_W[pass] * k * 1.6 + 1.2;
      mctx.beginPath();
      for (let gx = cx0; gx <= cx1; gx++) {
        for (let gz = cz0; gz <= cz1; gz++) {
          for (const sg of roadGrid.get(`${gx},${gz}`) || []) {
            if (sg.line.t !== pass || seen.has(sg)) continue;
            seen.add(sg);
            const [ax, ay] = tx(sg.a[0], sg.a[1]), [bx, by] = tx(sg.b[0], sg.b[1]);
            mctx.moveTo(ax, ay); mctx.lineTo(bx, by);
          }
        }
      }
      mctx.stroke();
    }
    if (goal) {
      let [gx, gy] = tx(goal.x, goal.z);
      const dx = gx - c, dy = gy - c, d = Math.hypot(dx, dy);
      const out = d > c - 18;
      if (out) { gx = c + (dx / d) * (c - 18); gy = c + (dy / d) * (c - 18); }
      mctx.fillStyle = '#ffb547'; mctx.strokeStyle = '#3a2a10'; mctx.lineWidth = 3;
      mctx.beginPath();
      if (out) {
        const a = Math.atan2(dy, dx);
        mctx.moveTo(gx + Math.cos(a) * 14, gy + Math.sin(a) * 14);
        mctx.lineTo(gx + Math.cos(a + 2.4) * 12, gy + Math.sin(a + 2.4) * 12);
        mctx.lineTo(gx + Math.cos(a - 2.4) * 12, gy + Math.sin(a - 2.4) * 12);
      } else mctx.arc(gx, gy, 10, 0, Math.PI * 2);
      mctx.closePath(); mctx.stroke(); mctx.fill();
    }
    mctx.restore();
    // auto uprostřed, sever
    mctx.fillStyle = '#ff5a4f'; mctx.strokeStyle = '#fff'; mctx.lineWidth = 3;
    mctx.beginPath(); mctx.moveTo(c, c - 16); mctx.lineTo(c + 11, c + 12); mctx.lineTo(c, c + 6); mctx.lineTo(c - 11, c + 12);
    mctx.closePath(); mctx.stroke(); mctx.fill();
    const [nx, ny] = tx(st.x, st.z - 1000);
    const na = Math.atan2(ny - c, nx - c);
    mctx.fillStyle = '#fff'; mctx.font = 'bold 22px system-ui, sans-serif'; mctx.textAlign = 'center'; mctx.textBaseline = 'middle';
    mctx.fillText('S', c + Math.cos(na) * (c - 16), c + Math.sin(na) * (c - 16));
  }

  function bridgeY(x, z) {
    const n = nearestSeg(bridgeGrid, x, z);
    if (!n || n.d > 5) return null;
    const b = n.s.line.bridge;
    const [ax, az] = b[0], [bx, bz] = b[b.length - 1];
    const ext = 4, L = Math.hypot(bx - ax, bz - az) || 1, ux = (bx - ax) / L, uz = (bz - az) / L;
    const ha = world.heightAt(ax - ux * ext, az - uz * ext), hb = world.heightAt(bx + ux * ext, bz + uz * ext);
    const tt = ((x - ax) * ux + (z - az) * uz + ext) / (L + 2 * ext);
    return THREE.MathUtils.lerp(ha, hb, THREE.MathUtils.clamp(tt, 0, 1)) + 0.3;
  }

  /** Povrch pod bodem: typ komunikace (nebo -1 mimo cestu) a výška jízdní plochy. */
  function surfaceAt(x, z) {
    const n = nearestSeg(roadGrid, x, z, (l) => l.t !== 8);
    const on = n && n.d <= n.s.line.w / 2 + 0.4 ? n.s.line.t : -1;
    const br = on >= 0 ? bridgeY(x, z) : null;
    const y = (br ?? world.heightAt(x, z)) + (on >= 0 ? LIFT[on] : 0.02);
    return { type: on, y, seg: n };
  }

  function start(x, z, heading) {
    // na nejbližší silnici nebo cestu (do 400 m) ve směru, kterým se díváme
    const n = nearestSeg(roadGrid, x, z, (l) => l.t <= 6);
    let hx = x, hz = z, h = heading;
    if (n && n.d < 400) {
      const s = n.s;
      hx = s.a[0] + (s.b[0] - s.a[0]) * n.t; hz = s.a[1] + (s.b[1] - s.a[1]) * n.t;
      const d = n.dir;
      const diff = Math.atan2(Math.sin(heading - d), Math.cos(heading - d));
      h = Math.abs(diff) < Math.PI / 2 ? d : d + Math.PI;
      // na pravý jízdní pruh
      const off = Math.min(1.6, s.line.w / 4);
      hx += -Math.sin(h) * off; hz += Math.cos(h) * off;          // vpravo od středu cesty
    }
    Object.assign(st, { x: hx, z: hz, heading: h, v: 0, steer: 0, active: true });
    st.y = surfaceAt(hx, hz).y;
    model.car.visible = true;
    hud.hidden = false;
    mapEl.hidden = false;
    goalEl.hidden = !goal && !reached;
    touch.hidden = !matchMedia('(pointer: coarse)').matches;
    placeCamera(true);
    sound.start();
  }

  function stop() {
    st.active = false;
    model.car.visible = false;
    hud.hidden = true;
    mapEl.hidden = true;
    goalEl.hidden = true;
    touch.hidden = true;
    touchKeys.clear();
    sound.stop();
    return { x: st.x, y: st.y, z: st.z, heading: st.heading };
  }

  const fwd = new THREE.Vector3(), tmpV = new THREE.Vector3();
  function placeCamera(instant, dt = 0.016) {
    const cx = Math.cos(st.heading), cz = Math.sin(st.heading);
    const [back, up, ahead] = st.view === 0 ? [8.2, 3.4, 5] : st.view === 1 ? [17, 9, 6] : [-0.2, 1.32, 20];
    const want = tmpV.set(st.x - cx * back, st.y + up, st.z - cz * back);
    if (st.view !== 2) want.y = Math.max(want.y, world.heightAt(want.x, want.z) + 1.2);
    const look = fwd.set(st.x + cx * ahead, st.y + (st.view === 2 ? 1.2 : 1.1), st.z + cz * ahead);
    const k = instant || st.view === 2 ? 1 : 1 - Math.exp(-dt * 6);
    st.camPos.lerp(want, k);
    if (instant) st.camPos.copy(want);
    st.camLook.lerp(look, instant ? 1 : 1 - Math.exp(-dt * 10));
    if (instant) st.camLook.copy(look);
    camera.position.copy(st.camPos);
    camera.lookAt(st.camLook);
  }

  addEventListener('keydown', (e) => {
    if (!st.active || e.repeat) return;
    if (e.code === 'KeyC') cycleView();
    if (e.code === 'KeyT') newGoal();
    if (e.code === 'KeyP') repaint();
    if (e.code === 'KeyM') toggleSound();
    if (e.code === 'Space') e.preventDefault();
  });

  function update(dt, keys) {
    if (!st.active) return false;
    const k = (...c) => c.some((x) => keys.has(x) || touchKeys.has(x));
    const gas = k('KeyW', 'ArrowUp') ? 1 : 0;
    const brake = k('KeyS', 'ArrowDown') ? 1 : 0;
    const steerIn = (k('KeyA', 'ArrowLeft') ? 1 : 0) - (k('KeyD', 'ArrowRight') ? 1 : 0);
    const hand = k('Space');

    const surf = surfaceAt(st.x, st.z);
    const type = surf.type;
    const maxV = type >= 0 ? MAX_SPEED[type] : OFFROAD.max;
    const grip = type >= 0 ? GRIP[type] : OFFROAD.grip;
    const rolling = type >= 0 ? 0.25 + (type >= 5 ? 0.6 : 0) : OFFROAD.rolling;

    // podélně: plyn, brzda/couvání, odpor, svah
    let v = st.v;
    if (gas) v += (v < 0 ? 9 : 4.2 * (1 - Math.max(0, v) / (maxV * 1.15))) * dt;
    if (brake) v -= (v > 0.3 ? 9 : 3.2) * dt;
    if (!brake && v < 0 && !gas) v = Math.min(0, v + 3 * dt);
    if (hand) v -= Math.sign(v) * Math.min(Math.abs(v), 10 * dt);
    v -= Math.sign(v) * Math.min(Math.abs(v), (rolling + 0.0016 * v * v) * dt);
    v -= 9.81 * Math.sin(st.pitch) * dt * 0.6;
    if (v > maxV) v -= (v - maxV) * 2 * dt;
    v = THREE.MathUtils.clamp(v, -6, 34);
    if (!gas && !brake && Math.abs(v) < 0.05) v = 0;

    // řízení: menší rejd ve vyšší rychlosti
    const maxSteer = 0.58 / (1 + Math.abs(v) / 11);
    st.steer += (steerIn * maxSteer - st.steer) * Math.min(1, dt * 6);
    const yawRate = (v * Math.tan(st.steer)) / WHEELBASE * (hand ? 1.25 : grip);
    const newHeading = st.heading - yawRate * dt;

    const nx = st.x + Math.cos(newHeading) * v * dt, nz = st.z + Math.sin(newHeading) * v * dt;
    // srážka s budovou: předek / zadek auta
    const dir = Math.sign(v) || 1;
    const px = nx + Math.cos(newHeading) * 2.1 * dir, pz = nz + Math.sin(newHeading) * 2.1 * dir;
    const lim = world.W / 2 - 5, limZ = world.H / 2 - 5;
    if (hitsBuilding(px, pz) || Math.abs(nx) > lim || Math.abs(nz) > limZ) {
      v = -v * 0.25;
      if (Math.abs(st.v) > 4) flash('Bum! Pozor na domy');
    } else {
      st.x = nx; st.z = nz;
      st.odo += Math.abs(v * dt);
    }
    st.heading = newHeading;
    st.v = v;

    // výška, náklon podle terénu pod koly
    const ch = Math.cos(st.heading), sh = Math.sin(st.heading);
    const hF = surfaceAt(st.x + ch * 1.3, st.z + sh * 1.3).y, hB = surfaceAt(st.x - ch * 1.3, st.z - sh * 1.3).y;
    const hL = surfaceAt(st.x + sh * 0.8, st.z - ch * 0.8).y, hR = surfaceAt(st.x - sh * 0.8, st.z + ch * 0.8).y;
    const targetY = (hF + hB + hL + hR) / 4;
    st.y += (targetY - st.y) * Math.min(1, dt * 14);
    st.pitch += (Math.atan2(hF - hB, 2.6) - st.pitch) * Math.min(1, dt * 10);
    st.roll += (Math.atan2(hL - hR, 1.6) - st.roll) * Math.min(1, dt * 10);

    // model
    const car = model.car;
    car.position.set(st.x, st.y, st.z);
    car.rotation.order = 'YZX';
    car.rotation.set(st.roll, -st.heading, st.pitch);
    // lehké naklonění karoserie v zatáčce a při brzdění
    model.body.rotation.x = THREE.MathUtils.clamp(-yawRate * v * 0.006, -0.06, 0.06);
    model.body.rotation.z = THREE.MathUtils.clamp((brake && v > 1 ? -0.025 : 0) + (gas ? 0.012 : 0), -0.04, 0.03);
    for (const w of model.wheels) {
      w.spin.rotation.z -= (v * dt) / 0.35;
      if (w.front) w.pivot.rotation.y = st.steer;
    }
    const night = NIGHT.night.value;
    for (const b of model.beams) b.intensity = night * 60;
    model.head.emissiveIntensity = 0.3 + night * 2.2;
    model.tail.emissiveIntensity = (brake ? 1.6 : 0.35) + night * 0.8;

    placeCamera(false, dt);
    updateGoal();
    mapT -= dt;
    if (mapT <= 0) { mapT = 0.08; drawMap(); }

    // tachometr a místo (název ulice jen občas)
    $('.dh-speed b').textContent = Math.round(Math.abs(v) * 3.6);
    if (flashT > 0) flashT -= dt;
    else {
      const sn = nearestSeg(streetGrid, st.x, st.z);
      const street = sn && sn.d < 14 ? sn.s.line.name : '';
      const label = (street || (type >= 0 ? SURFACE_NAME[type] : 'mimo cestu')) + '|' + (type >= 0 ? SURFACE_NAME[type] : 'mimo cestu');
      if (label !== lastLabel) {
        lastLabel = label;
        const [a, b] = label.split('|');
        $('.dh-street').textContent = a;
        $('.dh-surface').textContent = a === b ? '' : b;
      }
    }
    const rpmBase = Math.abs(v) / Math.max(8, maxV);
    sound.update(0.15 + (rpmBase * 3) % 1 * 0.6 + rpmBase * 0.4, gas ? 1 : 0.2);
    return true;
  }

  return { start, stop, update, get active() { return st.active; }, state: st };
}
