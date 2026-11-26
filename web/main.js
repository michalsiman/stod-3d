import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { World } from './js/world.js';
import { createBuildings } from './js/buildings.js';
import { createTrees } from './js/trees.js';
import { createRoads } from './js/roads.js';
import { createSidewalks } from './js/sidewalks.js';
import { createSports, stadiumPitch } from './js/sports.js';
import { createFootball, stadiumLights } from './js/football.js';
import { createNightGlow } from './js/nightglow.js';
import { createFarLights } from './js/farlights.js';
import { createRain } from './js/rain.js';
import { createSnow } from './js/snow.js';
import { SEASON } from './js/season.js';
import { createToon } from './js/toon.js';
import { createHistory } from './js/history.js';
import { createSquare, SQUARE_TREES, SQUARE_PARKING } from './js/square.js';
import { createTaxiLot, inTaxiLot } from './js/taxis.js';
import { createCemeteries } from './js/cemetery.js';
import { NIGHT } from './js/night.js';
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
import { createLandmarks, createRoundabouts, FLOODLIT, EXTRA_BRIDGES, EXTRA_FENCES } from './js/landmarks.js';
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
const [farH, farTex, buildings, roads, bridges, fences, power, treesBuf, poiData, lamps, signs, stops, bike, cemeteries, parking, sport, rail] = await Promise.all([
  get('far_h.bin', 'bin'),
  new THREE.TextureLoader().loadAsync('data/far.png'),
  get('buildings.json'), get('roads.json'), get('bridges.json'), get('fences.json'), get('power.json'),
  get('trees.bin', 'bin'),
  fetch('data/poi.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  fetch('data/lamps.json').then((r) => (r.ok ? r.json() : [])).catch(() => []),
  fetch('data/signs.json').then((r) => (r.ok ? r.json() : [])).catch(() => []),
  fetch('data/stops.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  fetch('data/bike.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  fetch('data/cemetery.json').then((r) => (r.ok ? r.json() : [])).catch(() => []),
  fetch('data/parking.json').then((r) => (r.ok ? r.json() : [])).catch(() => []),
  fetch('data/sport.json').then((r) => (r.ok ? r.json() : [])).catch(() => []),
  fetch('data/rail.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
]);
// koleje: místo jedné osy trati (ZABAGED) jednotlivé koleje z OSM (hlavní, předjízdné, kolejiště, vlečky)
if (rail?.length) {
  for (let i = roads.length - 1; i >= 0; i--) if (roads[i].t === 8) roads.splice(i, 1);
  for (const r of rail) roads.push({ t: 8, p: r.p, svc: r.s });
}
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
const rain = createRain(scene);
const snow = createSnow(scene);
const toon = createToon(renderer, isCoarse);

// stíny – přepínač (pamatuje si volbu); na mobilu ve výchozím stavu vypnuté
let shadows = !isCoarse;
try { const v = localStorage.getItem('stod3d.shadows'); if (v !== null) shadows = v === '1'; } catch { /* ignorovat */ }
function applyLight() {
  applySun(sunPos, { sun, hemi, sky, fog: scene.fog, renderer, shadowsWanted: shadows });
  rain.weather({ sun, hemi, sky, fog: scene.fog });
  snow.weather({ sun, hemi, sky, fog: scene.fog });
  renderer.shadowMap.enabled = sun.castShadow;
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
const trees = createTrees({ buf: treesBuf, meta, world, exclude: (x, z, r) => landmarks.keepOut(x, z, r) || inTaxiLot(x, z, r), extra: SQUARE_TREES });
const fenceLayer = createFences({ fences: [...fences, ...EXTRA_FENCES], world });
const bridgeInfo = prepareBridges([...bridges, ...EXTRA_BRIDGES], roads, world);
// cyklostezky (OSM) – vlastní pás v červenohnědém asfaltu
if (bike?.paths?.length) world.builders.push(createRoads({ roads: bike.paths.map((p) => ({ t: 9, p })), bridges: bridgeInfo, world }));
const sidewalks = createSidewalks({ roads, buildings, bridges: bridgeInfo, world, blocked: inTaxiLot });
world.builders.push(sidewalks.build);
world.builders.push(createSquare({ world }));        // nám. ČSA: parkoviště, park s lavičkami
world.builders.push(createTaxiLot({ world }));       // konec Sokolské: stání s taxíky
world.builders.push(createCemeteries({ cemeteries, roads, buildings, world }));   // hroby na hřbitovech
world.builders.push(createRoads({ roads, bridges: bridgeInfo, world }), createBridges({ info: bridgeInfo, world }), trees.build, fenceLayer.build, createPower({ power, world }));
world.lodHooks.push(fenceLayer.lod);
world.builders.push(createLamps({ lamps, world }));
const lit = [...FLOODLIT, ...stadiumLights(stadiumPitch(sport))];   // nasvícený kostel, stadion
world.builders.push(createNightGlow({ lamps, buildings, world, spots: lit }));
scene.add(createFarLights({ lamps, buildings, world, spots: lit }));       // světla města z dálky / z výšky
const postsBuild = createPosts({ roads, buildings, bridges: bridgeInfo, world });
world.builders.push(postsBuild);
scene.add(createBuildings({ buildings, world, skip: landmarks.skip }));
signLayer = createSigns({ signs, buildings, roads, world });
signLayer.update();
scene.add(signLayer);
const placeSigns = createPlaceSigns({ roads, buildings, places: poiData?.places, bridges: bridgeInfo, world });
scene.add(placeSigns);
world.builders.push(() => placeSigns.userData.refresh?.());
const sports = createSports({ sport, world });
const football = createFootball({ pitch: stadiumPitch(sport), world, scene });   // fotbal na stadionu
scene.add(sports);
world.builders.push(() => sports.userData.refresh());
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
// telefon: mapa se posouvá víc než prst (jeden tah přejede větší kus) a po puštění ještě dojíždí
if (isCoarse) Object.assign(orbit, { panSpeed: 2.2, dampingFactor: 0.06 });
const look = new PointerLockControls(camera, canvas);
const keys = new Set();
let mode = 'orbit';

// projížďka autem (režim „drive“)
const drive = createDrive({
  roads, bridges: bridgeInfo, buildings, streets: poiData?.streets, pois: poiData?.pois, world, scene, camera,
  onExit: () => setMode('orbit'),
  onGta: (on) => document.getElementById('gta-mode').classList.toggle('active', on),
  // pevné sloupy: lampy, sloupy elektrického vedení, patníky
  obstacles: [
    ...lamps.map((l) => [l[0], l[1], 0.2]),
    ...power.flat().map((p) => [p[0], p[1], 0.3]),
    ...postsBuild.points.map((p) => [p[0], p[1], 0.08]),
  ],
});

// živá mapa: doprava, lidé, zvířata (přepínače si pamatují volbu)
const traffic = createTraffic({ roads, bridges: bridgeInfo, buildings, world, scene, stops, parking: [...parking, ...SQUARE_PARKING], coarse: isCoarse, drive });
const life = createLife({ roads, bridges: bridgeInfo, buildings, world, scene, meta, treesBuf, stops, bike, sidewalks, coarse: isCoarse });
Object.assign(drive.hooks, { traffic, life });
world.builders.push(() => traffic.refreshStops());
world.builders.push(() => traffic.refreshParked());
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
  bind('live-people', 'people', (v) => { life.setPeople(v); football.set(v); });
  bind('live-animals', 'animals', (v) => life.setAnimals(v));
  // déšť: ve výchozím stavu vypnutý; zvuk až po kliknutí (pravidla prohlížečů)
  // kreslený styl (filtr přes celý obraz)
  const tc = document.getElementById('toon');
  tc.checked = opt('toon', false);
  toon.set(tc.checked);
  tc.addEventListener('change', () => {
    try { localStorage.setItem('stod3d.toon', tc.checked ? '1' : '0'); } catch { /* ignorovat */ }
    toon.set(tc.checked);
    invalidate();
  });
  // sníh: padající vločky + zasněžená krajina (plynulé zasněžení)
  const sc = document.getElementById('snow');
  sc.checked = opt('snow', false);
  snow.set(sc.checked);
  SEASON.snow.value = sc.checked ? 1 : 0;
  sc.addEventListener('change', () => {
    try { localStorage.setItem('stod3d.snow', sc.checked ? '1' : '0'); } catch { /* ignorovat */ }
    snow.set(sc.checked);
    if (sc.checked && rc.checked) { rc.checked = false; rc.dispatchEvent(new Event('change')); }   // buď sníh, nebo déšť
    applyLight();
  });
  // historie: terén s historickou mapou / leteckým snímkem, současné vrstvy skryté
  const hs = document.getElementById('history');
  const keepObj = (o) => o === sky.mesh || o.isLight || o === sun.target || o === rain.points || o === snow.points;
  const histLayer = createHistory({ world, meta, scene, keep: keepObj, coarse: isCoarse, camera });
  const applyHist = () => {
    histLayer.set(hs.value, invalidate);
    world.hidden = !!hs.value;
    traffic.setEnabled(!hs.value && document.getElementById('live-traffic').checked);
    document.body.classList.toggle('history', !!hs.value);
    world.update(camera);
    invalidate();
  };
  hs.addEventListener('change', applyHist);
  const rc = document.getElementById('rain');
  rc.checked = opt('rain', false) && !sc.checked;
  rain.set(rc.checked, false);
  rc.addEventListener('change', () => {
    try { localStorage.setItem('stod3d.rain', rc.checked ? '1' : '0'); } catch { /* ignorovat */ }
    rain.set(rc.checked);
    if (rc.checked && sc.checked) { sc.checked = false; sc.dispatchEvent(new Event('change')); }   // buď déšť, nebo sníh
    applyLight();
  });
}
window.stod3d = { drive, world, camera, orbit, signs: signLayer, placeSigns, traffic, life, football };      // pro ladění v konzoli

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
  flyAgl = null;
  document.body.classList.toggle('driving', mode === 'drive');
  document.body.dataset.mode = mode;
  document.querySelectorAll('#modes [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('fly-ctl').hidden = mode !== 'fly';
  document.querySelectorAll('#help [data-help]').forEach((d) => { d.hidden = d.dataset.help !== mode; });
  invalidate();
}

document.querySelectorAll('#modes [data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
// Demolice: projížďka autem s nárazy naostro (opakované klepnutí ji vypne, auto jede dál)
function startGta() { setMode('drive'); drive.setGta(true); }
document.getElementById('gta-mode').addEventListener('click', () => {
  if (mode === 'drive' && drive.gta) drive.setGta(false); else startGta();
});
document.body.dataset.mode = mode;
// sbalení menu (na mobilu ve výchozím stavu sbalené)
{
  const panel = document.getElementById('title'), btn = document.getElementById('panel-collapse');
  const set = (open) => { panel.classList.toggle('collapsed', !open); btn.setAttribute('aria-expanded', String(open)); document.body.classList.toggle('menu-open', open); };
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
// tlačítka letu: podržení = stisknutá klávesa
document.querySelectorAll('#fly-ctl [data-key]').forEach((b) => {
  const k = b.dataset.key;
  const on = (e) => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch { /* bez zachycení */ } keys.add(k); b.classList.add('on'); dirty = true; };
  const off = () => { keys.delete(k); b.classList.remove('on'); };
  b.addEventListener('pointerdown', on);
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, off);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
});
addEventListener('blur', () => keys.clear());

const fwd = new THREE.Vector3(), right = new THREE.Vector3(), move = new THREE.Vector3();
// létání: dopředu/dozadu/do stran vodorovně a ve stále stejné výšce nad terénem (kopce kopíruje),
// výšku mění jen Q/E – i když se díváš dolů, letí se rovně, ne do země
let flyAgl = null, flyTurn = 0, flyRoll = 0;
const flyEuler = new THREE.Euler(0, 0, 0, 'YXZ');
function updateFree(dt) {
  const walk = mode === 'walk';
  const fast = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const speed = walk ? (fast ? 9 : 3) : (fast ? 440 : 100);
  const ground = () => world.heightAt(camera.position.x, camera.position.z);
  if (!walk && flyAgl === null) flyAgl = 80;                 // let začíná 80 m nad terénem
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) { const e = camera.matrixWorld.elements; fwd.set(e[4], 0, e[6]); }   // pohled kolmo dolů: dopředu = horní okraj obrazu
  fwd.normalize();
  right.crossVectors(fwd, camera.up).normalize();
  move.set(0, 0, 0);
  if (keys.has('KeyW') || keys.has('ArrowUp')) move.add(fwd);
  if (keys.has('KeyS') || keys.has('ArrowDown')) move.sub(fwd);
  if (walk) {
    if (keys.has('KeyD') || keys.has('ArrowRight')) move.add(right);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) move.sub(right);
  }
  if (move.lengthSq()) { camera.position.addScaledVector(move.normalize(), speed * dt); dirty = true; }
  if (!walk) {
    // zatáčení jako letadlo: ←/→ (A/D) otáčí směr letu a letadlo se do zatáčky nakloní;
    // PageDown/PageUp (nebo tlačítka) sklání pohled dolů / zvedá nahoru
    const turn = ((keys.has('KeyA') || keys.has('ArrowLeft')) ? 1 : 0) - ((keys.has('KeyD') || keys.has('ArrowRight')) ? 1 : 0);
    flyTurn += (turn * 0.75 - flyTurn) * Math.min(1, dt * 3);
    if (Math.abs(flyTurn) < 1e-3 && !turn) flyTurn = 0;
    const tilt = (keys.has('PageDown') || keys.has('LookDown') ? -1 : 0) + (keys.has('PageUp') || keys.has('LookUp') ? 1 : 0);
    if (flyTurn || tilt || flyRoll) {
      flyEuler.setFromQuaternion(camera.quaternion, 'YXZ');
      flyEuler.y += flyTurn * dt;
      flyEuler.x = THREE.MathUtils.clamp(flyEuler.x + tilt * 0.9 * dt, -1.5, 0.6);
      flyEuler.z = flyTurn * 0.45;                                   // náklon do zatáčky
      if (Math.abs(flyEuler.z) < 1e-3) flyEuler.z = 0;
      flyRoll = flyEuler.z;
      camera.quaternion.setFromEuler(flyEuler);
      dirty = true;
    }
  }
  if (!walk) {
    const up = (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
    if (up) flyAgl = THREE.MathUtils.clamp(flyAgl + up * speed * dt * Math.max(1, flyAgl / 150), 3, 3000);
  }
  {
    const target = ground() + (walk ? 1.7 : flyAgl);
    if (Math.abs(target - camera.position.y) > 0.01) {
      camera.position.y += (target - camera.position.y) * Math.min(1, dt * (walk ? 10 : 5));
      dirty = true;
    }
  }
}

// ovládání mapy klávesnicí (režim Mapa), podobně jako běžné mapové aplikace:
//   ←↑↓→ / WASD posun · Q/E nebo Shift+←/→ otáčení · Shift+↑/↓ náklon · +/− nebo PgUp/PgDn zoom
const panF = new THREE.Vector3(), panR = new THREE.Vector3(), panD = new THREE.Vector3();
const sph = new THREE.Spherical(), off = new THREE.Vector3();
const has = (...c) => c.some((k) => keys.has(k));
// ------------------------------------------------------------------ ovládací tlačítka na mapě + zoom jedním prstem
const held = { rot: 0, tilt: 0, zoom: 0, any() { return this.rot || this.tilt || this.zoom; } };
let northT = null;
function northAnim(dt) {
  if (northT === null) return false;
  off.subVectors(camera.position, orbit.target);
  sph.setFromVector3(off);
  const d = Math.atan2(Math.sin(-sph.theta), Math.cos(-sph.theta));
  const stepA = Math.sign(d) * Math.min(Math.abs(d), dt * 5);
  sph.theta += stepA;
  camera.position.copy(orbit.target).add(off.setFromSpherical(sph));
  camera.lookAt(orbit.target);
  if (Math.abs(d) < 0.002) { northT = null; orbit.dispatchEvent({ type: 'change' }); }
  return true;
}
{
  const ctl = document.getElementById('map-ctl');
  ctl.querySelectorAll('[data-hold]').forEach((b) => {
    const [k, v] = b.dataset.hold.split(':');
    const down = (e) => { e.preventDefault(); held[k] = +v; anim = null; northT = null; try { b.setPointerCapture(e.pointerId); } catch { /* ignorovat */ } invalidate(); };
    const up = () => { held[k] = 0; orbit.dispatchEvent({ type: 'change' }); };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  });
  ctl.querySelector('.ctl-north').addEventListener('click', () => { anim = null; northT = 1; invalidate(); });
  // střelka kompasu ukazuje sever
  const needle = ctl.querySelector('.ctl-north svg');
  orbit.addEventListener('change', () => {
    off.subVectors(camera.position, orbit.target);
    needle.style.transform = `rotate(${(-Math.atan2(off.x, off.z) * 180 / Math.PI).toFixed(1)}deg)`;
  });

  // zoom jedním prstem (jako Google / Mapy.cz): ťuk + znovu přiložit a táhnout nahoru/dolů;
  // samotné dvojité ťuknutí přiblíží
  let lastTap = 0, lastX = 0, lastY = 0, zoomTouch = null;
  addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || e.target !== canvas || mode !== 'orbit') return;
    const now = performance.now();
    if (now - lastTap < 320 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 40) {
      e.stopImmediatePropagation(); e.preventDefault();
      zoomTouch = { id: e.pointerId, y0: e.clientY, y: e.clientY, moved: false };
      orbit.enabled = false; anim = null;
      lastTap = 0;
      return;
    }
    lastTap = now; lastX = e.clientX; lastY = e.clientY;
  }, { capture: true });
  addEventListener('pointermove', (e) => {
    if (!zoomTouch || e.pointerId !== zoomTouch.id) return;
    e.stopImmediatePropagation();
    const dy = e.clientY - zoomTouch.y;
    zoomTouch.y = e.clientY;
    if (Math.abs(e.clientY - zoomTouch.y0) > 8) zoomTouch.moved = true;
    off.subVectors(camera.position, orbit.target);
    sph.setFromVector3(off);
    sph.radius = THREE.MathUtils.clamp(sph.radius * Math.exp(-dy * 0.008), orbit.minDistance, orbit.maxDistance);
    camera.position.copy(orbit.target).add(off.setFromSpherical(sph));
    invalidate();
  }, { capture: true });
  const endZoom = (e) => {
    if (!zoomTouch || e.pointerId !== zoomTouch.id) return;
    e.stopImmediatePropagation();
    if (!zoomTouch.moved) {                       // dvojité ťuknutí → přiblížit
      off.subVectors(camera.position, orbit.target);
      sph.setFromVector3(off);
      sph.radius = Math.max(orbit.minDistance, sph.radius * 0.5);
      camera.position.copy(orbit.target).add(off.setFromSpherical(sph));
    }
    zoomTouch = null;
    orbit.enabled = true;
    orbit.dispatchEvent({ type: 'change' });
    invalidate();
  };
  addEventListener('pointerup', endZoom, { capture: true });
  addEventListener('pointercancel', endZoom, { capture: true });
}

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
  rot += held.rot; tilt += held.tilt; zoom += held.zoom;           // tlačítka na mapě
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
  else if (mode === 'orbit') { if (keys.size || held.any()) panByKeys(dt); if (northAnim(dt)) dirty = true; if (orbit.update()) dirty = true; } else if (keys.size || dirty) updateFree(dt);

  // mlha jen na obzoru: s výškou kamery se odsouvá (z výšky není město zamlžené); v dešti blíž
  {
    const camH = Math.max(0, camera.position.y - world.heightAt(camera.position.x, camera.position.z));
    const bad = rain.on || snow.on;
    scene.fog.near = (bad ? 600 : 3000) + camH * 4;
    scene.fog.far = (bad ? 6000 : 14000) + camH * 9;
    if (rain.on) { rain.update(clock.elapsedTime, camera, NIGHT.night.value); dirty = true; }
    if (snow.on) { snow.update(clock.elapsedTime, camera, NIGHT.night.value, renderer.getPixelRatio()); dirty = true; }
    // sněhová pokrývka narůstá / taje plynule
    const want = snow.on ? 1 : 0;
    if (SEASON.snow.value !== want) { SEASON.snow.value += Math.sign(want - SEASON.snow.value) * Math.min(Math.abs(want - SEASON.snow.value), dt * 0.5); dirty = true; }
  }
  // doprava a život: jen když je kamera dost nízko, aby šlo něco vidět (jinak se nekreslí pořád dokola)
  if (!world.hidden && (traffic.enabled || life.active)) {
    const lf = mode === 'orbit' ? orbit.target : camera.position;
    const camH = camera.position.y - world.heightAt(camera.position.x, camera.position.z);
    const a = traffic.update(dt, lf, camera);
    const b = life.update(dt, lf, camera);
    const c = !world.hidden && camH < 1500 && football.update(dt, lf);
    if ((a || b || c) && camH < 2500) dirty = true;
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
  if (toon.on) toon.render(scene, camera); else renderer.render(scene, camera);
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
// za tmy nebo soumraku nabídnout přepnutí na den (mapa se otevírá v aktuálním čase)
{
  const tip = document.getElementById('night-tip');
  if (tip && sunPos.el < -2 && document.getElementById('time-live')?.checked) {
    tip.querySelector('.nt-when').textContent = sunPos.el > -8 ? 'šero' : 'tma';
    tip.hidden = false;
    const close = () => { tip.hidden = true; };
    tip.querySelector('.nt-keep').onclick = close;
    tip.querySelector('.nt-day').onclick = () => {
      const min = document.getElementById('time-min');
      document.getElementById('time-live').checked = false;
      min.value = 780;                                   // 13:00 téhož dne
      min.dispatchEvent(new Event('input'));
      close();
    };
    setTimeout(close, 25000);
  }
}
applyShadows();
document.getElementById('loader').classList.add('done');
// reklama na Demolici po načtení (dá se vypnout „Už nezobrazovat“)
{
  const ad = document.getElementById('gta-ad');
  let off = false;
  try { off = localStorage.getItem('stod3d.gtaAd') === '0'; } catch { /* bez úložiště */ }
  if (ad && !off && !new URLSearchParams(location.search).has('mark')) {
    const close = () => {
      ad.hidden = true;
      if (ad.querySelector('.ga-never input').checked) { try { localStorage.setItem('stod3d.gtaAd', '0'); } catch { /* bez úložiště */ } }
    };
    ad.querySelector('.ga-x').onclick = close;
    ad.querySelector('.ga-no').onclick = close;
    ad.addEventListener('click', (e) => { if (e.target === ad) close(); });
    addEventListener('keydown', (e) => { if (e.code === 'Escape' && !ad.hidden) close(); });
    ad.querySelector('.ga-go').onclick = () => { close(); document.getElementById('night-tip').hidden = true; startGta(); };
    setTimeout(() => { if (mode === 'orbit') ad.hidden = false; }, 1500);
  }
}
