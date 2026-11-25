import * as THREE from 'three';
import { gridGeometry } from './terrain.js';

// Přepínač „Historie“: terén potažený historickou mapou nebo leteckým snímkem (data/hist/<rok>/<i>_<j>.jpg,
// tools/build_history.py); současné budovy, silnice, stromy, doprava a další vrstvy se skryjí.
// Dlaždice se načítají až při prvním zapnutí daného roku.

export const HISTORY = {
  '1953': 'Letecké snímky 1953',
  '1880': 'Vojenská mapa kolem 1880',
};

export function createHistory({ world, meta, scene, keep }) {
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
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      loader.load(`data/hist/${key}.jpg`, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        mat.map = tex; mat.needsUpdate = true;
        onLoad?.();
      });
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
        for (const m of meshes) m.material = material(year, ...m.userData.tile);
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
