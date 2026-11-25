#!/usr/bin/env python3
"""
Zastávky autobusů a vlaků (web/data/stops.json) z OpenStreetMap.

* autobusové zastávky: highway=bus_stop / public_transport=platform (bez vlaků); stejný název do 80 m
  = jedna zastávka (obvykle dvě nástupiště, každé na jedné straně silnice)
* obce, kde v OSM zastávka chybí: odhad – nejbližší místo na silnici I.–III. třídy (nebo ulici)
  u středu obce, dvojice nástupišť proti sobě (označeno "est": 1)
* vlakové zastávky a stanice: railway=halt/station + nástupiště (railway=platform) do 250 m

Spuštění:  .venv/bin/python tools/build_transit.py      (potřebuje web/data/roads.json a poi.json)
"""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_data as B  # noqa: E402
import build_poi as P  # noqa: E402

OUT = B.OUT / "stops.json"


def query():
    bb = f"({P.S},{P.Wl},{P.N},{P.E})"
    q = f"""[out:json][timeout:180];
(
 node[highway=bus_stop]{bb};
 node[public_transport]{bb};
 node[amenity=bus_station]{bb};
 node[railway~"^(station|halt)$"]{bb};
 way[railway=platform]{bb};
);
out tags geom;
"""
    for url in B.OVERPASS * 2:
        try:
            return json.loads(B.fetch("stod/osm_stops.json", url, data={"data": q}, retries=2))["elements"]
        except (RuntimeError, ValueError) as e:
            (B.CACHE / "stod/osm_stops.json").unlink(missing_ok=True)
            print(f"  {url}: {e}")
    raise SystemExit("Overpass nedostupný")


def nearest_on(roads, x, z, types):
    best = None
    for r in roads:
        if r["t"] not in types:
            continue
        p = r["p"]
        for (ax, az), (bx, bz) in zip(p, p[1:]):
            dx, dz = bx - ax, bz - az
            l2 = dx * dx + dz * dz or 1
            t = max(0, min(1, ((x - ax) * dx + (z - az) * dz) / l2))
            px, pz = ax + dx * t, az + dz * t
            d = math.hypot(x - px, z - pz)
            if best is None or d < best[0]:
                L = math.sqrt(l2)
                best = (d, px, pz, dx / L, dz / L, r["t"])
    return best


def main():
    els = query()
    roads = json.loads((B.OUT / "roads.json").read_text())
    places = json.loads((B.OUT / "poi.json").read_text())["places"]
    WIDTH = [8.5, 6.5, 5.0, 3.5]

    bus, rail, platforms = [], [], []
    for e in els:
        t = e.get("tags", {})
        if e["type"] == "way":
            g = [P.local(p["lon"], p["lat"]) for p in e.get("geometry", [])]
            if len(g) >= 2 and any(P.inside(*p) for p in g):
                platforms.append([[round(v, 1) for v in p] for p in g])
            continue
        x, z = P.local(e["lon"], e["lat"])
        if not P.inside(x, z):
            continue
        name = (t.get("name") or "").replace(",,", ",").strip()
        if t.get("railway") in ("station", "halt"):
            rail.append(dict(n=name, x=round(x, 1), z=round(z, 1)))
            continue
        is_bus = (t.get("highway") == "bus_stop" or t.get("amenity") == "bus_station"
                  or (t.get("public_transport") == "platform" and t.get("train") != "yes"))
        if not is_bus or not name:
            continue
        bus.append(dict(n=name, x=round(x, 1), z=round(z, 1), sh=int(t.get("shelter") == "yes"),
                        be=int(t.get("bench") == "yes"), pos=t.get("public_transport") == "stop_position"))

    # stop_position jen tam, kde u něj není nástupiště se stejným jménem
    bus = [b for b in bus if not b["pos"] or not any(
        o is not b and not o["pos"] and o["n"] == b["n"] and math.dist((o["x"], o["z"]), (b["x"], b["z"])) < 40 for o in bus)]
    # duplicitní body (stejné jméno do 6 m)
    out = []
    for b in bus:
        if any(o["n"] == b["n"] and math.dist((o["x"], o["z"]), (b["x"], b["z"])) < 6 for o in out):
            continue
        out.append(b)
    bus = out

    # obce bez zastávky → odhad
    for p in places:
        if p["rank"] < 2:
            continue
        if any(math.dist((b["x"], b["z"]), (p["x"], p["z"])) < 450 for b in bus):
            continue
        nr = nearest_on(roads, p["x"], p["z"], {0, 1}) or nearest_on(roads, p["x"], p["z"], {2})
        if nr[0] > 300:
            nr = nearest_on(roads, p["x"], p["z"], {2, 3})
        d, px, pz, dx, dz, t = nr
        off = WIDTH[t] / 2 + 1.0
        for s in (1, -1):
            bus.append(dict(n=p["name"], x=round(px - dz * off * s, 1), z=round(pz + dx * off * s, 1),
                            sh=int(s == 1), be=int(s == 1), pos=False, est=1))
        print(f"  odhad zastávky: {p['name']} ({d:.0f} m od středu)")

    for b in bus:
        b.pop("pos", None)
    # nástupiště k vlakovým zastávkám
    for r in rail:
        r["pl"] = [pl for pl in platforms if min(math.dist(q, (r["x"], r["z"])) for q in pl) < 250]
    OUT.write_text(json.dumps(dict(bus=bus, rail=rail), ensure_ascii=False, separators=(",", ":")))
    print(f"{len(bus)} autobusových nástupišť, {len(rail)} vlakových zastávek → {OUT}")
    for b in sorted(bus, key=lambda b: b["n"]):
        print(f"   {b['n']:<34} {b['x']:8.1f} {b['z']:8.1f} {'přístřešek' if b['sh'] else ''} {'odhad' if b.get('est') else ''}")
    for r in rail:
        print(f"   vlak {r['n']:<29} {r['x']:8.1f} {r['z']:8.1f}  nástupišť {len(r['pl'])}")


if __name__ == "__main__":
    main()
