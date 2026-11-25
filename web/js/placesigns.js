import * as THREE from 'three';

// Dopravní značky IS12a „Začátek obce“ a IS12b „Konec obce“ (s červeným pruhem) na silnicích
// a místních komunikacích, kde vjíždějí do zástavby: bílá tabule s černým okrajem a názvem, vpravo
// ve směru jízdy. Zástavba = souvislá oblast obytných a veřejných budov (mezery do ~200 m – pole,
// park, řeka – se uzavřou), aspoň 12 domů. Název = nejbližší obec / část obce.
const ROAD_TYPES = new Set([0, 1, 2, 3]);
const WIDTH = [8.5, 6.5, 5.0, 3.5];
const STEP = 5, NEAR = 50, GAP = 220, SET_BACK = 12;
// zástavbu tvoří obytné a veřejné budovy; samotné statky, haly a kůlny ne
const HOMES = new Set(['house', 'flats', 'civic']);

function texture(name, end) {
  const H = 160;
  const c = document.createElement('canvas');
  let ctx = c.getContext('2d');
  const font = `600 ${H * 0.46}px "Inter", "Segoe UI", Arial, sans-serif`;
  ctx.font = font;
  const w = Math.max(H * 2.2, Math.ceil(ctx.measureText(name).width + H * 0.7));
  c.width = w; c.height = H;
  ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, H);
  ctx.strokeStyle = '#111'; ctx.lineWidth = H * 0.06;
  const r = H * 0.08, m = H * 0.07;
  ctx.beginPath(); ctx.roundRect(m, m, w - 2 * m, H - 2 * m, r); ctx.stroke();
  ctx.font = font; ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(name, w / 2, H * 0.53);
  if (end) {
    ctx.strokeStyle = '#d0201b'; ctx.lineWidth = H * 0.11; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(m * 1.6, H - m * 1.6); ctx.lineTo(w - m * 1.6, m * 1.6); ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return { tex: t, aspect: w / H };
}

export function createPlaceSigns({ roads, buildings, places, bridges, world }) {
  const group = new THREE.Group();
  const towns = (places || []).filter((p) => p.rank >= 2);
  if (!towns.length) return group;
  // ---- zástavba obcí: mřížka 10 m s obytnými budovami → rozšířit o 50 m → uzavřít mezery do ~200 m
  // (pole, park, řeka mezi domy) → souvislé oblasti; oblasti s alespoň 12 domy = obec
  const CELL = 10, GW = Math.ceil(world.W / CELL), GH = Math.ceil(world.H / CELL);
  const gi = (x, z) => {
    const c = Math.floor((x + world.W / 2) / CELL), r = Math.floor((z + world.H / 2) / CELL);
    return c >= 0 && r >= 0 && c < GW && r < GH ? r * GW + c : -1;
  };
  let grid = new Uint8Array(GW * GH);
  const homes = [];
  for (const b of buildings) {
    if (!HOMES.has(b.k)) continue;
    const r = b.rings[0];
    let cx = 0, cz = 0;
    for (const [x, z] of r) { cx += x; cz += z; const k = gi(x, z); if (k >= 0) grid[k] = 1; }
    homes.push([cx / r.length, cz / r.length]);
  }
  // max / min filtr čtvercem (dvě 1D projížďky s posuvným počtem)
  const morph = (src, rad, dilate) => {
    const tmp = new Uint8Array(src.length), out = new Uint8Array(src.length);
    const pass = (a, b, n, m, stride, step) => {
      for (let o = 0; o < m; o++) {
        let cnt = 0;
        const base = o * stride, at = (i) => a[base + i * step];
        for (let i = 0; i < Math.min(rad, n); i++) cnt += at(i);
        for (let i = 0; i < n; i++) {
          if (i + rad < n) cnt += at(i + rad);
          if (i - rad - 1 >= 0) cnt -= at(i - rad - 1);
          const win = Math.min(n - 1, i + rad) - Math.max(0, i - rad) + 1;
          b[base + i * step] = dilate ? (cnt > 0 ? 1 : 0) : (cnt === win ? 1 : 0);
        }
      }
    };
    pass(src, tmp, GW, GH, GW, 1);      // řádky
    pass(tmp, out, GH, GW, 1, GW);      // sloupce
    return out;
  };
  grid = morph(grid, Math.round(NEAR / CELL), true);
  grid = morph(morph(grid, Math.round(GAP / 2 / CELL), true), Math.round(GAP / 2 / CELL), false);
  // souvislé oblasti
  const label = new Int32Array(GW * GH);
  const areas = [];
  for (let k = 0; k < grid.length; k++) {
    if (!grid[k] || label[k]) continue;
    const id = areas.length + 1, stack = [k];
    label[k] = id;
    while (stack.length) {
      const q = stack.pop(), r = Math.floor(q / GW), c = q % GW;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= GH || cc >= GW) continue;
        const n = rr * GW + cc;
        if (grid[n] && !label[n]) { label[n] = id; stack.push(n); }
      }
    }
    areas.push({ id, n: 0, x: 0, z: 0, name: null });
  }
  for (const [x, z] of homes) {
    const k = gi(x, z);
    if (k < 0 || !label[k]) continue;
    const a = areas[label[k] - 1];
    a.n++; a.x += x; a.z += z;
  }
  for (const a of areas) {
    if (a.n < 12) continue;
    a.x /= a.n; a.z /= a.n;
    let bd = 2000;
    for (const p of towns) {
      const d = Math.hypot(p.x - a.x, p.z - a.z);
      if (d < bd) { bd = d; a.name = p.name; }
    }
  }
  const areaAt = (x, z) => {
    const k = gi(x, z);
    const a = k >= 0 && label[k] ? areas[label[k] - 1] : null;
    return a && a.name ? a : null;
  };

  // přechody silnic přes hranici zástavby: [x, z, směr jízdy do obce dx, dz, šířka, název]
  const spots = [];
  for (const r of roads) {
    if (!ROAD_TYPES.has(r.t) || r.p.length < 2) continue;
    const pts = [];
    for (let i = 0; i < r.p.length - 1; i++) {
      const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
      const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / STEP));
      for (let k = 0; k < n; k++) pts.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
    }
    pts.push(r.p[r.p.length - 1]);
    const ar = pts.map(([x, z]) => areaAt(x, z));
    for (let i = 1; i < pts.length; i++) {
      if (ar[i] === ar[i - 1]) continue;
      const [px, pz] = pts[i - 1], [qx, qz] = pts[i];
      const l = Math.hypot(qx - px, qz - pz) || 1;
      const ux = (qx - px) / l, uz = (qz - pz) / l;
      for (const [a, sign] of [[ar[i], 1], [ar[i - 1], -1]]) {
        if (!a) continue;                       // vjezd do a (sign 1) nebo výjezd z a (sign −1)
        const dx = ux * sign, dz = uz * sign;
        const x = (px + qx) / 2 - dx * SET_BACK, z = (pz + qz) / 2 - dz * SET_BACK;
        if (bridges.at(x, z, 8) !== null) continue;
        if (Math.abs(x) > world.W / 2 - 40 || Math.abs(z) > world.H / 2 - 40) continue;   // okraj mapy
        spots.push({ x, z, dx, dz, w: WIDTH[r.t], name: a.name });
      }
    }
  }
  // stejné místo z více úseků (souběžné / navazující linie) jen jednou
  const kept = [];
  for (const s of spots) {
    if (kept.some((k) => k.name === s.name && Math.hypot(k.x - s.x, k.z - s.z) < 60 && Math.abs(k.dx * s.dx + k.dz * s.dz) > 0.3)) continue;
    kept.push(s);
  }

  const cache = new Map();
  const tex = (name, end) => {
    const key = `${name}|${end}`;
    if (!cache.has(key)) {
      const { tex: t, aspect } = texture(name, end);
      cache.set(key, { mat: new THREE.MeshLambertMaterial({ map: t }), aspect });
    }
    return cache.get(key);
  };
  const backMat = new THREE.MeshLambertMaterial({ color: 0x8d9093 });
  const postMat = new THREE.MeshLambertMaterial({ color: 0x9a9da0 });
  const H = 0.62;
  const sign = (x, z, fx, fz, name, end) => {
    const { mat, aspect } = tex(name, end);
    const w = H * aspect;
    const g = new THREE.Group();
    const board = new THREE.Mesh(new THREE.PlaneGeometry(w, H), mat);
    board.position.set(0, 1.55 + H / 2, 0.03);
    const back = new THREE.Mesh(new THREE.BoxGeometry(w, H, 0.03), backMat);
    back.position.set(0, board.position.y, 0);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.3, 6), postMat);
    post.position.set(0, 1.0, -0.05);
    g.add(board, back, post);
    g.position.set(x, world.heightAt(x, z) - 0.1, z);
    g.rotation.y = Math.atan2(fx, fz);
    g.userData.ground = [x, z];
    group.add(g);
  };
  for (const s of kept) {
    const rx = -s.dz, rz = s.dx;                     // vpravo ve směru jízdy do obce
    const off = s.w / 2 + 1.2;
    // začátek obce: vpravo pro přijíždějící, čelem proti nim
    sign(s.x + rx * off, s.z + rz * off, -s.dx, -s.dz, s.name, false);
    // konec obce: vpravo pro odjíždějící (druhá strana silnice)
    sign(s.x - rx * off, s.z - rz * off, s.dx, s.dz, s.name, true);
  }
  // výška terénu se zpřesní, až se načte dlaždice zblízka
  group.userData.refresh = () => {
    for (const g of group.children) g.position.y = world.heightAt(...g.userData.ground) - 0.1;
  };
  return group;
}
