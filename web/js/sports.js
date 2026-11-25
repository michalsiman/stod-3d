import * as THREE from 'three';

// Sportoviště z OSM (data/sport.json): plocha podle povrchu (tráva, antuka, tartan, umělá tráva, asfalt,
// písek), na fotbalových hřištích bílé čáry, heliport (bílý kruh s H). Položené na terén, výšky se
// zpřesní po načtení dlaždic zblízka.

const LIFT = 0.36;
// stadiony s oválnou dráhou (bod u hřiště) – Stod, Luční
const TRACK_AROUND = [[-581, -889]];
const SURF = {
  grass: 0x58a043, artificial_turf: 0x3f9a4f, clay: 0xc86a3e, tartan: 0xb84a34, rubber: 0xb84a34,
  asphalt: 0x6f7378, concrete: 0x9a9890, sand: 0xdcc894, paving_stones: 0x9d9a93,
};

function colorOf(f) {
  if (f.k === 'playground') return SURF[f.surface] || 0xd8c495;
  if (f.k === 'track') return SURF[f.surface] || 0xb84a34;
  if (SURF[f.surface]) return SURF[f.surface];
  if (/tennis|athletics/.test(f.sport)) return SURF.clay;
  if (/beachvolleyball|volleyball/.test(f.sport)) return SURF.sand;
  if (/basketball|multi|skateboard|cycling/.test(f.sport)) return SURF.asphalt;
  return SURF.grass;
}

/** Nejmenší opsaný obdélník (podle hran polygonu): střed, osy u/v, poloviční délky. */
function obb(p) {
  let best = null;
  for (let i = 0; i < p.length - 1; i++) {
    const dx = p[i + 1][0] - p[i][0], dz = p[i + 1][1] - p[i][1], L = Math.hypot(dx, dz);
    if (L < 1) continue;
    const ux = dx / L, uz = dz / L;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, z] of p) {
      const a = x * ux + z * uz, b = -x * uz + z * ux;
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area) {
      const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
      best = { area, cx: ca * ux - cb * uz, cz: ca * uz + cb * ux, ux, uz, ha: (a1 - a0) / 2, hb: (b1 - b0) / 2 };
    }
  }
  if (best && best.hb > best.ha) {      // u = delší osa
    Object.assign(best, { ux: -best.uz, uz: best.ux, ha: best.hb, hb: best.ha });
  }
  return best;
}

export function createSports({ sport, world }) {
  const group = new THREE.Group();
  if (!sport?.length) { group.userData.refresh = () => {}; return group; }
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -24 });
  // větší plochy dřív (níž), menší navrch
  const items = sport.filter((f) => f.k !== 'helipad' && f.closed).map((f) => {
    let a = 0;
    for (let i = 0; i < f.p.length - 1; i++) a += f.p[i][0] * f.p[i + 1][1] - f.p[i + 1][0] * f.p[i][1];
    return { f, area: Math.abs(a) / 2 };
  }).sort((p, q) => q.area - p.area);

  const build = () => {
    const pos = [], col = [];
    const y = (x, z, k) => world.heightAt(x, z) + LIFT + k * 0.015;
    const tri = (a, b, c, k, h) => {
      // dělení dlouhých hran, aby plocha kopírovala terén
      const L = Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), Math.hypot(b[0] - c[0], b[1] - c[1]), Math.hypot(c[0] - a[0], c[1] - a[1]));
      if (L > 6) {
        const m = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        const ab = m(a, b), bc = m(b, c), ca = m(c, a);
        tri(a, ab, ca, k, h); tri(ab, b, bc, k, h); tri(ca, bc, c, k, h); tri(ab, bc, ca, k, h);
        return;
      }
      for (const p of [a, b, c]) { pos.push(p[0], y(p[0], p[1], h), p[1]); col.push(k.r, k.g, k.b); }
    };
    const poly = (ring, k, h) => {
      const pts = ring.slice(0, -1).map(([x, z]) => new THREE.Vector2(x, z));
      if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
      for (const [i, j, l] of THREE.ShapeUtils.triangulateShape(pts, [])) {
        // orientace nahoru (osa z mapy míří na jih)
        tri([pts[i].x, pts[i].y], [pts[l].x, pts[l].y], [pts[j].x, pts[j].y], k, h);
      }
    };
    const line = (a, b, w, k, h) => {
      const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1, nx = -dz / L * w / 2, nz = dx / L * w / 2;
      const q = [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]];
      tri(q[0], q[2], q[1], k, h); tri(q[0], q[3], q[2], k, h);
    };
    const white = new THREE.Color(0xf2f2ee);
    // ovál běžecké dráhy kolem hřiště stadionu (OSM ji nemá): rovinky + oblouky, 6 m široká, škvára
    for (const [x, z] of TRACK_AROUND) {
      const pitch = items.map((q) => q.f).filter((f) => /soccer/.test(f.sport))
        .sort((p, q) => Math.hypot(p.p[0][0] - x, p.p[0][1] - z) - Math.hypot(q.p[0][0] - x, q.p[0][1] - z))[0];
      const o = pitch && obb(pitch.p);
      if (!o) continue;
      const R = o.hb + 3, S = o.ha - 0.28 * R, TW = 6.2, k = new THREE.Color(0xb5603d), h = -0.5;
      const P = (a, b) => [o.cx + o.ux * a - o.uz * b, o.cz + o.uz * a + o.ux * b];
      const ring = (r) => {
        const pts = [];
        for (let i = 0; i <= 16; i++) { const t = -Math.PI / 2 + (i / 16) * Math.PI; pts.push(P(S + Math.cos(t) * r, Math.sin(t) * r)); }
        for (let i = 0; i <= 16; i++) { const t = Math.PI / 2 + (i / 16) * Math.PI; pts.push(P(-S + Math.cos(t) * r, Math.sin(t) * r)); }
        return pts;
      };
      const inn = ring(R), out = ring(R + TW);
      for (let i = 0; i < inn.length; i++) {
        const j = (i + 1) % inn.length;
        tri(inn[i], out[j], out[i], k, h); tri(inn[i], inn[j], out[j], k, h);
        line(inn[i], inn[j], 0.12, white, h + 0.2); line(out[i], out[j], 0.12, white, h + 0.2);
      }
      // vnitřek oválu (tráva kolem hřiště)
      const g = new THREE.Color(0x5f9c47);
      for (let i = 1; i < inn.length - 1; i++) tri(inn[0], inn[i + 1], inn[i], g, h - 0.3);
    }
    items.forEach(({ f }, n) => {
      const c = new THREE.Color(colorOf(f));
      poly(f.p, c, n);
      // fotbal: pruhy trávy a bílé čáry (obrys, půlicí čára, středový kruh, pokutová území)
      const o = /soccer/.test(f.sport) && (f.surface === 'grass' || f.surface === 'artificial_turf' || !f.surface) ? obb(f.p) : null;
      if (o && o.ha > 15) {
        const P = (a, b) => [o.cx + o.ux * a - o.uz * b, o.cz + o.uz * a + o.ux * b];
        const A = o.ha - 1.5, Bh = o.hb - 1.5;
        const dark = c.clone().multiplyScalar(0.9);
        for (let a = -A, s = 0; a < A; a += A / 6, s++) {
          if (s % 2) { tri(P(a, -Bh), P(a + A / 6, Bh), P(a + A / 6, -Bh), dark, n + 0.3); tri(P(a, -Bh), P(a, Bh), P(a + A / 6, Bh), dark, n + 0.3); }
        }
        const w = 0.14, h = n + 0.6;
        line(P(-A, -Bh), P(A, -Bh), w, white, h); line(P(-A, Bh), P(A, Bh), w, white, h);
        line(P(-A, -Bh), P(-A, Bh), w, white, h); line(P(A, -Bh), P(A, Bh), w, white, h);
        line(P(0, -Bh), P(0, Bh), w, white, h);
        const R = Math.min(9.15, Bh * 0.4);
        for (let i = 0; i < 24; i++) {
          const a0 = (i / 24) * Math.PI * 2, a1 = ((i + 1) / 24) * Math.PI * 2;
          line(P(Math.cos(a0) * R, Math.sin(a0) * R), P(Math.cos(a1) * R, Math.sin(a1) * R), w, white, h);
        }
        for (const s of [1, -1]) {
          const d = Math.min(16.5, A * 0.3), b = Math.min(20, Bh * 0.6);
          line(P(s * A, -b), P(s * (A - d), -b), w, white, h); line(P(s * A, b), P(s * (A - d), b), w, white, h);
          line(P(s * (A - d), -b), P(s * (A - d), b), w, white, h);
        }
      }
      // tenis: bílé čáry dvorce
      if (/tennis/.test(f.sport)) {
        const t = obb(f.p);
        if (t && t.ha > 9) {
          const P = (a, b) => [t.cx + t.ux * a - t.uz * b, t.cz + t.uz * a + t.ux * b];
          const A = Math.min(11.9, t.ha - 1), Bh = Math.min(5.5, t.hb - 0.8), w = 0.08, h = n + 0.6;
          line(P(-A, -Bh), P(A, -Bh), w, white, h); line(P(-A, Bh), P(A, Bh), w, white, h);
          line(P(-A, -Bh), P(-A, Bh), w, white, h); line(P(A, -Bh), P(A, Bh), w, white, h);
          line(P(-6.4, 0), P(6.4, 0), w, white, h); line(P(-6.4, -Bh * 0.75), P(-6.4, Bh * 0.75), w, white, h);
          line(P(6.4, -Bh * 0.75), P(6.4, Bh * 0.75), w, white, h); line(P(0, -Bh - 0.5), P(0, Bh + 0.5), 0.05, new THREE.Color(0x333333), h + 0.2);
        }
      }
    });
    // heliport: bílý kruh a H
    for (const f of sport.filter((q) => q.k === 'helipad')) {
      const [cx, cz] = f.p[0], h = items.length + 1;
      const W = new THREE.Color(0xf4f4f0), G = new THREE.Color(0x5e9a48);
      for (let i = 0; i < 40; i++) {
        const a0 = (i / 40) * Math.PI * 2, a1 = ((i + 1) / 40) * Math.PI * 2;
        line([cx + Math.cos(a0) * 9, cz + Math.sin(a0) * 9], [cx + Math.cos(a1) * 9, cz + Math.sin(a1) * 9], 0.8, W, h);
      }
      void G;
      line([cx - 2.5, cz - 4], [cx - 2.5, cz + 4], 1.0, W, h); line([cx + 2.5, cz - 4], [cx + 2.5, cz + 4], 1.0, W, h);
      line([cx - 2.5, cz], [cx + 2.5, cz], 1.0, W, h);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  };
  const mesh = new THREE.Mesh(build(), mat);
  mesh.receiveShadow = true;
  group.add(mesh);
  let pending = 0;
  group.userData.refresh = () => {          // po načtení dlaždic (sloučit víc volání do jednoho)
    clearTimeout(pending);
    pending = setTimeout(() => { mesh.geometry.dispose(); mesh.geometry = build(); }, 300);
  };
  return group;
}
