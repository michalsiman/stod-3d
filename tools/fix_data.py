#!/usr/bin/env python3
"""
Opravy dat po build_data.py (spouštět po každém přegenerování; opakované spuštění nic nezmění).

1. Budovy ve svahu: základna = nejnižší místo terénu pod půdorysem tak, jak ho vykresluje web (síť 8 m
   z web/data/t/*.bin), okap nad nejvyšším místem terénu – jinak se dům na kopci „zanoří“ a ze svahu
   kouká jen střecha. Původní hodnoty zůstávají v "h0" (base, eave, ridge).
2. Úpravy typů komunikací podle skutečnosti (ZABAGED je má jinak): úsek se najde podle polohy středu.

Spuštění:  python3 tools/fix_data.py
"""
import json
import math
from array import array
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "web" / "data"

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
]

# úseky bez aut (jen pěší a kola): (x, z středu úseku, důvod) → "nc": 1, doprava je vynechá
NO_CARS = [
    (-170.0, -737.0, "Stod, ulička u kostela sv. Máří Magdalény – jen pro pěší a kola"),
    (-229.5, -1232.0, "Stod, chodníček od kruhového objezdu k parkovišti u Stříbrské"),
    (169.0, -1675.0, "Stod, Háj umučených – příjezd, zákaz vjezdu (pietní místo)"),
    (207.0, -1700.0, "Stod, Háj umučených – cesta hájem, zákaz vjezdu (pietní místo)"),
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
    path.write_text(json.dumps(R, separators=(",", ":")))
    print(f"komunikace: {len(ROAD_TYPES)} úprav typu, {len(NO_CARS)} bez aut")


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
    fit_buildings(terrain())
    fix_roads()
    fix_lamps()
