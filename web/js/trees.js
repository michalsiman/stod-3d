import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SEASON, SEASON_GLSL } from './season.js';
import { COMMON } from './glsl.js';

// Stylizované stromy: listnatý = mnohostěn (20 trojúhelníků), jehličnan = dva kužely.
// Po blocích 256 × 256 m; zobrazují se s detailem dlaždice (do ~700 m), dál je les
// znázorněn zvednutým terénem zdálky.

function rand(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// tónování koruny: zespodu tmavší, nahoře světlejší (vertex color × barva instance)
function shade(g, lo = 0.72, hi = 1.12) {
  const pos = g.attributes.position, col = new Float32Array(pos.count * 3);
  g.computeBoundingBox();
  const { min, max } = g.boundingBox;
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - min.y) / (max.y - min.y || 1);
    const k = lo + (hi - lo) * t;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function deciduousGeo() {
  // koruna ze dvou „chuchvalců“ s mírně rozházenými vrcholy (40 trojúhelníků)
  const r = rand(11);
  const parts = [[1, 0, -0.08, 0], [0.68, 0.32, 0.42, -0.18]].map(([rad, x, y, z]) => {
    const g = new THREE.IcosahedronGeometry(rad, 0);
    const p = g.attributes.position;
    const jit = new Map();
    for (let i = 0; i < p.count; i++) {
      const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
      if (!jit.has(key)) jit.set(key, 0.88 + r() * 0.24);
      const k = jit.get(key);
      p.setXYZ(i, p.getX(i) * k + x, p.getY(i) * k * 0.92 + y, p.getZ(i) * k + z);
    }
    g.deleteAttribute('uv');
    return g;
  });
  const g = mergeGeometries(parts);
  g.computeVertexNormals();
  return shade(g);
}

function coniferGeo() {
  const parts = [[1.0, 0.0, 0.5], [0.78, 0.3, 0.78], [0.52, 0.58, 1.0]].map(([r, y0, y1]) => {
    const g = new THREE.ConeGeometry(r, y1 - y0, 7, 1).translate(0, (y0 + y1) / 2, 0).toNonIndexed();
    g.deleteAttribute('uv');
    return g;
  });
  const g = mergeGeometries(parts);
  g.computeVertexNormals();
  return shade(g, 0.7, 1.08);
}

export function createTrees({ buf, meta, world, exclude, extra = [] }) {
  const u16 = new Uint16Array(buf), u8 = new Uint8Array(buf);
  const W = meta.width, H = meta.height, C = meta.chunk, ncx = W / C;
  const starts = meta.tree_chunks;

  const mat = new THREE.MeshLambertMaterial({ flatShading: true, vertexColors: true });
  // listnáče: barvy a hustota koruny podle ročního období (holé v zimě)
  const decMat = mat.clone();
  decMat.onBeforeCompile = (shader) => {
    shader.uniforms.uDoy = SEASON.doy;
    shader.uniforms.uSnow = SEASON.snow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uDoy;\nfloat leafAmt(){ return smoothstep(100., 128., uDoy) * (1. - smoothstep(292., 320., uDoy)); }`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed *= mix(.72, 1., leafAmt());');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${COMMON}\n${SEASON_GLSL}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\n{ vec3 nv = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition))); float upw = max(dot(nv, normalize((viewMatrix * vec4(0., 1., 0., 0.)).xyz)), 0.);\n  diffuseColor.rgb = snowy(seasonLeaf(diffuseColor.rgb), .4 * upw); }');
  };
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x7a5c44 });
  // jehličnany: sníh na horních plochách
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSnow = SEASON.snow;
    shader.uniforms.uDoy = SEASON.doy;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${COMMON}\n${SEASON_GLSL}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\n{ vec3 nv = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition))); float upw = dot(nv, normalize((viewMatrix * vec4(0., 1., 0., 0.)).xyz));\n  diffuseColor.rgb = snowy(diffuseColor.rgb, .6 * smoothstep(.15, .6, abs(upw))); }');
  };
  // spadané listí: plochý kruh pod korunou; v shaderu skvrny listí (šum podle polohy), hustší u kmene,
  // množství a barva podle ročního období (říjen přibývá, v zimě hnědne, na jaře zmizí), pod sněhem skryté
  const litterGeo = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
  const litterMat = new THREE.MeshLambertMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
  litterMat.onBeforeCompile = (shader) => {
    shader.uniforms.uDoy = SEASON.doy;
    shader.uniforms.uSnow = SEASON.snow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLW; varying vec2 vLR; varying vec3 vSeed;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLR = position.xz;
        vLW = (modelMatrix * instanceMatrix * vec4(position, 1.)).xyz;
        vSeed = instanceColor;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${COMMON}\n${SEASON_GLSL}\nvarying vec3 vLW; varying vec2 vLR; varying vec3 vSeed;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float d = uDoy;
          float amt = max(smoothstep(280., 318., d), 1. - smoothstep(60., 105., d)) * (1. - uSnow);
          float r = length(vLR);
          float n = vnoise(vLW.xz * 2.6) * .65 + vnoise(vLW.xz * 7.3) * .35;
          float dens = amt * (1.05 - r * .75) - (1. - smoothstep(.8, 1., 1. - r)) * .0;
          if (n > dens * .95 || r > .98) discard;
          float h = hash12(floor(vLW.xz * 5.));
          vec3 autumn = mix(hexc(214, 152, 48), hexc(176, 78, 34), h);
          autumn = mix(autumn, hexc(132, 96, 58), step(.7, hash12(floor(vLW.xz * 3.1) + 7.)));
          vec3 old = mix(hexc(104, 80, 56), hexc(128, 104, 74), h);
          float aging = smoothstep(318., 350., d) + (1. - step(200., d));
          diffuseColor.rgb = mix(autumn, old, clamp(aging, 0., 1.)) * (.85 + .3 * fract(h * 7.));
        }`);
  };
  litterMat.customProgramCacheKey = () => 'leaf-litter';
  const decGeo = deciduousGeo(), conGeo = coniferGeo();
  const trunkGeo = new THREE.CylinderGeometry(0.15, 0.2, 1, 4, 1).translate(0, 0.5, 0);

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const col = new THREE.Color();

  // doplňkové stromy (např. z OSM tam, kde je výškový model nevidí): [x, z, výška, poloměr]
  const extraBy = new Map();
  for (const t of extra) {
    const k = Math.floor((t[1] + H / 2) / C) * ncx + Math.floor((t[0] + W / 2) / C);
    if (!extraBy.has(k)) extraBy.set(k, []);
    extraBy.get(k).push(t);
  }
  function buildChunk(cx, cz) {
    const k = cz * ncx + cx, a = starts[k] ?? 0, b = starts[k + 1] ?? 0;
    const ex = extraBy.get(k) || [];
    if (!(b > a) && !ex.length) return null;
    const r = rand(k * 31 + 7);
    const dec = [], con = [], trunk = [], litter = [];
    for (let i = a; i < b + ex.length; i++) {
      let x, z, h, rad, kind;
      if (i < b) {
        x = u16[i * 4] * 0.2 - W / 2; z = u16[i * 4 + 1] * 0.2 - H / 2;
        h = u8[i * 8 + 4] / 5; rad = u8[i * 8 + 5] / 10; kind = u8[i * 8 + 6];
        if (exclude && exclude(x, z, rad)) continue;
      } else {
        [x, z, h, rad] = ex[i - b]; kind = 0;
      }
      const g = world.heightAt(x, z);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, r() * Math.PI * 2);
      if (kind & 1) {
        const y0 = h * 0.15;
        m.compose(p.set(x, g + y0, z), q, s.set(rad, h - y0, rad));
        col.setHSL(0.31 + r() * 0.05, 0.32 + r() * 0.1, 0.28 + r() * 0.06);
        con.push([m.clone(), col.clone()]);
      } else {
        const ch = Math.max(h * 0.62, 1.6);
        m.compose(p.set(x, g + h - ch / 2, z), q, s.set(rad, ch / 2, rad));
        col.setHSL(0.22 + r() * 0.06, 0.4 + r() * 0.12, 0.36 + r() * 0.08);
        dec.push([m.clone(), col.clone()]);
        // spadané listí pod korunou (jen u samostatných stromů a na okraji lesa – v lese je zem tmavá)
        if (!(kind & 2) || r() < 0.35) {
          litter.push([new THREE.Matrix4().compose(p.set(x, g + 0.1, z), q, s.set(rad * 1.25, 1, rad * 1.25)), col.clone()]);
        }
        // kmen i u stromů v lese (jinak koruna visí ve vzduchu – koruna začíná až v ~40 % výšky)
        trunk.push([new THREE.Matrix4().compose(p.set(x, g - 0.2, z), q, s.set(1, Math.max(0.5, h - ch * 0.8), 1))]);
      }
    }
    const grp = new THREE.Group();
    for (const [geo, list, material] of [[decGeo, dec, decMat], [conGeo, con, mat], [trunkGeo, trunk, trunkMat]]) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(geo, material, list.length);
      list.forEach(([mm, cc], i) => { im.setMatrixAt(i, mm); if (cc) im.setColorAt(i, cc); });
      im.castShadow = im.receiveShadow = true;
      im.computeBoundingSphere();
      grp.add(im);
    }
    if (litter.length) {
      const im = new THREE.InstancedMesh(litterGeo, litterMat, litter.length);
      litter.forEach(([mm, cc], i) => { im.setMatrixAt(i, mm); im.setColorAt(i, cc); });
      im.receiveShadow = true;
      im.computeBoundingSphere();
      grp.add(im);
    }
    return grp;
  }

  return {
    build(tile, group) {
      const n = meta.tile / C;
      for (let dz = 0; dz < n; dz++) {
        for (let dx = 0; dx < n; dx++) {
          const ch = buildChunk(tile.i * n + dx, tile.j * n + dz);
          if (ch) group.add(ch);
        }
      }
    },
  };
}
