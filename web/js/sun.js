import * as THREE from 'three';
import { NIGHT } from './night.js';

// Slunce podle skutečnosti: astronomická poloha pro Stod, barvy světla a oblohy podle výšky slunce,
// režim „Aktuální čas“ (online) nebo vlastní datum a hodina.

const LAT = 49.6393, LON = 13.1647;
const rad = THREE.MathUtils.degToRad, deg = THREE.MathUtils.radToDeg;

/** Poloha slunce (NOAA, přesnost ~0,1°): { az: od severu po směru hodin, el: nad obzorem } ve stupních. */
export function solarPosition(date, lat = LAT, lon = LON) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(rad(M)) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * T) + Math.sin(rad(3 * M)) * 0.000289;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(rad(125.04 - 1934.136 * T));
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(125.04 - 1934.136 * T));
  const decl = Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda)));
  const y = Math.tan(rad(eps / 2)) ** 2;
  const eqTime = 4 * deg(y * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(rad(M))
    + 4 * e * y * Math.sin(rad(M)) * Math.cos(2 * rad(L0)) - 0.5 * y * y * Math.sin(4 * rad(L0))
    - 1.25 * e * e * Math.sin(2 * rad(M)));
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const tst = (utcMin + eqTime + 4 * lon + 1440) % 1440;
  const ha = rad(tst / 4 - 180);
  const la = rad(lat);
  const cosZ = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(THREE.MathUtils.clamp(cosZ, -1, 1));
  let az = deg(Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(la) - Math.tan(decl) * Math.cos(la))) + 180;
  az = (az + 360) % 360;
  return { az, el: 90 - deg(zen) };
}

/** Český místní čas (SEČ / SELČ) → Date. */
function lastSunday(year, month) {         // month 0–11
  const d = new Date(Date.UTC(year, month + 1, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}
export function pragueDate(year, dayOfYear, minutes) {
  const base = Date.UTC(year, 0, 1) + (dayOfYear - 1) * 86400000 + minutes * 60000;
  const dstStart = lastSunday(year, 2).getTime() + 3600000;     // 1:00 UTC
  const dstEnd = lastSunday(year, 9).getTime() + 3600000;
  let d = new Date(base - 3600000);                              // SEČ = UTC+1
  if (d >= dstStart && d < dstEnd) d = new Date(base - 7200000); // SELČ = UTC+2
  return d;
}
function pragueParts(date) {
  const f = new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const y = +p.year, m = +p.month, d = +p.day;
  const doy = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
  return { year: y, doy, minutes: +p.hour * 60 + +p.minute };
}

// ---------------------------------------------------------------- obloha
export function createSky() {
  const uniforms = {
    top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() },
    glow: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) },
    sunVis: { value: 1 }, stars: { value: 0 },
  };
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(15000, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, uniforms,
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
      fragmentShader: /* glsl */ `
        uniform vec3 top, horizon, glow, sunDir; uniform float sunVis, stars; varying vec3 vP;
        float h(vec3 p){ p = fract(p * .3183099 + .1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        void main(){
          vec3 d = normalize(vP);
          float up = smoothstep(-.02, .5, d.y);
          vec3 c = mix(horizon, top, up);
          float s = max(dot(d, sunDir), 0.);
          // záře kolem slunce a červánky na straně slunce u obzoru
          c += glow * (pow(s, 8.) * .35 + pow(s, 48.) * .5) * (1. - up * .85);
          c += vec3(1., .96, .88) * smoothstep(.9994, .99975, s) * sunVis;        // kotouč
          c += vec3(1., .9, .7) * pow(s, 600.) * .8 * sunVis;
          if (stars > 0. && d.y > 0.) {
            vec3 q = floor(d * 420.);
            float st = step(.9975, h(q)) * (.5 + .5 * h(q + 3.));
            c += vec3(st) * stars * smoothstep(0., .25, d.y);
          }
          gl_FragColor = vec4(c, 1.);
        }`,
    }),
  );
  mesh.renderOrder = -1;
  return { mesh, uniforms };
}

// ---------------------------------------------------------------- osvětlení podle výšky slunce
const C = (h) => new THREE.Color(h);
const DAY = { top: C(0x7fb2e5), horizon: C(0xe4eef4) };
const DUSK = { top: C(0x4a6aa0), horizon: C(0xf2b27c), glow: C(0xff9a50) };
const NIGHTC = { top: C(0x070d1c), horizon: C(0x1a2438) };
const SUN_HI = C(0xfff4e4), SUN_LO = C(0xff9c55);
const ss = THREE.MathUtils.smoothstep;

export function applySun({ el, az }, { sun, hemi, sky, fog, renderer, shadowsWanted }) {
  const dir = new THREE.Vector3(Math.sin(rad(az)) * Math.cos(rad(el)), Math.sin(rad(el)), -Math.cos(rad(az)) * Math.cos(rad(el)));
  const day = ss(el, -6, 8);                 // 0 noc … 1 den (občanský soumrak)
  const dusk = Math.max(0, 1 - Math.abs(el - 1) / 9);   // červánky kolem východu/západu
  // slunce
  sun.userData.dir = dir.clone();
  sun.intensity = 2.1 * ss(el, -1, 12);
  sun.color.copy(SUN_LO).lerp(SUN_HI, ss(el, 2, 25));
  sun.castShadow = shadowsWanted && el > 1;
  renderer.shadowMap.enabled = sun.castShadow;
  // obloha: noc → soumrak → den
  const top = NIGHTC.top.clone().lerp(DAY.top, day).lerp(DUSK.top, dusk * 0.5);
  const hor = NIGHTC.horizon.clone().lerp(DAY.horizon, day).lerp(DUSK.horizon, dusk * 0.75);
  sky.uniforms.top.value.copy(top);
  sky.uniforms.horizon.value.copy(hor);
  sky.uniforms.glow.value.copy(DUSK.glow).multiplyScalar(0.25 + dusk * 0.9).multiplyScalar(ss(el, -8, 0));
  sky.uniforms.sunDir.value.copy(dir);
  sky.uniforms.sunVis.value = ss(el, -1.5, 0.5);
  sky.uniforms.stars.value = 1 - ss(el, -14, -5);
  fog.color.copy(hor);
  // rozptýlené světlo: v noci slabé modravé (měsíc)
  hemi.intensity = 0.32 + 1.8 * day;
  hemi.color.copy(C(0x5a6c9a)).lerp(C(0xe8f2ff), day).lerp(C(0xffd2a8), dusk * 0.4);
  hemi.groundColor.copy(C(0x1e2430)).lerp(C(0xc2c8a8), day);
  // noc pro okna a lampy
  NIGHT.night.value = 1 - ss(el, -7, 1);
  return dir;
}

/** Podíl rozsvícených oken podle hodiny. */
function litFraction(minutes) {
  const h = minutes / 60;
  if (h >= 16 && h < 22) return 0.45;
  if (h >= 22 || h < 0.5) return 0.28;
  if (h < 5) return 0.07;
  if (h < 8) return 0.3;
  return 0.35;
}

// ---------------------------------------------------------------- ovládání času
const MONTHS = ['ledna', 'února', 'března', 'dubna', 'května', 'června', 'července', 'srpna', 'září', 'října', 'listopadu', 'prosince'];

export function createTimeControls({ onChange }) {
  const root = document.getElementById('time-opts');
  const live = root.querySelector('#time-live');
  const manual = root.querySelector('.time-manual');
  const dayR = root.querySelector('#time-day');
  const minR = root.querySelector('#time-min');
  const label = root.querySelector('.time-label');
  const info = root.querySelector('.time-info');
  let year = new Date().getFullYear();

  function current() {
    if (live.checked) {
      const now = new Date();
      const p = pragueParts(now);
      year = p.year;
      dayR.value = p.doy; minR.value = p.minutes;
      return { date: now, ...p };
    }
    const doy = +dayR.value, minutes = +minR.value;
    return { date: pragueDate(year, doy, minutes), year, doy, minutes };
  }

  function update() {
    manual.hidden = live.checked;
    const t = current();
    const pos = solarPosition(t.date);
    NIGHT.litFrac.value = litFraction(t.minutes);
    const d = new Date(Date.UTC(t.year, 0, t.doy));
    const hh = String(Math.floor(t.minutes / 60)), mm = String(t.minutes % 60).padStart(2, '0');
    label.textContent = `${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]}, ${hh}:${mm}`;
    info.textContent = pos.el > 0 ? `slunce ${pos.el.toFixed(0)}° nad obzorem` : pos.el > -6 ? 'soumrak' : 'noc';
    onChange(pos);
  }

  live.addEventListener('change', update);
  dayR.addEventListener('input', () => { live.checked = false; update(); });
  minR.addEventListener('input', () => { live.checked = false; update(); });
  root.querySelectorAll('[data-season]').forEach((b) => b.addEventListener('click', () => {
    live.checked = false;
    dayR.value = b.dataset.season;
    update();
  }));
  // ve stylu „online“ se čas posouvá každou minutu
  setInterval(() => { if (live.checked) update(); }, 60000);
  update();
}
