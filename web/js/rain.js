import * as THREE from 'three';

// Déšť: kapky (krátké čáry) v kvádru kolem kamery, padají a mírně je unáší vítr; poloha se počítá
// v shaderu (bez přepočtu v JS). Při dešti tlumené světlo, šedá obloha a tichý šum deště.

const N = 9000, R = 55, H = 60, SPEED = 9;

export function createRain(scene) {
  const pos = new Float32Array(N * 2 * 3), seed = new Float32Array(N * 2 * 3), end = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    const s = [Math.random(), Math.random(), Math.random()];
    for (let k = 0; k < 2; k++) { seed.set(s, (i * 2 + k) * 3); end[i * 2 + k] = k; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 3));
  g.setAttribute('end', new THREE.BufferAttribute(end, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: { time: { value: 0 }, cam: { value: new THREE.Vector3() }, light: { value: 1 } },
    vertexShader: `
      attribute vec3 seed; attribute float end;
      uniform float time; uniform vec3 cam;
      varying float vA;
      const float R = ${R.toFixed(1)}, H = ${H.toFixed(1)};
      void main(){
        float sp = ${SPEED.toFixed(1)} * (0.85 + 0.3 * seed.z);
        vec3 p;
        p.x = cam.x - R + mod(seed.x * 2. * R - (cam.x - R) + time * 1.2, 2. * R);
        p.z = cam.z - R + mod(seed.z * 2. * R - (cam.z - R), 2. * R);
        p.y = cam.y - H * .5 + mod(seed.y * H - time * sp - (cam.y - H * .5), H);
        p += end * vec3(0.12, 0.85, 0.0);          // délka a sklon čárky (vítr)
        vA = 1. - smoothstep(R * .5, R, length(p.xz - cam.xz));
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.);
      }`,
    fragmentShader: `
      uniform float light; varying float vA;
      void main(){ gl_FragColor = vec4(vec3(.78, .82, .88) * (.35 + .65 * light), .42 * vA); }`,
  });
  const lines = new THREE.LineSegments(g, mat);
  lines.frustumCulled = false;
  lines.visible = false;
  lines.renderOrder = 5;
  scene.add(lines);

  // zvuk: šum (filtrovaný) – spustí se až po kliknutí na přepínač (pravidla prohlížečů)
  let ctx = null, gain = null;
  function sound(on) {
    try {
      if (on && !ctx) {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = buf.getChannelData(0);
        let last = 0;
        for (let i = 0; i < d.length; i++) { last = (last + 0.04 * (Math.random() * 2 - 1)) / 1.04; d[i] = last * 3 + (Math.random() * 2 - 1) * 0.15; }
        const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2400;
        gain = ctx.createGain(); gain.gain.value = 0;
        src.connect(f).connect(gain).connect(ctx.destination); src.start();
      }
      if (gain) gain.gain.setTargetAtTime(on ? 0.12 : 0, ctx.currentTime, 0.4);
    } catch { /* zvuk není podstatný */ }
  }

  let on = false;
  return {
    points: lines,
    get on() { return on; },
    set(v, withSound = true) { on = v; lines.visible = v; if (withSound) sound(v); },
    update(time, camera, night) {
      if (!on) return;
      mat.uniforms.time.value = time;
      mat.uniforms.cam.value.copy(camera.position);
      mat.uniforms.light.value = 1 - night * 0.8;
    },
    /** Úprava světla a oblohy při dešti (po applySun). */
    weather({ sun, hemi, sky, fog }) {
      if (!on) return;
      const grey = new THREE.Color(0x8c949c);
      sun.intensity *= 0.25;
      sun.castShadow = false;
      hemi.intensity *= 0.8;
      const dim = sky.uniforms.top.value.getHSL({}).l;
      sky.uniforms.top.value.lerp(grey.clone().multiplyScalar(Math.min(1, dim * 1.6 + 0.15)), 0.8);
      sky.uniforms.horizon.value.lerp(grey.clone().multiplyScalar(Math.min(1, dim * 1.8 + 0.2)), 0.75);
      sky.uniforms.sunVis.value *= 0.1;
      sky.uniforms.glow.value.multiplyScalar(0.2);
      fog.color.copy(sky.uniforms.horizon.value);
    },
  };
}
