import * as THREE from 'three';
import { patch } from './glsl.js';


// Zjednodušený, stylizovaný povrch: každá třída pokryvu jednou plochou barvou.
// Žádný šum ani bump mapping – jen 4 čtení z mapy pokryvu kvůli hladkým hranicím.
// Barvy (sRGB) musí odpovídat FAR_COL v tools/build_data.py.
const PALETTE = {
  1: [146, 172, 98], 2: [128, 160, 82], 3: [154, 188, 102], 4: [136, 164, 94], 5: [96, 128, 74],
  6: [84, 116, 70], 7: [90, 122, 72], 8: [116, 146, 84], 9: [192, 186, 162], 10: [178, 174, 162],
  11: [112, 162, 192], 17: [172, 166, 156], 19: [142, 168, 112], 20: [154, 144, 132],
};
const FIELDS = [[[118, 156, 76], [138, 170, 84], [104, 146, 82]], [[222, 198, 122], [210, 182, 108], [228, 210, 140]],
  [[172, 130, 94], [156, 118, 86], [184, 144, 104]]];

const srgb = (c) => c.map((v) => (v / 255) ** 2.2);
const vec3 = (c) => `vec3(${srgb(c).map((v) => v.toFixed(4)).join(', ')})`;
const PALETTE_GLSL = Object.entries(PALETTE)
  .map(([k, c]) => `  if (cls == ${k}) return ${vec3(c)};`).join('\n');
const FIELD_GLSL = FIELDS.map((st, i) => st.map((c, j) => `  if (st == ${i} && v == ${j}) return ${vec3(c)};`).join('\n')).join('\n');

const SURFACE = /* glsl */ `
uniform sampler2D uLC;
uniform vec4 uRect;          // x0, z0, velikost dlaždice [m], velikost textury [px]
varying vec3 vWPos;

vec3 fieldColor(int st, int v){
${FIELD_GLSL}
  return vec3(.3);
}
vec3 classColor(int cls){
${PALETTE_GLSL}
  return ${vec3(PALETTE[1])};
}
// Barva plochy s hladkými hranicemi: 3×3 pixely mapy pokryvu s váhami kvadratického B-splinu,
// vyhrává plocha s největší vahou. Pole se rozlišují i podle stavu (zelený kanál), takže hranice
// dvou sousedních polí je plynulá křivka a ne schody po pixelech.
int landKey(vec4 t){
  int r = int(t.r * 255. + .5);
  return r == 2 ? 512 + int(t.g * 255. + .5) : r;
}
vec3 landColor(vec2 p){
  vec2 f = vec2(p.x - uRect.x, uRect.z - (p.y - uRect.y)) * (uRect.w / uRect.z) - .5;
  vec2 c = floor(f + .5);
  vec2 d = f - c;
  vec3 wx = vec3(.5 * (.5 - d.x) * (.5 - d.x), .75 - d.x * d.x, .5 * (.5 + d.x) * (.5 + d.x));
  vec3 wy = vec3(.5 * (.5 - d.y) * (.5 - d.y), .75 - d.y * d.y, .5 * (.5 + d.y) * (.5 + d.y));
  int S = int(uRect.w) - 1;
  ivec2 ic = ivec2(c);
  vec4 tx[9]; int k[9]; float w[9];
  for (int j = 0; j < 3; j++) for (int i = 0; i < 3; i++) {
    int n = j * 3 + i;
    tx[n] = texelFetch(uLC, clamp(ic + ivec2(i - 1, j - 1), ivec2(0), ivec2(S)), 0);
    k[n] = landKey(tx[n]);
    w[n] = wx[i] * wy[j];
  }
  int best = 4; float bestScore = -1.;
  for (int a = 0; a < 9; a++) {
    float sc = 0.;
    for (int b = 0; b < 9; b++) sc += k[b] == k[a] ? w[b] : 0.;
    if (sc > bestScore + 1e-4) { bestScore = sc; best = a; }
  }
  vec4 t = tx[best];
  int cls = int(t.r * 255. + .5);
  if (cls == 2) {
    int g = int(t.g * 255. + .5);
    return fieldColor(min(g / 64, 2), (g % 64) % 3);
  }
  return classColor(cls);
}
`;

export function createTerrainMaterials({ farTex, meta }) {
  const far = new THREE.MeshLambertMaterial({ map: farTex, flatShading: true });

  /** Materiál pro jednu dlaždici zblízka (vlastní mapa pokryvu). */
  function near(lcTex, x0, z0) {
    const uniforms = {
      uLC: { value: lcTex },
      uRect: { value: new THREE.Vector4(x0, z0, meta.tile, lcTex.image.width) },
    };
    const mat = new THREE.MeshLambertMaterial({ flatShading: true });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      patch(shader, {
        vertHead: 'varying vec3 vWPos;',
        vertBody: 'vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        fragHead: SURFACE,
        afterColor: 'diffuseColor.rgb = landColor(vWPos.xz);',
      });
    };
    mat.customProgramCacheKey = () => 'terrain-near-smooth';
    return mat;
  }
  return { far, near };
}

/**
 * Síť dlaždice n × n uzlů se „sukní“ (svislý pruh dolů po obvodu), která schová škvíry
 * mezi dlaždicemi s různým rozlišením. Normály se počítají z výšek i přes hranu dlaždice.
 */
export function gridGeometry({ n, step, x0, z0, h, heightAt, uvWorld }) {
  const skirt = 8;
  const border = [];
  for (let c = 0; c < n; c++) border.push([0, c]);
  for (let r = 1; r < n; r++) border.push([r, n - 1]);
  for (let c = n - 2; c >= 0; c--) border.push([n - 1, c]);
  for (let r = n - 2; r >= 1; r--) border.push([r, 0]);
  const total = n * n + border.length * 2;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const uv = uvWorld ? new Float32Array(total * 2) : null;

  const H = (r, c) => (r >= 0 && r < n && c >= 0 && c < n ? h(r, c) : heightAt(x0 + c * step, z0 + r * step));
  let k = 0;
  const put = (x, y, z, nn) => {
    pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
    nrm[k * 3] = nn[0]; nrm[k * 3 + 1] = nn[1]; nrm[k * 3 + 2] = nn[2];
    if (uv) { uv[k * 2] = (x + uvWorld.x / 2) / uvWorld.x; uv[k * 2 + 1] = 1 - (z + uvWorld.y / 2) / uvWorld.y; }
    k++;
  };
  const normals = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const nx = H(r, c - 1) - H(r, c + 1), nz = H(r - 1, c) - H(r + 1, c), ny = 2 * step;
      const l = Math.hypot(nx, ny, nz);
      const nn = [nx / l, ny / l, nz / l];
      normals.push(nn);
      put(x0 + c * step, h(r, c), z0 + r * step, nn);
    }
  }
  const idx = [];
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const a = r * n + c, b = a + n;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const top0 = k;
  for (const [r, c] of border) {
    const i = r * n + c;
    put(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], normals[i]);
    put(pos[i * 3], pos[i * 3 + 1] - skirt, pos[i * 3 + 2], normals[i]);
  }
  for (let q = 0; q < border.length; q++) {
    const a = top0 + q * 2, b = top0 + ((q + 1) % border.length) * 2;
    idx.push(a, a + 1, b, b, a + 1, b + 1, a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  if (uv) g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
