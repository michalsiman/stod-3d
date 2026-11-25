#!/usr/bin/env python3
"""
Stod 3D – příprava dat pro vykreslovaný model obce Stod (k.ú. Stod + k.ú. Lelov).

Podklady:
  * DMR 5G, DMP 1G (ČÚZK)  – terén; DMP − DMR = výšky budov, stromů, tvar střech
  * ZABAGED (ČÚZK)          – pokryv území, komunikace, železnice, mosty, vodní toky,
                              zdi, elektrické vedení, budovy, kůlny
  * RÚIAN (ČÚZK)            – obec, budovy (podlaží), parcely zahrad (ploty)
  * LPIS (eAGRI)            – skutečné hony (jen geometrie a kultura)
  * OSM                     – doplnění budov
  * Ortofoto (ČÚZK)         – NEZOBRAZUJE SE, jen klasifikace krytiny a stavu polí

Uspořádání: území rozdělené na dlaždice 1024 × 1024 m (i = východ, j = jih).
Lokální souřadnice: x = východ, z = jih (Three.js), počátek ve středu území.

Výstup web/data/:
  meta.json
  far_h.bin              Uint16 cm nad hmin, síť 16 m, v lesích výška korun
  far.png                barevná mapa celého území 4 m/px (vykreslená z tříd, ne foto)
  t/{i}_{j}.bin          Uint16 cm, terén 4 m (257 × 257)
  t/{i}_{j}.png          pokryv 1 m/px: R třída, G stav/variace, B orientace
  buildings.json         budovy (půdorys, výšky, typ, krytina, tvar střechy)
  trees.bin              8 B/strom: x, z (Uint16 po 0,2 m od SZ rohu), výška·5, poloměr·10, druh
  roads.json             osy komunikací a železnice (typ)
  bridges.json, fences.json, power.json

Spuštění:  python3 tools/build_data.py [--refresh]
"""
import io
import json
import math
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from PIL import Image, ImageDraw
from pyproj import Transformer
from scipy import ndimage
from shapely.geometry import Polygon

# ---------------------------------------------------------------- nastavení
OBEC_KOD = 558389                    # Stod
MARGIN = 300                         # okraj kolem hranice obce [m]
TILE = 1024                          # dlaždice [m]
T_STEP = 4                           # terén zblízka [m]
FAR_STEP = 16                        # terén zdálky [m]
FAR_PX = 4                           # barevná mapa zdálky [m/px]
CHUNK = 256                          # bloky pro stromy [m]
USE_ORTHO_HINTS = True
PLACES = {"Stod": (13.1647, 49.6393), "Lelov": (13.16496, 49.62000)}

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "cache"
OUT = ROOT / "web" / "data"

AGS = "https://ags.cuzk.gov.cz"
DMR = f"{AGS}/arcgis2/rest/services/dmr5g/ImageServer/exportImage"
DMP = f"{AGS}/arcgis2/rest/services/dmp1g/ImageServer/exportImage"
ORTO = f"{AGS}/arcgis1/rest/services/ORTOFOTO/MapServer/export"
RUIAN = f"{AGS}/arcgis/rest/services/RUIAN/Prohlizeci_sluzba_nad_daty_RUIAN/MapServer"
ZBG = f"{AGS}/arcgis/rest/services/ZABAGED_POLOHOPIS/MapServer"
LPIS = "https://mze.gov.cz/public/app/wms/plpis_wfs.fcgi"
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]

# třídy pokryvu – musí souhlasit s web/js/terrain.js
LC = dict(MEADOW=1, ARABLE=2, LAWN=3, GARDEN=4, FOREST_DECID=5, FOREST_CONIF=6, FOREST_MIXED=7,
          SHRUB=8, SETTLEMENT=9, YARD=10, WATER=11, BUILDING=17, CEMETERY=19, RAIL=20)
FOREST = (5, 6, 7)
# barvy zdálky (sRGB); lesy jako koruny – zdálky je terén zvednutý o výšku porostu
FAR_COL = {1: (146, 172, 98), 2: (128, 160, 82), 3: (154, 188, 102), 4: (136, 164, 94), 5: (70, 108, 60),
           6: (60, 98, 58), 7: (64, 102, 60), 8: (116, 146, 84), 9: (192, 186, 162), 10: (178, 174, 162),
           11: (112, 162, 192), 17: (172, 166, 156), 19: (142, 168, 112), 20: (154, 144, 132)}
FIELD_COL = [(124, 158, 80), (220, 196, 122), (170, 130, 94)]
# komunikace: typ → (šířka [m], barva zdálky); musí souhlasit s web/js/roads.js
ROAD = {0: (8.5, (122, 124, 130)), 1: (6.5, (122, 124, 130)), 2: (5.0, (122, 124, 130)), 3: (3.5, (122, 124, 130)),
        4: (3.2, (184, 180, 170)), 5: (3.0, (205, 194, 168)), 6: (2.6, (184, 156, 116)),
        7: (1.2, (196, 173, 136)), 8: (4.2, (122, 110, 100))}

REFRESH = "--refresh" in sys.argv
to_jtsk = Transformer.from_crs(4326, 5514, always_xy=True)
to_wgs = Transformer.from_crs(5514, 4326, always_xy=True)
rng = np.random.default_rng(7)
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "stod-3d/0.3 (data pipeline)"})


def log(*a):
    print("·", *a, flush=True)


def fetch(name, url, params=None, data=None, retries=4):
    path = CACHE / name
    if path.exists() and not REFRESH:
        return path.read_bytes()
    for i in range(retries):
        try:
            r = (SESSION.post(url, data=data, timeout=240) if data
                 else SESSION.get(url, params=params, timeout=240))
            r.raise_for_status()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(r.content)
            return r.content
        except requests.RequestException as e:
            log(f"  {name}: pokus {i + 1} selhal ({e})")
            time.sleep(4 * 2 ** i)
    raise RuntimeError(f"nepodařilo se stáhnout {name}")


# ---------------------------------------------------------------- území
def area():
    d = json.loads(fetch("stod/obec.json", f"{RUIAN}/12/query", params=dict(
        where=f"kod={OBEC_KOD}", outFields="kod,nazev", returnGeometry="true", outSR=5514, f="json")))
    rings = d["features"][0]["geometry"]["rings"]
    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    x0 = math.floor((min(xs) - MARGIN) / TILE) * TILE
    x1 = math.ceil((max(xs) + MARGIN) / TILE) * TILE
    y0 = math.floor((min(ys) - MARGIN) / TILE) * TILE
    y1 = math.ceil((max(ys) + MARGIN) / TILE) * TILE
    return rings, x0, y0, x1, y1


RINGS, X0, Y0, X1, Y1 = area()                 # S-JTSK (E, N); Y1 = sever
W, H = X1 - X0, Y1 - Y0
NX, NY = W // TILE, H // TILE
CX, CY = X0 + W / 2, Y0 + H / 2
BBOX = f"{X0},{Y0},{X1},{Y1}"


def loc(e, n):
    """S-JTSK → lokální (x východ, z jih)."""
    return e - CX, CY - n


def raster(name, url, e0, n1, size, step):
    """Výškový rastr se středy pixelů na uzlech sítě; e0 = západ, n1 = sever."""
    n = int(size / step) + 1
    h = step / 2
    raw = fetch(name, url, params=dict(
        bbox=f"{e0 - h},{n1 - size - h},{e0 + size + h},{n1 + h}", bboxSR=5514, imageSR=5514,
        size=f"{n},{n}", format="tiff", pixelType="F32",
        interpolation="RSP_BilinearInterpolation", f="image"))
    a = np.array(Image.open(io.BytesIO(raw)), dtype=np.float32)
    bad = (a < 100) | (a > 2000)
    if bad.all():
        raise RuntimeError(f"{name}: prázdný rastr")
    if bad.any():
        a[bad] = np.median(a[~bad])
    return a


def arcgis(name, url, where="1=1", fields="*"):
    feats, off = [], 0
    while True:
        d = json.loads(fetch(f"{name}_{off}.json", url, params=dict(
            where=where, geometry=BBOX, geometryType="esriGeometryEnvelope", inSR=5514, outSR=5514,
            spatialRel="esriSpatialRelIntersects", outFields=fields, returnGeometry="true",
            resultOffset=off, resultRecordCount=1000, f="json")))
        if "error" in d:
            raise RuntimeError(f"{name}: {d['error']}")
        feats += d.get("features", [])
        if not d.get("exceededTransferLimit"):
            return feats
        off += 1000


def zbg(layer):
    return arcgis(f"stod/zbg{layer}", f"{ZBG}/{layer}/query")


def rings_of(f):
    return f.get("geometry", {}).get("rings") or []


def paths_of(feats):
    return [p for f in feats for p in (f.get("geometry", {}).get("paths") or [])]


# ---------------------------------------------------------------- geometrie
def ring_area(r):
    return 0.5 * sum(r[i][0] * r[i - 1][1] - r[i - 1][0] * r[i][1] for i in range(len(r)))


def centroid(r):
    xs, ys = zip(*r)
    return sum(xs) / len(xs), sum(ys) / len(ys)


def obb(ring):
    """Nejmenší opsaný obdélník: (plocha, úhel podélné osy, L, W, střed)."""
    best = None
    for i in range(len(ring) - 1):
        (x1, y1), (x2, y2) = ring[i], ring[i + 1]
        L = math.hypot(x2 - x1, y2 - y1)
        if L < 0.5:
            continue
        ax, ay = (x2 - x1) / L, (y2 - y1) / L
        us = [x * ax + y * ay for x, y in ring]
        vs = [-x * ay + y * ax for x, y in ring]
        du, dv = max(us) - min(us), max(vs) - min(vs)
        if best is None or du * dv < best[0]:
            cu, cv = (max(us) + min(us)) / 2, (max(vs) + min(vs)) / 2
            c = (cu * ax - cv * ay, cu * ay + cv * ax)
            best = (du * dv, math.atan2(ay, ax), du, dv, c) if du >= dv else \
                (du * dv, math.atan2(ax, -ay), dv, du, c)
    return best


def orient_byte(ring):
    o = obb(ring)
    return int(o[1] % math.pi / math.pi * 255) if o else 0


class Canvas:
    """Rastr pokryvu celého území, 1 m/px, řádek 0 = sever."""

    def __init__(self):
        self.R = np.full((H, W), LC["MEADOW"], np.uint8)
        self.G = np.zeros((H, W), np.uint8)
        self.B = np.zeros((H, W), np.uint8)

    @staticmethod
    def px(e, n):
        return e - X0, Y1 - n

    def mask(self, rings):
        pts = [self.px(x, y) for r in rings for x, y in r]
        xs, ys = zip(*pts)
        c0, c1 = max(0, int(min(xs)) - 1), min(W, int(max(xs)) + 2)
        r0, r1 = max(0, int(min(ys)) - 1), min(H, int(max(ys)) + 2)
        if c1 <= c0 or r1 <= r0:
            return None, None
        img = Image.new("1", (c1 - c0, r1 - r0), 0)
        d = ImageDraw.Draw(img)
        sign = math.copysign(1, ring_area(rings[0]))
        for r in rings:
            d.polygon([(px - c0, py - r0) for px, py in (self.px(x, y) for x, y in r)],
                      fill=1 if math.copysign(1, ring_area(r)) == sign else 0)
        m = np.array(img, dtype=bool)
        return (m, (slice(r0, r1), slice(c0, c1))) if m.any() else (None, None)

    def fill(self, rings, cls, g=None, b=None):
        m, sl = self.mask(rings)
        if m is None:
            return None
        self.R[sl][m] = cls
        self.G[sl][m] = int(rng.integers(0, 64)) if g is None else g
        if b is not None:
            self.B[sl][m] = b
        return m, sl

    def line(self, paths, cls, width):
        w = max(1, round(width))
        for p in paths:
            pts = [self.px(x, y) for x, y in p]
            xs, ys = zip(*pts)
            c0, c1 = max(0, int(min(xs)) - w), min(W, int(max(xs)) + w + 1)
            r0, r1 = max(0, int(min(ys)) - w), min(H, int(max(ys)) + w + 1)
            if c1 <= c0 or r1 <= r0:
                continue
            img = Image.new("1", (c1 - c0, r1 - r0), 0)
            ImageDraw.Draw(img).line([(x - c0, y - r0) for x, y in pts], fill=1, width=w, joint="curve")
            m = np.array(img, dtype=bool)
            sl = (slice(r0, r1), slice(c0, c1))
            self.R[sl][m] = cls
            self.G[sl][m] = 0


# ---------------------------------------------------------------- ortofoto (jen klasifikace)
ORTHO = None


def load_ortho():
    global ORTHO
    if not USE_ORTHO_HINTS:
        return
    log("Ortofoto – jen pro klasifikaci (po dlaždicích)")
    ORTHO = np.zeros((H, W, 3), np.uint8)

    def one(ij):
        i, j = ij
        e0, n1 = X0 + i * TILE, Y1 - j * TILE
        raw = fetch(f"stod/orto/{i}_{j}.jpg", ORTO, params=dict(
            bbox=f"{e0},{n1 - TILE},{e0 + TILE},{n1}", bboxSR=5514, imageSR=5514,
            size=f"{TILE},{TILE}", format="jpg", f="image"))
        ORTHO[j * TILE:(j + 1) * TILE, i * TILE:(i + 1) * TILE] = np.asarray(
            Image.open(io.BytesIO(raw)).convert("RGB"))
    with ThreadPoolExecutor(6) as ex:
        list(ex.map(one, [(i, j) for j in range(NY) for i in range(NX)]))


def field_state(m, sl):
    if ORTHO is None:
        return int(rng.integers(0, 3))
    px = ORTHO[sl][m]
    if px.size == 0:
        return 0
    r, g, b = np.median(px, axis=0).astype(float)
    if g >= r and g >= b * 1.02:
        return 0
    return 1 if (r + g + b) / 3 > 135 else 2


def roof_class(m, sl):
    if ORTHO is None:
        return int(rng.choice([0, 0, 0, 1, 2, 3]))
    px = ORTHO[sl][m].astype(np.float32)
    green = (2 * px[:, 1] - px[:, 0] - px[:, 2]) > 24
    if (~green).sum() >= 8:
        px = px[~green]
    if len(px) < 8:
        return 0
    lum = px.mean(axis=1)
    r, g, b = np.median(px[lum >= np.median(lum)], axis=0)
    L, warm = (r + g + b) / 3, r - b
    if L > 175 and warm < 28:
        return 4
    if warm >= 40:
        return 0 if L >= 125 else 1
    if warm >= 22:
        return 1
    return 2 if L < 110 else 3


# ---------------------------------------------------------------- výškopis
def build_heights():
    log(f"Výškopis: {NX} × {NY} dlaždic po {TILE} m")
    ndsm = np.zeros((H + 1, W + 1), np.float16)
    dmr4 = np.zeros((H // T_STEP + 1, W // T_STEP + 1), np.float32)
    k = TILE // T_STEP

    def one(ij):
        i, j = ij
        e0, n1 = X0 + i * TILE, Y1 - j * TILE
        t4 = raster(f"stod/dmr4/{i}_{j}.tif", DMR, e0, n1, TILE, T_STEP)
        d1 = raster(f"stod/dmr1/{i}_{j}.tif", DMR, e0, n1, TILE, 1)
        p1 = raster(f"stod/dmp1/{i}_{j}.tif", DMP, e0, n1, TILE, 1)
        dmr4[j * k:(j + 1) * k + 1, i * k:(i + 1) * k + 1] = t4
        ndsm[j * TILE:(j + 1) * TILE + 1, i * TILE:(i + 1) * TILE + 1] = np.clip(p1 - d1, 0, 60)
    with ThreadPoolExecutor(6) as ex:
        list(ex.map(one, [(i, j) for j in range(NY) for i in range(NX)]))
    return dmr4, ndsm


def write_terrain(dmr4, hmin):
    (OUT / "t").mkdir(parents=True, exist_ok=True)
    k = TILE // T_STEP
    cm = np.round((dmr4 - hmin) * 100).astype("<u2")
    for j in range(NY):
        for i in range(NX):
            (OUT / "t" / f"{i}_{j}.bin").write_bytes(
                np.ascontiguousarray(cm[j * k:(j + 1) * k + 1, i * k:(i + 1) * k + 1]).tobytes())


def h4(e, n, dmr4):
    c = min(max((e - X0) / T_STEP, 0), dmr4.shape[1] - 1.001)
    r = min(max((Y1 - n) / T_STEP, 0), dmr4.shape[0] - 1.001)
    c0, r0 = int(c), int(r)
    fc, fr = c - c0, r - r0
    a = dmr4[r0:r0 + 2, c0:c0 + 2]
    return float((a[0, 0] * (1 - fc) + a[0, 1] * fc) * (1 - fr) + (a[1, 0] * (1 - fc) + a[1, 1] * fc) * fr)


def nd_at(e, n, ndsm):
    c, r = int(round(e - X0)), int(round(Y1 - n))
    if 0 <= r < ndsm.shape[0] and 0 <= c < ndsm.shape[1]:
        return float(ndsm[r, c])
    return 0.0


# ---------------------------------------------------------------- LPIS
def lpis_blocks():
    out, seen = [], set()
    step = 2048
    for e in range(X0, X1, step):
        for n in range(Y0, Y1, step):
            raw = fetch(f"stod/lpis/{e}_{n}.xml", LPIS, params=dict(
                SERVICE="WFS", VERSION="1.1.0", REQUEST="GetFeature", TYPENAME="ms:LPIS_DPB_UCINNE",
                SRSNAME="EPSG:5514", BBOX=f"{e},{n},{e + step},{n + step},EPSG:5514")).decode("utf-8")
            for f in raw.split("<gml:featureMember>")[1:]:
                fid = re.search(r'gml:id="([^"]+)"', f)
                if not fid or fid.group(1) in seen:
                    continue
                seen.add(fid.group(1))
                k = re.search(r"<ms:kultura>([^<]*)</ms:kultura>", f)
                rings = []
                for tag in ("exterior", "interior"):
                    for m in re.finditer(rf"<gml:{tag}>.*?<gml:posList[^>]*>([^<]+)</gml:posList>", f, re.S):
                        v = list(map(float, m.group(1).split()))
                        rings.append([[v[i], v[i + 1]] for i in range(0, len(v), 2)])
                if rings:
                    out.append((k.group(1) if k else "", rings))
    return out


# ---------------------------------------------------------------- pokryv území
def build_landcover():
    log("Pokryv území – ZABAGED + LPIS")
    cv = Canvas()

    def poly(layer, cls_fn, orient=False, state=False):
        for f in zbg(layer):
            rings = rings_of(f)
            if not rings:
                continue
            cls = cls_fn(f["attributes"]) if callable(cls_fn) else cls_fn
            res = cv.fill(rings, cls, b=orient_byte(rings[0]) if orient else None)
            if res and state:
                m, sl = res
                cv.G[sl][m] = field_state(m, sl) * 64 + int(rng.integers(0, 64))

    poly(139, LC["MEADOW"], orient=True)
    poly(138, LC["ARABLE"], orient=True, state=True)
    blocks = lpis_blocks()
    for kult, rings in blocks:
        if "orná" in kult:
            res = cv.fill(rings, LC["ARABLE"], b=orient_byte(rings[0]))
            if res:
                m, sl = res
                cv.G[sl][m] = field_state(m, sl) * 64 + int(rng.integers(0, 64))
        elif "travní" in kult or "úhor" in kult:
            cv.fill(rings, LC["MEADOW"], b=orient_byte(rings[0]))
    log(f"  LPIS: {len(blocks)} dílů půdních bloků")
    poly(134, LC["LAWN"])
    poly(135, LC["GARDEN"], orient=True)
    poly(140, LC["SHRUB"])
    poly(142, LC["FOREST_DECID"])
    poly(144, lambda a: {"J": LC["FOREST_CONIF"], "L": LC["FOREST_DECID"]}.get(a.get("druh_k"), LC["FOREST_MIXED"]))
    for layer in (114, 117, 118, 119, 123, 127):
        poly(layer, LC["YARD"])
    poly(115, LC["SETTLEMENT"])
    poly(116, LC["CEMETERY"])
    poly(121, LC["RAIL"])
    poly(122, LC["RAIL"])
    poly(132, LC["WATER"])
    toky = zbg(93)
    cv.line(paths_of([f for f in toky if f["attributes"].get("vydattok_p") == "stálý"]), LC["WATER"], 2)
    green_from_ortho(cv)
    return cv


TREE_HINT = None     # koruny stromů z ortofota tam, kde je DMP nevidí (bool, H × W)


def green_from_ortho(cv):
    """Areály a zástavba (šedé plochy) jsou z velké části tráva a stromy – podle ortofota: souvisle zelené
    plochy → trávník; tmavé členité zelené plochy (koruny) si zapamatovat pro stromy (build_trees)."""
    global TREE_HINT
    if ORTHO is None:
        return
    TREE_HINT = np.zeros((H, W), bool)
    n_lawn = 0
    M = 6
    for j in range(NY):
        for i in range(NX):
            r0, c0 = max(j * TILE - M, 0), max(i * TILE - M, 0)
            r1, c1 = min((j + 1) * TILE + M, H), min((i + 1) * TILE + M, W)
            px = ORTHO[r0:r1, c0:c1].astype(np.int16)
            R, G, Bc = px[..., 0], px[..., 1], px[..., 2]
            gi = ndimage.median_filter(2 * G - R - Bc, 5)
            lum = (R + G + Bc) / 3
            green = gi > 14
            # tráva: všechno, co není šedý zpevněný povrch (asfalt, beton, dlažba – nízká sytost)
            # nebo holá zem; zahrnuje i trávu ve stínu stromů
            sat = np.max(px, axis=-1) - np.min(px, axis=-1)
            soil = (R > G + 8) & (R > Bc + 18)
            lawn = ndimage.binary_closing(ndimage.median_filter((gi > 4) & ~soil & (sat > 14), 7), iterations=2)
            # koruny: zelené, tmavší a členité (rozptyl jasu)
            lf = lum.astype(np.float32)
            var = ndimage.uniform_filter(lf * lf, 5) - ndimage.uniform_filter(lf, 5) ** 2
            crown = ndimage.binary_opening(green & (lum < 105) & (var > 90), iterations=2)
            lab, nlab = ndimage.label(crown)
            if nlab:
                sizes = ndimage.sum(crown, lab, np.arange(1, nlab + 1))
                crown = np.isin(lab, np.nonzero(sizes >= 30)[0] + 1)
            sr = slice(j * TILE - r0, j * TILE - r0 + TILE)
            sc = slice(i * TILE - c0, i * TILE - c0 + TILE)
            cls = cv.R[j * TILE:(j + 1) * TILE, i * TILE:(i + 1) * TILE]
            grey = np.isin(cls, [LC["YARD"], LC["SETTLEMENT"]])
            m = grey & lawn[sr, sc]
            cls[m] = LC["LAWN"]
            n_lawn += int(m.sum())
            TREE_HINT[j * TILE:(j + 1) * TILE, i * TILE:(i + 1) * TILE] = crown[sr, sc] & ~np.isin(cls, list(FOREST) + [LC["WATER"]])
    log(f"  ortofoto: {n_lawn / 1e4:.0f} ha šedých ploch → trávník, {TREE_HINT.sum() / 1e4:.0f} ha korun stromů")


# ---------------------------------------------------------------- vektory
def lpts(p):
    return [[round(v, 1) for v in loc(x, y)] for x, y in p]


def build_vectors():
    log("Komunikace, železnice, mosty, elektrické vedení")
    roads = []

    def add(paths, t):
        roads.extend(dict(t=t, p=lpts(p)) for p in paths)

    sil = zbg(79)
    first = lambda f: (f["attributes"].get("typsil_p") or "").startswith("silnice I.")  # noqa: E731
    add(paths_of([f for f in sil if first(f)]), 0)
    add(paths_of([f for f in sil if not first(f)]), 1)
    add(paths_of(zbg(84)), 2)

    def surf(a):
        p = a.get("povrch_p") or ""
        return 3 if "asfalt" in p else 4 if ("panel" in p or "dlažba" in p) else 5 if "štěrk" in p else 6
    cesty = zbg(83)
    for t in (3, 4, 5, 6):
        add(paths_of([f for f in cesty if surf(f["attributes"]) == t]), t)
    add(paths_of(zbg(82)), 7)
    add(paths_of(zbg(75)) + paths_of(zbg(76)), 8)
    (OUT / "roads.json").write_text(json.dumps(roads, separators=(",", ":")))
    bridges = [lpts(p) for p in paths_of(zbg(73))]
    (OUT / "bridges.json").write_text(json.dumps(bridges, separators=(",", ":")))
    power = [lpts(p) for p in paths_of(zbg(88))]
    (OUT / "power.json").write_text(json.dumps(power, separators=(",", ":")))
    log(f"  {len(roads)} úseků komunikací, {len(bridges)} mostů, {len(power)} vedení")
    return roads, bridges, power


def build_fences(cv):
    """Ploty po obvodu zahrad (parcely RÚIAN, druh 5) + zdi ze ZABAGED."""
    log("Ploty a zdi")
    parcels = arcgis("stod/ruian_zahrady", f"{RUIAN}/5/query", where="druhpozemkukod=5", fields="id")
    seen, fences = set(), []
    for f in parcels:
        typ = int(rng.choice([0, 0, 1, 1, 2, 3]))      # dřevo, pletivo, kov, živý plot
        for ring in rings_of(f):
            run = []
            for a, b in zip(ring, ring[1:]):
                key = tuple(sorted([(round(a[0], 1), round(a[1], 1)), (round(b[0], 1), round(b[1], 1))]))
                px, py = int((a[0] + b[0]) / 2 - X0), int(Y1 - (a[1] + b[1]) / 2)
                bad = (key in seen or math.dist(a, b) < 0.8 or not (0 <= py < H and 0 <= px < W)
                       or cv.R[py, px] in (LC["BUILDING"], LC["WATER"]))
                seen.add(key)
                if bad:
                    if len(run) >= 2:
                        fences.append(dict(t=typ, p=run))
                    run = []
                    continue
                if not run:
                    run = [[round(v, 1) for v in loc(*a)]]
                run.append([round(v, 1) for v in loc(*b)])
            if len(run) >= 2:
                fences.append(dict(t=typ, p=run))
    fences += [dict(t=4, p=lpts(p)) for p in paths_of(zbg(39))]
    (OUT / "fences.json").write_text(json.dumps(fences, separators=(",", ":")))
    log(f"  {len(parcels)} zahrad → {len(fences)} úseků plotů a zdí")


# ---------------------------------------------------------------- budovy
def osm_buildings():
    corners = [to_wgs.transform(x, y) for x in (X0, X1) for y in (Y0, Y1)]
    lons, lats = zip(*corners)
    q = f"[out:json][timeout:180];way[building]({min(lats)},{min(lons)},{max(lats)},{max(lons)});out tags geom;"
    for url in OVERPASS:
        try:
            els = json.loads(fetch("stod/osm_buildings.json", url, data={"data": q}, retries=3)).get("elements", [])
            break
        except (RuntimeError, ValueError) as e:
            (CACHE / "stod/osm_buildings.json").unlink(missing_ok=True)
            log(f"  {url}: {e}")
    else:
        return []
    out = []
    for el in els:
        g = el.get("geometry")
        if not g or len(g) < 4:
            continue
        t = el.get("tags", {})
        lv = t.get("building:levels", "")
        out.append(dict(rings=[[list(to_jtsk.transform(p["lon"], p["lat"])) for p in g]],
                        osmkind=t.get("building"),
                        floors=int(float(lv)) if lv.replace(".", "").isdigit() else None))
    return out


class Grid:
    """Prostorový index budov – padne bod do některé budovy?"""

    def __init__(self, s=64):
        self.s, self.cells = s, {}

    def add(self, b):
        r = b["rings"][0]
        xs, ys = [p[0] for p in r], [p[1] for p in r]
        for gx in range(int(min(xs) // self.s), int(max(xs) // self.s) + 1):
            for gy in range(int(min(ys) // self.s), int(max(ys) // self.s) + 1):
                self.cells.setdefault((gx, gy), []).append(b)

    def hit(self, x, y):
        for b in self.cells.get((int(x // self.s), int(y // self.s)), []):
            r = b["rings"][0]
            inside, j = False, len(r) - 1
            for i in range(len(r)):
                if (r[i][1] > y) != (r[j][1] > y) and \
                        x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1] + 1e-12) + r[i][0]:
                    inside = not inside
                j = i
            if inside:
                return True
        return False


def roof_shape(o, eave, ridge, ndsm):
    """Tvar střechy z povrchového modelu: gable (sedlová) / hip (valbová) / gambrel (lomená)."""
    _, ang, L, Wd, (cx, cy) = o
    ax, ay = math.cos(ang), math.sin(ang)
    bx, by = -ay, ax

    def s(u, v):
        return nd_at(cx + ax * u + bx * v, cy + ay * u + by * v, ndsm)
    if ridge - eave < 1.2 or Wd < 4 or L < 4:
        return "gable"
    mid = float(np.median([s(0, 0), s(1, 0), s(-1, 0)]))
    if mid - eave < 1:
        return "gable"
    end = (s(L / 2 - 1.2, 0) + s(-L / 2 + 1.2, 0)) / 2
    q = (s(0, Wd / 4) + s(0, -Wd / 4)) / 2
    if (end - eave) < 0.5 * (mid - eave):
        return "hip"
    if Wd > 7.5 and (q - eave) > 0.72 * (mid - eave):
        return "gambrel"
    return "gable"



# RÚIAN – způsob využití stavebního objektu (číselník CE_ZPUSOB_VYUZITI_OBJEKTU) → druh pro vykreslení
USE_KIND = {1: "industry", 2: "house", 3: "house", 4: "farm", 5: "civic", 6: "flats", 7: "house", 8: "house",
            9: "civic", 10: "civic", 11: "civic", 12: "industry", 13: "farm", 14: "civic", 15: "civic",
            16: "shed", 17: "shed", 18: "garage", 19: "shed", 20: "civic", 21: "greenhouse"}
OSM_KIND = {"shed": "shed", "hut": "shed", "carport": "shed", "garage": "garage", "garages": "garage",
            "greenhouse": "greenhouse", "barn": "farm", "farm_auxiliary": "farm", "cowshed": "farm",
            "stable": "farm", "industrial": "industry", "warehouse": "industry", "apartments": "flats",
            "church": "civic", "chapel": "civic", "school": "civic", "public": "civic", "retail": "civic",
            "commercial": "civic", "civic": "civic", "train_station": "civic", "office": "civic"}
LOW_KINDS = ("shed", "garage", "greenhouse")


def building_kind(b, area):
    if b.get("shed"):
        return "shed"
    k = USE_KIND.get(b.get("use")) or OSM_KIND.get(b.get("osmkind") or "")
    if k:
        if k == "house" and (b.get("flats") or 0) >= 4:
            return "flats"
        return k
    return "farm" if area > 220 and not b.get("cp") else "house"


def above_floors(b, kind):
    """Nadzemní podlaží (RÚIAN počítá i podzemní – odhad podle objemu)."""
    f = b.get("floors")
    if not f:
        return None
    if kind in LOW_KINDS:
        return 1
    vol, area = b.get("vol"), b.get("built")
    if f >= 2 and vol and area and vol / area < 3.0 * f - 1.5:
        f -= 1                         # jedno podlaží je nejspíš sklep
    return int(f)


def building_height(b, kind, m, sl, ndsm):
    """Okap a hřeben [m nad terénem] z povrchového modelu, hlídané údaji z RÚIAN.

    Okraj půdorysu se vynechá (sousední domy, posun půdorysu), zelené pixely z ortofota také
    (koruny stromů nad střechou); výška nesmí výrazně přesáhnout, co odpovídá počtu podlaží
    a obestavěnému prostoru."""
    inner = ndimage.binary_erosion(m, iterations=1)
    if inner.sum() < max(4, 0.35 * m.sum()):
        inner = m
    vals = ndsm[sl][inner].astype(np.float32)
    if ORTHO is not None and vals.size >= 8:
        px = ORTHO[sl][inner].astype(np.int16)
        if px.shape[0] == vals.size:
            green = (2 * px[:, 1] - px[:, 0] - px[:, 2]) > 24
            if (~green).sum() >= max(4, 0.3 * vals.size):
                vals = vals[~green]
    fl = above_floors(b, kind)
    fh = 3.3 if kind in ("civic", "industry", "farm") else 2.9
    guess_e = {"shed": 2.4, "garage": 2.6, "greenhouse": 2.6}.get(kind, fh * (fl or 1) + 0.4)
    guess_r = guess_e + (1.2 if kind in LOW_KINDS else 3.5)
    # horní mez: podlaží + vysoká střecha, objem / plocha; kostely a sila mohou být vyšší
    cap = None
    if kind in LOW_KINDS:
        cap = 5.5
    elif fl:
        cap = fh * fl + 8.0
        vol, area = b.get("vol"), b.get("built")
        if vol and area and area > 10:
            cap = max(cap, 2.2 * vol / area + 2.0) if kind != "civic" else max(cap, 3.0 * vol / area + 4.0)
    if vals.size < 4:
        return guess_e, guess_r, "odhad"
    if cap is not None:
        ok = vals[vals <= cap + 1.0]
        if ok.size >= max(4, 0.25 * vals.size):
            vals = ok
    eave, ridge = float(np.percentile(vals, 35)), float(np.percentile(vals, 92))
    if ridge < 2.0 or ridge > 45 or (cap is not None and ridge > cap + 1.5):
        return guess_e, guess_r, "odhad"
    # okap: alespoň na podlaží, u nízkých podlaží ne o moc výš, než odpovídá
    if fl:
        eave = min(eave, fh * fl + 1.5)
    eave = max(2.2, min(eave, ridge))
    return round(eave, 2), round(ridge, 2), "dmp" if cap is None else "dmp+ruian"


def no_tree_mask(roads, bridges, power):
    """Kde nesmí stát samostatný strom: silnice, železnice, mosty, vedení (DMP tam vidí mostovku,
    auta, trolej a sloupy)."""
    img = Image.new("1", (W, H), 0)
    d = ImageDraw.Draw(img)

    def draw(p, w):
        pts = [(x + W / 2, z + H / 2) for x, z in p]
        if len(pts) >= 2:
            d.line(pts, fill=1, width=max(1, round(w)), joint="curve")
    for r in roads:
        draw(r["p"], ROAD[r["t"]][0] + (5 if r["t"] == 8 else 0))
    for p in bridges:
        draw(p, 16)
        for q in (p[0], p[-1]):
            x, z = q[0] + W / 2, q[1] + H / 2
            d.ellipse((x - 8, z - 8, x + 8, z + 8), fill=1)
    for p in power:
        draw(p, 3)
    return np.array(img, dtype=bool)


def build_buildings(cv, dmr4, ndsm, hmin):
    log("Budovy – RÚIAN + ZABAGED + OSM")
    blds, grid = [], Grid()
    for f in arcgis("stod/ruian_budovy", f"{RUIAN}/3/query", fields="kod,cisladomovni,pocetpodlazi,zpusobvyuzitikod,obestavenyprostor,zastavenaplocha,pocetbytu"):
        if rings_of(f):
            a = f["attributes"]
            b = dict(rings=rings_of(f), floors=a.get("pocetpodlazi"), cp=a.get("cisladomovni"),
                     use=a.get("zpusobvyuzitikod"), vol=a.get("obestavenyprostor"),
                     built=a.get("zastavenaplocha"), flats=a.get("pocetbytu"))
            blds.append(b)
            grid.add(b)
    cells = {}

    def index_add(poly, i):
        x0, y0, x1, y1 = poly.bounds
        for gx in range(int(x0 // 50), int(x1 // 50) + 1):
            for gy in range(int(y0 // 50), int(y1 // 50) + 1):
                cells.setdefault((gx, gy), []).append(i)

    def tree_query(poly):
        x0, y0, x1, y1 = poly.bounds
        out = set()
        for gx in range(int(x0 // 50), int(x1 // 50) + 1):
            for gy in range(int(y0 // 50), int(y1 // 50) + 1):
                for i in cells.get((gx, gy), []):
                    if poly.intersects(blds[i]["_poly"]):
                        out.add(i)
        return out
    for i, b in enumerate(blds):
        try:
            b["_poly"] = Polygon(b["rings"][0]).buffer(0)
        except ValueError:
            b["_poly"] = Polygon()
        index_add(b["_poly"], i)
    counts = {"ruian": len(blds)}

    def add(cands, src):
        k = 0
        for b in cands:
            # duplicita = většina půdorysu se překrývá s už přidanou budovou
            try:
                poly = Polygon(b["rings"][0]).buffer(0)
            except ValueError:
                continue
            if poly.is_empty or poly.area < 1:
                continue
            hits = [blds[i]["_poly"] for i in tree_query(poly)]
            over = sum(poly.intersection(h).area for h in hits)
            if over < 0.4 * poly.area:
                b["_poly"] = poly
                blds.append(b)
                grid.add(b)
                index_add(poly, len(blds) - 1)
                k += 1
        counts[src] = k
    add([dict(rings=rings_of(f)) for f in zbg(99) if rings_of(f)], "zabaged")
    add([dict(rings=rings_of(f), shed=True) for f in zbg(105) if rings_of(f)], "kulna")
    add(osm_buildings(), "osm")
    log("  ", counts)

    out, shapes, hsrc = [], {}, {}
    for b in blds:
        outer = b["rings"][0]
        area = abs(ring_area(outer))
        if area < 6:
            continue
        res = cv.fill(b["rings"], LC["BUILDING"], g=0)
        if not res:
            continue
        m, sl = res
        kind = building_kind(b, area)
        eave, ridge, src = building_height(b, kind, m, sl, ndsm)
        hsrc[src] = hsrc.get(src, 0) + 1
        base = min(h4(x, y, dmr4) for x, y in outer)
        o = obb(outer)
        shape = roof_shape(o, eave, ridge, ndsm) if o else "gable"
        shapes[shape] = shapes.get(shape, 0) + 1
        out.append(dict(
            k=kind, roof=roof_class(m, sl), shape=shape, cp=b.get("cp"), fl=above_floors(b, kind),
            base=round(base - hmin, 2), eave=round(eave, 2), ridge=round(ridge, 2),
            rings=[lpts(r) for r in b["rings"]],
        ))
    (OUT / "buildings.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    kinds = {}
    for o in out:
        kinds[o["k"]] = kinds.get(o["k"], 0) + 1
    log(f"  {len(out)} budov, střechy: {shapes}")
    log(f"  druhy: {kinds}, výška z: {hsrc}")


# ---------------------------------------------------------------- stromy
def build_trees(cv, ndsm, nomask):
    log("Stromy")
    allt = []
    for j in range(NY):
        for i in range(NX):
            r0, c0 = j * TILE, i * TILE
            nd = ndsm[r0:r0 + TILE, c0:c0 + TILE].astype(np.float32)
            cls = cv.R[r0:r0 + TILE, c0:c0 + TILE]
            forest = np.isin(cls, FOREST)
            near_b = ndimage.binary_dilation(cls == LC["BUILDING"], iterations=2)
            bad = nomask[r0:r0 + TILE, c0:c0 + TILE] | (cls == LC["RAIL"])
            h = np.where(near_b | (cls == LC["WATER"]), 0, nd)
            # samostatné stromy: lokální vrcholy
            peaks = (h >= ndimage.maximum_filter(h, 5)) & (h > 3) & (h < 45) & ~forest & ~bad
            ys, xs = np.nonzero(peaks)
            hs = h[ys, xs]
            r = np.clip(hs * 0.22 + rng.normal(0, 0.4, hs.size), 1.2, 6.0)
            fl = np.zeros(hs.size, bool)
            # les: rozvolněná mřížka 7 m
            sp = 7.0
            gy, gx = np.meshgrid(np.arange(sp / 2, TILE, sp), np.arange(sp / 2, TILE, sp), indexing="ij")
            gy = np.clip(np.round(gy + rng.uniform(-2, 2, gy.shape)), 0, TILE - 1).astype(int).ravel()
            gx = np.clip(np.round(gx + rng.uniform(-2, 2, gx.shape)), 0, TILE - 1).astype(int).ravel()
            h3 = ndimage.maximum_filter(h, 3)
            ok = forest[gy, gx] & (h3[gy, gx] > 4) & (h3[gy, gx] < 45) & ~bad[gy, gx]
            gy, gx = gy[ok], gx[ok]
            ys = np.concatenate([ys, gy])
            xs = np.concatenate([xs, gx])
            hs = np.concatenate([hs, h3[gy, gx]])
            r = np.concatenate([r, sp * 0.68 * rng.uniform(0.85, 1.15, gy.size)])
            fl = np.concatenate([fl, np.ones(gy.size, bool)])
            # koruny z ortofota, kde DMP strom nevidí (např. park u nemocnice): středy korun po ~6 m
            if TREE_HINT is not None:
                hint = TREE_HINT[r0:r0 + TILE, c0:c0 + TILE] & (nd < 2) & ~forest & ~bad & ~near_b
                if hint.any():
                    dist = ndimage.distance_transform_edt(hint)
                    pk = (dist >= ndimage.maximum_filter(dist, 7)) & (dist >= 1.5)
                    oy, ox = np.nonzero(pk)
                    keep = rng.random(oy.size) < 0.8
                    oy, ox = oy[keep], ox[keep]
                    oh = rng.uniform(8, 15, oy.size)
                    ys = np.concatenate([ys, oy])
                    xs = np.concatenate([xs, ox])
                    hs = np.concatenate([hs, oh])
                    r = np.concatenate([r, np.clip(dist[oy, ox] * 1.1 + 1.0, 2.2, 5.0)])
                    fl = np.concatenate([fl, np.zeros(oy.size, bool)])
            c = cls[ys, xs]
            pc = np.where(c == LC["FOREST_CONIF"], 0.9, np.where(c == LC["FOREST_MIXED"], 0.45, 0.04))
            con = rng.random(hs.size) < pc
            r = np.where(con, np.minimum(r * 0.72, hs * 0.22 + 0.6), r)
            allt.append(np.stack([c0 + xs, r0 + ys, hs, r, con + 2 * fl], axis=1).astype(np.float32))
    t = np.concatenate(allt)
    ncx = W // CHUNK
    key = (t[:, 1] // CHUNK).astype(int) * ncx + (t[:, 0] // CHUNK).astype(int)
    order = np.argsort(key, kind="stable")
    t, key = t[order], key[order]
    rec = np.zeros(len(t), dtype=[("x", "<u2"), ("z", "<u2"), ("h", "u1"), ("r", "u1"), ("k", "u1"), ("p", "u1")])
    rec["x"] = np.round(t[:, 0] / 0.2)
    rec["z"] = np.round(t[:, 1] / 0.2)
    rec["h"] = np.clip(np.round(t[:, 2] * 5), 0, 255)
    rec["r"] = np.clip(np.round(t[:, 3] * 10), 0, 255)
    rec["k"] = t[:, 4]
    (OUT / "trees.bin").write_bytes(rec.tobytes())
    starts = np.searchsorted(key, np.arange(ncx * (H // CHUNK) + 1)).tolist()
    log(f"  {len(t)} stromů ({int((t[:, 4] >= 2).sum())} v lesích)")
    return starts


# ---------------------------------------------------------------- rastry
def write_tiles(cv):
    for j in range(NY):
        for i in range(NX):
            sl = (slice(j * TILE, (j + 1) * TILE), slice(i * TILE, (i + 1) * TILE))
            Image.fromarray(np.stack([cv.R[sl], cv.G[sl], cv.B[sl], np.full((TILE, TILE), 255, np.uint8)], 2),
                            "RGBA").save(OUT / "t" / f"{i}_{j}.png", optimize=True)


def write_far(cv, roads, dmr4, ndsm, hmin):
    log("Pohled zdálky – barevná mapa a výšky s korunami")
    lut = np.zeros((256, 3), np.float32)
    for k, c in FAR_COL.items():
        lut[k] = c
    k = FAR_PX
    far = np.zeros((H // k, W // k, 3), np.uint8)
    for j in range(NY):
        sl = slice(j * TILE, (j + 1) * TILE)
        R, G = cv.R[sl], cv.G[sl]
        col = lut[R]
        ar = R == LC["ARABLE"]
        st = np.minimum(G >> 6, 2)
        for s in range(3):
            col[ar & (st == s)] = FIELD_COL[s]
        far[j * TILE // k:(j + 1) * TILE // k] = col.reshape(TILE // k, k, W // k, k, 3).mean(axis=(1, 3))
    img = Image.fromarray(far)
    d = ImageDraw.Draw(img)
    for r in roads:
        w, c = ROAD[r["t"]]
        d.line([((x + W / 2) / k, (z + H / 2) / k) for x, z in r["p"]], fill=c, width=max(1, round(w / k)))
    img.save(OUT / "far.png", optimize=True)

    s = FAR_STEP
    fh = dmr4[::s // T_STEP, ::s // T_STEP].copy()
    nd = ndsm[:H, :W].astype(np.float32).reshape(H // s, s, W // s, s).mean(axis=(1, 3))
    fr = np.isin(cv.R, FOREST).reshape(H // s, s, W // s, s).mean(axis=(1, 3)) > 0.5
    canopy = np.pad(np.where(fr, nd * 0.9, 0), ((0, 1), (0, 1)), mode="edge")
    fh = fh + canopy
    (OUT / "far_h.bin").write_bytes(np.round((fh - hmin) * 100).astype("<u2").tobytes())
    return fh.shape


# ---------------------------------------------------------------- main
def main():
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    for old in ("terrain.bin", "landcover.png", "ortho.jpg"):
        (OUT / old).unlink(missing_ok=True)
    log(f"Území {W} × {H} m ({NX} × {NY} dlaždic), střed S-JTSK {CX:.0f}, {CY:.0f}")
    dmr4, ndsm = build_heights()
    hmin = float(dmr4.min())
    write_terrain(dmr4, hmin)
    load_ortho()
    cv = build_landcover()
    build_buildings(cv, dmr4, ndsm, hmin)
    global ORTHO
    ORTHO = None
    roads, bridges, power = build_vectors()
    build_fences(cv)
    starts = build_trees(cv, ndsm, no_tree_mask(roads, bridges, power))
    write_tiles(cv)
    far_shape = write_far(cv, roads, dmr4, ndsm, hmin)

    places = {k: [round(v, 1) for v in loc(*to_jtsk.transform(*p))] for k, p in PLACES.items()}
    meta = dict(
        name="Stod", width=W, height=H, tile=TILE, nx=NX, ny=NY, t_step=T_STEP,
        far=dict(step=FAR_STEP, w=far_shape[1], h=far_shape[0], px=FAR_PX),
        hmin=round(hmin, 2), hmax=round(float(dmr4.max()), 2), chunk=CHUNK, tree_chunks=starts,
        places=places, boundary=[lpts(r) for r in RINGS],
        sources=["ČÚZK DMR 5G", "ČÚZK DMP 1G", "ČÚZK ZABAGED", "ČÚZK RÚIAN", "eAGRI LPIS",
                 "© přispěvatelé OpenStreetMap (ODbL)"],
        built=time.strftime("%Y-%m-%d"),
    )
    (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")))
    # opravy po sestavení: budovy ve svahu, typy komunikací podle skutečnosti
    import fix_data
    fix_data.fix_roads()
    fix_data.flatten_roads()
    fix_data.fit_buildings(fix_data.terrain())
    fix_data.fix_lamps()
    log(f"hotovo za {time.time() - t0:.0f} s →", OUT)


if __name__ == "__main__":
    main()
