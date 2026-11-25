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


// Sada pomůcek pro stavbu v rámci (počátek O, osa u, kolmice v na „jih“) – vrací trojúhelníky s barvami.
function kit(O, u) {
  const v = [-u[1], u[0]];
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
  };
  const tris = (list, c) => {
    const pos = [], cols = [], k = new THREE.Color(c);
    for (const t of list) for (const q of t) { pos.push(...q); cols.push(k.r, k.g, k.b); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    parts.push(g);
  };
  const quad = (a, b, c, d) => [[a, b, c], [a, c, d]];
  const basis = (m) => m.makeBasis(new THREE.Vector3(u[0], 0, u[1]), new THREE.Vector3(0, 1, 0), new THREE.Vector3(v[0], 0, v[1]));
  const box = (u0, u1, v0, v1, y0, y1, c) => {
    const g = new THREE.BoxGeometry(u1 - u0, y1 - y0, v1 - v0);
    const m = basis(new THREE.Matrix4()), c0 = P((u0 + u1) / 2, (v0 + v1) / 2, (y0 + y1) / 2);
    m.setPosition(c0[0], c0[1], c0[2]);
    col(g.applyMatrix4(m), c);
  };
  // libovolná geometrie (osa Y nahoru) posazená do bodu rámce, natočená podle osy u
  const place = (g, uu, vv, y, c, rot = 0) => {
    const m = basis(new THREE.Matrix4()).multiply(new THREE.Matrix4().makeRotationY(rot));
    const c0 = P(uu, vv, y);
    m.setPosition(c0[0], c0[1], c0[2]);
    col(g.applyMatrix4(m), c);
  };
  const onWall = (shape, a, n, y, off, c) => {
    const nw = [u[0] * n[0] + v[0] * n[1], u[1] * n[0] + v[1] * n[1]];
    const sd = new THREE.Vector3(nw[1], 0, -nw[0]);
    const m = new THREE.Matrix4().makeBasis(sd, new THREE.Vector3(0, 1, 0), new THREE.Vector3(nw[0], 0, nw[1]));
    const q = P(a[0], a[1], y);
    m.setPosition(q[0] + nw[0] * off, q[1], q[2] + nw[1] * off);
    col(new THREE.ShapeGeometry(shape, 10).applyMatrix4(m), c);
  };
  const arch = (w, h) => {
    const sh = new THREE.Shape();
    sh.moveTo(-w / 2, 0); sh.lineTo(w / 2, 0); sh.lineTo(w / 2, h - w / 2);
    sh.absarc(0, h - w / 2, w / 2, 0, Math.PI, false); sh.lineTo(-w / 2, 0);
    return sh;
  };
  const halfMoon = (w) => { const sh = new THREE.Shape(); sh.moveTo(-w / 2, 0); sh.absarc(0, 0, w / 2, 0, Math.PI, false); sh.lineTo(-w / 2, 0); return sh; };
  const rect = (w, h) => { const sh = new THREE.Shape(); sh.moveTo(-w / 2, 0); sh.lineTo(w / 2, 0); sh.lineTo(w / 2, h); sh.lineTo(-w / 2, h); sh.lineTo(-w / 2, 0); return sh; };
  const circle = (r) => { const sh = new THREE.Shape(); sh.absarc(0, r, r, 0, Math.PI * 2, false); return sh; };
  const cross = (uu, vv, y, h, c) => {
    box(uu - 0.06, uu + 0.06, vv - 0.06, vv + 0.06, y, y + h, c);
    box(uu - 0.06, uu + 0.06, vv - h * 0.28, vv + h * 0.28, y + h * 0.62, y + h * 0.72, c);
  };
  const done = () => {
    const geo = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
    geo.computeVertexNormals();
    return geo;
  };
  return { P, v, tris, quad, box, place, onWall, arch, halfMoon, rect, circle, cross, done };
}

/**
 * Kostel sv. Máří Magdalény ve Stodě – empírový, okrově žlutý s bílými lizénami, červená taška,
 * velká půlkruhová (termální) okna pod římsou, dole menší obloukové; věž uprostřed průčelí s hodinami
 * a zelenou měděnou jehlancovou střechou. Půdorys RÚIAN: loď 37,5 × 20 m, mělký presbytář na východě.
 */
function kostelStod() {
  const O = [-154.1, -731.7], u = [0.87894, -0.47694];
  const K = kit(O, u), { box, tris, quad, P, onWall, arch, halfMoon, rect, circle, cross, place } = K;
  const C = { wall: 0xe9c983, trim: 0xf4ecd8, roof: 0xb0503a, plinth: 0xb8a37a, glass: 0x2b3238, copper: 0x7fae96, gold: 0xd4a640, door: 0x5a3e2c };
  const L = 37.5, V0 = -9, V1 = 11, VC = 1, E = 11.5, R = 18.5;
  box(0, L, V0, V1, 0, E, C.wall);
  box(-0.15, L + 0.1, V0 - 0.15, V1 + 0.15, 0, 0.9, C.plinth);
  box(-0.3, L + 0.25, V0 - 0.3, V1 + 0.3, E - 0.55, E, C.trim);                 // hlavní římsa
  // lizény po stranách a na nárožích
  for (const uu of [0.6, 7.5, 15, 22.5, 30, L - 0.6]) for (const vv of [V0, V1]) box(uu - 0.45, uu + 0.45, vv - 0.12, vv + 0.12, 0.9, E - 0.55, C.trim);
  // střecha: sedlová nad lodí, nad presbytářem valba
  const o = 0.6, re = E - 0.4;
  tris([...quad(P(-o, V1 + o, re), P(L - (V1 - V0) / 2, V1 + o, re), P(L - (V1 - V0) / 2, VC, R), P(-o, VC, R)),
    ...quad(P(L - (V1 - V0) / 2, V0 - o, re), P(-o, V0 - o, re), P(-o, VC, R), P(L - (V1 - V0) / 2, VC, R)),
    [P(L - (V1 - V0) / 2, V1 + o, re), P(L + o, V1 + o, re), P(L - (V1 - V0) / 2, VC, R)],
    [P(L + o, V0 - o, re), P(L - (V1 - V0) / 2, V0 - o, re), P(L - (V1 - V0) / 2, VC, R)],
    [P(L + o, V1 + o, re), P(L + o, V0 - o, re), P(L - (V1 - V0) / 2, VC, R)]], C.roof);
  tris([[P(-0.02, V0, E), P(-0.02, V1, E), P(-0.02, VC, R - 0.3)]], C.wall);    // štít průčelí
  // okna lodi: půlkruhová nahoře, obloukové dole
  for (const uu of [4, 11.2, 18.7, 26.2, 33.4]) for (const [vv, n] of [[V1, [0, 1]], [V0, [0, -1]]]) {
    onWall(halfMoon(4.2), [uu, vv], n, 7.6, 0.03, C.trim);
    onWall(halfMoon(3.6), [uu, vv], n, 7.75, 0.05, C.glass);
    onWall(arch(1.3, 2.6), [uu, vv], n, 2.4, 0.03, C.trim);
    onWall(arch(1.0, 2.3), [uu, vv], n, 2.55, 0.05, C.glass);
  }
  // presbytář (mělký, užší) na východě
  box(L, L + 2.2, -3.4, 5.2, 0, E - 1.5, C.wall);
  tris([...quad(P(L, -3.8, E - 1.6), P(L + 2.5, -3.8, E - 1.6), P(L + 2.5, 0.9, E + 1.5), P(L, 0.9, E + 1.5)),
    ...quad(P(L + 2.5, 5.6, E - 1.6), P(L, 5.6, E - 1.6), P(L, 0.9, E + 1.5), P(L + 2.5, 0.9, E + 1.5))], C.roof);
  // věž uprostřed průčelí: 6,8 × 6,8 m, mírně předsazená, dřík do 27 m
  const TU0 = -0.8, TU1 = 6.0, TV0 = VC - 3.4, TV1 = VC + 3.4, TH = 27;
  box(TU0, TU1, TV0, TV1, 0, TH, C.wall);
  box(TU0 - 0.15, TU1 + 0.15, TV0 - 0.15, TV1 + 0.15, 0, 0.9, C.plinth);
  for (const y of [E - 0.5, 19.5, TH - 0.5]) box(TU0 - 0.2, TU1 + 0.2, TV0 - 0.2, TV1 + 0.2, y, y + 0.5, C.trim);
  for (const [uu, vv] of [[TU0, TV0], [TU0, TV1], [TU1, TV0], [TU1, TV1]]) box(uu - 0.35, uu + 0.35, vv - 0.35, vv + 0.35, 0.9, TH - 0.5, C.trim);
  // portál, okna věže, hodiny na třech stranách
  onWall(arch(2.6, 4.6), [TU0, VC], [-1, 0], 0.4, 0.03, C.trim);
  onWall(arch(2.0, 4.1), [TU0, VC], [-1, 0], 0.4, 0.05, C.door);
  onWall(arch(1.4, 3.0), [TU0, VC], [-1, 0], 13.5, 0.05, C.glass);
  const faces = [[[TU0, VC], [-1, 0]], [[(TU0 + TU1) / 2, TV0], [0, -1]], [[(TU0 + TU1) / 2, TV1], [0, 1]]];
  for (const [a, n] of faces) {
    onWall(arch(1.1, 2.4), a, n, 20.6, 0.05, C.glass);
    onWall(circle(1.25), a, n, 23.0, 0.03, C.trim);
    onWall(circle(1.0), a, n, 23.25, 0.05, 0xf8f6ee);
    onWall(rect(0.09, 0.8), a, n, 24.25, 0.07, 0x222222);
    onWall(rect(0.6, 0.09), a, n, 24.2, 0.07, 0x222222);
  }
  // zelená měděná střecha věže: zvonovitá spodní část a štíhlý jehlan, koule a kříž
  const hw = (TU1 - TU0) / 2, uc = (TU0 + TU1) / 2;
  place(new THREE.CylinderGeometry(hw * 0.85, hw * 1.05, 1.6, 8, 1, true), uc, VC, TH + 0.8, C.copper);
  place(new THREE.CylinderGeometry(hw * 0.55, hw * 0.85, 1.4, 8, 1, true), uc, VC, TH + 2.3, C.copper);
  place(new THREE.ConeGeometry(hw * 0.55, 7.5, 8, 1, true), uc, VC, TH + 3 + 3.75, C.copper);
  place(new THREE.SphereGeometry(0.3, 10, 8), uc, VC, TH + 10.9, C.gold);
  cross(uc, VC, TH + 11.1, 1.8, C.gold);
  return { at: [-134.8, -741.5], radius: 8, geo: K.done() };
}

/** Špitální kaple ve Stodě – osmiboká, bílá se žlutými lizénami a šambránami, červená jehlancová
 *  střecha s černou lucernou a cibulkou. Půdorys RÚIAN ~11 m. */
function spitalniKaple() {
  const c0 = [-147.3, -813.6];
  const K = kit(c0, [1, 0]), { place, box } = K;
  const C = { wall: 0xf3f1ea, yellow: 0xe9b941, roof: 0xb5533a, lantern: 0x2b2b2b, plinth: 0xa59e90, glass: 0x2b3238 };
  const R = 5.2, H = 7.2;
  place(new THREE.CylinderGeometry(R, R, H, 8), 0, 0, H / 2, C.wall, Math.PI / 8);
  place(new THREE.CylinderGeometry(R + 0.15, R + 0.15, 0.7, 8), 0, 0, 0.35, C.plinth, Math.PI / 8);
  place(new THREE.CylinderGeometry(R + 0.3, R + 0.3, 0.45, 8), 0, 0, H - 0.2, C.yellow, Math.PI / 8);
  // lizény v rozích a okna na stěnách
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4, ax = Math.cos(a) * R * 1.0, az = Math.sin(a) * R * 1.0;
    box(ax - 0.35, ax + 0.35, az - 0.35, az + 0.35, 0.7, H - 0.3, C.yellow);
    const b = a + Math.PI / 8, rr = R * Math.cos(Math.PI / 8), wx = Math.cos(b) * rr, wz = Math.sin(b) * rr;
    const sh = K.arch(1.5, 2.9), sh2 = K.arch(1.0, 2.4);
    K.onWall(sh, [wx, wz], [Math.cos(b), Math.sin(b)], 2.2, 0.03, C.yellow);
    K.onWall(sh2, [wx, wz], [Math.cos(b), Math.sin(b)], 2.45, 0.05, i === 4 ? 0x5a3e2c : C.glass);
  }
  // střecha: osmiboký jehlan s mírným podbitím, lucerna, cibulka, kříž
  place(new THREE.ConeGeometry(R + 0.7, 4.2, 8), 0, 0, H + 2.1, C.roof, Math.PI / 8);
  place(new THREE.CylinderGeometry(0.75, 0.75, 1.7, 8), 0, 0, H + 4.6, C.lantern);
  place(new THREE.SphereGeometry(0.95, 10, 8), 0, 0, H + 5.9, C.lantern);
  place(new THREE.ConeGeometry(0.35, 1.1, 8), 0, 0, H + 7.1, C.lantern);
  K.cross(0, 0, H + 7.5, 1.1, 0x8a7a50);
  return { at: [-146.9, -815.7], radius: 5, geo: K.done() };
}

// Mosty podle fotografií: styl se přiřadí mostu, jehož střed leží do 30 m od `at`.
export const BRIDGE_STYLES = [
  // silniční most I/26 přes Radbuzu: dva bílé ocelové oblouky se závěsy mezi vozovkou a chodníky
  { at: [-187, -929], type: 'arch', color: 0xf4f4f2, rail: 0xdfe3e6, sidewalk: 3.0, span: [0.15, 0.55], rise: 6 },
  // lávka přes Radbuzu (Wikidata): zelená ocelová příhradová konstrukce s horním pásem do oblouku
  { at: [57.5, -999], type: 'truss', color: 0x3f8a6a, rail: 0x3f8a6a, extra: 0.9, rise: 1.4 },
];
// Mosty, které ZABAGED nemá (osa po pěšině přes vodu)
export const EXTRA_BRIDGES = [
  [[67.2, -989.0], [60.1, -999.1], [53.2, -1007.7], [48.0, -1014.0]],
];

const LANDMARKS = [krizovyVrch, kostelStod, spitalniKaple];

/**
 * Barvy a výšky vybraných budov podle veřejně dostupných fotografií (Wikimedia Commons – jen předloha).
 * at = bod v budově; radius + kinds = všechny budovy daného druhu v okolí (areál).
 * wall / roof / plinth = barvy fasády, střechy a soklu (plinthH = výška soklu / přízemí v jiné barvě),
 * eave / ridge / shape / flat = oprava tvaru, kde RÚIAN uvádí málo podlaží.
 */
export const FACADES = [
  // novorenesanční radnice, nám. ČSA: světle šedobéžová s pásovou bosáží, červená taška, přízemí + patro
  { name: 'Městský úřad', at: [-222, -1069], wall: 0xdcd9c3, roof: 0xa83c2c, plinth: 0xc6c2aa, plinthH: 1.0, eave: 9.2, ridge: 13.2, shape: 'hip' },
  // stará škola, Komenského nám.: světle zelenkavá, bílé šambrány, červená střecha s vikýři, dvě patra
  { name: 'ZŠ Komenského náměstí', at: [-112, -1033], wall: 0xc3cfb2, roof: 0xb8432f, plinth: 0xaebb9e, plinthH: 0.7, eave: 8.4, ridge: 12.4, shape: 'hip' },
  // nová škola, Hradecká: bílošedá s cihlově červenými plochami, červená valbová střecha
  { name: 'ZŠ Hradecká', at: [-706, -1072], wall: 0xe6e3dc, roof: 0xc1532f, plinth: 0xc0573f, plinthH: 0.8, eave: 9.0, ridge: 13.6, shape: 'hip' },
  { name: 'ZŠ Hradecká – křídlo', at: [-690, -1075], wall: 0xe6e3dc, roof: 0xc1532f, plinth: 0xc0573f, plinthH: 0.8 },
  // nemocnice: žlutá, oranžové přízemí, ploché střechy
  { name: 'Stodská nemocnice', at: [-955, -830], radius: 70, kinds: ['civic'], wall: 0xe8d35c, plinth: 0xd8772f, plinthH: 1.7, flat: true },
  // hasičská zbrojnice, U Elektrárny 266: bílá, růžové šambrány, tmavě hnědá taška
  { name: 'Hasičská zbrojnice', at: [-307, -960], wall: 0xefebe3, roof: 0x6b4a3c, plinth: 0xd8cfc6, plinthH: 0.5 },
  // kulturní dům: béžový, kamenný obklad přízemí, červená taška; vyšší část se třemi podlažími
  { name: 'Kulturní dům', at: [-769, -1228], wall: 0xd9d1be, roof: 0xb9452f, plinth: 0xd9d1be, plinthH: 0.4, eave: 6.6, ridge: 10.2 },
  { name: 'Kulturní dům – vyšší část', at: [-788, -1207], wall: 0xd9d1be, roof: 0xb9452f, plinth: 0x8a6e52, plinthH: 3.0, eave: 9.0, ridge: 13.2, shape: 'hip' },
  // ---- Stod – domy s adresou na fotografiích
  { name: 'Komenského nám. 19', at: [-185.3, -984.1], wall: 0xd8e6d2, roof: 0x5a5754, plinth: 0xc4cfc0, plinthH: 0.8 },
  { name: 'Sokolská 433', at: [-542.5, -1266.5], wall: 0xf0e6c6, roof: 0xb24a30, plinth: 0xb8b0a0, plinthH: 0.9 },
  { name: 'nám. ČSA 69', at: [-260.0, -1043.9], wall: 0xf2f0ea, roof: 0x8a3e2c, plinth: 0xb9b6ae, plinthH: 0.5 },
  { name: 'nám. ČSA 70', at: [-245.2, -1022.9], wall: 0xe8c2b8, roof: 0x5c4a42, plinth: 0xc9a59a, plinthH: 0.9 },
  { name: 'nám. ČSA 71', at: [-237.1, -1006.0], wall: 0xd77d52, roof: 0x5c4a42, plinth: 0xb56440, plinthH: 0.9 },
  // Stará pošta (Suvorovův dům): bílá s okrovými barokními štíty, hnědočervená taška
  { name: 'Stará pošta', at: [-115.3, -993.8], wall: 0xf3eedc, roof: 0xa04a32, plinth: 0xe7c35a, plinthH: 0.6 },
  // Hammerschmiedův dům: oprýskaná béžová omítka, červenohnědá taška
  { name: 'Hammerschmiedův dům', at: [-18.0, -900.8], wall: 0xd9caa0, roof: 0x9e4630, plinth: 0xb7a880, plinthH: 0.8 },
  // lékárna Devětsil, Dělnická: krémová, přízemí obložené cihlou
  { name: 'Lékárna Devětsil', at: [-406.9, -1139.7], wall: 0xefe6d3, roof: 0x6b4a3c, plinth: 0xb0553a, plinthH: 1.2 },
  // úřad práce, Sokolská 566: bílá patra, přízemí z cihel
  { name: 'Úřad práce', at: [-611.4, -1241.3], wall: 0xf2f1ee, roof: 0x6f6d6a, plinth: 0xa0583e, plinthH: 3.0 },
  // sportovní hala: šedobílé panely, pás oken, nízká střecha
  { name: 'Sportovní hala', at: [-696.9, -992.6], wall: 0xd9dbdc, roof: 0x8d9094, plinth: 0x8f9396, plinthH: 0.6 },
  // ---- Chotěšov – domy s adresou na fotografiích
  { name: 'Osvobozených politických vězňů 476', at: [3139.7, -2412.7], wall: 0xf3e8e8, roof: 0xa83a2a, plinth: 0xd8c4c4, plinthH: 0.6 },
  { name: 'Plzeňská 190', at: [2564.1, -2601.9], wall: 0xe8d49a, roof: 0xb24a32, plinth: 0xc9b07a, plinthH: 0.9 },
  { name: 'Plzeňská 244', at: [2667.9, -2801.4], wall: 0xf0cf4a, roof: 0x8e3e2e, plinth: 0xb89a3a, plinthH: 0.6 },
  { name: 'Úzká 19', at: [2583.1, -2324.5], wall: 0xe8e2d4, roof: 0x5d4c44, plinth: 0xc9c2b2, plinthH: 0.6 },
  { name: 'Dům čp. 28', at: [2642.6, -2305.8], wall: 0xd9c49a, roof: 0x6b4a3a, plinth: 0xb39f78, plinthH: 0.6 },
  { name: 'Mantov čp. 40', at: [3160.1, -854.9], wall: 0xcdbb94, roof: 0x6b4a3a, plinth: 0xa89874, plinthH: 0.6 },
  // ---- Střelice, Hradec, Lelov
  { name: 'Střelice čp. 7', at: [-2558.6, -439.7], wall: 0xeea040, roof: 0xa04030, plinth: 0x6e4a36, plinthH: 0.6 },
  { name: 'Fara v Hradci', at: [-3413.1, -1171.7], wall: 0xd9c27a, roof: 0x6e4a3a, plinth: 0xb6a064, plinthH: 0.7 },
  { name: 'Lelov – hospoda', at: [-580.5, 1199.4], wall: 0xf1ead6, roof: 0x4f4a48, plinth: 0x7a5a44, plinthH: 0.7 },
  { name: 'Lelov – dům', at: [-290.9, 1091.0], wall: 0xe2c35a, roof: 0x8a4a36, plinth: 0xb39a4a, plinthH: 0.6 },
  // ---- Chotěšov
  // obecní úřad: velká krémová budova se štítem s hodinami, červená taška, tři podlaží
  { name: 'Obecní úřad Chotěšov', at: [2442.4, -2349.5], wall: 0xe6dcc0, roof: 0xb8452f, plinth: 0xcfc4a6, plinthH: 0.9, ridge: 16.0, shape: 'hip' },
  // Coop Konzum, Plzeňská: krémový dům, antracitová střecha
  { name: 'Coop Chotěšov', at: [2595.9, -2586.7], wall: 0xf0e2c2, roof: 0x3c3d40, plinth: 0xc9b99a, plinthH: 0.6 },
  // obchodní dům (JIP), nám. 1. máje: bílá přízemní stavba s plochou střechou
  { name: 'Obchodní dům Chotěšov', at: [2705.2, -2251.4], wall: 0xf4f3ef, flat: true },
  // bývalá rybárna: bílá, oranžová valbová střecha s vikýři
  { name: 'Bývalá rybárna', at: [2490.0, -1983.4], wall: 0xf6f4ee, roof: 0xd0662f, plinth: 0xd9d6cc, plinthH: 0.5 },
  // bývalý pivovar: oprýskaná šedookrová omítka, tmavá střecha
  { name: 'Bývalý pivovar Chotěšov', at: [2457.1, -1943.3], wall: 0xb9ac8c, roof: 0x5b4f48, plinth: 0x8f8670, plinthH: 0.8 },
  // ---- Střelice
  // obecní úřad: lidová usedlost se štítem do návsi, krémová s okrovými šambránami, hnědá taška
  { name: 'Obecní úřad Střelice', at: [-2479.5, -451.4], wall: 0xf2e7c9, roof: 0x7a4a36, plinth: 0xd9a34c, plinthH: 0.5, eave: 4.6, ridge: 9.4, shape: 'gable' },
  // kaple na návsi: bílá s okrovými lizénami, tmavá střecha
  { name: 'Kaple ve Střelicích', at: [-2514.0, -426.4], wall: 0xf3efe6, roof: 0x4a4440, plinth: 0xa8a59c, plinthH: 0.5 },
  // ---- Hradec
  // pošta: světle růžová, červená taška
  { name: 'Pošta Hradec', at: [-3340.6, -1137.8], wall: 0xedcdc3, roof: 0xb24a34, plinth: 0xc9aaa0, plinthH: 0.6 },
  // ---- Ves Touškov
  // hostinec: šedá omítka, cihlový vstup, plochá střecha
  { name: 'Hostinec Ves Touškov', at: [-3216.6, -4095.1], wall: 0xbdbab2, plinth: 0x9c4a35, plinthH: 1.0, flat: true },
];

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
