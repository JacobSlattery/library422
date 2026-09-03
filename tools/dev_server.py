"""Local dev server for the PWA. Serves app/ with correct WASM/ESM mime types
and no-cache headers (so edits show up on refresh). Binds 0.0.0.0 so an Android
phone on the same WiFi can reach it.

Run:  pixi run dev     then open http://localhost:8000 (or http://<LAN-IP>:8000)

Note: OPFS (where the app keeps its databases) needs a secure context, so the
plain-http LAN address works on the desktop (localhost) but a phone browser
will not get persistent storage from it — use the APK for phone testing.
"""
import mimetypes
import socket
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/manifest+json", ".webmanifest")

ROOT = Path(__file__).resolve().parent.parent
APP_DIR = ROOT / "app"

app = FastAPI()


class NoCache(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        resp = await call_next(request)
        resp.headers["Cache-Control"] = "no-store"
        return resp


app.add_middleware(NoCache)


# deep links (/read/john/3/16, /library/<work>/<page>, /word/G3056): any path
# without a file extension is the app shell — the same single-page fallback
# Cloudflare applies (wrangler.app.jsonc not_found_handling)
class SpaFallback(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        resp = await call_next(request)
        path = request.url.path
        if resp.status_code == 404 and "." not in path.rsplit("/", 1)[-1] \
                and not path.startswith(("/data/", "/models/", "/testbed/")):
            from fastapi.responses import FileResponse
            return FileResponse(APP_DIR / "index.html", headers={"Cache-Control": "no-store"})
        return resp


app.add_middleware(SpaFallback)
# local eval extras (harness + big model files); mounted before the app root.
# Both folders are gitignored/optional — a fresh clone must still serve app/.
for name in ("models", "testbed"):
    d = ROOT / name
    if d.is_dir():
        app.mount(f"/{name}", StaticFiles(directory=d, html=True), name=name)
app.mount("/", StaticFiles(directory=APP_DIR, html=True), name="app")


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    import uvicorn
    print(f"\n  Desktop:  http://localhost:8000\n  Phone:    http://{lan_ip()}:8000\n")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="warning")
