import * as THREE from 'three';

// Sněžení: vločky (body s měkkým okrajem) v kvádru kolem kamery, padají pomalu a poletují;
// poloha se počítá v shaderu. Při sněžení šedobílá zatažená obloha a měkké světlo.

const N = 7000, R = 60, H = 55;

export function createSnow(scene) {
  const pos = new Float32Array(N * 3), seed = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) seed.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: { time: { value: 0 }, cam: { value: new THREE.Vector3() }, light: { value: 1 }, px: { value: 1 } },
    vertexShader: `
      attribute vec4 seed; uniform float time, px; uniform vec3 cam; varying float vA;
      const float R = ${R.toFixed(1)}, H = ${H.toFixed(1)};
      void main(){
        float sp = 1.1 + seed.w * .9;
        vec3 p;
        float sway = sin(time * (.6 + seed.w) + seed.x * 40.) * 1.2;
        p.x = cam.x - R + mod(seed.x * 2. * R - (cam.x - R) + time * .5 + sway, 2. * R);
        p.z = cam.z - R + mod(seed.z * 2. * R - (cam.z - R) + cos(time * .7 + seed.y * 30.) * .9, 2. * R);
        p.y = cam.y - H * .5 + mod(seed.y * H - time * sp - (cam.y - H * .5), H);
        vec4 mv = viewMatrix * vec4(p, 1.);
        vA = 1. - smoothstep(R * .55, R, length(p.xz - cam.xz));
        gl_PointSize = clamp((2.2 + seed.w * 2.) * 60. / -mv.z, 1., 9.) * px;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float light; varying float vA;
      void main(){ float r = length(gl_PointCoord - .5) * 2.; float a = (1. - smoothstep(.45, 1., r)) * vA;
        gl_FragColor = vec4(vec3(1.) * (.35 + .65 * light), a * .9); }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.visible = false;
  pts.renderOrder = 5;
  scene.add(pts);
  let on = false;
  return {
    points: pts,
    get on() { return on; },
    set(v) { on = v; pts.visible = v; },
    update(time, camera, night, pr) {
      if (!on) return;
      mat.uniforms.time.value = time;
      mat.uniforms.cam.value.copy(camera.position);
      mat.uniforms.light.value = 1 - night * 0.75;
      mat.uniforms.px.value = pr;
    },
    weather({ sun, hemi, sky, fog }) {
      if (!on) return;
      const white = new THREE.Color(0xc8ccd2);
      sun.intensity *= 0.35;
      sun.castShadow = false;
      hemi.intensity *= 1.05;
      const dim = sky.uniforms.top.value.getHSL({}).l;
      sky.uniforms.top.value.lerp(white.clone().multiplyScalar(Math.min(1, dim * 1.6 + 0.12)), 0.8);
      sky.uniforms.horizon.value.lerp(white.clone().multiplyScalar(Math.min(1, dim * 1.8 + 0.18)), 0.8);
      sky.uniforms.sunVis.value *= 0.15;
      sky.uniforms.glow.value.multiplyScalar(0.2);
      fog.color.copy(sky.uniforms.horizon.value);
    },
  };
}
