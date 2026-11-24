import * as THREE from 'three';
import { createTerrainMaterials, gridGeometry } from './terrain.js';

// Dlaždice 1024 m: zdálky levná síť 16 m s barevnou mapou, zblízka síť 4 m
// s procedurálním povrchem + detaily (silnice, stromy, ploty, vedení).
const SHOW_D = 700;      // do této vzdálenosti [m] se ukazuje detail dlaždice
const LOAD_D = 950;      // od této vzdálenosti se detail začne načítat
const DROP_D = 2600;     // dál se detail zahodí (paměť)
const NEAR_STRIDE = 2;   // terén zblízka 8 m (každý 2. uzel 4m dat) – méně trojúhelníků

export class World {
  constructor({ meta, farH, farTex, scene, onChange }) {
    Object.assign(this, { meta, scene, onChange });
    this.T = meta.tile;
    this.W = meta.width;
    this.H = meta.height;
    this.farH = farH;
    this.fw = meta.far.w;
    this.fstep = meta.far.step;
    this.mats = createTerrainMaterials({ farTex, meta });
    this.builders = [];          // (tile, group) => void – detailní vrstvy
    this.lodHooks = [];          // (tile, camera) => void
    this.loading = 0;
    this.tiles = [];
    for (let j = 0; j < meta.ny; j++) {
      for (let i = 0; i < meta.nx; i++) {
        const t = { i, j, x0: -this.W / 2 + i * this.T, z0: -this.H / 2 + j * this.T, h: null, detail: null };
        t.far = this.farMesh(t);
        scene.add(t.far);
        this.tiles.push(t);
      }
    }
  }

  tileAt(x, z) {
    const i = Math.floor((x + this.W / 2) / this.T), j = Math.floor((z + this.H / 2) / this.T);
    if (i < 0 || j < 0 || i >= this.meta.nx || j >= this.meta.ny) return null;
    return this.tiles[j * this.meta.nx + i];
  }

  /** Výška terénu [m nad hmin]; zblízka z 4m sítě, jinak ze vzdálené 16m sítě (v lesích koruny). */
  heightAt(x, z) {
    const t = this.tileAt(x, z);
    if (t && t.h) {
      // síť zblízka = každý NEAR_STRIDE-tý uzel 4m dat (8 m) – stejná jako vykreslený terén
      const s = this.meta.t_step * NEAR_STRIDE, n = this.T / s + 1, N = this.T / this.meta.t_step + 1;
      const c = Math.min((x - t.x0) / s, n - 1.001), r = Math.min((z - t.z0) / s, n - 1.001);
      const c0 = Math.floor(c), r0 = Math.floor(r), fc = c - c0, fr = r - r0;
      const at = (rr, cc) => t.h[rr * NEAR_STRIDE * N + cc * NEAR_STRIDE];
      return ((at(r0, c0) * (1 - fc) + at(r0, c0 + 1) * fc) * (1 - fr)
        + (at(r0 + 1, c0) * (1 - fc) + at(r0 + 1, c0 + 1) * fc) * fr) / 100;
    }
    return this.farHeightAt(x, z);
  }

  farHeightAt(x, z) {
    const s = this.fstep, w = this.fw, hh = this.meta.far.h;
    const c = THREE.MathUtils.clamp((x + this.W / 2) / s, 0, w - 1.001);
    const r = THREE.MathUtils.clamp((z + this.H / 2) / s, 0, hh - 1.001);
    const c0 = Math.floor(c), r0 = Math.floor(r), fc = c - c0, fr = r - r0, i = r0 * w + c0;
    const a = this.farH;
    return ((a[i] * (1 - fc) + a[i + 1] * fc) * (1 - fr) + (a[i + w] * (1 - fc) + a[i + w + 1] * fc) * fr) / 100;
  }

  farMesh(t) {
    const n = this.T / this.fstep + 1;
    const c0 = t.i * (n - 1), r0 = t.j * (n - 1);
    const g = gridGeometry({
      n, step: this.fstep, x0: t.x0, z0: t.z0,
      h: (r, c) => this.farH[(r0 + r) * this.fw + c0 + c] / 100,
      heightAt: (x, z) => this.farHeightAt(x, z),
      uvWorld: { x: this.W, y: this.H },
    });
    const m = new THREE.Mesh(g, this.mats.far);
    m.receiveShadow = true;
    return m;
  }

  loadHeights(t) {
    if (!t.hPromise) {
      t.hPromise = fetch(`data/t/${t.i}_${t.j}.bin`).then((r) => r.arrayBuffer())
        .then((b) => { t.h = new Uint16Array(b); });
    }
    return t.hPromise;
  }

  async loadDetail(t) {
    this.loading++;
    try {
      // výšky sousedů – kvůli navazování silnic a normál přes hranu
      const nb = this.tiles.filter((o) => Math.abs(o.i - t.i) <= 1 && Math.abs(o.j - t.j) <= 1);
      const [lcTex] = await Promise.all([
        new THREE.TextureLoader().loadAsync(`data/t/${t.i}_${t.j}.png`),
        ...nb.map((o) => this.loadHeights(o)),
      ]);
      lcTex.colorSpace = THREE.NoColorSpace;
      lcTex.magFilter = lcTex.minFilter = THREE.NearestFilter;
      lcTex.generateMipmaps = false;
      const s = this.meta.t_step * NEAR_STRIDE, n = this.T / s + 1, N = this.T / this.meta.t_step + 1;
      const g = gridGeometry({
        n, step: s, x0: t.x0, z0: t.z0,
        h: (r, c) => t.h[r * NEAR_STRIDE * N + c * NEAR_STRIDE] / 100,
        heightAt: (x, z) => this.heightAt(x, z),
      });
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(g, this.mats.near(lcTex, t.x0, t.z0));
      mesh.receiveShadow = true;
      group.add(mesh);
      t.lcTex = lcTex;
      for (const b of this.builders) b(t, group);
      group.visible = false;
      t.detail = group;
      this.scene.add(group);
    } finally {
      this.loading--;
    }
    this.onChange();
  }

  dropDetail(t) {
    t.detail.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.isInstancedMesh) o.dispose();
    });
    t.detail.children[0].material.dispose();
    t.lcTex.dispose();
    this.scene.remove(t.detail);
    t.detail = null;
    t.detailPromise = null;
  }

  /** Vzdálenost kamery od dlaždice (vodorovně k obdélníku + výška nad terénem). */
  distance(cam, x0, z0, size, groundY) {
    const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + size));
    const dz = Math.max(z0 - cam.z, 0, cam.z - (z0 + size));
    return Math.hypot(dx, dz, Math.max(0, cam.y - groundY));
  }

  update(camera) {
    const cam = camera.position;
    const g = this.heightAt(cam.x, cam.z);
    let changed = false;
    const order = this.tiles.map((t) => [t, this.distance(cam, t.x0, t.z0, this.T, g)]).sort((a, b) => a[1] - b[1]);
    for (const [t, d] of order) {
      if (d < LOAD_D && !t.detailPromise && this.loading < 2) t.detailPromise = this.loadDetail(t);
      if (t.detail && d > DROP_D) { this.dropDetail(t); changed = true; continue; }
      // hystereze: zapnout pod SHOW_D, vypnout až nad SHOW_D + 150 m (jinak na hranici bliká)
      const near = !!t.detail && (t.detail.visible ? d < SHOW_D + 150 : d < SHOW_D);
      if (t.far.visible === near) { t.far.visible = !near; changed = true; }
      if (t.detail && t.detail.visible !== near) { t.detail.visible = near; changed = true; }
      if (near) for (const hook of this.lodHooks) changed = hook(t, cam, g) || changed;
    }
    return changed;
  }
}
