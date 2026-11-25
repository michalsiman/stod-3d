import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Náměstí ČSA ve Stodě (podle OSM a leteckého snímku): parkoviště se stromořadími a na jižním konci
// park – dlážděná plocha s mřížkou světlých spár, malé stromky v řadách a lavičky. Plochy kopírují
// terén (síť 1 m / 0,5 m) a leží pod vozovkou; stromy z OSM (natural=tree) se přidají do vrstvy stromů,
// stání na parkovišti do seznamu parkovišť (zaparkovaná auta).

// hranice náměstí (OSM place=square) a parku (OSM highway=pedestrian, area=yes)
const SQUARE = [[-248.6, -1084.2], [-223.5, -1018.0], [-230.5, -1015.3], [-231.3, -1017.0], [-239.1, -1032.9], [-239.7, -1033.3],
  [-251.8, -1048.4], [-258.5, -1056.0], [-264.7, -1070.7], [-265.2, -1071.4], [-269.0, -1072.7], [-293.3, -1136.2], [-281.6, -1139.3],
  [-264.6, -1140.6], [-256.5, -1141.0], [-252.0, -1136.8], [-252.3, -1112.2], [-248.6, -1084.2]];
const PARK = [[-264.7, -1076.7], [-262.6, -1072.9], [-255.3, -1059.9], [-248.8, -1048.4], [-245.0, -1049.9], [-240.3, -1051.8],
  [-251.0, -1081.0], [-258.0, -1078.8], [-264.7, -1076.7]];

// stromy z OSM: [x, z]; v parku malé stromky, na parkovišti a podél silnice vzrostlé lípy
const TREES = [
  [-283, -1121], [-288, -1135], [-295, -1133], [-259, -1134], [-265, -1134], [-270, -1134], [-276, -1133], [-283, -1132], [-287, -1131],
  [-268, -1081], [-271, -1088], [-274, -1096], [-278, -1105], [-280, -1113], [-257, -1104], [-257, -1112], [-257, -1119], [-257, -1126],
  [-267, -1119], [-256, -1094], [-255, -1087],
  [-240, -1045], [-243, -1053], [-245, -1057], [-249, -1056], [-246, -1062], [-251, -1060], [-248, -1066], [-252, -1065], [-249, -1070],
  [-254, -1069], [-251, -1075], [-255, -1073], [-259, -1071], [-252, -1079], [-257, -1077], [-261, -1076],
  [-219, -1028], [-222, -1036], [-225, -1045], [-228, -1053], [-231, -1061], [-234, -1071], [-237, -1080], [-240, -1088], [-241, -1097],
  [-242, -1106], [-241, -1115], [-240, -1123],
];

function inPoly(x, z, r) {
  let ins = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > z) !== (r[j][1] > z) && x < (r[j][0] - r[i][0]) * (z - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) ins = !ins;
  }
  return ins;
}

/** Stromy pro createTrees({ extra }): [x, z, výška, poloměr koruny]. */
// poslední řada (13 stromů) je stromořadí podél silnice – menší stromy
export const SQUARE_TREES = TREES.map(([x, z], i) => (inPoly(x, z, PARK) ? [x, z, 6.5, 1.9]
  : i >= TREES.length - 13 ? [x, z, 8, 2.4] : [x, z, 12 + Math.abs((x * 7 + z * 3) % 3), 3.6]));

// stání podél uličky parkoviště (OSM parking_aisle): pás 9,5 m po obou stranách
export const SQUARE_PARKING = (() => {
  const a = [-258.1, -1079.6], b = [-271.7, -1120.0];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, nx = -uz, nz = ux;
  const strip = (s, u0, u1) => {
    const P = (u, v) => [a[0] + ux * u + nx * v * s, a[1] + uz * u + nz * v * s];
    const r = [P(u0, 2.6), P(u1, 2.6), P(u1, 12.1), P(u0, 12.1)];
    return { p: [...r, r[0]], busy: 0.75, n: 'nám. ČSA' };
  };
  return [strip(1, 3, 38), strip(-1, 6, 40)];
})();

// lavičky v parku: [x, z, úhel natočení (sedí se směrem +v)]
function benches() {
  const a = [-240.3, -1051.8], b = [-251.0, -1081.0];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, nx = -uz, nz = ux;
  const out = [];
  for (let u = 6; u < L - 3; u += 6) {
    for (const s of [-1, 1]) {
      const v = -5.2 + s * 2.6;           // dvě řady podél středové cesty parku
      out.push([a[0] + ux * u + nx * v, a[1] + uz * u + nz * v, Math.atan2(nz * -s, nx * -s)]);
    }
  }
  return out;
}

function benchGeo() {
  const parts = [];
  const box = (w, h, d, x, y, z, c) => {
    const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    const k = new THREE.Color(c), n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([k.r, k.g, k.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  };
  // osa x = délka, +z = předek (kam se sedí)
  for (let i = 0; i < 4; i++) box(1.7, 0.04, 0.09, 0, 0.44, -0.2 + i * 0.12, 0x9a6b42);   // latě sedáku
  for (let i = 0; i < 3; i++) box(1.7, 0.09, 0.03, 0, 0.6 + i * 0.13, -0.27, 0x9a6b42);  // opěradlo
  for (const x of [-0.7, 0.7]) {
    box(0.06, 0.42, 0.06, x, 0.21, 0.15, 0x2f3336);
    box(0.06, 0.85, 0.06, x, 0.42, -0.25, 0x2f3336);
    box(0.06, 0.05, 0.45, x, 0.42, -0.05, 0x2f3336);
  }
  return mergeGeometries(parts);
}

export function createSquare({ world }) {
  const T = world.tileAt(-260, -1080);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -10 });
  const LIFT = 0.06;
  const ASPH = new THREE.Color(0x9b9a96), ASPH2 = new THREE.Color(0x8f8e8a);
  const PAVE = new THREE.Color(0xb3ada2), JOINT = new THREE.Color(0xcfc9bc);

  function surface() {
    const pos = [], col = [];
    const cell = (x0, z0, s, c) => {
      const P = (x, z) => [x, world.heightAt(x, z) + LIFT, z];
      const a = P(x0, z0), b = P(x0 + s, z0), d = P(x0, z0 + s), e = P(x0 + s, z0 + s);
      pos.push(...a, ...d, ...b, ...b, ...d, ...e);
      for (let k = 0; k < 6; k++) col.push(c.r, c.g, c.b);
    };
    const xs = SQUARE.map((p) => p[0]), zs = SQUARE.map((p) => p[1]);
    const x0 = Math.floor(Math.min(...xs)), x1 = Math.ceil(Math.max(...xs)), z0 = Math.floor(Math.min(...zs)), z1 = Math.ceil(Math.max(...zs));
    // park: osa podél parku pro mřížku dlažby (čtverce 3 m, světlé spáry)
    const pa = [-240.3, -1051.8], pu = [-0.344, -0.939];
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        if (!inPoly(x + 0.5, z + 0.5, SQUARE) && !inPoly(x + 0.5, z + 0.5, PARK)) continue;
        if (inPoly(x + 0.5, z + 0.5, PARK) || [[0, 0], [1, 0], [0, 1], [1, 1]].some(([a, b]) => inPoly(x + a, z + b, PARK))) {
          for (let k = 0; k < 4; k++) {
            const sx = x + (k % 2) * 0.5, sz = z + (k >> 1) * 0.5, cx = sx + 0.25, cz = sz + 0.25;
            if (inPoly(cx, cz, PARK)) {
              const u = (cx - pa[0]) * pu[0] + (cz - pa[1]) * pu[1], v = (cx - pa[0]) * -pu[1] + (cz - pa[1]) * pu[0];
              const j = Math.abs(((u % 3) + 3) % 3 - 1.5) > 1.25 || Math.abs(((v % 3) + 3) % 3 - 1.5) > 1.25;
              cell(sx, sz, 0.5, j ? JOINT : PAVE);
            } else if (inPoly(cx, cz, SQUARE)) cell(sx, sz, 0.5, ASPH);
          }
        } else {
          cell(x, z, 1, ((x * 13 + z * 7) & 7) === 0 ? ASPH2 : ASPH);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  }

  // čáry stání (bílé) podél uličky
  function bayLines() {
    const pos = [];
    const a = [-258.1, -1079.6], b = [-271.7, -1120.0];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, nx = -uz, nz = ux;
    for (const s of [1, -1]) {
      for (let u = s > 0 ? 3 : 6; u <= (s > 0 ? 38 : 40); u += 2.6) {
        const q = (uu, v) => { const x = a[0] + ux * uu + nx * v * s, z = a[1] + uz * uu + nz * v * s; return [x, world.heightAt(x, z) + LIFT + 0.02, z]; };
        const p = [q(u - 0.06, 2.8), q(u + 0.06, 2.8), q(u + 0.06, 7.8), q(u - 0.06, 7.8)];
        pos.push(...p[0], ...p[3], ...p[1], ...p[1], ...p[3], ...p[2]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }

  const bGeo = benchGeo();
  const bMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const lineMat = new THREE.MeshLambertMaterial({ color: 0xeeeeea, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -14 });

  return function build(tile, group) {
    if (!T || tile.i !== T.i || tile.j !== T.j) return;
    const m = new THREE.Mesh(surface(), mat);
    m.receiveShadow = true;
    group.add(m);
    group.add(new THREE.Mesh(bayLines(), lineMat));
    const list = benches();
    const im = new THREE.InstancedMesh(bGeo, bMat, list.length);
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    list.forEach(([x, z, ang], i) => {
      // lokální +z (předek lavičky) natočit do směru ang
      q.setFromAxisAngle(up, Math.PI / 2 - ang);
      im.setMatrixAt(i, M.compose(p.set(x, world.heightAt(x, z) + LIFT, z), q, one));
    });
    im.castShadow = im.receiveShadow = true;
    group.add(im);
  };
}
