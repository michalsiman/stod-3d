#!/usr/bin/env python3
"""
Cyklostezky, cyklotrasy a parkoviště z OpenStreetMap.

  web/data/bike.json     {"paths": [[[x, z], …], …],   samostatné cyklostezky (highway=cycleway, cesty s bicycle=designated mimo silnice)
                          "routes": [[[x, z], …], …]}  trasy cyklotras (route=bicycle) – cyklisté jezdí hlavně po nich
  web/data/parking.json  [{"p": [[x, z], …], "busy": 0.4–0.9}, …]   povrchová parkoviště (amenity=parking)

Spuštění:  .venv/bin/python tools/build_osm_extra.py
"""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_data as B  # noqa: E402
import build_poi as P  # noqa: E402

def overpass(cache, q):
    for url in B.OVERPASS * 3:
        try:
            return json.loads(B.fetch(cache, url, data={"data": q}, retries=1))["elements"]
        except (RuntimeError, ValueError) as e:
            (B.CACHE / cache).unlink(missing_ok=True)
            print(f"  {url}: {e}")
    raise SystemExit("Overpass nedostupný")


def query():
    """Dva menší dotazy (velký dotaz s celými dálkovými trasami Overpass často nezvládne)."""
    bb = f"({P.S},{P.Wl},{P.N},{P.E})"
    ways = overpass("stod/osm_bike_ways.json", f"""[out:json][timeout:60];
(way[highway=cycleway]{bb};way[bicycle=designated]{bb};way[amenity=parking]{bb};);out tags geom;""")
    routes = overpass("stod/osm_bike_routes.json", f"""[out:json][timeout:120];
rel[route=bicycle]{bb}->.r;.r out tags;way(r.r){bb};out tags geom;""")
    for e in routes:
        if e["type"] == "way":
            e["route"] = True
    return ways + routes


def geom(g):
    pts = [[round(v, 1) for v in P.local(p["lon"], p["lat"])] for p in g if p]
    return pts if any(P.inside(*p) for p in pts) else None


def main():
    els = query()
    paths, routes, parking = [], [], []
    for e in els:
        t = e.get("tags", {})
        if e["type"] == "relation":
            print(f"  cyklotrasa {t.get('ref', '')} {t.get('name', '')}")
            continue
        if e.get("route"):
            g = geom(e.get("geometry", []))
            if g and len(g) >= 2:
                routes.append(g)
            continue
        if e["type"] != "way" or not e.get("geometry"):
            continue
        g = geom(e["geometry"])
        if not g or len(g) < 2:
            continue
        if t.get("amenity") == "parking":
            if t.get("parking") in ("underground", "multi-storey", "rooftop") or len(g) < 4:
                continue
            if math.dist(g[0], g[-1]) > 1:
                continue
            area = abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(g, g[1:]))) / 2
            if area < 60:
                continue
            busy = 0.85 if t.get("access") in ("customers", "private") else 0.6
            parking.append(dict(p=g, busy=busy, n=t.get("name", "")))
            continue
        hw = t.get("highway")
        # samostatné cyklostezky; cesty se smíšeným provozem (bicycle=designated) jen mimo silnice
        if hw == "cycleway" or (t.get("bicycle") == "designated" and hw in ("path", "footway", "track", "service")):
            paths.append(g)
    (B.OUT / "bike.json").write_text(json.dumps(dict(paths=paths, routes=routes), separators=(",", ":")))
    (B.OUT / "parking.json").write_text(json.dumps(parking, ensure_ascii=False, separators=(",", ":")))
    L = sum(math.dist(a, b) for p in paths for a, b in zip(p, p[1:]))
    print(f"{len(paths)} úseků cyklostezek ({L / 1000:.1f} km), {len(routes)} úseků cyklotras, {len(parking)} parkovišť")


if __name__ == "__main__":
    main()
