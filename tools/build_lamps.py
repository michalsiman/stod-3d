#!/usr/bin/env python3
"""
3D Stodsko – rozmístění pouličních lamp → web/data/lamps.json

Lampy po ~32 m podél ulic a silnic, ale jen tam, kde je do 45 m nějaká budova (zástavba).
Lampa stojí 4–5 m od osy na střídající se straně, rameno míří do silnice.
Formát: [[x, z, úhel_ramene], …] v lokálních souřadnicích webu.

Spuštění (po build_data.py):  python3 tools/build_lamps.py
"""
import json
import math
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "web" / "data"
STEP = 32.0
NEAR = 45.0
TYPES = {0: 5.5, 1: 4.6, 2: 3.8}          # typ silnice → odstup od osy [m]


def main():
    roads = json.loads((DATA / "roads.json").read_text())
    blds = json.loads((DATA / "buildings.json").read_text())
    # mřížka středů budov (kromě kůlen)
    cell = 50.0
    grid = {}
    for b in blds:
        if b.get("k") == "shed":
            continue
        r = b["rings"][0]
        cx = sum(p[0] for p in r) / len(r)
        cz = sum(p[1] for p in r) / len(r)
        grid.setdefault((int(cx // cell), int(cz // cell)), []).append((cx, cz))

    def near_building(x, z):
        gx, gz = int(x // cell), int(z // cell)
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for bx, bz in grid.get((gx + dx, gz + dz), ()):
                    if (bx - x) ** 2 + (bz - z) ** 2 < NEAR ** 2:
                        return True
        return False

    lamps, side = [], 1
    for r in roads:
        if r["t"] not in TYPES:
            continue
        off = TYPES[r["t"]]
        pts = r["p"]
        carry = STEP / 2
        for (x1, z1), (x2, z2) in zip(pts, pts[1:]):
            L = math.hypot(x2 - x1, z2 - z1)
            if L < 0.1:
                continue
            ux, uz = (x2 - x1) / L, (z2 - z1) / L
            s = carry
            while s < L:
                x, z = x1 + ux * s, z1 + uz * s
                if near_building(x, z):
                    nx, nz = -uz * side, ux * side          # kolmo na silnici
                    lx, lz = x + nx * off, z + nz * off
                    # úhel ramene: od lampy směrem k ose silnice
                    lamps.append([round(lx, 1), round(lz, 1), round(math.atan2(-nz, -nx), 2)])
                    side = -side
                s += STEP
            carry = s - L
    # odstranit lampy příliš blízko sebe (křižovatky, souběžné úseky)
    out, cells = [], {}
    for l in lamps:
        k = (int(l[0] // 12), int(l[1] // 12))
        if any(math.hypot(l[0] - o[0], l[1] - o[1]) < 14
               for dx in (-1, 0, 1) for dz in (-1, 0, 1) for o in cells.get((k[0] + dx, k[1] + dz), [])):
            continue
        cells.setdefault(k, []).append(l)
        out.append(l)
    (DATA / "lamps.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"· {len(out)} pouličních lamp → {DATA / 'lamps.json'}")


if __name__ == "__main__":
    main()
