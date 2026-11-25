import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Ručně modelované stavby, které obecný generátor budov nevystihne. Každá nahradí budovu (budovy),
// jejíž půdorys má těžiště blízko `at`. Rozměry podle půdorysu RÚIAN a popisu (obec Chotěšov, kudyznudy.cz),
// vzhled podle veřejně dostupných fotografií – jen jako předloha, nic z nich se nepoužívá.

const C = {
  ivory: 0xf7efd2, ochre: 0xcdb47c, ochreDark: 0xb8955a, infill: 0xe6e3da, plinth: 0x9c8f78,
  slate: 0x50555c, slate2: 0x5d636b, gold: 0xd4a640, glass: 0x2a3138, stone: 0xf6f3ea, iron: 0x6f6550,
  gazeboRoof: 0x9a3f2c, wood: 0x7a5636, step: 0xa49e92,
};

/**
 * Kostel sv. Kříže na Křížovém vrchu (Vrabina, 487 m) – poutní kostel z pol. 19. stol., věž z r. 1931,
 * dnes rozhledna (věž 22 m, plošina 13 m). Jednolodní, štítové průčelí na západ s portálem a kulatým oknem,
 * věž v severozápadním rohu se třemi obloukovými okny vyhlídky a jehlancovou břidlicovou střechou,
 * boční okna lodi zazděná, omítka oprýskaná, užší presbytář s trojbokým závěrem a sanktusníkem.
 */
function krizovyVrch() {
  // rámec: počátek = jihozápadní roh průčelí, u = osa lodi na východ, v = na jih
  const O = [2895.4, 1390.9], u = [0.96555, 0.26022], v = [-u[1], u[0]];
  const P = (uu, vv, y) => [O[0] + u[0] * uu + v[0] * vv, y, O[1] + u[1] * uu + v[1] * vv];
  const parts = [];
  const col = (geo, c) => {
    const k = new THREE.Color(c), n = geo.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = k.r; a[i * 3 + 1] = k.g; a[i * 3 + 2] = k.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
    if (geo.attributes.uv) geo.deleteAttribute('uv');
    if (geo.attributes.normal) geo.deleteAttribute('normal');
    if (geo.index) geo = geo.toNonIndexed();
    parts.push(geo);
    return geo;
  };
  // trojúhelníky z bodů rámce
  const tris = (list, c, jitter = 0) => {
    const pos = [], cols = [], k = new THREE.Color(c);
    for (const t of list) {
      const j = jitter ? 1 + (Math.random() - 0.5) * jitter : 1;
      for (const p of t) { pos.push(...p); cols.push(k.r * j, k.g * j, k.b * j); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    parts.push(g);
  };
  const quad = (a, b, c, d) => [[a, b, c], [a, c, d]];
  // kvádr v rámci
  const box = (u0, u1, v0, v1, y0, y1, c) => {
    const g = new THREE.BoxGeometry(u1 - u0, y1 - y0, v1 - v0);
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(u[0], 0, u[1]), new THREE.Vector3(0, 1, 0), new THREE.Vector3(v[0], 0, v[1]));
    const c0 = P((u0 + u1) / 2, (v0 + v1) / 2, (y0 + y1) / 2);
    m.setPosition(c0[0], c0[1], c0[2]);
    col(g.applyMatrix4(m), c);
  };
  // stěna z dlaždic 1 × 1 m s mírnou změnou odstínu (oprýskaná omítka)
  const wall = (a, b, y0, y1, c, jitter) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(L)), m = Math.max(1, Math.round(y1 - y0));
    const list = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        const s0 = i / n, s1 = (i + 1) / n, h0 = y0 + (y1 - y0) * j / m, h1 = y0 + (y1 - y0) * (j + 1) / m;
        const p = (s, h) => P(a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, h);
        list.push(...quad(p(s0, h0), p(s1, h0), p(s1, h1), p(s0, h1)));
      }
    }
    tris(list, c, jitter);
  };
  // tvar (okno, portál) na stěně: n = vnější normála v rámci [nu, nv], a = bod na stěně [u, v], y = výška spodku
  const onWall = (shape, a, n, y, off, c) => {
    const nw = [u[0] * n[0] + v[0] * n[1], u[1] * n[0] + v[1] * n[1]];
    const s = new THREE.Vector3(nw[1], 0, -nw[0]);
    const m = new THREE.Matrix4().makeBasis(s, new THREE.Vector3(0, 1, 0), new THREE.Vector3(nw[0], 0, nw[1]));
    const p = P(a[0], a[1], y);
    m.setPosition(p[0] + nw[0] * off, p[1], p[2] + nw[1] * off);
    col(new THREE.ShapeGeometry(shape, 8).applyMatrix4(m), c);
  };
  const arch = (w, h) => {
    const s = new THREE.Shape();
    s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, h - w / 2);
    s.absarc(0, h - w / 2, w / 2, 0, Math.PI, false); s.lineTo(-w / 2, 0);
    return s;
  };
  const rect = (w, h) => { const s = new THREE.Shape(); s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, h); s.lineTo(-w / 2, h); s.lineTo(-w / 2, 0); return s; };
  const circle = (r) => { const s = new THREE.Shape(); s.absarc(0, r, r, 0, Math.PI * 2, false); return s; };
  // okno s rámem: ram = světlé ostění, sklo tmavé
  const win = (shape, frame, a, n, y, cFrame = C.stone, cGlass = C.glass) => {
    onWall(frame, a, n, y - 0.1, 0.03, cFrame);
    onWall(shape, a, n, y, 0.05, cGlass);
  };
  // kříž v rámci (uu, vv), ramena napříč osou lodi – je vidět od průčelí
  const cross = (uu, vv, y, h, c) => {
    box(uu - 0.05, uu + 0.05, vv - 0.05, vv + 0.05, y, y + h, c);
    box(uu - 0.05, uu + 0.05, vv - h * 0.28, vv + h * 0.28, y + h * 0.62, y + h * 0.72, c);
  };

  // ---------------- loď: u 0–19,5, v −7,8–0; okap 7,4 m, hřeben 12,4 m
  const N0 = -7.8, N1 = 0, NE = 19.5, EAVE = 7.4, RIDGE = 12.4, NC = (N0 + N1) / 2;
  wall([0, N1], [NE, N1], 0, EAVE, C.ochre, 0.16);                 // jižní stěna (oprýskaná)
  wall([NE, N0], [4.4, N0], 0, EAVE, C.ochre, 0.16);               // severní stěna za věží
  tris([...quad(P(0, N0, 0), P(0, N1, 0), P(0, N1, EAVE), P(0, N0, EAVE)), [P(0, N0, EAVE), P(0, N1, EAVE), P(0, NC, RIDGE)]], C.ivory);
  tris([[P(NE, N1, EAVE), P(NE, N0, EAVE), P(NE, NC, RIDGE)]], C.ochre);
  box(-0.15, NE, N0 - 0.15, N1 + 0.15, 0, 0.55, C.plinth);         // sokl
  box(-0.12, NE + 0.05, N1 - 0.05, N1 + 0.12, EAVE - 0.35, EAVE, C.stone);  // římsa
  box(-0.12, NE + 0.05, N0 - 0.12, N0 + 0.05, EAVE - 0.35, EAVE, C.stone);
  // střecha s přesahem
  const o = 0.45, re = EAVE - o * (RIDGE - EAVE) / ((N1 - N0) / 2);
  tris([...quad(P(-o, N1 + o, re), P(NE + 0.2, N1 + o, re), P(NE + 0.2, NC, RIDGE), P(-o, NC, RIDGE)),
    ...quad(P(NE + 0.2, N0 - o, re), P(-o, N0 - o, re), P(-o, NC, RIDGE), P(NE + 0.2, NC, RIDGE))], C.slate);
  // boční okna lodi: vysoké oblouky, zazděné, v hlubší špaletě; mezi nimi lizény
  for (const uu of [6.2, 10.6, 15.0]) {
    for (const [vv, n] of [[N1, [0, 1]], [N0, [0, -1]]]) {
      onWall(arch(2.2, 4.4), [uu, vv], n, 1.7, 0.03, C.ochreDark);
      onWall(arch(1.6, 3.9), [uu, vv], n, 1.95, 0.05, C.infill);
    }
  }
  for (const uu of [4.0, 8.4, 12.8, 17.2]) {
    box(uu - 0.35, uu + 0.35, N1, N1 + 0.1, 0.55, EAVE - 0.35, 0xd9c48f);
    if (uu > 5) box(uu - 0.35, uu + 0.35, N0 - 0.1, N0, 0.55, EAVE - 0.35, 0xd9c48f);
  }
  // průčelí: portál s kamenným ostěním, kulaté okno, okénko ve štítu, kříž na vrcholu
  const FC = -3.3;
  onWall(arch(2.5, 3.9), [0, FC], [-1, 0], 0, 0.03, C.stone);
  onWall(arch(1.8, 3.4), [0, FC], [-1, 0], 0, 0.05, 0x3b3128);
  onWall(circle(0.9), [0, FC], [-1, 0], 4.6, 0.03, C.stone);
  onWall(circle(0.68), [0, FC], [-1, 0], 4.82, 0.05, C.glass);
  win(arch(0.55, 1.1), arch(0.75, 1.3), [0, NC], [-1, 0], 8.7);
  box(-0.12, 0.05, N0, N1, EAVE - 0.35, EAVE - 0.1, C.stone);       // římsa průčelí
  cross(-0.05, NC, RIDGE - 0.1, 1.3, C.iron);

  // ---------------- presbytář: užší, trojboký závěr
  const PU = 25.2, PV = -3.9, PR = 2.6, PE = 6.4, PRI = 9.4;
  const end = [0, 60, 120, 180].map((a) => [PU + PR * Math.sin(a * Math.PI / 180), PV - PR * Math.cos(a * Math.PI / 180)]);
  wall([NE, PV - PR], [PU, PV - PR], 0, PE, C.ochre, 0.14);
  wall([PU, PV + PR], [NE, PV + PR], 0, PE, C.ochre, 0.14);
  for (let i = 0; i < 3; i++) wall(end[i], end[i + 1], 0, PE, C.ochre, 0.14);
  box(NE, PU, PV - PR - 0.1, PV + PR + 0.1, 0, 0.5, C.plinth);
  const po = 0.35, pre = PE - po * (PRI - PE) / PR;
  tris([...quad(P(NE, PV + PR + po, pre), P(PU, PV + PR + po, pre), P(PU, PV, PRI), P(NE, PV, PRI)),
    ...quad(P(PU, PV - PR - po, pre), P(NE, PV - PR - po, pre), P(NE, PV, PRI), P(PU, PV, PRI))], C.slate);
  for (let i = 0; i < 3; i++) {
    const a = end[i], b = end[i + 1];
    const ex = (p) => [PU + (p[0] - PU) * (PR + po) / PR, PV + (p[1] - PV) * (PR + po) / PR];
    const A = ex(a), B = ex(b);
    tris([[P(A[0], A[1], pre), P(B[0], B[1], pre), P(PU, PV, PRI)]], C.slate);
  }
  for (const [a, b] of [[end[1], end[2]]]) {
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    onWall(arch(1.3, 2.8), m, [1, 0], 2.4, 0.03, C.ochreDark);
    onWall(arch(0.9, 2.5), m, [1, 0], 2.55, 0.05, C.infill);
  }
  // sanktusník na hřebeni lodi u presbytáře
  box(17.6, 18.5, NC - 0.45, NC + 0.45, RIDGE - 0.6, RIDGE + 1.2, C.ivory);
  {
    const s = new THREE.ConeGeometry(0.7, 1.8, 4).rotateY(Math.PI / 4);
    const c0 = P(18.05, NC, RIDGE + 2.1);
    col(s.applyMatrix4(new THREE.Matrix4().makeRotationY(-Math.atan2(u[1], u[0])).setPosition(c0[0], c0[1], c0[2])), C.slate2);
    cross(18.05, NC, RIDGE + 3.0, 0.9, C.gold);
  }

  // ---------------- věž (rozhledna): u −0,3–4,4, v −11,2–6,6; dřík do 16,2 m, jehlan do 21,6 m
  const TU0 = -0.3, TU1 = 4.4, TV0 = -11.2, TV1 = -6.6, TH = 16.2;
  const TUc = (TU0 + TU1) / 2, TVc = (TV0 + TV1) / 2;
  box(TU0, TU1, TV0, TV1, 0, TH, C.ivory);
  box(TU0 - 0.12, TU1 + 0.12, TV0 - 0.12, TV1 + 0.12, 0, 0.6, C.plinth);
  box(TU0 - 0.18, TU1 + 0.18, TV0 - 0.18, TV1 + 0.18, TH - 0.35, TH, C.stone);       // hlavní římsa
  box(TU0 - 0.06, TU1 + 0.06, TV0 - 0.06, TV1 + 0.06, 12.75, 12.95, C.stone);        // kordonová římsa pod vyhlídkou
  // otvory: tři obloukové v patře vyhlídky na každé straně, velké obloukové okno, malá obdélná okénka
  const faces = [
    { a: [TU0, TVc], n: [-1, 0], w: TV1 - TV0 }, { a: [TU1, TVc], n: [1, 0], w: TV1 - TV0 },
    { a: [TUc, TV0], n: [0, -1], w: TU1 - TU0 }, { a: [TUc, TV1], n: [0, 1], w: TU1 - TU0 },
  ];
  const along = (f, d) => (f.n[0] ? [f.a[0], f.a[1] + d] : [f.a[0] + d, f.a[1]]);
  for (const f of faces) {
    for (const d of [-1.25, 0, 1.25]) win(arch(0.72, 1.25), arch(0.9, 1.42), along(f, d), f.n, 13.55);
    if (f.n[1] !== 1) win(arch(1.05, 2.1), arch(1.3, 2.35), f.a, f.n, 9.3);
  }
  const front = faces[0];
  win(rect(0.55, 0.95), rect(0.75, 1.15), front.a, front.n, 6.1);
  win(rect(0.55, 0.95), rect(0.75, 1.15), front.a, front.n, 3.6);
  win(arch(0.75, 1.5), arch(0.95, 1.7), front.a, front.n, 0.95);
  win(rect(0.5, 0.9), rect(0.7, 1.1), faces[2].a, faces[2].n, 6.1);
  // jehlancová střecha s podbitím (zvlnění dole), koule a kříž
  {
    const c0 = P(TUc, TVc, 0);
    const rot = new THREE.Matrix4().makeRotationY(-Math.atan2(u[1], u[0]) + Math.PI / 4);
    const hw = (TU1 - TU0) / 2 + 0.3;
    const kick = new THREE.CylinderGeometry(hw * 0.8 * Math.SQRT2, hw * Math.SQRT2, 0.9, 4, 1, true);
    col(kick.applyMatrix4(rot.clone().setPosition(c0[0], TH + 0.45 + c0[1], c0[2])), C.slate2);
    const spire = new THREE.ConeGeometry(hw * 0.8 * Math.SQRT2, 4.6, 4, 1, true);
    col(spire.applyMatrix4(rot.clone().setPosition(c0[0], TH + 0.9 + 2.3 + c0[1], c0[2])), C.slate2);
    const ball = new THREE.SphereGeometry(0.22, 10, 8);
    col(ball.translate(c0[0], TH + 5.6 + c0[1], c0[2]), C.gold);
    cross(TUc, TVc, TH + 5.75, 1.5, C.gold);
  }
  // nízká přístavba (sakristie) severně od věže s obloukovými dveřmi
  box(0.6, 4.0, TV0 - 1.5, TV0, 0, 3.3, C.ivory);
  tris([...quad(P(0.45, TV0 - 1.7, 3.0), P(4.15, TV0 - 1.7, 3.0), P(4.15, TV0, 3.9), P(0.45, TV0, 3.9))], C.slate);
  onWall(arch(1.0, 2.2), [0.6, TV0 - 0.75], [-1, 0], 0, 0.04, 0x5a4330);

  // ---------------- altán před kostelem a schodiště s bílými pilíři
  {
    const g = P(-7.5, -14.5, 0);
    const posts = [];
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      posts.push(new THREE.CylinderGeometry(0.09, 0.09, 2.3, 6).translate(g[0] + Math.cos(a) * 2.1, 1.15, g[2] + Math.sin(a) * 2.1));
    }
    for (const p of posts) col(p, C.wood);
    col(new THREE.CylinderGeometry(2.25, 2.25, 0.9, 6, 1, true).translate(g[0], 0.45, g[2]), C.wood);
    col(new THREE.ConeGeometry(2.9, 1.5, 6).translate(g[0], 3.0, g[2]), C.gazeboRoof);
    col(new THREE.CylinderGeometry(2.3, 2.3, 0.15, 6).translate(g[0], 0.08, g[2]), C.step);
  }
  for (let i = 0; i < 6; i++) box(-16 + i * 0.9, -15.1 + i * 0.9, -4.6, -2.0, -2.2 + i * 0.35, -1.85 + i * 0.35, C.step);
  for (const vv of [-4.9, -1.7]) box(-12.2, -11.4, vv - 0.35, vv + 0.35, -0.6, 0.9, C.stone);

  const geo = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
  geo.computeVertexNormals();
  // bez stromů: kostel, altán a prostranství před průčelím (rámec u, v)
  const keepOut = (x, z, r) => {
    const dx = x - O[0], dz = z - O[1], uu = dx * u[0] + dz * u[1], vv = dx * v[0] + dz * v[1];
    return uu > -12 - r && uu < 29 + r && vv > -17 - r && vv < 1.2 + r;
  };
  return { at: [2909, 1389], radius: 18, geo, keepOut };
}

const LANDMARKS = [krizovyVrch];

/** Vrátí { group, skip, keepOut } – skip = indexy budov, které landmark nahrazuje, keepOut(x, z, r) = bez stromů. */
export function createLandmarks({ buildings }) {
  const group = new THREE.Group();
  const skip = new Set(), outs = [];
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  for (const make of LANDMARKS) {
    const lm = make();
    let base = null;
    buildings.forEach((b, i) => {
      const r = b.rings[0];
      let cx = 0, cz = 0;
      for (const p of r) { cx += p[0]; cz += p[1]; }
      cx /= r.length; cz /= r.length;
      if (Math.hypot(cx - lm.at[0], cz - lm.at[1]) < lm.radius) {
        skip.add(i);
        base = base === null ? b.base : Math.min(base, b.base);
      }
    });
    if (base === null) continue;
    if (lm.keepOut) outs.push(lm.keepOut);
    const m = new THREE.Mesh(lm.geo, mat);
    m.position.y = base;
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }
  return { group, skip, keepOut: (x, z, r = 0) => outs.some((f) => f(x, z, r)) };
}
