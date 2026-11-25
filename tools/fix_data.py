#!/usr/bin/env python3
"""
Opravy dat po build_data.py (spouštět po každém přegenerování; opakované spuštění nic nezmění).

1. Budovy ve svahu: základna = nejnižší místo terénu pod půdorysem tak, jak ho vykresluje web (síť 8 m
   z web/data/t/*.bin), okap nad nejvyšším místem terénu – jinak se dům na kopci „zanoří“ a ze svahu
   kouká jen střecha. Původní hodnoty zůstávají v "h0" (base, eave, ridge).
2. Úpravy typů komunikací podle skutečnosti (ZABAGED je má jinak): úsek se najde podle polohy středu.
3. Terén pod silnicemi (asfalt, panely): napříč vodorovně, podél vyhlazeně (násypy / zářezy), aby se vozovka
   ve svahu nelámala uprostřed. Původní výšky jsou v cache/t_orig (počítá se vždy z nich).

Spuštění:  python3 tools/fix_data.py
"""
import json
import math
from array import array
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "web" / "data"
ORIG = Path(__file__).resolve().parent.parent / "cache" / "t_orig"

# (x, z středu úseku, nový typ, důvod) – typy viz roads.js (2 ulice, 3 asfaltová cesta, 7 pěšina)
ROAD_TYPES = [
    (66.8, -922.2, 7, "Stod, lávka přes náhon u Mlýnské – jen pro pěší"),
    (-878.8, -802.9, 7, "zahrada nemocnice – cesta pro pěší"),
    (-942.1, -777.4, 7, "zahrada nemocnice – cesta pro pěší"),
    (-995.1, -768.6, 7, "zahrada nemocnice – cesta pro pěší"),
    (2601.3, -2319.8, 3, "Chotěšov, úzká ulička u kláštera"),
    (2590.9, -2270.1, 3, "Chotěšov, úzká ulička u kláštera"),
    (2707.6, -2377.0, 3, "Chotěšov, úzká ulička"),
    (2588.2, -2235.9, 3, "Chotěšov, úzká ulička u kláštera"),
    (2562.6, -2345.5, 3, "Chotěšov, úzká ulička"),
    (-761.0, -1153.0, 3, "Stod, cesta parkem pod nádražím (u Tyršovy) – jen pro pěší a kola"),
]

# úseky bez aut (jen pěší a kola): (x, z středu úseku, důvod) → "nc": 1, doprava je vynechá
NO_CARS = [
    (-170.0, -737.0, "Stod, ulička u kostela sv. Máří Magdalény – jen pro pěší a kola"),
    (-229.5, -1232.0, "Stod, chodníček od kruhového objezdu k parkovišti u Stříbrské"),
    (169.0, -1675.0, "Stod, Háj umučených – příjezd, zákaz vjezdu (pietní místo)"),
    (207.0, -1700.0, "Stod, Háj umučených – cesta hájem, zákaz vjezdu (pietní místo)"),
    (-765.0, -1156.0, "Stod, cesta parkem pod nádražím – auta tu nejezdí"),
]

def terrain():
    meta = json.loads((DATA / "meta.json").read_text())
    T, step = meta["tile"], meta["t_step"]
    N = T // step + 1
    W, H = meta["width"], meta["height"]
    tiles = {}

    def tile(i, j):
        if (i, j) not in tiles:
            a = array("H")
            a.frombytes((DATA / "t" / f"{i}_{j}.bin").read_bytes())
            tiles[(i, j)] = a
        return tiles[(i, j)]

    S, n = step * 2, T // (step * 2) + 1       # world.js: NEAR_STRIDE = 2

    def height(x, z):
        i = min(max(int((x + W / 2) // T), 0), meta["nx"] - 1)
        j = min(max(int((z + H / 2) // T), 0), meta["ny"] - 1)
        h = tile(i, j)
        x0, z0 = -W / 2 + i * T, -H / 2 + j * T
        c = min(max((x - x0) / S, 0), n - 1.001)
        r = min(max((z - z0) / S, 0), n - 1.001)
        c0, r0 = int(c), int(r)
        fc, fr = c - c0, r - r0
        at = lambda rr, cc: h[rr * 2 * N + cc * 2]  # noqa: E731
        return ((at(r0, c0) * (1 - fc) + at(r0, c0 + 1) * fc) * (1 - fr)
                + (at(r0 + 1, c0) * (1 - fc) + at(r0 + 1, c0 + 1) * fc) * fr) / 100
    return height


FLAT_TYPES = (0, 1, 2, 3, 4)   # silnice, ulice, asfaltové a panelové cesty
WIDTH = [8.5, 6.5, 5.0, 3.5, 3.2]   # roads.js
FLAT_IN, FLAT_OUT = 4.0, 12.0  # [m] od okraje vozovky: plně zarovnáno / plynulý přechod do terénu
SMOOTH = 16.0                  # [m] vyhlazení podélného profilu (zůstane mírné houpání, ne hrboly)
EXTRA_BRIDGES = [              # landmarks.js EXTRA_BRIDGES
    [[67.2, -989.0], [60.1, -999.1], [53.2, -1007.7], [48.0, -1014.0]],
    [[-490.5, -724.9], [-514, -739.5], [-537.7, -754.2]],
    [[60.5, -917.8], [64, -920], [67, -922], [69, -924], [73.5, -927]],
]


def _seg_dist(px, pz, ax, az, bx, bz):
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz or 1e-9
    t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / L2))
    return math.hypot(px - (ax + dx * t), pz - (az + dz * t)), t


def flatten_roads():
    """Terén pod silnicemi napříč do roviny. Pracuje se sítí 8 m, kterou web vykresluje (world.js)."""
    import hashlib
    import shutil
    meta = json.loads((DATA / "meta.json").read_text())
    T, step = meta["tile"], meta["t_step"]
    N, S = T // step + 1, step * 2
    W, H = meta["width"], meta["height"]
    ORIG.mkdir(parents=True, exist_ok=True)
    stamp = ORIG / "flattened.json"
    done = json.loads(stamp.read_text()) if stamp.exists() else {}
    tiles = {}
    for f in sorted((DATA / "t").glob("*.bin")):
        cur = f.read_bytes()
        o = ORIG / f.name
        # nově vygenerovaná dlaždice (build_data) → to jsou nové původní výšky
        if not o.exists() or done.get(f.name) != hashlib.md5(cur).hexdigest():
            shutil.copyfile(f, o)
        a = array("H")
        a.frombytes(o.read_bytes())
        i, j = map(int, f.stem.split("_"))
        tiles[(i, j)] = a

    def node_h(gc, gr):                       # uzel sítě 8 m (globální index)
        n8 = T // S
        i, j = min(gc // n8, meta["nx"] - 1), min(gr // n8, meta["ny"] - 1)
        c, r = gc - i * n8, gr - j * n8
        return tiles[(i, j)][r * 2 * N + c * 2] / 100

    def height(x, z):
        c = min(max((x + W / 2) / S, 0), W / S - 0.001)
        r = min(max((z + H / 2) / S, 0), H / S - 0.001)
        c0, r0 = int(c), int(r)
        fc, fr = c - c0, r - r0
        return ((node_h(c0, r0) * (1 - fc) + node_h(c0 + 1, r0) * fc) * (1 - fr)
                + (node_h(c0, r0 + 1) * (1 - fc) + node_h(c0 + 1, r0 + 1) * fc) * fr)

    bridges = json.loads((DATA / "bridges.json").read_text()) + EXTRA_BRIDGES
    bsegs = [(p[k], p[k + 1]) for p in bridges for k in range(len(p) - 1)]

    def near_bridge(x, z):
        return any(_seg_dist(x, z, a[0], a[1], b[0], b[1])[0] < 14 for a, b in bsegs
                   if abs(a[0] - x) < 120 and abs(a[1] - z) < 120)

    best = {}                                  # (gc, gr) → (váha, cílová výška, vzdálenost)
    roads = json.loads((DATA / "roads.json").read_text())
    for rd in roads:
        t = rd["t"]
        if t not in FLAT_TYPES:
            continue
        hw = WIDTH[t] / 2
        pts = []
        p = rd["p"]
        for k in range(len(p) - 1):
            (ax, az), (bx, bz) = p[k], p[k + 1]
            n = max(1, math.ceil(math.hypot(bx - ax, bz - az) / 4))
            pts += [(ax + (bx - ax) * q / n, az + (bz - az) * q / n) for q in range(n)]
        pts.append(tuple(p[-1]))
        if len(pts) < 2:
            continue
        raw = [height(x, z) for x, z in pts]
        skip = [near_bridge(x, z) for x, z in pts]
        # podélné vyhlazení (klouzavý průměr ±SMOOTH po 4 m)
        k = int(SMOOTH / 4)
        prof = [sum(raw[max(0, q - k):q + k + 1]) / len(raw[max(0, q - k):q + k + 1]) for q in range(len(raw))]
        R = hw + FLAT_OUT
        for q in range(len(pts) - 1):
            if skip[q] or skip[q + 1]:
                continue
            (ax, az), (bx, bz) = pts[q], pts[q + 1]
            c0 = int((min(ax, bx) - R + W / 2) // S)
            c1 = int((max(ax, bx) + R + W / 2) // S) + 1
            r0 = int((min(az, bz) - R + H / 2) // S)
            r1 = int((max(az, bz) + R + H / 2) // S) + 1
            for gr in range(max(r0, 0), min(r1, H // S) + 1):
                z = -H / 2 + gr * S
                for gc in range(max(c0, 0), min(c1, W // S) + 1):
                    x = -W / 2 + gc * S
                    d, tt = _seg_dist(x, z, ax, az, bx, bz)
                    if d > R:
                        continue
                    e = d - hw - FLAT_IN
                    w = 1.0 if e <= 0 else 0.5 + 0.5 * math.cos(math.pi * e / (FLAT_OUT - FLAT_IN))
                    target = prof[q] + (prof[q + 1] - prof[q]) * tt
                    old = best.get((gc, gr))
                    if old is None or w > old[0] + 1e-6 or (abs(w - old[0]) < 1e-6 and d < old[2]):
                        best[(gc, gr)] = (w, target, d)

    n8 = T // S
    changed, maxd = 0, 0.0
    for (i, j), a in tiles.items():
        out = array("H", a)
        for r in range(n8 + 1):
            for c in range(n8 + 1):
                b = best.get((i * n8 + c, j * n8 + r))
                if not b:
                    continue
                w, target, _ = b
                idx = r * 2 * N + c * 2
                h = a[idx] / 100
                nh = h + w * (target - h)
                out[idx] = max(0, min(65535, round(nh * 100)))
                if abs(nh - h) > 0.05:
                    changed += 1
                    maxd = max(maxd, abs(nh - h))
        data = out.tobytes()
        (DATA / "t" / f"{i}_{j}.bin").write_bytes(data)
        done[f"{i}_{j}.bin"] = hashlib.md5(data).hexdigest()
    stamp.write_text(json.dumps(done))
    print(f"silnice: terén zarovnán v {changed} uzlech sítě 8 m (nejvíc o {maxd:.1f} m)")


def fit_buildings(height):
    path = DATA / "buildings.json"
    B = json.loads(path.read_text())
    changed = 0
    for b in B:
        base0, eave0, ridge0 = b.get("h0") or (b["base"], b["eave"], b["ridge"])
        r = b["rings"][0]
        pts = list(r) + [((a[0] + c[0]) / 2, (a[1] + c[1]) / 2) for a, c in zip(r, r[1:] + r[:1])]
        pts.append((sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r)))
        g = [height(x, z) for x, z in pts]
        gmin, gmax = min(g), max(g)
        base = min(base0, gmin - 0.05)
        top = max(base0 + eave0, gmax + max(0.85 * eave0, min(eave0, 2.0)))
        delta = top - (base0 + eave0)
        eave = top - base
        ridge = ridge0 + delta + (base0 - base)
        if abs(base - b["base"]) > 0.01 or abs(eave - b["eave"]) > 0.01:
            changed += 1
        b["h0"] = [base0, eave0, ridge0]
        b["base"], b["eave"], b["ridge"] = round(base, 2), round(eave, 2), round(ridge, 2)
    path.write_text(json.dumps(B, ensure_ascii=False, separators=(",", ":")))
    moved = sum(1 for b in B if abs(b["base"] - b["h0"][0]) > 0.05 or abs(b["eave"] - b["h0"][1]) > 0.05)
    print(f"budovy: {moved} z {len(B)} posazeno na terén / prodlouženo ve svahu ({changed} změněno teď)")


def fix_roads():
    path = DATA / "roads.json"
    R = json.loads(path.read_text())
    for x, z, t, why in ROAD_TYPES:
        best, bd = None, 6.0
        for r in R:
            if r["t"] > 7:
                continue
            p = r["p"]
            m = p[len(p) // 2]
            d = math.hypot(m[0] - x, m[1] - z)
            if d < bd:
                best, bd = r, d
        if best is None:
            print(f"  ! úsek nenalezen: {why} ({x}, {z})")
            continue
        best["t"] = t
    for x, z, why in NO_CARS:
        best, bd = None, 25.0
        for r in R:
            if r["t"] > 7:
                continue
            d = min(math.hypot(p[0] - x, p[1] - z) for p in r["p"])
            if d < bd:
                best, bd = r, d
        if best is None:
            print(f"  ! úsek nenalezen: {why} ({x}, {z})")
        else:
            best["nc"] = 1
    # cesty, které jsou cyklostezkou (OSM, bike.json): žádná motorová vozidla (ani traktory)
    bike = DATA / "bike.json"
    nbike = 0
    if bike.exists():
        segs = [(p[k], p[k + 1]) for p in json.loads(bike.read_text()).get("paths", []) for k in range(len(p) - 1)]
        grid = {}
        for a, c in segs:
            for gx in range(int(min(a[0], c[0]) // 50) - 1, int(max(a[0], c[0]) // 50) + 2):
                for gz in range(int(min(a[1], c[1]) // 50) - 1, int(max(a[1], c[1]) // 50) + 2):
                    grid.setdefault((gx, gz), []).append((a, c))

        def near(x, z):
            return any(_seg_dist(x, z, a[0], a[1], c[0], c[1])[0] < 4 for a, c in grid.get((int(x // 50), int(z // 50)), []))
        for r in R:
            if r["t"] < 3 or r["t"] > 7 or r.get("nc"):
                continue
            pts = r["p"]
            if len(pts) >= 2 and sum(near(x, z) for x, z in pts) >= 0.8 * len(pts):
                r["nc"] = 1
                nbike += 1
    path.write_text(json.dumps(R, separators=(",", ":")))
    print(f"komunikace: {len(ROAD_TYPES)} úprav typu, {len(NO_CARS)} bez aut, {nbike} cyklostezek bez aut")


def fix_lamps():
    """Lampy, které stojí na vozovce (nepřesná poloha v OSM), posunout na okraj – na chodník 0,7 m za
    hranu vozovky; rameno natočit nad silnici. Původní poloha zůstává v 4. a 5. prvku."""
    WIDTH = [8.5, 6.5, 5.0, 3.5]
    path = DATA / "lamps.json"
    L = json.loads(path.read_text())
    R = [r for r in json.loads((DATA / "roads.json").read_text()) if r["t"] <= 3]
    grid = {}
    for r in R:
        hw = WIDTH[r["t"]] / 2
        for a, b in zip(r["p"], r["p"][1:]):
            for cx in range(int(min(a[0], b[0]) // 20) - 1, int(max(a[0], b[0]) // 20) + 2):
                for cz in range(int(min(a[1], b[1]) // 20) - 1, int(max(a[1], b[1]) // 20) + 2):
                    grid.setdefault((cx, cz), []).append((a, b, hw))
    def clear(x, z):
        """Vzdálenost od nejbližší hrany vozovky (záporná = na vozovce) a bod na ose nejbližší silnice."""
        best = (1e9, x, z)
        for cx in (int(x // 20) - 1, int(x // 20), int(x // 20) + 1):
            for cz in (int(z // 20) - 1, int(z // 20), int(z // 20) + 1):
                for a, b, hw in grid.get((cx, cz), []):
                    dx, dz = b[0] - a[0], b[1] - a[1]
                    l2 = dx * dx + dz * dz or 1
                    t = max(0, min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2))
                    px, pz = a[0] + dx * t, a[1] + dz * t
                    d = math.hypot(x - px, z - pz) - hw
                    if d < best[0]:
                        best = (d, px, pz)
        return best

    moved = 0
    for lamp in L:
        x0, z0 = (lamp[3], lamp[4]) if len(lamp) >= 5 else (lamp[0], lamp[1])
        if clear(x0, z0)[0] >= 0.4:
            continue
        # nejbližší místo mimo všechny vozovky (aspoň 0,6 m od hrany), hledání po kružnicích
        spot = None
        for k in range(1, 61):
            r = k * 0.25
            for q in range(24):
                a = q / 24 * 2 * math.pi
                x, z = x0 + math.cos(a) * r, z0 + math.sin(a) * r
                if clear(x, z)[0] >= 0.6:
                    spot = (x, z)
                    break
            if spot:
                break
        if not spot:
            continue
        x, z = spot
        _, px, pz = clear(x, z)
        lamp[:3] = [round(x, 1), round(z, 1), round(math.atan2(pz - z, px - x), 3)]     # rameno k silnici
        if len(lamp) < 5:
            lamp += [x0, z0]
        moved += 1
    path.write_text(json.dumps(L, separators=(",", ":")))
    print(f"lampy: {moved} z {len(L)} posunuto z vozovky na okraj")


if __name__ == "__main__":
    fix_roads()
    flatten_roads()
    fit_buildings(terrain())
    fix_lamps()
