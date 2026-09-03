"""Screenshot a view of the app in headless Chrome, for design review.

    pixi run python testbed/devtools/shot.py --out shots/read-wide.png --width 1440 --height 900 --view read
    pixi run python testbed/devtools/shot.py --out shots/word-phone.png --width 412 --height 915 --view read --tap-word
    pixi run python testbed/devtools/shot.py --url https://app.library422.org/ --view settings

--view: read | library | search | settings | ask | books
--tap-word: tap the first tagged word (opens the word panel / pane)
--tap-verse: tap verse 1's number (opens the verse panel / pane)
--dark: emulate prefers-color-scheme: dark
Reuses smoke_app.py's Chrome profile (data already installed) unless --profile is given.
"""
import argparse, asyncio, base64, json, subprocess, sys, time, urllib.request
from pathlib import Path
import websockets

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PROFILE = Path(r"C:\Users\timbe\AppData\Local\Temp\atb-cdp-profile")
_id = 0


async def cmd(ws, method, params=None, timeout=60):
    global _id
    _id += 1
    await ws.send(json.dumps({"id": _id, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout))
        if msg.get("id") == _id:
            return msg.get("result", {})


async def js(ws, expr, timeout=120):
    r = await cmd(ws, "Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True}, timeout)
    if "exceptionDetails" in r:
        raise RuntimeError("JS: " + json.dumps(r["exceptionDetails"])[:400])
    return r.get("result", {}).get("value")


async def wait_for(ws, expr, timeout=180):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if await js(ws, expr):
            return True
        await asyncio.sleep(0.4)
    raise TimeoutError(expr)


TAP = """
(sel, nth=0) => { const n = document.querySelectorAll(sel)[nth]; if (!n) return false;
  const r = n.getBoundingClientRect(); const o = {bubbles:true, clientX:r.left+2, clientY:r.top+2, pointerId:1};
  n.dispatchEvent(new PointerEvent('pointerdown', o)); n.dispatchEvent(new PointerEvent('pointerup', o)); return true; }
"""


async def run(ws, a):
    await cmd(ws, "Runtime.enable")
    await cmd(ws, "Page.enable")
    await cmd(ws, "Emulation.setDeviceMetricsOverride",
              {"width": a.width, "height": a.height, "deviceScaleFactor": 1, "mobile": a.width < 700})
    if a.dark or a.light:
        await cmd(ws, "Emulation.setEmulatedMedia",
                  {"features": [{"name": "prefers-color-scheme", "value": "dark" if a.dark else "light"}]})
    await cmd(ws, "Page.navigate", {"url": a.url})
    if a.boot:   # the first-launch screen itself, a moment after navigation
        await asyncio.sleep(a.boot)
        shot = await cmd(ws, "Page.captureScreenshot", {"format": "png"})
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_bytes(base64.b64decode(shot["data"]))
        print("wrote", a.out)
        return
    await wait_for(ws, "!!document.querySelector('#reader') && !document.querySelector('#reader').hidden", 600)
    if a.state:
        await js(ws, f"localStorage.setItem('atb-reader', JSON.stringify({a.state}))")
        await cmd(ws, "Page.reload")
        await wait_for(ws, "!!document.querySelector('#reader') && !document.querySelector('#reader').hidden", 120)
    await wait_for(ws, "document.querySelectorAll('.verse-row').length > 3 || document.querySelector('.packnotice')", 60)
    tab = {"read": "#tab-read", "library": "#tab-library", "search": "#tab-search",
           "settings": "#tab-settings", "ask": "#tab-ask"}.get(a.view)
    if a.view == "books":
        await js(ws, "document.querySelector('#locbtn').click()")
    elif tab:
        if a.view == "ask":
            await js(ws, "localStorage.setItem('atb-ai-beta', '1')")
            await cmd(ws, "Page.reload")
            await wait_for(ws, "document.querySelectorAll('.verse-row').length > 3", 120)
        await js(ws, f"document.querySelector('{tab}').click()")
    await asyncio.sleep(1.2)
    if a.tap_word:
        await js(ws, f"({TAP})('.line.lang-grc .word, .line.lang-hbo .word', 1)")
        await asyncio.sleep(2.5)
    if a.tap_verse:
        await js(ws, "document.querySelector('.verse-row[data-verse=\"1\"] .vnum').click()")
        await asyncio.sleep(3)
    if a.js_file:
        a.js = Path(a.js_file).read_text(encoding="utf-8")
    if a.js:
        await js(ws, a.js)
        await asyncio.sleep(1.5)
    shot = await cmd(ws, "Page.captureScreenshot", {"format": "png"})
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_bytes(base64.b64decode(shot["data"]))
    print("wrote", a.out)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000/")
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--view", default="read")
    ap.add_argument("--state", default=None, help="JSON for atb-reader, e.g. '{\"book\":43,\"chapter\":3,\"textA\":\"web\",\"textB\":\"tagged-grc\"}'")
    ap.add_argument("--tap-word", action="store_true")
    ap.add_argument("--tap-verse", action="store_true")
    ap.add_argument("--dark", action="store_true")
    ap.add_argument("--light", action="store_true")
    ap.add_argument("--js", default=None, help="extra JS to run before the shot")
    ap.add_argument("--js-file", default=None, help="file with JS to run before the shot (quoting-safe)")
    ap.add_argument("--profile", default=str(PROFILE))
    ap.add_argument("--boot", type=float, default=0, help="screenshot the boot screen N seconds after navigation")
    a = ap.parse_args()
    proc = subprocess.Popen([CHROME, "--headless=new", "--remote-debugging-port=9224",
                             f"--window-size={a.width},{a.height}", "--hide-scrollbars",
                             f"--user-data-dir={a.profile}", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        target = None
        for _ in range(40):
            try:
                with urllib.request.urlopen("http://localhost:9224/json") as r:
                    target = next(t for t in json.load(r) if t["type"] == "page")
                break
            except Exception:
                time.sleep(0.5)
        if not target:
            print("Chrome did not start"); return 2
        async with websockets.connect(target["webSocketDebuggerUrl"], max_size=80_000_000, ping_interval=None) as ws:
            await run(ws, a)
    finally:
        proc.kill()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
