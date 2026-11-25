import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { World } from './js/world.js';
import { createBuildings } from './js/buildings.js';
import { createTrees } from './js/trees.js';
import { createRoads } from './js/roads.js';
import { prepareBridges, createBridges } from './js/bridges.js';
import { createFences } from './js/fences.js';
import { createPower } from './js/power.js';
import { createLabels } from './js/labels.js';
import { createReport } from './js/report.js';
import { createSky, applySun, createTimeControls } from './js/sun.js';
import { createLamps, updateLamps } from './js/lamps.js';
import { createDrive } from './js/drive.js';
import { createPosts } from './js/posts.js';
import { createSigns } from './js/signs.js';
import { createLandmarks, createRoundabouts, EXTRA_BRIDGES } from './js/landmarks.js';
import { createPlaceSigns } from './js/placesigns.js';
import { createTraffic } from './js/traffic.js';
import { createLife } from './js/life.js';

// ------------------------------------------------------------------ renderer
const canvas = document.getElementById('scene');
const isCoarse = matchMedia('(pointer: coarse)').matches;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, isCoarse ? 1.5 : 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.NoToneMapping;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xe4eef4, 1500, 8000);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 20000);

// ------------------------------------------------------------------ načítání
const loaderText = document.getElementById('loader-text');
const loaderBar = document.getElementById('loader-bar');
let loaded = 0;
const step = (x) => { loaderBar.style.width = `${(++loaded / 8) * 100}%`; return x; };
const get = (p, kind = 'json') => fetch(`data/${p}`).then((r) => {
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return kind === 'json' ? r.json() : r.arrayBuffer();
}).then(step);

const meta = await get('meta.json');
loaderText.textContent = 'Načítám terén, budovy a cesty…';
const [farH, farTex, buildings, roads, bridges, fences, power, treesBuf, poiData, lamps, signs, stops] = await Promise.all([
  get('far_h.bin', 'bin'),
  new THREE.TextureLoader().loadAsync('data/far.png'),
  get('buildings.json'), get('roads.json'), get('bridges.json'), get('fences.json'), get('power.json'),
  get('trees.bin', 'bin'),
  fetch('data/poi.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  fetch('data/lamps.json').then((r) => (r.ok ? r.json() : [])).catch(() => []),
  fetch('data/signs.json').then((r) => (r.ok ? r.json() : [])).catch(() => []),
  fetch('data/stops.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
]);
farTex.colorSpace = THREE.SRGBColorSpace;
farTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
loaderText.textContent = 'Stavím scénu…';
await new Promise(requestAnimationFrame);

let dirty = true;
const invalidate = () => { dirty = true; };

// ------------------------------------------------------------------ obloha a světlo podle skutečného slunce
const sky = createSky();
scene.add(sky.mesh);
const sun = new THREE.DirectionalLight(0xfff4e4, 2.0);
sun.shadow.mapSize.setScalar(2048);
sun.shadow.bias = -0.0015;
sun.userData.dir = new THREE.Vector3(0.3, 0.7, 0.6).normalize();
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xe8f2ff, 0xc2c8a8, 2.1);
scene.add(hemi);
let sunPos = { el: 40, az: 205 };
let signLayer = null;

// stíny – přepínač (pamatuje si volbu); na mobilu ve výchozím stavu vypnuté
let shadows = !isCoarse;
try { const v = localStorage.getItem('stod3d.shadows'); if (v !== null) shadows = v === '1'; } catch { /* ignorovat */ }
function applyLight() {
  applySun(sunPos, { sun, hemi, sky, fog: scene.fog, renderer, shadowsWanted: shadows });
  updateLamps();
  signLayer?.update();
  scene.traverse((o) => { if (o.material && !o.material.isShaderMaterial) o.material.needsUpdate = true; });
  invalidate();
}
function applyShadows() {
  const cb = document.getElementById('shadows');
  if (cb) cb.checked = shadows;
  applyLight();
}

function updateSun(focus, dist) {
  const ext = THREE.MathUtils.clamp(dist * 1.2, 60, 1400);
  const cam = sun.shadow.camera;
  if (Math.abs(cam.right - ext) > ext * 0.1) {
    Object.assign(cam, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 5000 });
    cam.updateProjectionMatrix();
    sun.shadow.normalBias = 0.1 + ext / 700;
  }
  // zarovnat střed na mřížku stínové mapy, jinak se stíny při pohybu chvějí
  const texel = (2 * cam.right) / sun.shadow.mapSize.x;
  const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
  sun.target.position.set(fx, focus.y, fz);
  sun.position.copy(sun.target.position).addScaledVector(sun.userData.dir, 2000);
}

// ------------------------------------------------------------------ svět
const world = new World({ meta, farH: new Uint16Array(farH), farTex, scene, onChange: invalidate });
const landmarks = createLandmarks({ buildings });
scene.add(landmarks.group);
const trees = createTrees({ buf: treesBuf, meta, world, exclude: landmarks.keepOut });
const fenceLayer = createFences({ fences, world });
const bridgeInfo = prepareBridges([...bridges, ...EXTRA_BRIDGES], roads, world);
world.builders.push(createRoads({ roads, bridges: bridgeInfo, world }), createBridges({ info: bridgeInfo, world }), trees.build, fenceLayer.build, createPower({ power, world }));
world.lodHooks.push(fenceLayer.lod);
world.builders.push(createLamps({ lamps, world }));
world.builders.push(createPosts({ roads, buildings, bridges: bridgeInfo, world }));
scene.add(createBuildings({ buildings, world, skip: landmarks.skip }));
signLayer = createSigns({ signs, buildings, roads, world });
signLayer.update();
scene.add(signLayer);
const placeSigns = createPlaceSigns({ roads, buildings, places: poiData?.places, bridges: bridgeInfo, world });
scene.add(placeSigns);
world.builders.push(() => placeSigns.userData.refresh?.());
const roundabouts = createRoundabouts({ world });
scene.add(roundabouts);
world.builders.push(() => roundabouts.userData.refresh());

// okolí za hranou území
{
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x92ac62 }));
  ground.position.y = -6;
  scene.add(ground);
}

// ------------------------------------------------------------------ ovládání
const orbit = new MapControls(camera, canvas);
Object.assign(orbit, {
  enableDamping: true, dampingFactor: 0.08, screenSpacePanning: false,
  maxPolarAngle: 1.5, minDistance: 5, maxDistance: 4500, zoomToCursor: true,
});
const look = new PointerLockControls(camera, canvas);
const keys = new Set();
let mode = 'orbit';

// projížďka autem (režim „drive“)
const drive = createDrive({
  roads, bridges: bridgeInfo, buildings, streets: poiData?.streets, pois: poiData?.pois, world, scene, camera,
  onExit: () => setMode('orbit'),
});

// živá mapa: doprava, lidé, zvířata (přepínače si pamatují volbu)
const traffic = createTraffic({ roads, bridges: bridgeInfo, buildings, world, scene, stops, coarse: isCoarse, drive });
const life = createLife({ roads, bridges: bridgeInfo, buildings, world, scene, meta, treesBuf, stops, coarse: isCoarse });
world.builders.push(() => traffic.refreshStops());
{
  const opt = (key, def) => { try { const v = localStorage.getItem(`stod3d.${key}`); return v === null ? def : v === '1'; } catch { return def; } };
  const bind = (id, key, apply) => {
    const cb = document.getElementById(id);
    cb.checked = opt(key, true);
    apply(cb.checked);
    cb.addEventListener('change', () => {
      try { localStorage.setItem(`stod3d.${key}`, cb.checked ? '1' : '0'); } catch { /* ignorovat */ }
      apply(cb.checked);
      invalidate();
    });
  };
  bind('live-traffic', 'traffic', (v) => { traffic.setEnabled(v); drive.setBots(!v); });
  bind('live-people', 'people', (v) => life.setPeople(v));
  bind('live-animals', 'animals', (v) => life.setAnimals(v));
}
window.stod3d = { drive, world, camera, orbit, signs: signLayer, placeSigns, traffic, life };      // pro ladění v konzoli

// ------------------------------------------------------------------ plynulý přelet
let anim = null;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);   // rozjezd i dobrzdění

/**
 * Přelet na bod (x, z): nejdřív natočení směrem ke středu Stodu, pak let.
 * V cíli se kamera dívá na místo od strany, za kterou je v dálce Stod; nízký sklon → víc vidět do krajiny.
 */
const PITCH = THREE.MathUtils.degToRad(20);
function flyToXZ(x, z, dist = 500, instant = false) {
  if (mode !== 'orbit') setMode('orbit');
  const g = world.heightAt(x, z);
  const [sx, sz] = meta.places.Stod;
  const dir = new THREE.Vector3(sx - x, 0, sz - z);               // směr pohledu: k centru Stodu
  if (dir.lengthSq() < 150 * 150) dir.subVectors(orbit.target, camera.position).setY(0);
  if (dir.lengthSq() < 1) dir.set(0, 0, -1);
  dir.normalize();
  const endT = new THREE.Vector3(x, g, z);
  const endC = endT.clone().addScaledVector(dir, -dist * Math.cos(PITCH)).setY(g + dist * Math.sin(PITCH));
  endC.y = Math.max(endC.y, world.heightAt(endC.x, endC.z) + 15);
  if (instant) {
    orbit.target.copy(endT);
    camera.position.copy(endC);
    orbit.update();
    invalidate();
    return;
  }
  // fáze 1: otočení kolem současného středu tak, aby se kamera dívala ve směru dir
  const off = new THREE.Vector3().subVectors(camera.position, orbit.target);
  const s0 = new THREE.Spherical().setFromVector3(off);
  const s1 = new THREE.Spherical().setFromVector3(dir.clone().negate().setY(0.0001));
  let dTheta = s1.theta - s0.theta;
  dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));        // nejkratší cestou
  const travel = Math.hypot(x - orbit.target.x, z - orbit.target.z);
  anim = {
    phase: 'turn', t0: performance.now(), dur: 350 + Math.abs(dTheta) * 230,
    s0, dTheta, endT, endC,
    flyDur: THREE.MathUtils.clamp(900 + travel * 0.45, 1000, 2200),
    arc: Math.min(travel * 0.22, 600),
  };
  invalidate();
}

function stepAnim() {
  const now = performance.now();
  const t = Math.min(1, (now - anim.t0) / anim.dur);
  const e = ease(t);
  if (anim.phase === 'turn') {
    const sp = anim.s0.clone();
    sp.theta += anim.dTheta * e;
    camera.position.copy(orbit.target).add(new THREE.Vector3().setFromSpherical(sp));
    camera.lookAt(orbit.target);
    if (t >= 1) {
      Object.assign(anim, { phase: 'fly', t0: now, dur: anim.flyDur, fromT: orbit.target.clone(), fromC: camera.position.clone() });
    }
    return;
  }
  orbit.target.lerpVectors(anim.fromT, anim.endT, e);
  camera.position.lerpVectors(anim.fromC, anim.endC, e);
  camera.position.y += Math.sin(Math.PI * t) * anim.arc;
  camera.lookAt(orbit.target);
  if (t >= 1) { anim = null; orbit.update(); orbit.dispatchEvent({ type: 'change' }); }
}

function flyTo(name, instant = false) {
  const [x, z] = meta.places[name];
  flyToXZ(x, z, 560, instant);
}

function setMode(next) {
  if (next === mode) return;
  let fromCar = null;
  if (mode === 'drive') fromCar = drive.stop();
  if (next === 'drive') {
    look.unlock();
    orbit.enabled = false;
    anim = null;
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const at = mode === 'orbit' ? orbit.target : camera.position;
    drive.start(at.x, at.z, Math.atan2(dir.z, dir.x));
  } else if (next === 'orbit' && fromCar) {
    // z auta na mapu: pohled shora šikmo na místo, kde auto stojí
    orbit.target.set(fromCar.x, fromCar.y, fromCar.z);
    const back = new THREE.Vector3(-Math.cos(fromCar.heading), 0, -Math.sin(fromCar.heading));
    camera.position.set(fromCar.x, fromCar.y, fromCar.z).addScaledVector(back, 90).setY(fromCar.y + 70);
    camera.lookAt(orbit.target);
    orbit.enabled = true;
    orbit.update();
  } else if (next === 'orbit') {
    look.unlock();
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const t = camera.position.clone().addScaledVector(dir, 120);
    t.y = world.heightAt(t.x, t.z);
    orbit.target.copy(t);
    orbit.enabled = true;
  } else {
    orbit.enabled = false;
    if (next === 'walk') camera.position.y = world.heightAt(camera.position.x, camera.position.z) + 1.7;
    const dir = camera.getWorldDirection(new THREE.Vector3());
    dir.y = THREE.MathUtils.clamp(dir.y, -0.35, 0.35);
    camera.lookAt(camera.position.clone().add(dir));
  }
  mode = next;
  document.body.classList.toggle('driving', mode === 'drive');
  document.querySelectorAll('#modes [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  document.querySelectorAll('#help [data-help]').forEach((d) => { d.hidden = d.dataset.help !== mode; });
  invalidate();
}

document.querySelectorAll('#modes [data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
// sbalení menu (na mobilu ve výchozím stavu sbalené)
{
  const panel = document.getElementById('title'), btn = document.getElementById('panel-collapse');
  const set = (open) => { panel.classList.toggle('collapsed', !open); btn.setAttribute('aria-expanded', String(open)); };
  set(!isCoarse);
  btn.onclick = () => set(panel.classList.contains('collapsed'));
}
// nápověda k ovládání – ve výchozím stavu zabalená do ikonky
{
  const help = document.getElementById('help'), btn = document.getElementById('help-toggle');
  const set = (open) => { help.hidden = !open; btn.hidden = open; btn.setAttribute('aria-expanded', String(open)); };
  btn.onclick = () => set(true);
  help.querySelector('.help-close').onclick = () => set(false);
}
document.getElementById('shadows').addEventListener('change', (e) => {
  shadows = e.target.checked;
  try { localStorage.setItem('stod3d.shadows', shadows ? '1' : '0'); } catch { /* ignorovat */ }
  applyShadows();
});
canvas.addEventListener('click', () => { if ((mode === 'fly' || mode === 'walk') && !look.isLocked) look.lock(); });
orbit.addEventListener('change', invalidate);
orbit.addEventListener('start', () => { anim = null; });
look.addEventListener('change', invalidate);

addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code.startsWith('Arrow') || e.code === 'PageUp' || e.code === 'PageDown') e.preventDefault();
  if (e.repeat) return;
  if (e.code === 'KeyO' || (e.code === 'Escape' && mode === 'drive')) setMode('orbit');
  if (e.code === 'KeyV') setMode('drive');
  if (mode === 'drive') return;                 // v autě jsou W/A/S/D a šipky pedály a volant
  if (e.code === 'KeyF') setMode('fly');
  if (e.code === 'KeyG') setMode('walk');
  if (e.code === 'KeyR') flyTo('Stod');
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

const fwd = new THREE.Vector3(), right = new THREE.Vector3(), move = new THREE.Vector3();
function updateFree(dt) {
  const walk = mode === 'walk';
  const fast = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const speed = walk ? (fast ? 9 : 3) : (fast ? 220 : 50);
  camera.getWorldDirection(fwd);
  if (walk) fwd.y = 0;
  fwd.normalize();
  right.crossVectors(fwd, camera.up).normalize();
  move.set(0, 0, 0);
  if (keys.has('KeyW') || keys.has('ArrowUp')) move.add(fwd);
  if (keys.has('KeyS') || keys.has('ArrowDown')) move.sub(fwd);
  if (keys.has('KeyD') || keys.has('ArrowRight')) move.add(right);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) move.sub(right);
  if (!walk && keys.has('KeyE')) move.y += 1;
  if (!walk && keys.has('KeyQ')) move.y -= 1;
  if (move.lengthSq()) { camera.position.addScaledVector(move.normalize(), speed * dt); dirty = true; }
  if (walk) {
    const target = world.heightAt(camera.position.x, camera.position.z) + 1.7;
    if (Math.abs(target - camera.position.y) > 0.01) {
      camera.position.y += (target - camera.position.y) * Math.min(1, dt * 10);
      dirty = true;
    }
  }
}

// ovládání mapy klávesnicí (režim Mapa), podobně jako běžné mapové aplikace:
//   ←↑↓→ / WASD posun · Q/E nebo Shift+←/→ otáčení · Shift+↑/↓ náklon · +/− nebo PgUp/PgDn zoom
const panF = new THREE.Vector3(), panR = new THREE.Vector3(), panD = new THREE.Vector3();
const sph = new THREE.Spherical(), off = new THREE.Vector3();
const has = (...c) => c.some((k) => keys.has(k));
function panByKeys(dt) {
  const shift = has('ShiftLeft', 'ShiftRight');
  let f = 0, r = 0, rot = 0, tilt = 0, zoom = 0;
  if (has('KeyW') || (!shift && has('ArrowUp'))) f += 1;
  if (has('KeyS') || (!shift && has('ArrowDown'))) f -= 1;
  if (has('KeyD') || (!shift && has('ArrowRight'))) r += 1;
  if (has('KeyA') || (!shift && has('ArrowLeft'))) r -= 1;
  if (has('KeyQ') || (shift && has('ArrowLeft'))) rot -= 1;
  if (has('KeyE') || (shift && has('ArrowRight'))) rot += 1;
  if (shift && has('ArrowUp')) tilt -= 1;
  if (shift && has('ArrowDown')) tilt += 1;
  if (has('Equal', 'NumpadAdd', 'PageUp', 'BracketRight')) zoom -= 1;
  if (has('Minus', 'NumpadSubtract', 'PageDown', 'Slash')) zoom += 1;
  if (!f && !r && !rot && !tilt && !zoom) return;
  anim = null;

  const dist = camera.position.distanceTo(orbit.target);
  if (f || r) {
    camera.getWorldDirection(panF).setY(0).normalize();
    panR.crossVectors(panF, camera.up).normalize();
    const speed = THREE.MathUtils.clamp(dist * 0.8, 25, 3000);
    panD.set(0, 0, 0).addScaledVector(panF, f).addScaledVector(panR, r).normalize().multiplyScalar(speed * dt);
    orbit.target.add(panD);
    camera.position.add(panD);
    orbit.target.y = world.heightAt(orbit.target.x, orbit.target.z);
  }
  if (rot || tilt || zoom) {
    off.subVectors(camera.position, orbit.target);
    sph.setFromVector3(off);
    sph.theta -= rot * dt * 1.6;                                    // ~90°/s
    sph.phi = THREE.MathUtils.clamp(sph.phi + tilt * dt * 0.9, 0.05, orbit.maxPolarAngle);
    sph.radius = THREE.MathUtils.clamp(sph.radius * Math.exp(zoom * dt * 1.6), orbit.minDistance, orbit.maxDistance);
    camera.position.copy(orbit.target).add(off.setFromSpherical(sph));
    camera.lookAt(orbit.target);
  }
  dirty = true;
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => orbit.dispatchEvent({ type: 'change' }), 400);
}

function clampCamera() {
  const lx = meta.width / 2, lz = meta.height / 2;
  camera.position.x = THREE.MathUtils.clamp(camera.position.x, -lx, lx);
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, -lz, lz);
  const floor = world.heightAt(camera.position.x, camera.position.z) + (mode === 'walk' ? 1.5 : 2.5);
  if (camera.position.y < floor) camera.position.y = floor;
  if (mode === 'orbit') {
    orbit.target.x = THREE.MathUtils.clamp(orbit.target.x, -lx, lx);
    orbit.target.z = THREE.MathUtils.clamp(orbit.target.z, -lz, lz);
  }
}

// pohled v URL (#x,y,z,tx,ty,tz)
function readHash() {
  const v = location.hash.slice(1).split(',').map(Number);
  if (v.length !== 6 || v.some(Number.isNaN)) return false;
  camera.position.set(v[0], v[1], v[2]);
  orbit.target.set(v[3], v[4], v[5]);
  orbit.update();
  return true;
}
let hashTimer = 0;
orbit.addEventListener('change', () => {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const p = camera.position, t = orbit.target;
    history.replaceState(null, '', `#${[p.x, p.y, p.z, t.x, t.y, t.z].map((n) => n.toFixed(1)).join(',')}`);
  }, 400);
});
// výchozí pohled: Stod s Radbuzou (kostel, most, meandr řeky)
const DEFAULT_VIEW = [-460, 190, -660, -200, 0, -990];
if (!readHash()) {
  const [cx, cy, cz, tx, , tz] = DEFAULT_VIEW;
  const g = world.heightAt(tx, tz);
  camera.position.set(cx, g + cy, cz);
  orbit.target.set(tx, g, tz);
  orbit.update();
}

// ------------------------------------------------------------------ smyčka – kreslí se jen při změně
const clock = new THREE.Clock();
const focus = new THREE.Vector3(), tmp = new THREE.Vector3();
let lastWorldCheck = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (anim) { stepAnim(); dirty = true; }
  else if (mode === 'drive') { drive.update(dt, keys); dirty = true; }
  else if (mode === 'orbit') { if (keys.size) panByKeys(dt); if (orbit.update()) dirty = true; } else if (keys.size || dirty) updateFree(dt);

  // doprava a život: jen když je kamera dost nízko, aby šlo něco vidět (jinak se nekreslí pořád dokola)
  if (traffic.enabled || life.active) {
    const lf = mode === 'orbit' ? orbit.target : camera.position;
    const camH = camera.position.y - world.heightAt(camera.position.x, camera.position.z);
    const a = traffic.update(dt, lf, camera);
    const b = life.update(dt, lf, camera);
    if ((a || b) && camH < 2500) dirty = true;
  }

  const now = clock.elapsedTime;
  if (dirty || now - lastWorldCheck > 0.5) {      // dlaždice kontrolovat i bez pohybu (dokončené načtení)
    lastWorldCheck = now;
    if (world.update(camera)) dirty = true;
  }
  if (!dirty) return;
  dirty = false;
  clampCamera();
  if (mode === 'orbit') focus.copy(orbit.target);
  else focus.copy(camera.position).addScaledVector(camera.getWorldDirection(tmp), 40);
  updateSun(focus, camera.position.distanceTo(focus));
  const above = camera.position.y - world.heightAt(camera.position.x, camera.position.z);
  const near = THREE.MathUtils.clamp(above * 0.03, 0.3, 25);
  if (Math.abs(near - camera.near) > camera.near * 0.15) { camera.near = near; camera.updateProjectionMatrix(); }
  sky.mesh.position.copy(camera.position);
  renderer.render(scene, camera);
  labels?.render(scene, camera);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labels?.resize();
  invalidate();
});

const labels = poiData ? createLabels({
  data: poiData, world, scene, camera, container: document.body, onChange: invalidate, flyTo: flyToXZ,
}) : null;
if (!labels) document.getElementById('poi-panel').hidden = true;
// odkaz ze stránky hlášení: ?mark=x,z,id → špendlík na místě hlášení
{
  const m = new URLSearchParams(location.search).get('mark')?.split(',').map(Number);
  if (m && m.length >= 2 && m.every(Number.isFinite)) labels?.highlight(`Hlášení #${m[2] ?? ''}`, m[0], m[1]);
}
createReport({
  camera, canvas, world, orbit, addresses: poiData?.addresses,
  mark: (name, x, z) => labels?.highlight(name, x, z), onChange: invalidate,
});
createTimeControls({ onChange: (pos) => { sunPos = pos; applyLight(); } });
applyShadows();
document.getElementById('loader').classList.add('done');
