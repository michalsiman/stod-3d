#!/usr/bin/env python3
"""
Stod 3D – zajímavosti, názvy obcí a ulic → web/data/poi.json

Zdroje:
  * Wikidata (SPARQL)        – památky, kříže, kaple, pomníky, mosty, jezy, stromy, události…
  * Wikipedie (cs, REST)     – krátký úvod k položkám, které mají článek (CC BY-SA, s odkazem)
  * ZABAGED (ČÚZK)           – kříže, pomníky, věže, významné stromy, definiční body částí obcí
  * RÚIAN (ČÚZK)             – ulice (geometrie + názvy)
  * OpenStreetMap (Overpass) – doplněk (pokud je server dostupný)
  * tools/poi_web.json       – ruční rešerše webů (město Stod, okolní obce, kudyznudy.cz, …)

Spuštění:  python3 tools/build_poi.py [--refresh]
"""
import json
import math
import sys
import time
import urllib.parse
from pathlib import Path

sys.argv = [a for a in sys.argv]
sys.path.insert(0, str(Path(__file__).parent))
import build_data as B  # noqa: E402  – sdílí území, cache a fetch

OUT = B.OUT / "poi.json"
WEB = Path(__file__).parent / "poi_web.json"
to_wgs, to_jtsk = B.to_wgs, B.to_jtsk


def bbox_wgs():
    c = [to_wgs.transform(x, y) for x in (B.X0, B.X1) for y in (B.Y0, B.Y1)]
    return min(p[1] for p in c), min(p[0] for p in c), max(p[1] for p in c), max(p[0] for p in c)


S, Wl, N, E = bbox_wgs()


def local(lon, lat):
    x, y = to_jtsk.transform(lon, lat)
    return B.loc(x, y)


def inside(x, z):
    return abs(x) <= B.W / 2 and abs(z) <= B.H / 2


# ---------------------------------------------------------------- kategorie
CATS = {
    "cirkev": "Kostely, kaple a kříže",
    "smirci": "Smírčí kříže",
    "pamatnik": "Pomníky a památníky",
    "stavba": "Stavby a technické památky",
    "priroda": "Příroda",
    "historie": "Historie a události",
    "obec": "Obce a jejich historie",
    "turistika": "Turistika",
    "sluzby": "Veřejné služby",
}


def category(types, label):
    t = " ".join(types).lower() + " " + label.lower()
    if "smírčí" in t:
        return "smirci"
    if any(k in t for k in ("kostel", "kaple", "kaplič", "kříž", "boží muka", "socha", "sousoší", "fara", "klášter",
                            "mariánský sloup", "křížová cesta", "piedestal", "podstavec")):
        return "cirkev"
    if any(k in t for k in ("pomník", "památník", "pamětní", "pohřebiště", "hrob")):
        return "pamatnik"
    if any(k in t for k in ("havárie", "hradiště", "zanikl", "bitva", "událost")):
        return "historie"
    if any(k in t for k in ("strom", "rybník", "hora", "vrch", "kopec", "potok", "řeka", "lípa", "dub")):
        return "priroda"
    if any(k in t for k in ("muzeum", "rozhledna", "naučná", "vyhlídka", "letiště")):
        return "turistika"
    return "stavba"


SKIP_TYPES = ("ulice", "náměstí", "katastrální území", "správní obvod", "soudní okres", "silnice",
              "obec v česku", "část obce", "město v česku", "výhybna")


# ---------------------------------------------------------------- Wikidata
def wikidata():
    q = f"""SELECT ?item ?itemLabel ?itemDescription ?coord ?typeLabel ?article ?heritage ?inception ?image WHERE {{
  SERVICE wikibase:box {{ ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point({Wl} {S})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point({E} {N})"^^geo:wktLiteral . }}
  OPTIONAL {{ ?item wdt:P31 ?type . }}
  OPTIONAL {{ ?item wdt:P762 ?heritage . }}
  OPTIONAL {{ ?item wdt:P571 ?inception . }}
  OPTIONAL {{ ?article schema:about ?item ; schema:isPartOf <https://cs.wikipedia.org/> . }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "cs,en". }}
}}"""
    raw = B.fetch("stod/poi_wikidata.json", "https://query.wikidata.org/sparql",
                  params={"query": q, "format": "json"})
    items = {}
    for b in json.loads(raw)["results"]["bindings"]:
        k = b["item"]["value"]
        it = items.setdefault(k, dict(types=set(), b=b))
        it["types"].add(b.get("typeLabel", {}).get("value", ""))
        for f in ("article", "heritage", "inception"):
            if f in b:
                it["b"][f] = b[f]
    return items


def wiki_summary(url):
    title = urllib.parse.unquote(url.rsplit("/", 1)[-1])
    if not (B.CACHE / f"stod/wiki/{title.replace('/', '_')}.json").exists():
        time.sleep(1.2)                                   # Wikipedie omezuje počet dotazů
    try:
        raw = B.fetch(f"stod/wiki/{title.replace('/', '_')}.json",
                      f"https://cs.wikipedia.org/api/rest_v1/page/summary/{urllib.parse.quote(title)}", retries=2)
        txt = json.loads(raw).get("extract", "")
    except Exception:  # noqa: BLE001
        return ""
    # jen první 2 věty, ať je to krátké
    parts = txt.replace("\n", " ").split(". ")
    return (". ".join(parts[:2]).strip() + ("." if len(parts) > 1 else ""))[:420]


# ---------------------------------------------------------------- OSM (nepovinné)
def osm():
    q = f"""[out:json][timeout:120];(
nwr["historic"]({S},{Wl},{N},{E});
nwr["tourism"~"viewpoint|attraction|museum|artwork|information"]["name"]({S},{Wl},{N},{E});
nwr["amenity"="place_of_worship"]({S},{Wl},{N},{E});
nwr["natural"="tree"]["name"]({S},{Wl},{N},{E});
node["place"~"town|village|hamlet|suburb|isolated_dwelling|locality"]({S},{Wl},{N},{E});
);out tags center;"""
    for i, url in enumerate(B.OVERPASS * 2):
        try:
            raw = B.fetch("stod/poi_osm.json", url, data={"data": q}, retries=1)
            return json.loads(raw).get("elements", [])
        except Exception as e:  # noqa: BLE001
            (B.CACHE / "stod/poi_osm.json").unlink(missing_ok=True)
            B.log(f"  Overpass {url}: {str(e)[:80]}")
            time.sleep(10 * (i + 1))
    return []


OSM_CAT = {"wayside_cross": "cirkev", "wayside_shrine": "cirkev", "memorial": "pamatnik", "monument": "pamatnik",
           "castle": "historie", "ruins": "historie", "archaeological_site": "historie", "boundary_stone": "historie",
           "mine": "historie", "mine_shaft": "historie", "milestone": "stavba", "chapel": "cirkev", "church": "cirkev"}
OSM_NAME = {"wayside_cross": "Kříž", "wayside_shrine": "Boží muka / výklenková kaplička", "memorial": "Pamětní místo",
            "monument": "Pomník", "boundary_stone": "Hraniční kámen", "archaeological_site": "Archeologická lokalita",
            "ruins": "Zřícenina", "milestone": "Milník"}


def osm_services():
    q = f"""[out:json][timeout:120];(
nwr["amenity"~"^(townhall|school|kindergarten|library|community_centre|arts_centre|theatre|cinema|doctors|dentist|clinic|hospital|pharmacy|post_office|fire_station|police|bus_station|social_facility|recycling_centre)$"]({S},{Wl},{N},{E});
nwr["recycling_type"="centre"]({S},{Wl},{N},{E});
node["highway"="bus_stop"]({S},{Wl},{N},{E});
nwr["railway"~"^(station|halt)$"]({S},{Wl},{N},{E});
nwr["leisure"~"^(sports_centre|swimming_pool|stadium|sports_hall)$"]({S},{Wl},{N},{E});
);out tags center;"""
    for i, url in enumerate(B.OVERPASS * 3):
        try:
            raw = B.fetch("stod/poi_osm_sluzby.json", url, data={"data": q}, retries=1)
            return json.loads(raw).get("elements", [])
        except Exception as e:  # noqa: BLE001
            (B.CACHE / "stod/poi_osm_sluzby.json").unlink(missing_ok=True)
            B.log(f"  Overpass {url}: {str(e)[:80]}")
            time.sleep(15 * (i + 1))
    return []


SERVICE_NAME = {
    "townhall": "Obecní úřad", "school": "Škola", "kindergarten": "Mateřská škola", "library": "Knihovna",
    "community_centre": "Kulturní dům / společenský sál", "arts_centre": "Kulturní centrum", "theatre": "Divadlo",
    "cinema": "Kino", "doctors": "Lékař", "dentist": "Zubní ordinace", "clinic": "Zdravotní středisko",
    "hospital": "Nemocnice", "pharmacy": "Lékárna", "post_office": "Pošta", "fire_station": "Hasičská zbrojnice",
    "police": "Policie", "bus_station": "Autobusové nádraží", "social_facility": "Sociální zařízení",
    "recycling_centre": "Sběrný dvůr", "bus_stop": "Autobusová zastávka", "station": "Železniční stanice",
    "halt": "Železniční zastávka", "sports_centre": "Sportovní areál", "swimming_pool": "Koupaliště / bazén",
    "stadium": "Stadion", "sports_hall": "Sportovní hala",
}

# ZABAGED – definiční body veřejných služeb: vrstva → (pole s názvem, výchozí název)
ZBG_SERVICES = {43: ("nazev_ps", "Policie"), 44: ("nazevobce", "Hasičská zbrojnice"), 45: ("nazev", "Úřad"),
                46: ("nazev", "Pošta"), 47: ("nazev", "Škola"), 48: ("nazev", "Školské zařízení"),
                49: ("nazev", "Sociální zařízení"), 50: ("nazev", "Nemocnice"), 51: ("nazev", "Zdravotnické zařízení"),
                58: ("zst_p", "Železniční stanice")}


# ---------------------------------------------------------------- main

# ---------------------------------------------------------------- duplicity
# Stejná věc z více zdrojů (rešerše webu, Wikidata, ZABAGED, OSM) pod různými názvy:
# „Obec Hradec“ = „Obecní úřad Hradec“, „Pošta Stod (33301)“ = „Pošta Stod“ = OSM „Stod“ (pošta),
# „ZŠ a MŠ Stod“ = „Základní a mateřská škola Stod“, „Hasičská zbrojnice“ = „Hasičská zbrojnice Líšina“…
SRC_RANK = {"rešerše webu": 0, "Wikidata / Wikipedie": 1, "Wikidata": 2, "OpenStreetMap": 3, "ZABAGED": 4}
ABBR = {"zš": "základní škola", "mš": "mateřská škola", "zuš": "základní umělecká škola", "oú": "obecní úřad",
        "mú": "městský úřad", "sou": "střední odborné učiliště", "ddm": "dům dětí mládeže",
        "sdh": "hasičská zbrojnice", "žst": "železniční stanice", "žel.st.": "železniční stanice",
        "oop": "policie", "kd": "kulturní dům"}
STOP = {"a", "ve", "v", "u", "na", "pod", "nad", "od", "do", "se", "s", "z", "k", "the", "okres", "plzeň-jih",
        "příspěvková", "organizace", "s.r.o.", "a.s.", "spol.", "bývalá", "bývalý", "bývalé", "zaniklá", "zaniklý",
        "obce", "části", "česká", "republiky", "čr", "pracoviště"}
# obec / město / obecní úřad / radnice = totéž (sídlo úřadu)
SYN = {"obec": "úřad", "obecní": "úřad", "město": "úřad", "městský": "úřad", "městská": "úřad", "radnice": "úřad"}
# názvy, které nic neříkají – sloučí se do pojmenované věze stejného druhu poblíž
GENERIC = {"Kříž", "Kříž / sloup kulturního významu", "Pomník / mohyla", "Pomník", "Pamětní místo",
           "Boží muka / výklenková kaplička", "Hasičská zbrojnice", "Věž", "Policie", "letní kino"}
# ručně ověřené dvojice (stejná věc, názvy se neshodují): (ponechat, sloučit)
SAME = [("Poutní kostel na Křížovém vrchu (Vrabina)", "Rozhledna na Křížovém vrchu"),
        ("Jez a lávka přes Radbuzu u Chotěšova", "jez Chotěšov"),
        ("Pivovar a rybárna v Chotěšově", "Bývalá rybárna"),
        ("Hradiště na vrchu Trný", "Trný"),
        ("Sportovní areál a letní kino Stod", "letní kino"),
        ("Obecní úřad a pošta Hradec", "Pošta Hradec u Stoda (33211)"),
        ("Odborné učiliště – škola Stod", "Střední odborné učiliště, Domažlice, Prokopa Velikého 640"),
        ("Lékařské a zubní ordinace, Hradecká 435", "Psychiatrie MUDr. Gabriela Ťupová s.r.o."),
        ("Lékařské a zubní ordinace, Hradecká 435", "Gruberovi-stomatologie s.r.o."),
        ("Lékařské a zubní ordinace, Hradecká 435", "MUDr Věra Hrubá, MUDr Friedrichová Gabriel"),
        ("Policie", "OOP Stod"),
        ("Obecní úřad Chotěšov a zdravotní středisko", "Sdružení lékařů"),
        ("Obecní úřad Chotěšov a zdravotní středisko", "Praktická lékařka pro dospělé, MUDr. Klemperová, MUDr. Jelínková"),
        ("Obecní úřad Chotěšov a zdravotní středisko", "KL Dental, s.r.o."),
        ("Obecní úřad Chotěšov a zdravotní středisko", "Gynekologie MUDr. Krčál, s.r.o.")]
RENAME = {"Poutní kostel na Křížovém vrchu (Vrabina)": "Kostel sv. Kříže a rozhledna na Křížovém vrchu (Vrabina)",
          "Policie": "Policie ČR – obvodní oddělení Stod",
          "Stod, žel.st.": "Zastávka Stod, žel. st. (autobusy)"}


def _tokens(name, places):
    import re
    n = name.lower()
    n = re.sub(r"\([^)]*\d[^)]*\)", " ", n)              # (33301), (1945)…
    for k, v in ABBR.items():
        n = re.sub(rf"(?<![\w.]){re.escape(k)}(?![\w])", v, n)
    out = set()
    for w in re.split(r"[\s,–\-/()„“\"]+", n):
        w = w.strip(".")
        if len(w) < 3 or w in STOP or w.isdigit():
            continue
        out.add(SYN.get(w, w)[:4])
    pl = {w[:4] for w in out if w in places}
    return out, pl


def dedupe(pois, addresses=()):
    """Sloučí duplicity; vrátí nový seznam (id přečíslovaná) a počet sloučených."""
    places = set()
    for nm in ("stod", "stodu", "stodská", "stodský", "stodské", "chotěšov", "chotěšově", "chotěšova", "hradec",
               "hradci", "lelov", "lelově", "líšina", "líšině", "střelice", "střelicích", "touškov", "mantov",
               "mantově", "losina", "losině", "lažany", "maškrov", "vrabina", "vrabině", "přestavlky", "ves"):
        places.add(nm[:4])
    info = []
    for p in pois:
        tk, _ = _tokens(p["name"], set())
        info.append(dict(p=p, tk=tk, core=tk - places, rank=SRC_RANK.get(p["src"], 5), gone=False))

    def merge(keep, drop):
        a, b = keep["p"], drop["p"]
        a["links"] = list(dict.fromkeys(a["links"] + [l for l in b["links"] if l]))
        if not a["text"] and b["text"]:
            a["text"] = b["text"]
        elif b["text"] and b["src"] == "rešerše webu" and b["text"] not in a["text"]:
            a["text"] = a["text"].rstrip() + " " + b["text"]
        if not a.get("year") and b.get("year"):
            a["year"] = b["year"]
        drop["gone"] = True

    def pick(i, j):
        """Která položka zůstane: lepší zdroj, při shodě delší text."""
        a, b = info[i], info[j]
        if (a["rank"], -len(a["p"]["text"])) <= (b["rank"], -len(b["p"]["text"])):
            return a, b
        return b, a

    by_name = {}
    for k, it in enumerate(info):
        by_name.setdefault(it["p"]["name"], []).append(k)
    for keep, drop in SAME:
        for i in by_name.get(keep, []):
            for j in by_name.get(drop, []):
                pi, pj = info[i]["p"], info[j]["p"]
                if not info[j]["gone"] and math.hypot(pi["x"] - pj["x"], pi["z"] - pj["z"]) < 400:
                    merge(info[i], info[j])

    def wd(p):
        import re
        return {m for l in p["links"] for m in re.findall(r"wikidata\.org/(?:wiki|entity)/(Q\d+)", l or "")}

    def nums(name):
        import re
        return set(re.findall(r"\d+", re.sub(r"\([^)]*\)", "", name)))

    def same(a, b, d):
        pa, pb = a["p"], b["p"]
        na, nb = pa["name"], pb["name"]
        qa, qb = wd(pa), wd(pb)
        if qa and qb and not (qa & qb):
            return False                     # dvě různé položky Wikidat
        if nums(na) and nums(nb) and nums(na) != nums(nb):
            return False                     # čp. 25 ≠ čp. 35, Domov 1 ≠ Domov 2 (sloučí se níže)
        ga, gb = na in GENERIC or na == "Významný strom", nb in GENERIC or nb == "Významný strom"
        if na == nb and not ga:
            return d < (150 if pa["cat"] != "sluzby" or na.startswith("Zastávka") else 60)
        if ga or gb:
            if ga and gb:
                return d < 12
            g, o = (a, b) if ga else (b, a)
            compat = {"cirkev": {"cirkev", "pamatnik"}, "pamatnik": {"pamatnik", "cirkev", "historie", "turistika"},
                      "stavba": {"stavba"}, "sluzby": {"sluzby"}, "priroda": {"priroda"}}
            gn = g["p"]["name"]
            if gn in ("Hasičská zbrojnice", "Policie", "letní kino"):
                return d < 40 and bool(g["core"] & o["tk"])
            return d < 50 and o["p"]["cat"] in compat.get(g["p"]["cat"], set()) and gn != "Věž"
        ta, tb = a["tk"], b["tk"]
        if not ta or not tb:
            return False
        small, big = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
        core_small = (a["core"] if small is ta else b["core"])
        if small <= big:
            if not core_small:                      # jen název obce („Stod“) – musí stát na stejném místě
                return d < 15
            return d < (60 if pa["cat"] == "sluzby" or pb["cat"] == "sluzby" else 80)
        if d < 12 and (a["core"] & b["core"]) - {"úřad"}:
            return True
        inter = len(ta & tb) / len(ta | tb)
        return inter >= 0.6 and d < 60

    n = len(info)
    log = []
    for i in range(n):
        if info[i]["gone"]:
            continue
        for j in range(i + 1, n):
            if info[j]["gone"] or info[i]["gone"]:
                continue
            pi, pj = info[i]["p"], info[j]["p"]
            d = math.hypot(pi["x"] - pj["x"], pi["z"] - pj["z"])
            if d > 400:
                continue
            if same(info[i], info[j], d):
                keep, drop = pick(i, j)
                # obecný název nikdy nevyhrává nad konkrétním
                if keep["p"]["name"] in GENERIC and drop["p"]["name"] not in GENERIC:
                    keep, drop = drop, keep
                merge(keep, drop)
                log.append(f'{drop["p"]["name"]} → {keep["p"]["name"]} ({d:.0f} m)')

    out = [it["p"] for it in info if not it["gone"]]
    # Domov Háječek 1, 2, 3 → Domov Háječek
    import re
    groups = {}
    for p in out:
        m = re.fullmatch(r"(.+?)\s+\d+", p["name"])
        if m and p["src"] == "ZABAGED":
            groups.setdefault(m.group(1), []).append(p)
    for base, g in groups.items():
        if len(g) > 1 and max(math.hypot(a["x"] - b["x"], a["z"] - b["z"]) for a in g for b in g) < 120:
            g[0]["name"] = base
            g[0]["x"] = round(sum(a["x"] for a in g) / len(g), 1)
            g[0]["z"] = round(sum(a["z"] for a in g) / len(g), 1)
            for a in g[1:]:
                a["gone"] = True
    out = [p for p in out if not p.get("gone")]
    # stejný název na více místech (víc budov jedné organizace) → doplnit adresu
    cnt = {}
    for p in out:
        cnt[p["name"]] = cnt.get(p["name"], 0) + 1
    for p in out:
        if cnt[p["name"]] > 1 and p["cat"] == "sluzby" and addresses:
            a = min(addresses, key=lambda a: math.hypot(a[1] - p["x"], a[2] - p["z"]))
            if math.hypot(a[1] - p["x"], a[2] - p["z"]) < 60:
                p["name"] = p["name"].split(", příspěvková")[0] + " – " + a[0].split(",")[0]
    for p in out:
        p["name"] = RENAME.get(p["name"], p["name"])
        p.pop("gone", None)
    for k, p in enumerate(out):
        p["id"] = k
    dedupe.log = log
    return out, len(pois) - len(out)


def main():
    pois, places = [], {}

    def near(x, z, d=30):
        return next((p for p in pois if math.hypot(p["x"] - x, p["z"] - z) < d), None)

    def add(name, cat, x, z, text="", links=(), src="", year=None):
        if not inside(x, z):
            return None
        p = dict(id=len(pois), name=name, cat=cat, x=round(x, 1), z=round(z, 1), text=text,
                 links=list(dict.fromkeys(l for l in links if l)), src=src)
        if year:
            p["year"] = year
        pois.append(p)
        return p

    # 1) ruční rešerše webů – má přednost (nejlepší texty)
    web = json.loads(WEB.read_text()) if WEB.exists() else []
    for w in web:
        try:
            x, z = local(float(w["lon"]), float(w["lat"]))
        except (KeyError, ValueError, TypeError):
            continue
        add(w["name"], w.get("category", "stavba") if w.get("category") in CATS else "stavba", x, z,
            w.get("text", ""), w.get("sources", []), "rešerše webu", w.get("year"))
    B.log(f"Rešerše webů: {len(pois)} položek")

    # 2) Wikidata (+ úvod z Wikipedie)
    wd = wikidata()
    n0 = len(pois)
    for k, it in wd.items():
        b = it["b"]
        label = b.get("itemLabel", {}).get("value", "")
        types = sorted(t for t in it["types"] if t)
        tl = " ".join(types).lower()
        lon, lat = map(float, b["coord"]["value"].removeprefix("Point(").rstrip(")").split())
        x, z = local(lon, lat)
        if any(s in tl for s in ("obec v česku", "část obce", "město v česku")):
            places[label] = dict(name=label, x=round(x, 1), z=round(z, 1),
                                 rank=3 if "město" in tl else 2, link=b.get("article", {}).get("value"))
            continue
        if not label or label.startswith("Q") or any(s in tl for s in SKIP_TYPES):
            continue
        if "nenalezeno" in label:
            continue
        article = b.get("article", {}).get("value")
        desc = b.get("itemDescription", {}).get("value", "")
        text = wiki_summary(article) if article else ""
        if not text:
            text = (desc[:1].upper() + desc[1:] + ".") if desc else ""
            if "heritage" in b and "památka" not in text:
                text += " Kulturní památka České republiky."
        year = b.get("inception", {}).get("value", "")[:4] or None
        ex = near(x, z, 40)
        links = [article, k]
        if ex and ex["src"] == "rešerše webu":
            ex["links"] += [l for l in links if l and l not in ex["links"]]
            continue
        add(label, category(types, label), x, z, text, links,
            "Wikidata" + (" / Wikipedie" if article else ""), year)
    B.log(f"Wikidata: {len(pois) - n0} položek, {len(places)} obcí/částí")

    # 3) ZABAGED – kříže, pomníky, věže, stromy (jen kde ještě nic není)
    n0 = len(pois)
    for layer, cat, name in ((24, "cirkev", "Kříž / sloup kulturního významu"), (25, "pamatnik", "Pomník / mohyla"),
                             (26, "stavba", "Věž"), (14, "priroda", "Významný strom")):
        for f in B.zbg(layer):
            g = f.get("geometry", {})
            if "x" not in g:
                continue
            x, z = B.loc(g["x"], g["y"])
            if not near(x, z, 35):
                add(f["attributes"].get("jmeno") or name, cat, x, z,
                    "Objekt ze Základní báze geografických dat ČR (ZABAGED).", [], "ZABAGED")
    for f in B.zbg(3):
        g = f.get("geometry", {})
        a = f["attributes"]
        if "x" in g and a.get("nazev"):
            x, z = B.loc(g["x"], g["y"])
            pl = places.get(a["nazev"])
            if pl and math.hypot(pl["x"] - x, pl["z"] - z) < 1500:
                pl.update(x=round(x, 1), z=round(z, 1))      # definiční bod je přesnější střed obce
            elif inside(x, z):
                places[a["nazev"]] = dict(name=a["nazev"], x=round(x, 1), z=round(z, 1), rank=2)
            if a.get("poc_obyv"):
                places[a["nazev"]]["pop"] = a["poc_obyv"]
    B.log(f"ZABAGED: {len(pois) - n0} položek")

    # 4) OSM – doplněk
    n0 = len(pois)
    for el in osm():
        t = el.get("tags", {})
        c = el.get("center") or el
        if "lat" not in c:
            continue
        x, z = local(c["lon"], c["lat"])
        if "place" in t and t.get("name"):
            if t["name"] not in places and inside(x, z):
                places[t["name"]] = dict(name=t["name"], x=round(x, 1), z=round(z, 1),
                                         rank={"town": 3, "village": 2}.get(t["place"], 1))
            continue
        h = t.get("historic") or t.get("tourism") or ("chapel" if t.get("amenity") == "place_of_worship" else "")
        cat = OSM_CAT.get(h, "turistika" if "tourism" in t else "stavba")
        if t.get("natural") == "tree":
            cat, h = "priroda", "tree"
        name = t.get("name") or OSM_NAME.get(h)
        if not name or near(x, z, 35):
            continue
        if any(p["name"] == name and math.hypot(p["x"] - x, p["z"] - z) < 400 for p in pois):
            continue                       # tabule / rozcestník se jménem místa, které už je v seznamu
        info = t.get("information")
        if info == "guidepost":
            name = f"Rozcestník {name}"
        elif info == "board":
            name = f"Naučná tabule: {name}"
        elif info == "map":
            name = f"Mapa obce: {name}" if " " not in name else f"Informační mapa: {name}"
        osm_id = f"https://www.openstreetmap.org/{el['type']}/{el['id']}"
        add(name, cat, x, z, t.get("description", "") or t.get("inscription", ""), [t.get("website"), osm_id], "OpenStreetMap")
    B.log(f"OSM: {len(pois) - n0} položek")

    # 5) veřejné služby – ZABAGED (úřední názvy) + OSM (zastávky, ordinace, sály…)
    n0 = len(pois)
    for layer, (field, default) in ZBG_SERVICES.items():
        for f in B.zbg(layer):
            g, a = f.get("geometry", {}), f["attributes"]
            if "x" not in g:
                continue
            x, z = B.loc(g["x"], g["y"])
            name = a.get(field) or default
            if layer == 44:
                name = f"Hasičská zbrojnice {name}"
            if layer == 46:
                name = f"Pošta {name} ({a.get('psc', '')})"
            if layer == 58:
                name = f"Železniční {a.get('typ', 'stanice')} {name}"
            kind = {k: a.get(k) for k in ("typps_p", "uvs_typ_p", "vzdelani_p", "drsoza_p", "drzar_p") if a.get(k)}
            text = "; ".join(str(v) for v in kind.values())
            text = (text[:1].upper() + text[1:] + ". " if text else "") + "Zdroj: ZABAGED (ČÚZK)."
            ex = next((p for p in pois if p["name"] == name and math.hypot(p["x"] - x, p["z"] - z) < 80), None)
            if not ex:
                add(name, "sluzby", x, z, text, [], "ZABAGED")
    for el in osm_services():
        t = el.get("tags", {})
        c = el.get("center") or el
        if "lat" not in c:
            continue
        x, z = local(c["lon"], c["lat"])
        kind = t.get("amenity") or t.get("leisure") or t.get("railway") or \
            ("bus_stop" if t.get("highway") == "bus_stop" else "recycling_centre")
        base = SERVICE_NAME.get(kind, "Služba")
        name = t.get("name") or base
        if kind == "bus_stop":
            name = f"Zastávka {t['name']}" if t.get("name") else base
        if any(p["cat"] == "sluzby" and math.hypot(p["x"] - x, p["z"] - z) < 25 and
               (p["name"] == name or kind in ("bus_stop",) and p["name"].startswith("Zastávka")) for p in pois):
            continue
        addr = " ".join(v for v in (t.get("addr:street") or t.get("addr:place"), t.get("addr:housenumber") or
                                    t.get("addr:conscriptionnumber")) if v)
        text = base + (f", {addr}" if addr else "") + "." + (f" Otevírací doba: {t['opening_hours']}." if t.get("opening_hours") else "")
        add(name, "sluzby", x, z, text, [t.get("website"), f"https://www.openstreetmap.org/{el['type']}/{el['id']}"],
            "OpenStreetMap")
    B.log(f"Veřejné služby: {len(pois) - n0} položek")

    # 6) ulice z RÚIAN
    streets = {}
    for f in B.arcgis("stod/ruian_ulice", f"{B.RUIAN}/4/query", fields="kod,nazev,obec"):
        name = f["attributes"].get("nazev")
        for p in f.get("geometry", {}).get("paths") or []:
            pts = [[round(v, 1) for v in B.loc(x, y)] for x, y in p]
            if len(pts) >= 2:
                streets.setdefault(name, []).append(pts)
    street_list = [dict(name=k, paths=v) for k, v in streets.items() if k]

    # 7) adresní místa z RÚIAN (pro vyhledávání „ulice číslo“)
    addresses = []
    for f in B.arcgis("stod/ruian_adresy", f"{B.RUIAN}/1/query", fields="adresa"):
        g, a = f.get("geometry", {}), f["attributes"]
        if "x" in g and a.get("adresa"):
            x, z = B.loc(g["x"], g["y"])
            # bez PSČ a duplicitního názvu obce na konci – kratší a čitelnější
            txt = a["adresa"].replace(", ", "|", 1)
            parts = txt.split("|")
            short = parts[0] + (", " + parts[1].split(" ", 1)[1] if len(parts) > 1 and " " in parts[1] else "")
            addresses.append([short, round(x, 1), round(z, 1)])
    B.log(f"Adresy: {len(addresses)}")
    B.log(f"Ulice: {len(street_list)} názvů")

    # popisky obcí na náves / náměstí (střed katastru z Wikidat bývá mimo zástavbu)
    for name, pl in places.items():
        sq = next((p for p in pois if p["cat"] == "obec" and p["name"].split(" –")[0].split(" -")[0].strip() == name), None)
        if sq:
            pl.update(x=sq["x"], z=sq["z"])
    for name, (lon, lat) in B.PLACES.items():
        if name in places:
            x, z = local(lon, lat)
            places[name].update(x=round(x, 1), z=round(z, 1))

    pois, nd = dedupe(pois, addresses)
    B.log(f"Duplicity: sloučeno {nd}")
    out = dict(categories=CATS, pois=pois, places=sorted(places.values(), key=lambda p: -p["rank"]),
               streets=street_list, addresses=addresses, built=time.strftime("%Y-%m-%d"))
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    by = {}
    for p in pois:
        by[p["cat"]] = by.get(p["cat"], 0) + 1
    B.log(f"hotovo: {len(pois)} zajímavostí {by}, {len(places)} obcí → {OUT}")


def dedupe_only():
    """Jen sloučí duplicity v hotovém poi.json (bez stahování)."""
    d = json.loads(OUT.read_text())
    d["pois"], nd = dedupe(d["pois"], d.get("addresses", []))
    OUT.write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")))
    B.log(f"Duplicity: sloučeno {nd}, zbývá {len(d['pois'])} zajímavostí")


if __name__ == "__main__":
    if "--dedupe-only" in sys.argv:
        dedupe_only()
    else:
        main()
