"""Boot check for the desktop edition (Electron) — launches desktop-app with
remote debugging, waits for the reader, runs a few of the deterministic
checks through CDP (same approach as smoke_app.py), then quits.

    pixi run python testbed/devtools/smoke_desktop.py

Needs `pixi run python tools/build_desktop.py` (www/ + data/) and
`npm install` in desktop-app/ first. ELECTRON_RUN_AS_NODE is cleared because
the harness this runs under sets it (Electron would start as plain Node).
"""
import asyncio, json, os, subprocess, sys, time, urllib.request
from pathlib import Path
import websockets

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "desktop-app"
ELECTRON = APP / "node_modules" / "electron" / "dist" / "electron.exe"
PORT = 9223

_id = 0
console = []


async def cmd(ws, method, params=None, timeout=60):
    global _id
    _id += 1
    await ws.send(json.dumps({"id": _id, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout))
        if msg.get("method") == "Runtime.consoleAPICalled":
            p = msg["params"]
            console.append((p.get("type"), " ".join(str(a.get("value", a.get("description", ""))) for a in p.get("args", []))))
        elif msg.get("method") == "Runtime.exceptionThrown":
            d = msg["params"]["exceptionDetails"]
            console.append(("exception", (d.get("exception") or {}).get("description") or d.get("text")))
        if msg.get("id") == _id:
            return msg.get("result", {})


async def js(ws, expr, timeout=120):
    r = await cmd(ws, "Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True}, timeout)
    if "exceptionDetails" in r:
        raise RuntimeError("JS: " + json.dumps(r["exceptionDetails"])[:400])
    return r.get("result", {}).get("value")


async def wait_for(ws, expr, timeout=120, label=""):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if await js(ws, expr):
            return True
        await asyncio.sleep(0.5)
    raise TimeoutError(f"timed out waiting for {label or expr}")


results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("  ok   " if ok else "  FAIL ") + name + (f" — {detail}" if detail and not ok else ""))


async def run(ws):
    await cmd(ws, "Runtime.enable")
    await wait_for(ws, "!!document.querySelector('#reader') && !document.querySelector('#reader').hidden", 120, "boot")
    await wait_for(ws, "document.querySelectorAll('.verse-row').length > 5", 60, "chapter render")
    check("desktop: boots to the reader from disk", True)
    check("desktop: transport is the preload bridge", await js(ws, "!!window.desktopDB"))
    await js(ws, "document.querySelector('#tab-settings').click()")
    stxt = await js(ws, "document.querySelector('#settingsview').textContent")
    check("desktop: catalog reports everything installed", await js(ws,
          "[...document.querySelectorAll('#downloads .packrow')].every(r => r.textContent.includes('installed'))"))
    check("desktop: no download buttons", await js(ws,
          "![...document.querySelectorAll('#downloads button')].some(b => /Download/.test(b.textContent))"))
    await js(ws, "document.querySelector('#tab-search').click()")
    await js(ws, "document.querySelector('#q').value = 'shepherd'; document.querySelector('#gobtn').click()")
    await wait_for(ws, "document.querySelectorAll('#results .occ, #results .result-card').length > 0", 30, "search results")
    check("desktop: search works", True)
    await js(ws, "document.querySelector('#tab-library').click()")
    await wait_for(ws, "document.querySelectorAll('#libraryview .bookhead').length > 5", 30, "library shelves")
    check("desktop: library shelves list", True)
    # semantic search runs in the page over vectors from the backend
    n = await js(ws, "import('./js/db.js').then(m => m.semanticSearch('the martyrdom of Polycarp', 3)).then(r => r.length).catch(e => 'ERR ' + e.message)", 300)
    check("desktop: semantic Library search", n == 3, str(n))
    v = await js(ws, "import('./js/db.js').then(m => m.semanticVerses('the Lord is my shepherd, I shall not want', 3)).then(r => r.map(x => x.book + ' ' + x.chapter).join(',')).catch(e => 'ERR ' + e.message)", 300)
    check("desktop: semantic verse search", "Psalm" in str(v), str(v))


async def main():
    # --exe <path>: test a PACKAGED build (dist/desktop/.../Library422.exe) instead
    exe = None
    if "--exe" in sys.argv:
        exe = Path(sys.argv[sys.argv.index("--exe") + 1])
        if not exe.exists():
            print(f"{exe} missing"); return 2
        args = [str(exe), f"--remote-debugging-port={PORT}"]
    else:
        if not ELECTRON.exists():
            print(f"{ELECTRON} missing — npm install in desktop-app/ first"); return 2
        args = [str(ELECTRON), ".", f"--remote-debugging-port={PORT}"]
    env = dict(os.environ)
    env.pop("ELECTRON_RUN_AS_NODE", None)
    proc = subprocess.Popen(args, cwd=(exe.parent if exe else APP), env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ok = False
    try:
        target = None
        for _ in range(60):
            try:
                with urllib.request.urlopen(f"http://localhost:{PORT}/json") as r:
                    target = next(t for t in json.load(r) if t["type"] == "page")
                break
            except Exception:
                time.sleep(0.5)
        if not target:
            print("Electron did not expose a page"); return 2
        async with websockets.connect(target["webSocketDebuggerUrl"], max_size=50_000_000, ping_interval=None) as ws:
            try:
                await run(ws)
            except Exception as e:
                check("run completed", False, repr(e)[:300])
        errors = [c for c in console if c[0] in ("error", "exception")]
        check("desktop: no console errors", not errors, "; ".join((c[1] or "")[:160] for c in errors[:5]))
        failed = [r for r in results if not r[1]]
        print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
        for name, _, detail in failed:
            print(f"  - {name}: {detail}")
        ok = not failed
    finally:
        proc.kill()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
