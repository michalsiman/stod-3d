#!/usr/bin/env python3
"""
Nasazení webu na server (rsync) s číslem verze v adresách skriptů a dat.

Před serverem je Cloudflare, který prohlížečům nastavuje cache na hodiny – po aktualizaci by se jinak
načítaly staré skripty. Skript zkopíruje web/ do dočasné složky, ke všem relativním importům (`from './x.js'`),
k adresám dat (`'data/…'`, `` `data/…` ``) a ke skriptům / stylům v HTML přidá `?v=<verze>` a pošle ji na server.
Hlášení uživatelů (api/data/reports.json) se nepřepisují.

Spuštění:  python3 tools/deploy.py [cíl]      výchozí cíl: bludit:/var/www/ok1sim.cz/public_html/stod-3d/
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = sys.argv[1] if len(sys.argv) > 1 else "bludit:/var/www/ok1sim.cz/public_html/stod-3d/"


def stamp(text, v):
    text = re.sub(r"""(from\s+|import\s*\(\s*)(['"])(\.{1,2}/[^'"?]+\.js)\2""", rf"\1\2\3?v={v}\2", text)
    text = re.sub(r"'data/([^'?]+)'", rf"'data/\1?v={v}'", text)
    text = re.sub(r"`data/([^`?]+)`", rf"`data/\1?v={v}`", text)
    return text


def main():
    v = time.strftime("%Y%m%d%H%M%S")
    try:
        v = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"], text=True).strip() + "-" + v
    except (OSError, subprocess.CalledProcessError):
        pass
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "web"
        shutil.copytree(ROOT / "web", out, ignore=shutil.ignore_patterns("reports.json"))
        for f in out.rglob("*.js"):
            if "vendor" in f.parts:
                continue
            f.write_text(stamp(f.read_text(), v))
        # verze pro lidi: 1.<počet commitů>, datum vydání = datum posledního commitu
        try:
            n = subprocess.check_output(["git", "-C", str(ROOT), "rev-list", "--count", "HEAD"], text=True).strip()
            day = subprocess.check_output(["git", "-C", str(ROOT), "log", "-1", "--format=%cd", "--date=format:%-d. %-m. %Y"], text=True).strip()
        except (OSError, subprocess.CalledProcessError):
            n, day = "0", time.strftime("%-d. %-m. %Y")
        human = f"1.{n}"
        for f in out.glob("*.html"):
            t = f.read_text().replace("__VERSION__", human).replace("__DATE__", day).replace("__BUILD__", v)
            t = re.sub(r'((?:src|href)=")([\w./-]+\.(?:js|css))"', rf'\1\2?v={v}"', t)
            f.write_text(stamp(t, v))
        # aktuální verze pro otevřené stránky (hlídají ji a nabídnou načtení znovu)
        (out / "version.json").write_text(json.dumps({"build": v, "version": human, "date": day}, ensure_ascii=False))
        host, path = TARGET.split(":", 1)
        subprocess.check_call(["rsync", "-az", "--delete", "--exclude", "api/data/reports.json", f"{out}/", TARGET])
        subprocess.check_call(["ssh", host, f"chown -R www-data:www-data {path}"])
    print(f"nasazeno, verze {human} ({v}) → {TARGET}")


if __name__ == "__main__":
    main()
