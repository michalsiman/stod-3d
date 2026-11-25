import * as THREE from 'three';
import { gridGeometry } from './terrain.js';
import { NIGHT } from './night.js';

// Přepínač „Historie“: terén potažený historickou mapou nebo leteckým snímkem (data/hist/<rok>/<i>_<j>.jpg,
// tools/build_history.py); současné budovy, silnice, stromy, doprava a další vrstvy se skryjí.
// Dlaždice se načítají až při prvním zapnutí daného roku (nejbližší ke kameře první). Telefony dostanou
// zmenšené dlaždice (SMALL) – plné rozlišení zabere ~300 MB paměti grafiky a mobil textury nenačte.
// V noci je snímek mírně přisvětlený, aby byl čitelný.

export const HISTORY = {
  '1953': 'Letecké snímky 1953',
  '1880': 'Vojenská mapa kolem 1880',
};

const SMALL = { '1953': '1953s' };

export function createHistory({ world, meta, scene, keep, coarse, camera }) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  const T = meta.tile, step = 16, n = T / step + 1;
  const meshes = [];
  const loader = new THREE.TextureLoader();
  const mats = new Map();
  let year = null;
  const hidden = [];

  function build() {
    if (meshes.length) return;
    for (let j = 0; j < meta.ny; j++) {
      for (let i = 0; i < meta.nx; i++) {
        const x0 = -world.W / 2 + i * T, z0 = -world.H / 2 + j * T;
        const g = gridGeometry({
          n, step, x0, z0, h: (r, c) => world.heightAt(x0 + c * step, z0 + r * step) + 0.6, heightAt: (x, z) => world.heightAt(x, z) + 0.6,
        });
        // UV podle polohy v dlaždici (sukně po obvodu má UV okraje)
        const pos = g.attributes.position, uv = new Float32Array(pos.count * 2);
        for (let k = 0; k < pos.count; k++) {
          uv[k * 2] = THREE.MathUtils.clamp((pos.getX(k) - x0) / T, 0, 1);
          uv[k * 2 + 1] = 1 - THREE.MathUtils.clamp((pos.getZ(k) - z0) / T, 0, 1);
        }
        g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xcfc8b8 }));
        m.userData.tile = [i, j];
        m.receiveShadow = true;
        group.add(m);
        meshes.push(m);
      }
    }
  }
  function material(y, i, j) {
    const key = `${y}/${i}_${j}`;
    if (!mats.has(key)) {
      const mat = new THREE.MeshLambertMaterial({ color: 0xb9b4a8 });
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uNight = NIGHT.night;
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uNight;')
          .replace('#include <opaque_fragment>', 'outgoingLight += diffuseColor.rgb * uNight * .6;\n#include <opaque_fragment>');
      };
      const dir = (coarse && SMALL[y]) || y;
      loader.load(`data/hist/${dir}/${i}_${j}.jpg`, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = coarse ? 2 : 8;
        mat.map = tex; mat.color.set(0xffffff); mat.needsUpdate = true;
        onLoad?.();
      }, undefined, () => console.warn('historie: nenačteno', key));
      mats.set(key, mat);
    }
    return mats.get(key);
  }
  let onLoad = null;
  return {
    group,
    get year() { return year; },
    set(y, changed) {
      onLoad = changed;
      year = y || null;
      if (year) {
        build();
        // nejdřív dlaždice nejblíž ke kameře (načítání jde v pořadí požadavků)
        const T2 = meta.tile / 2, cx = camera ? camera.position.x : 0, cz = camera ? camera.position.z : 0;
        const dist = (m) => { const [i, j] = m.userData.tile; return Math.hypot(-world.W / 2 + i * meta.tile + T2 - cx, -world.H / 2 + j * meta.tile + T2 - cz); };
        for (const m of [...meshes].sort((a, b) => dist(a) - dist(b))) m.material = material(year, ...m.userData.tile);
        if (!hidden.length) {
          for (const o of scene.children) {
            if (o === group || keep(o) || !o.visible) continue;
            o.visible = false;
            hidden.push(o);
          }
        }
        group.visible = true;
      } else {
        group.visible = false;
        for (const o of hidden) o.visible = true;
        hidden.length = 0;
      }
    },
  };
}
