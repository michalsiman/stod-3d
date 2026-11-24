// Sdílené GLSL funkce: šum, převod barev, antialiasing vzorů, bump z výškové funkce.
export const COMMON = /* glsl */ `
float hash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 4; i++){ s += a * vnoise(p); p = p * 2.03 + 17.1; a *= .5; } return s / .9375; }
#define hexc(r, g, b) pow(vec3(r, g, b) / 255., vec3(2.2))
// 1 → vzor je vidět, 0 → vzor je menší než pixel (potlačit, ať to nezrní)
float aa(float period, float px){ return 1. - smoothstep(period * .2, period * .6, px); }
// bump mapping z libovolné výškové funkce (Mikkelsen, jako three.js bumpmap)
vec3 bumpNormal(vec3 surfPos, vec3 n, float h, float faceDir){
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
  vec2 dH = vec2(dFdx(h), dFdy(h));
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dH.x * r1 + dH.y * r2);
  return normalize(abs(det) * n - grad);
}
`;

/** Vloží kód do shaderu MeshStandardMaterial. */
export function patch(shader, { vertHead = '', vertBody = '', fragHead = '', afterColor = '', roughness, metalness, height }) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${vertHead}`)
    .replace('#include <fog_vertex>', `#include <fog_vertex>\n${vertBody}`);
  let f = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${COMMON}\n${fragHead}`)
    .replace('#include <color_fragment>', `#include <color_fragment>\n${afterColor}`);
  if (roughness) f = f.replace('#include <roughnessmap_fragment>', `float roughnessFactor = ${roughness};`);
  if (metalness) f = f.replace('#include <metalnessmap_fragment>', `float metalnessFactor = ${metalness};`);
  if (height) {
    f = f.replace('#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>\nnormal = bumpNormal(-vViewPosition, normal, ${height}, faceDirection);`);
  }
  shader.fragmentShader = f;
}
