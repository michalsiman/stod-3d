# 3D Stodsko

Interaktivní vykreslovaný 3D model obce Stod (k.ú. Stod a k.ú. Lelov, okres Plzeň-jih) v prohlížeči.
Čistě statický web – Three.js, žádný server ani build.

## Princip

Scéna je **vykreslovaná, bez fotografií**, ve zjednodušeném stylizovaném vzhledu kvůli svižnosti:
plné barvy podle druhu plochy a krytiny, jednoduché tvary stromů, síť terénu 8 m zblízka / 16 m zdálky,
levné materiály (Lambert), jednoduchá obloha, stíny lze vypnout tlačítkem „Stíny“.
Kreslí se jen při změně pohledu.

Ortofoto se na web nedostane – v přípravě dat slouží jen ke klasifikaci barvy krytiny a stavu pole
(`USE_ORTHO_HINTS` v `tools/build_data.py`).

## Struktura

```
tools/build_data.py   stáhne a zpracuje podklady → web/data/ (cca 4 min, cache v cache/)
web/
  index.html, style.css, main.js   UI, obloha, ovládání, kreslení jen při změně
  js/world.js       dlaždice 1 km: zdálky síť 16 m + barevná mapa, zblízka síť 4 m + detaily
  js/terrain.js     sítě terénu a barvy ploch podle mapy pokryvu
  js/roads.js       silnice, cesty a železnice jako barevné pásy s rovnými okraji
  js/bridges.js     mosty: co po nich vede, mostovka, římsy, zábradlí, pilíře, nosníky železničních mostů
  js/posts.js       směrové sloupky (patníky) podél silnic mimo obce
  js/signs.js       cedule s nápisy na domech (úřady, školy, obchody, restaurace, firmy)
  js/placesigns.js  značky začátek / konec obce (IS12a, IS12b) na vjezdech do zástavby
  js/landmarks.js   ručně modelované stavby (kostel s rozhlednou na Křížovém vrchu)
  js/buildings.js   budovy: sedlové, valbové, lomené střechy, rozklad L/T/U půdorysů, okna a barvy podle druhu
  js/trees.js       stylizované stromy po blocích 256 m
  js/fences.js      zdi a živé ploty
  js/power.js       elektrické vedení – sloupy a vodiče
  js/drive.js       projížďka autem: model auta, jízda po silnicích, srážky s domy, mapka, cíle jízdy
  js/glsl.js        sdílené GLSL funkce
  data/             meta.json, far.png, far_h.bin, t/{i}_{j}.bin|png, buildings/roads/fences/power/bridges.json, trees.bin
```

## Zdroje dat

| Vrstva | Zdroj | Použití |
|---|---|---|
| Hranice území | ČÚZK RÚIAN | obec Stod (kód 558389) + okraj 300 m |
| Terén | ČÚZK DMR 5G | 4 m zblízka, 16 m zdálky |
| Povrch | ČÚZK DMP 1G | výšky budov a stromů, tvar střech (valba / lomená), koruny lesů zdálky |
| Pokryv území | ČÚZK ZABAGED | louky, pole, lesy, sady, voda, areály, kolejiště |
| Komunikace | ČÚZK ZABAGED | silnice I.–III. tř., ulice, cesty dle povrchu, pěšiny, železnice, mosty |
| Pole | eAGRI LPIS | skutečné hony, směr řádků, kultura |
| Budovy | ČÚZK RÚIAN + ZABAGED + OSM | půdorysy, podlaží, způsob využití (rodinný / bytový dům, občanská vybavenost, výroba, zemědělská stavba, garáž, skleník), obestavěný prostor |
| Ploty | ČÚZK RÚIAN (parcely – zahrady) + ZABAGED zdi | |
| Elektrické vedení | ČÚZK ZABAGED | |

## Výšky budov a stromy

- Výška budovy = DMP 1G − DMR 5G uvnitř půdorysu, bez okraje půdorysu (sousední domy, posun) a bez zelených
  pixelů ortofota (koruny stromů nad střechou). Horní mez dává RÚIAN: nadzemní podlaží (podzemní se odečte podle
  obestavěného prostoru) a obestavěný prostor / zastavěná plocha; co ji přesáhne, se nahradí odhadem z podlaží.
  Stejně se odhadne výška domů, které v DMP ještě nejsou (novostavby).
- Druh budovy (okna, barvy, vrata garáží, skleníky) podle způsobu využití z RÚIAN, jinak podle OSM.
- Samostatné stromy se nehledají na silnicích, železnici, mostech a pod vedením (DMP tam vidí mostovku,
  auta, trolej a sloupy).

## Cedule a patníky

- `tools/build_signs.py` → `web/data/signs.json` (po `build_poi.py`): ručně vybraný seznam úřadů, škol, nemocnice,
  pošt, hasičů, obchodů, restaurací a větších firem. Poloha z adresních míst RÚIAN (adresy firem z jejich webů
  a katalogů), z OpenStreetMap nebo ze zajímavostí. Web cedulí označí dům pod bodem (nebo nejbližší do 30 m),
  na stěně k nejbližší ulici, mezi okny přízemí a patra. Bez domu stojí cedule na sloupcích.
- Patníky (směrové sloupky) se dopočítají na webu: silnice I.–III. třídy, mimo obec (budova do 70 m), ne na mostech
  a u křižovatek, po 50 m, v obloucích po 25 m; vpravo oranžová odrazka, vlevo dvě bílé.

## Ručně modelované stavby

`js/landmarks.js` nahrazuje obecně vygenerovanou budovu vlastním modelem. Kostel sv. Kříže na Křížovém vrchu
(Vrabina): rozměry z půdorysu RÚIAN, výšky podle popisu (věž 22 m, vyhlídka ve 13 m – obec Chotěšov,
kudyznudy.cz), vzhled podle veřejně dostupných fotografií (Wikimedia Commons) jen jako předlohy – štítové průčelí
s kulatým oknem a portálem, věž se třemi obloukovými okny vyhlídky a jehlancovou břidlicovou střechou, zazděná
okna lodi, presbytář s trojbokým závěrem, sanktusník, altán. Stromy se v okolí stavby nekreslí.

## Značky začátek a konec obce

Zástavba = souvislá oblast obytných a veřejných budov (rozšířená o 50 m, mezery do ~200 m uzavřené), aspoň 12 domů;
název podle nejbližší obce / části obce. Kde silnice nebo místní komunikace hranici přetíná, stojí 12 m před ní
vpravo „začátek obce“ a na druhé straně „konec obce“ (přeškrtnutý).

## Zajímavosti, názvy obcí a ulic

`tools/build_poi.py` → `web/data/poi.json` (spouští se zvlášť, po `build_data.py`). Slučuje:
- `tools/poi_web.json` – ruční rešerše webů (město Stod, okolní obce, Mikroregion Radbuza, kudyznudy.cz,
  navylet.cz, drobnepamatky.cz, Wikipedie) s vlastními texty a odkazy na zdroje – má přednost,
- Wikidata (+ krátký úvod z cs Wikipedie), ZABAGED (kříže, pomníky, úřady, školy, nemocnice, pošty, hasiči,
  policie, nádraží), OpenStreetMap (zastávky, ordinace, lékárny, školky, sály…), RÚIAN (ulice).

Duplicity (stejná věc z více zdrojů pod různými názvy – „Obec Hradec“ / „Obecní úřad Hradec“, „Pošta Stod (33301)“ /
„Pošta Stod“, „ZŠ a MŠ Stod“ / „Základní a mateřská škola Stod“…) slučuje `dedupe()` v `build_poi.py`: porovnává
názvy po rozepsání zkratek, synonymech (obec = město = úřad) a bez názvů obcí, vzdálenost a druh místa; ruční
dvojice v `SAME`. Různé položky Wikidat a různá čísla popisná se nikdy neslučují. Turistické rozcestníky a naučné
tabule z OSM mají v názvu, co jsou. Jen sloučení v hotových datech: `build_poi.py --dedupe-only`.

Na webu tlačítko **Zajímavosti**: přepínače Názvy obcí / Názvy ulic / Zajímavosti po kategoriích,
hledání, seznam a karta s detailem a zdroji. Volby se pamatují v prohlížeči.

## Přegenerování dat

```bash
python3 -m venv .venv && .venv/bin/pip install numpy pillow requests pyproj scipy shapely
.venv/bin/python tools/build_data.py            # použije cache/
.venv/bin/python tools/build_data.py --refresh  # stáhne vše znovu
```

Velikost oblasti, střed a rozlišení se nastavují v hlavičce `build_data.py`.

## Hlášení chyb a změn

Formulář „Nahlásit chybu / změnu“ v menu (typ, popis, místo – střed pohledu nebo kliknutím do mapy,
nepovinné jméno a e-mail) a stránka `hlaseni.html` s výpisem všech hlášení (nejnovější nahoře, filtr podle typu,
odkaz „Zobrazit na mapě“). E-maily se nikde nezveřejňují. Ochrana proti spamu: skryté pole + max. 1 hlášení / 30 s z IP.

Ukládání potřebuje serverovou část – dvě varianty se stejným API (`GET/POST api/reports`):
- `tools/server.py` – Python, servíruje i celý web; data v `reports/reports.json`,
- `web/api/reports.php` – pro běžný webhosting s PHP (Apache + `web/api/.htaccess`); data v `web/api/data/`
  (zvenku nepřístupné; složka musí být zapisovatelná pro PHP).

## Samostatný spustitelný soubor

`tools/build_exe.sh` sestaví do `dist/` jeden soubor pro každý systém (Windows, Linux, Mac Intel/ARM),
který obsahuje celý web i API hlášení (`launcher/main.go`, Go 1.22+). Po spuštění otevře mapu v prohlížeči,
funguje offline (Three.js i písmo Inter jsou přibalené v `web/vendor/`). Hlášení ukládá do složky
`stodsko-hlaseni` vedle programu. Návod pro uživatele: `dist/JAK-SPUSTIT.txt`.

```bash
GO=/cesta/k/go tools/build_exe.sh
```

## Lokální spuštění

```bash
python3 tools/server.py 8000   # web + hlášení → http://localhost:8000
```

## Nasazení

Obsah složky `web/` nahrát na libovolný statický hosting (nginx, Apache,
GitHub Pages, Cloudflare Pages…). Celkem ~15 MB, načítá se postupně podle polohy kamery. Doporučené nastavení nginx:

```nginx
server {
    server_name lelov.example.cz;
    root /var/www/lelov-3d;
    gzip on;
    gzip_types application/json application/octet-stream application/javascript text/css;
    location /data/ { add_header Cache-Control "public, max-age=86400"; }
}
```

## Ovládání

- **Mapa** (O) – myš / dotyk; klávesy ←↑↓→ nebo WASD posun, Q/E nebo Shift+←/→ otáčení, Shift+↑/↓ náklon, +/− nebo PgUp/PgDn zoom
- **Let** (F) – volný let, myš + WASD, E/Q nahoru/dolů, Shift rychle
- **Chůze** (G) – pohyb ve výšce očí nad terénem
- **Auto** (V) – projížďka autem po silnicích a cestách: ↑/W plyn, ↓/S brzda a couvání, ←/→ zatáčení,
  mezerník ruční brzda, C pohled (za autem / zdálky / z kabiny), P barva auta, M zvuk motoru, T nový cíl,
  Esc vystoupit. Nejrychleji to jede po silnici, štěrk, polní cesty a louky zpomalí, do domů se narazit dá.
  Tachometr ukazuje ulici a povrch, mapka vpravo nahoře je natočená po směru jízdy; tlačítko 🎯 vybere
  náhodnou zajímavost v okolí jako cíl a změří čas. Po silnicích a ulicích v okolí jezdí další auta (na mapce modré
  tečky). V noci svítí reflektory. Na mobilu dotykové pedály.
- **Stod / Lelov** – skok na obec (R = Stod)
- Aktuální pohled se ukládá do URL (`#x,y,z,…`) a dá se poslat odkazem.

## Licence a zdroje dat

- Geodata: © ČÚZK (DMR 5G, DMP 1G, ZABAGED, RÚIAN) – otevřená data, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Pole: © Ministerstvo zemědělství, eAGRI LPIS – otevřená data
- Mapová data: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), [ODbL](https://opendatacommons.org/licenses/odbl/)
- Zajímavosti: Wikidata (CC0), Wikipedie (CC BY-SA 4.0), weby uvedené u jednotlivých položek
- Three.js (`web/vendor/three`): MIT
