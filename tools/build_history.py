#!/usr/bin/env python3
"""
Historické podklady pro přepínač „Historie“ (web/data/hist/<rok>/<i>_<j>.jpg, dlaždice 1024 m jako terén):

* 1953 – historická ortofotomapa (letecké snímky z 50. let), CENIA / GEODIS Brno, CC BY 4.0
         https://gis.cenia.cz/mapcache/ortofotomapa_historicka/wms
* 1880 – III. vojenské mapování (speciální mapy 1:75 000, 1876–1880), CENIA / Laboratoř geoinformatiky UJEP
         https://gis.cenia.cz/mapcache/III_vojenske_mapovani/wms

Spuštění:  .venv/bin/python tools/build_history.py
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_data as B  # noqa: E402

LAYERS = {
    "1953": ("https://gis.cenia.cz/mapcache/ortofotomapa_historicka/wms", "orto", 1024),
    "1880": ("https://gis.cenia.cz/mapcache/III_vojenske_mapovani/wms", "III_vojenske_mapovani", 192),
}


def main():
    for year, (url, layer, px) in LAYERS.items():
        out = B.OUT / "hist" / year
        out.mkdir(parents=True, exist_ok=True)
        for j in range(B.NY):
            for i in range(B.NX):
                e0, n1 = B.X0 + i * B.TILE, B.Y1 - j * B.TILE
                raw = B.fetch(f"stod/hist/{year}_{i}_{j}.jpg", url, params=dict(
                    service="WMS", version="1.1.1", request="GetMap", layers=layer, styles="", srs="EPSG:5514",
                    bbox=f"{e0},{n1 - B.TILE},{e0 + B.TILE},{n1}", width=px, height=px, format="image/jpeg"))
                if raw[:3] != b"\xff\xd8\xff":
                    raise SystemExit(f"{year} {i}_{j}: služba nevrátila obrázek")
                (out / f"{i}_{j}.jpg").write_bytes(raw)
                time.sleep(0.15)
        print(f"{year}: {B.NX * B.NY} dlaždic → {out}")
        if px > 512:
            small(out, B.OUT / "hist" / f"{year}s", 512)


def small(src, dst, px):
    """Zmenšené dlaždice pro telefony (méně paměti grafiky; 56 × 1024² se do mobilu nevejde)."""
    from PIL import Image
    dst.mkdir(parents=True, exist_ok=True)
    for f in sorted(src.glob("*.jpg")):
        Image.open(f).convert("RGB").resize((px, px), Image.LANCZOS).save(dst / f.name, quality=82)
    print(f"  {dst.name}: zmenšeno na {px} px")


if __name__ == "__main__":
    main()
