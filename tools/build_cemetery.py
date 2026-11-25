#!/usr/bin/env python3
"""Hřbitovy z OSM (landuse=cemetery, amenity=grave_yard) → web/data/cemetery.json: [{p, r}] (p = obrys, r = náboženství)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_data as B  # noqa: E402
import build_osm_extra as X  # noqa: E402
import build_poi as P  # noqa: E402


def main():
    bb = f"({P.S},{P.Wl},{P.N},{P.E})"
    els = X.overpass("stod/osm_cemetery.json",
                     f"[out:json][timeout:60];(way[landuse=cemetery]{bb};way[amenity=grave_yard]{bb};);out geom tags;")
    out = []
    for e in els:
        if e["type"] != "way" or "geometry" not in e:
            continue
        p = [[round(c, 1) for c in B.loc(*B.to_jtsk.transform(q["lon"], q["lat"]))] for q in e["geometry"]]
        out.append({"p": p, "r": e.get("tags", {}).get("religion", "")})
    (B.OUT / "cemetery.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"hřbitovy: {len(out)}")


if __name__ == "__main__":
    main()
