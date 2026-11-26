import * as THREE from 'three';

// Režim „GTA“ (jen pro legraci): zvuky nárazů a výkřiků a trosky u nabouraných domů.
// Zvuky se skládají přímo ve Web Audio (šum + oscilátory), žádné soubory.

let ctx = null, noiseBuf = null;
function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function noise(c, t, dur, type, f0, f1, vol, q = 0.8) {
  const src = c.createBufferSource(); src.buffer = noiseBuf;
  const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f).connect(g).connect(c.destination);
  src.start(t, Math.random() * 0.3); src.stop(t + dur + 0.05);
}
function thump(c, t, f0, f1, dur, vol) {
  const o = c.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t); o.stop(t + dur + 0.05);
}

/** Rána: 'car' (plech a sklo), 'house' (dutý úder a padající omítka), 'pole' (kovové zadunění). */
export function bang(kind = 'car', strength = 1) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + 0.01, v = 0.35 + 0.45 * Math.min(1, strength);
  thump(c, t, kind === 'house' ? 110 : 150, 38, 0.35, v);
  noise(c, t, 0.25, 'lowpass', 2400, 300, v * 0.9);
  if (kind === 'car') {
    noise(c, t + 0.02, 0.6, 'bandpass', 3200, 1800, v * 0.5, 3);           // plech
    noise(c, t + 0.06, 0.45, 'highpass', 6000, 4000, v * 0.25);             // sklo
  } else if (kind === 'tree') {
    // dřevo: tupé zadunění, praskání (krátké suché klapnutí několikrát) a šumění listí
    for (let i = 0; i < 4; i++) noise(c, t + 0.03 + i * (0.04 + Math.random() * 0.05), 0.07, 'bandpass', 900 + Math.random() * 700, 500, v * 0.5, 4);
    noise(c, t + 0.1, 1.2, 'highpass', 5000, 2500, v * 0.18);
  } else if (kind === 'house') {
    noise(c, t + 0.05, 1.1, 'lowpass', 900, 150, v * 0.6);                  // drolení
  } else {
    const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = 410 + Math.random() * 80;
    const g = c.createGain(); g.gain.setValueAtTime(v * 0.3, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + 1);
  }
}

/** Bučení krávy: hluboké „Búú“ (pila přes formant samohlásky u), výška klesá. */
export function moo() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + 0.05, dur = 1.3;
  const o = c.createOscillator(); o.type = 'sawtooth';
  o.frequency.setValueAtTime(150, t); o.frequency.linearRampToValueAtTime(175, t + 0.3); o.frequency.linearRampToValueAtTime(115, t + dur);
  const out = c.createGain();
  out.gain.setValueAtTime(0.001, t); out.gain.exponentialRampToValueAtTime(0.4, t + 0.15);
  out.gain.setValueAtTime(0.4, t + dur * 0.7); out.gain.exponentialRampToValueAtTime(0.001, t + dur);
  for (const [f, q, g] of [[320, 5, 1], [700, 6, 0.5]]) {
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
    const gg = c.createGain(); gg.gain.value = g;
    o.connect(bp).connect(gg).connect(out);
  }
  out.connect(c.destination);
  o.start(t); o.stop(t + dur + 0.05);
}

/** Výkřik „Áá!“: pila přes dva formanty samohlásky a, výška nahoru a pak dolů, s chvěním. */
export function scream() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + 0.02, dur = 0.7 + Math.random() * 0.4;
  const base = 260 + Math.random() * 320;                        // hlubší i vyšší hlasy
  const o = c.createOscillator(); o.type = 'sawtooth';
  o.frequency.setValueAtTime(base, t);
  o.frequency.linearRampToValueAtTime(base * 1.5, t + 0.12);
  o.frequency.linearRampToValueAtTime(base * 0.75, t + dur);
  const vib = c.createOscillator(); vib.frequency.value = 7 + Math.random() * 3;
  const vg = c.createGain(); vg.gain.value = base * 0.05;
  vib.connect(vg).connect(o.frequency);
  const out = c.createGain();
  out.gain.setValueAtTime(0.001, t);
  out.gain.exponentialRampToValueAtTime(0.32, t + 0.04);
  out.gain.setValueAtTime(0.32, t + dur * 0.6);
  out.gain.exponentialRampToValueAtTime(0.001, t + dur);
  for (const [f, q, g] of [[800, 6, 1], [1250, 8, 0.7], [2600, 10, 0.25]]) {
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * (0.9 + Math.random() * 0.2); bp.Q.value = q;
    const gg = c.createGain(); gg.gain.value = g;
    o.connect(bp).connect(gg).connect(out);
  }
  out.connect(c.destination);
  o.start(t); vib.start(t); o.stop(t + dur + 0.05); vib.stop(t + dur + 0.05);
}

/** Trosky u nabouraných domů: tmavá „díra“ ve zdi a kusy cihel a omítky na zemi. Zůstávají. */
export function createDebris(scene, world) {
  const MAX = 900;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const im = new THREE.InstancedMesh(geo, mat, MAX);
  im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3).fill(1), 3);
  im.count = 0;
  im.castShadow = im.receiveShadow = true;
  im.frustumCulled = false;
  scene.add(im);
  const COLS = [0xb0533c, 0x9a4632, 0xc9c0ae, 0xd8d0c0, 0x8a847a, 0x6e6a64].map((h) => new THREE.Color(h));
  const hole = new THREE.Color(0x1d1a18);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  let next = 0;
  const put = (x, y, z, sx, sy, sz, yaw, col, tilt = 0) => {
    m.compose(p.set(x, y, z), q.setFromEuler(e.set(tilt * (Math.random() - 0.5), yaw, tilt * (Math.random() - 0.5))), s.set(sx, sy, sz));
    im.setMatrixAt(next, m); im.setColorAt(next, col);
    next = (next + 1) % MAX;
    im.count = Math.max(im.count, next);
  };
  return {
    /** x, z = místo nárazu na zdi, hx, hz = směr jízdy. */
    add(x, z, hx, hz, strength = 1) {
      const g = world.heightAt(x, z), yaw = Math.atan2(-hz, hx);
      const k = Math.min(1, strength);
      // díra (promáčklina) ve zdi
      put(x + hx * 0.15, g + 0.5 + 0.4 * k, z + hz * 0.15, 0.5, 0.7 + 0.8 * k, 1.6 + 1.2 * k, yaw, hole, 0.2);
      // trosky před zdí
      const n = 8 + Math.round(10 * k);
      for (let i = 0; i < n; i++) {
        const back = 0.4 + Math.random() * 2.5 * (0.5 + k), side = (Math.random() - 0.5) * 3;
        const bx = x - hx * back + -hz * side, bz = z - hz * back + hx * side;
        const sz = 0.12 + Math.random() * 0.3;
        put(bx, world.heightAt(bx, bz) + sz * 0.35, bz, sz * (1 + Math.random()), sz * 0.6, sz, Math.random() * 6.3,
          COLS[Math.floor(Math.random() * COLS.length)], 1.2);
      }
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor.needsUpdate = true;
    },
    clear() { im.count = 0; next = 0; },
  };
}

/** Kouř z nabouraných aut: měkké šedé obláčky, stoupají a rozplývají se. Zdroj = funkce vracející [x, y, z] nebo null. */
export function createSmoke(scene) {
  const MAX = 900;
  const pos = new Float32Array(MAX * 3), size = new Float32Array(MAX), alpha = new Float32Array(MAX);
  const vel = new Float32Array(MAX * 3), age = new Float32Array(MAX).fill(99), life = new Float32Array(MAX).fill(1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('size', new THREE.BufferAttribute(size, 1));
  g.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { scale: { value: 600 } },
    vertexShader: `attribute float size; attribute float alpha; varying float vA; uniform float scale;
      void main() { vA = alpha; vec4 mv = modelViewMatrix * vec4(position, 1.); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying float vA; void main() { float d = length(gl_PointCoord - .5) * 2.; if (d > 1.) discard;
      gl_FragColor = vec4(vec3(.32, .31, .3), vA * (1. - d * d)); }`,
    transparent: true, depthWrite: false,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  const sources = [];
  let next = 0;
  return {
    add(fn, rate = 10) { sources.push({ fn, rate, acc: Math.random() }); },
    update(dt, camera, viewH) {
      mat.uniforms.scale.value = viewH / (2 * Math.tan((camera.fov * Math.PI) / 360));
      for (let i = sources.length - 1; i >= 0; i--) {
        const s = sources[i], p = s.fn();
        if (!p) { sources.splice(i, 1); continue; }
        if (Math.hypot(p[0] - camera.position.x, p[2] - camera.position.z) > 400) continue;
        s.acc += dt * s.rate;
        while (s.acc >= 1) {
          s.acc -= 1;
          const k = next; next = (next + 1) % MAX;
          pos[k * 3] = p[0] + (Math.random() - 0.5) * 0.6; pos[k * 3 + 1] = p[1]; pos[k * 3 + 2] = p[2] + (Math.random() - 0.5) * 0.6;
          vel[k * 3] = (Math.random() - 0.5) * 0.5 + 0.3; vel[k * 3 + 1] = 1 + Math.random() * 0.8; vel[k * 3 + 2] = (Math.random() - 0.5) * 0.5;
          age[k] = 0; life[k] = 2.5 + Math.random() * 1.5;
        }
      }
      for (let k = 0; k < MAX; k++) {
        if (age[k] >= life[k]) { alpha[k] = 0; size[k] = 0; continue; }
        age[k] += dt;
        const t = age[k] / life[k];
        pos[k * 3] += vel[k * 3] * dt; pos[k * 3 + 1] += vel[k * 3 + 1] * dt; pos[k * 3 + 2] += vel[k * 3 + 2] * dt;
        size[k] = 0.7 + t * 3.2;
        alpha[k] = Math.min(1, t * 6) * (1 - t) * 0.55;
      }
      g.attributes.position.needsUpdate = g.attributes.size.needsUpdate = g.attributes.alpha.needsUpdate = true;
    },
    clear() { sources.length = 0; age.fill(99); alpha.fill(0); g.attributes.alpha.needsUpdate = true; },
  };
}

/** Sirény: policie „kvílí“ (plynulé houkání nahoru a dolů), sanitka střídá dva tóny. Hlasitost podle vzdálenosti. */
export function createSirens() {
  const voices = new Map();
  function drop(v, s) { try { s.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05); s.osc.stop(ctx.currentTime + 0.3); } catch { /* už stojí */ } voices.delete(v); }
  return {
    update(list, pos, on) {
      if (!on || !list.length) { for (const [v, s] of voices) drop(v, s); return; }
      const c = audio();
      if (!c) return;
      const t = c.currentTime;
      for (const v of list) {
        let s = voices.get(v);
        if (!s) {
          const osc = c.createOscillator(); osc.type = 'sawtooth';
          const filt = c.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 2400;
          const gain = c.createGain(); gain.gain.value = 0;
          osc.connect(filt).connect(gain).connect(c.destination);
          osc.start();
          s = { osc, gain, ph: Math.random() * 3 };
          voices.set(v, s);
        }
        const tt = t + s.ph;
        const f = v.em.type === 'police' ? 820 + 480 * Math.sin((tt * Math.PI * 2) / 2.6)
          : (tt % 1.2 < 0.6 ? 960 : 760);
        s.osc.frequency.setTargetAtTime(f, t, v.em.type === 'police' ? 0.03 : 0.004);
        const d = Math.hypot(v.x - pos.x, v.z - pos.z);
        const g = 0.13 * Math.max(0, 1 - d / 650) ** 2;
        s.gain.gain.setTargetAtTime(g, t, 0.1);
      }
      for (const [v, s] of voices) if (!list.includes(v)) drop(v, s);
    },
    clear() { for (const [v, s] of voices) drop(v, s); },
  };
}
