#!/usr/bin/env python3
"""
3D Stodsko – jednoduchý server: statický web (složka web/) + API pro hlášení chyb a změn.

  GET  /api/reports   → seznam hlášení (bez e-mailů), nejnovější první
  POST /api/reports   → nové hlášení (JSON: type, text, x, z, view, name, email, website=honeypot)

Hlášení se ukládají do reports/reports.json (mimo web, není v gitu).

Spuštění:  python3 tools/server.py [port]        (výchozí port 8765)
Na webhostingu s PHP lze místo toho použít web/api/reports.php (viz README).
"""
import json
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
STORE = ROOT / "reports" / "reports.json"
TYPES = {"chyba": "Chyba v mapě", "chybi": "Chybějící místo / objekt", "zmena": "Změna v terénu / stavba",
         "jine": "Jiné"}
COOLDOWN = 30                      # s mezi hlášeními z jedné IP
MAX_TEXT = 2000
lock = threading.Lock()
last_post = {}


def load():
    try:
        return json.loads(STORE.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return []


def public(r):
    return {k: v for k, v in r.items() if k not in ("email", "ip")}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0].rstrip("/") == "/api/reports":
            with lock:
                items = load()
            return self.send_json(200, [public(r) for r in reversed(items)])
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") != "/api/reports":
            return self.send_json(404, {"error": "nenalezeno"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n > 20000:
                return self.send_json(413, {"error": "příliš dlouhé"})
            d = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self.send_json(400, {"error": "neplatná data"})
        if d.get("website"):                                    # honeypot – vyplní jen robot
            return self.send_json(200, {"ok": True})
        text = str(d.get("text", "")).strip()
        if len(text) < 5:
            return self.send_json(400, {"error": "Popište prosím problém (aspoň pár slov)."})
        ip = self.client_address[0]
        now = time.time()
        if now - last_post.get(ip, 0) < COOLDOWN:
            return self.send_json(429, {"error": "Chvilku počkejte, než pošlete další hlášení."})

        def num(v):
            try:
                return round(float(v), 1)
            except (TypeError, ValueError):
                return None
        r = {
            "type": d.get("type") if d.get("type") in TYPES else "jine",
            "text": text[:MAX_TEXT],
            "name": str(d.get("name", "")).strip()[:80],
            "email": str(d.get("email", "")).strip()[:120],
            "x": num(d.get("x")), "z": num(d.get("z")),
            "place": str(d.get("place", "")).strip()[:120],
            "view": str(d.get("view", ""))[:120],
            "time": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "status": "nové",
        }
        with lock:
            items = load()
            r["id"] = (max((i.get("id", 0) for i in items), default=0) + 1)
            items.append(r)
            STORE.parent.mkdir(parents=True, exist_ok=True)
            tmp = STORE.with_suffix(".tmp")
            tmp.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
            tmp.replace(STORE)
            last_post[ip] = now
        return self.send_json(201, {"ok": True, "id": r["id"]})

    def log_message(self, fmt, *args):  # tišší log – jen API
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"3D Stodsko: http://localhost:{port}  (hlášení → {STORE})")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
