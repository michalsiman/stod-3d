#!/usr/bin/env python3
"""
Cedule s nápisy na domech: úřady, školy, nemocnice, pošty, hasiči, obchody, restaurace a větší firmy.

Zdroje:
  * web/data/poi.json – zajímavosti (rešerše webů, ZABAGED, OSM) a adresní místa RÚIAN
  * OpenStreetMap (ODbL) – obchody, restaurace, čerpací stanice, závody (souřadnice níže, „ll“)
  * rešerše webů firem a katalogů (firmy.cz, zivefirmy.cz, Česká pošta) – adresa → adresní místo RÚIAN

Výstup: web/data/signs.json  [{t: text, s: styl, x, z}]  (lokální souřadnice jako ostatní vrstvy)
Na kterou stěnu kterého domu cedule přijde, rozhoduje web (js/signs.js): dům pod bodem nebo nejbližší
do 30 m, stěna směrem k nejbližší silnici či ulici.

Spuštění (po build_data.py a build_poi.py):  python3 tools/build_signs.py
"""
import json
from pathlib import Path

from pyproj import Transformer

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "data"
CX, CY = -839168, -1080320           # střed území v S-JTSK (viz build_data.py, log „střed“)
to_jtsk = Transformer.from_crs(4326, 5514, always_xy=True)

# styly (barvy v js/signs.js): urad, zdravi, skola, posta, hasici, policie, kultura, nadrazi,
#                              obchod, jidlo, firma, benzin
SIGNS = [
    # ---- Stod – úřady a veřejné budovy
    ("MĚSTSKÝ ÚŘAD", "urad", {"at": [-222, -1070]}),
    ("STODSKÁ NEMOCNICE", "zdravi", {"at": [-941, -814]}),
    ("ČESKÁ POŠTA", "posta", {"at": [-315, -1307]}),
    ("ZÁKLADNÍ ŠKOLA", "skola", {"at": [-125, -1026]}),
    ("ZÁKLADNÍ UMĚLECKÁ ŠKOLA", "skola", {"at": [-447, -1150]}),
    ("STŘEDNÍ ODBORNÉ UČILIŠTĚ", "skola", {"at": [-102, -1367]}),
    ("KULTURNÍ DŮM", "kultura", {"at": [-778, -1216]}),
    ("DŮM DĚTÍ A MLÁDEŽE", "kultura", {"at": [-760, -1242]}),
    ("POLICIE", "policie", {"at": [-525, -1133]}),
    ("HASIČSKÁ ZBROJNICE", "hasici", {"at": [-298, -963]}),
    ("ZDRAVOTNÍ STŘEDISKO", "zdravi", {"at": [-620, -1076]}),
    ("LÉKÁRNA", "zdravi", {"at": [-401, -1138]}),
    ("ÚŘAD PRÁCE", "urad", {"at": [-614, -1239]}),
    ("STOD", "nadrazi", {"at": [-907, -1207]}),
    # ---- Stod – obchody, služby, restaurace (OSM)
    ("PENNY", "obchod", {"ll": [49.64277, 13.16745]}),
    ("COOP", "obchod", {"addr": "nám. ČSA 66, Stod", "ll": [49.63971, 13.16391]}),
    ("TETA drogerie", "obchod", {"ll": [49.64218, 13.16504]}),
    ("MOUNTFIELD", "obchod", {"ll": [49.64303, 13.16776]}),
    ("PEKAŘSTVÍ", "obchod", {"ll": [49.63852, 13.16515]}),
    ("MASO – UZENINY", "obchod", {"addr": "Nádražní 765, Stod", "ll": [49.63971, 13.16227]}),
    ("ŽELEZÁŘSTVÍ", "obchod", {"addr": "Plzeňská 574, Stod"}),
    ("KARPEM stavebniny", "firma", {"addr": "Stříbrská 44, Stod"}),
    ("KARPEM", "firma", {"addr": "Plzeňská 901, Stod"}),
    ("Restaurace U Matyáše", "jidlo", {"addr": "Domažlická 89, Stod", "ll": [49.63712, 13.16603]}),
    ("Restaurace Harlekýn", "jidlo", {"ll": [49.64019, 13.16455]}),
    ("Restaurace U Nádraží", "jidlo", {"ll": [49.64002, 13.15661]}),
    ("Hospůdka Na Zahrádce", "jidlo", {"ll": [49.63689, 13.16121]}),
    ("BENZINA", "benzin", {"ll": [49.64344, 13.1675]}),
    ("AVIA", "benzin", {"ll": [49.63322, 13.16147]}),
    # ---- Stod – firmy
    ("MURRELEKTRONIK", "firma", {"ll": [49.64468, 13.16353]}),
    ("WIENERBERGER", "firma", {"addr": "Stříbrská 369, Stod"}),
    # ---- Chotěšov
    ("OBECNÍ ÚŘAD CHOTĚŠOV", "urad", {"at": [2440, -2349]}),
    ("ČESKÁ POŠTA", "posta", {"at": [2551, -2554]}),
    ("ZÁKLADNÍ ŠKOLA", "skola", {"at": [2197, -2045]}),
    ("MATEŘSKÁ ŠKOLA", "skola", {"at": [3140, -2205]}),
    ("NÁRODNÍ DŮM", "kultura", {"at": [2878, -2544]}),
    ("HASIČSKÁ ZBROJNICE", "hasici", {"at": [2612, -2147]}),
    ("KLÁŠTER CHOTĚŠOV", "kultura", {"ll": [49.65312, 13.19857]}),
    ("CHOTĚŠOV U STODA", "nadrazi", {"at": [2462, -2637]}),
    ("JIP", "obchod", {"addr": "nám. 1. máje 565, Chotěšov", "ll": [49.65393, 13.20246]}),
    ("COOP", "obchod", {"addr": "Plzeňská 432, Chotěšov", "ll": [49.65682, 13.20019]}),
    ("PEKAŘSTVÍ", "obchod", {"addr": "Plzeňská 213, Chotěšov", "ll": [49.65659, 13.19976]}),
    ("PEKAŘSTVÍ ŠEFL", "obchod", {"addr": "Plzeňská 214, Chotěšov", "ll": [49.65561, 13.19959]}),
    ("Restaurace Pod Klášterem", "jidlo", {"ll": [49.65377, 13.20148]}),
    ("Hospůdka ve dvorku", "jidlo", {"addr": "Plzeňská 631, Chotěšov", "ll": [49.65624, 13.20029]}),
    ("Restaurace Na Rohu", "jidlo", {"ll": [49.65203, 13.20468]}),
    # ---- okolní obce
    ("OBECNÍ ÚŘAD HRADEC", "urad", {"at": [-3328, -1107]}),
    ("ČESKÁ POŠTA", "posta", {"at": [-3338, -1145]}),
    ("PENZION HRADEC", "jidlo", {"ll": [49.63682, 13.12322]}),
    ("COOP", "obchod", {"ll": [49.63594, 13.12312]}),
    ("Hospoda Myslivna", "jidlo", {"ll": [49.6347, 13.11289]}),
    ("HASIČSKÁ ZBROJNICE", "hasici", {"at": [-3449, -958]}),
    ("OBECNÍ ÚŘAD STŘELICE", "urad", {"at": [-2479, -454]}),
    ("OBECNÍ ÚŘAD VES TOUŠKOV", "urad", {"at": [-3065, -4020]}),
    ("HASIČSKÁ ZBROJNICE", "hasici", {"at": [-3078, -4014]}),
    ("Hostinec U Kostela", "jidlo", {"ll": [49.66219, 13.11741]}),
    ("OBECNÍ ÚŘAD LÍŠINA", "urad", {"at": [-776, 2937]}),
    ("HASIČSKÁ ZBROJNICE", "hasici", {"at": [-780, 2986]}),
]


def main():
    poi = json.loads((OUT / "poi.json").read_text())
    addr = {a[0]: (a[1], a[2]) for a in poi["addresses"]}
    out, missing = [], []
    for text, style, where in SIGNS:
        xz = None
        if "addr" in where:
            xz = addr.get(where["addr"])
            if xz is None:
                missing.append(where["addr"])
        if xz is None and "ll" in where:
            e, n = to_jtsk.transform(where["ll"][1], where["ll"][0])
            xz = (e - CX, CY - n)
        if xz is None and "at" in where:
            xz = tuple(where["at"])
        if xz is None:
            continue
        out.append(dict(t=text, s=style, x=round(xz[0], 1), z=round(xz[1], 1)))
    (OUT / "signs.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(out)} cedulí → web/data/signs.json")
    if missing:
        print("adresy nenalezené v RÚIAN (použita poloha z OSM):", ", ".join(missing))


if __name__ == "__main__":
    main()
