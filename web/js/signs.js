import * as THREE from 'three';
import { NIGHT } from './night.js';

// Cedule s nápisy (signs.json z tools/build_signs.py): na stěnu domu pod bodem nebo nejbližšího
// do 30 m, ke stěně, která míří k nejbližší silnici / ulici. Bez domu stojí cedule na dvou sloupcích.
const STYLE = {
  urad: ['#1f3a68', '#ffffff'],
  zdravi: ['#ffffff', '#0f7a3a', '#0f9a48'],
  skola: ['#7a2e22', '#fff2d8'],
  posta: ['#ffcc00', '#1d3b8f'],
  hasici: ['#b8221d', '#ffffff'],
  policie: ['#1d4f9c', '#ffffff'],
  kultura: ['#f3ead4', '#5a2d1a'],
  nadrazi: ['#1f4e8c', '#ffffff'],
  obchod: ['#ffffff', '#1d2b3a', '#e0a100'],
  jidlo: ['#3d2a1e', '#f4d9a8'],
  firma: ['#ffffff', '#0d3c78', '#0d3c78'],
  benzin: ['#1f6d3a', '#ffffff'],
};
const ROAD_TYPES = new Set([0, 1, 2, 3]);
// výška horní hrany oken přízemí a parapetu 1. patra nad terénem [m] podle druhu budovy
const FLOOR_GAP = {
  house: [2.55, 4.15], flats: [2.7, 4.05], civic: [3.05, 4.8],
  farm: [2.7, 99], industry: [2.6, 99], shed: [2.0, 99], garage: [2.2, 99], greenhouse: [2.4, 99],
};

function texture(text, style) {
  const [bg, fg, stripe] = STYLE[style] || STYLE.obchod;
  const H = 96, font = `700 ${H * 0.52}px "Inter", "Segoe UI", Arial, sans-serif`;
  const c = document.createElement('canvas');
  let ctx = c.getContext('2d');
  ctx.font = font;
  const pad = H * 0.45;
  const w = Math.min(2048, Math.ceil(ctx.measureText(text).width + pad * 2 + (stripe ? H * 0.25 : 0)));
  c.width = w; c.height = H;
  ctx = c.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, H);
  if (stripe) { ctx.fillStyle = stripe; ctx.fillRect(0, 0, H * 0.14, H); }
  ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 4; ctx.strokeRect(2, 2, w - 4, H - 4);
  ctx.font = font; ctx.fillStyle = fg; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.fillText(text, w / 2 + (stripe ? H * 0.07 : 0), H * 0.54);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return { tex: t, aspect: w / H };
}

function distToSeg(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / l2));
  const x = a[0] + t * dx, z = a[1] + t * dz;
  return [Math.hypot(px - x, pz - z), x, z];
}

const pointIn = (x, z, r) => {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > z) !== (r[j][1] > z) && x < (r[j][0] - r[i][0]) * (z - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
  }
  return inside;
};

export function createSigns({ signs, buildings, roads, world }) {
  const group = new THREE.Group();
  if (!signs?.length) return group;
  const near = (x, z, R) => buildings.filter((b) => {
    const p = b.rings[0][0];
    return Math.abs(p[0] - x) < R + 60 && Math.abs(p[1] - z) < R + 60;
  });
  const roadNear = (x, z) => {
    let best = null;
    for (const r of roads) {
      if (!ROAD_TYPES.has(r.t)) continue;
      const p0 = r.p[0];
      if (Math.abs(p0[0] - x) > 900 && Math.abs(r.p[r.p.length - 1][0] - x) > 900) continue;
      for (let i = 0; i < r.p.length - 1; i++) {
        const [d, px, pz] = distToSeg(x, z, r.p[i], r.p[i + 1]);
        if (!best || d < best.d) best = { d, x: px, z: pz };
      }
    }
    return best;
  };
  const used = new Map();
  const materials = [];

  for (const s of signs) {
    // dům: pod bodem, jinak nejbližší stěna do 30 m
    let bld = null, bd = 30;
    for (const b of near(s.x, s.z, 30)) {
      const r = b.rings[0];
      if (pointIn(s.x, s.z, r)) { bld = b; bd = 0; break; }
      for (let i = 0; i < r.length - 1; i++) {
        const [d] = distToSeg(s.x, s.z, r[i], r[i + 1]);
        if (d < bd) { bd = d; bld = b; }
      }
    }
    const { tex, aspect } = texture(s.t, s.s);
    const mat = new THREE.MeshLambertMaterial({
      map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.1, side: THREE.FrontSide,
    });
    materials.push(mat);
    const big = s.s === 'firma' || (bld && bld.k === 'industry');
    let h = big ? 1.6 : (s.s === 'obchod' || s.s === 'jidlo' ? 0.9 : 1.0);
    let w = h * aspect;

    if (bld) {
      // stěna k silnici: skóre = natočení k nejbližší silnici + délka stěny
      const r = bld.rings[0];
      let cx = 0, cz = 0;
      for (const p of r) { cx += p[0]; cz += p[1]; }
      cx /= r.length; cz /= r.length;
      const road = roadNear(cx, cz);
      const cands = [];
      for (let i = 0; i < r.length - 1; i++) {
        const a = r[i], b = r[i + 1];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 2.5) continue;
        // vnější normála (podle orientace prstence)
        let nx = (b[1] - a[1]) / L, nz = -(b[0] - a[0]) / L;
        const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
        if (pointIn(mx + nx * 0.3, mz + nz * 0.3, r)) { nx = -nx; nz = -nz; }
        let face = 0;
        if (road) {
          const dx = road.x - mx, dz = road.z - mz, dl = Math.hypot(dx, dz) || 1;
          face = (nx * dx + nz * dz) / dl;
        }
        const key = `${mx.toFixed(1)},${mz.toFixed(1)}`;
        cands.push({ a, b, L, nx, nz, mx, mz, key, score: face * 2 + Math.min(L, 14) / 14 - (used.get(key) || 0) * 3 });
      }
      if (!cands.length) continue;
      cands.sort((p, q) => q.score - p.score);
      const e = cands[0];
      used.set(e.key, (used.get(e.key) || 0) + 1);
      // pás mezi okny přízemí a 1. patra (stejné rozměry oken jako v buildings.js), u přízemních
      // budov mezi okny a okapem
      const [top, next] = FLOOR_GAP[bld.k] || FLOOR_GAP.house;
      const eave = bld.eave;
      let y0 = top + 0.12, y1 = Math.min(next - 0.12, eave - 0.2);
      if (y1 - y0 < 0.5) { y0 = Math.min(2.4, eave - 0.7); y1 = eave - 0.15; }
      if (h > y1 - y0) h = Math.max(0.75, y1 - y0);
      w = h * aspect;
      const maxW = e.L - 0.6;
      if (w > maxW) { h *= maxW / w; w = maxW; }
      const y = bld.base + (y0 + y1) / 2;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      mesh.position.set(e.mx + e.nx * 0.06, y, e.mz + e.nz * 0.06);
      mesh.rotation.y = Math.atan2(e.nx, e.nz);
      group.add(mesh);
    } else {
      // samostatná cedule na dvou sloupcích, čelem k silnici
      const road = roadNear(s.x, s.z);
      const yaw = road ? Math.atan2(road.x - s.x, road.z - s.z) : 0;
      const g = world.heightAt(s.x, s.z);
      const sign = new THREE.Group();
      const board = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      board.position.y = 2.4 + h / 2;
      const back = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, h + 0.08, 0.06), new THREE.MeshLambertMaterial({ color: 0x55595c }));
      back.position.set(0, board.position.y, -0.04);
      sign.add(board, back);
      for (const sx of [-w / 2 + 0.15, w / 2 - 0.15]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6 + h, 6), back.material);
        post.position.set(sx, (2.6 + h) / 2 - 0.2, -0.1);
        sign.add(post);
      }
      sign.position.set(s.x, g, s.z);
      sign.rotation.y = yaw;
      group.add(sign);
    }
  }
  // v noci cedule mírně svítí (podsvícené / nasvícené)
  const update = () => { const k = 0.08 + 0.55 * NIGHT.night.value; for (const m of materials) m.emissiveIntensity = k; };
  return Object.assign(group, { update });
}
