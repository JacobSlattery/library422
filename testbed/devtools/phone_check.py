"""Check the APK on a USB-connected phone through the WebView's DevTools socket.

    pixi run python testbed/devtools/phone_check.py

Finds the app's webview_devtools_remote_<pid> socket, forwards it to
localhost:9444, waits for the reader, and reports the catalog state (what
is installed at first launch), the text pair, and any console errors —
the phone-side counterpart of smoke_app.py's boot checks.
"""
import asyncio, json, re, subprocess, sys, time, urllib.request
import websockets

PORT = 9444
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


async def wait_for(ws, expr, timeout=300, label=""):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if await js(ws, expr):
            return True
        await asyncio.sleep(1)
    raise TimeoutError(f"timed out waiting for {label or expr}")


def forward():
    out = subprocess.run(["adb", "shell", "cat", "/proc/net/unix"], capture_output=True, text=True).stdout
    m = re.search(r"webview_devtools_remote_(\d+)", out)
    if not m:
        raise SystemExit("no WebView devtools socket — is the app running on the phone?")
    subprocess.run(["adb", "forward", f"tcp:{PORT}", f"localabstract:webview_devtools_remote_{m.group(1)}"], check=True)


async def main():
    forward()
    target = None
    for _ in range(20):
        try:
            with urllib.request.urlopen(f"http://localhost:{PORT}/json") as r:
                pages = json.load(r)
            target = next((t for t in pages if t.get("type") == "page" and "localhost" in t.get("url", "")), pages[0] if pages else None)
            if target:
                break
        except Exception:
            time.sleep(1)
    if not target:
        print("no page target"); return 2
    print("page:", target.get("url"))
    async with websockets.connect(target["webSocketDebuggerUrl"], max_size=50_000_000, ping_interval=None) as ws:
        await cmd(ws, "Runtime.enable")
        status = await js(ws, "document.querySelector('#status')?.textContent ?? ''")
        print("boot status:", status[:120])
        await wait_for(ws, "!!document.querySelector('#reader') && !document.querySelector('#reader').hidden", 600, "boot")
        await wait_for(ws, "document.querySelectorAll('.verse-row').length > 3 || !!document.querySelector('.packnotice')", 120, "chapter")
        print("texts:", await js(ws, "document.querySelector('#textA').textContent + ' | ' + document.querySelector('#textB').textContent"))
        print("verse rows:", await js(ws, "document.querySelectorAll('.verse-row').length"))
        await js(ws, "document.querySelector('#tab-settings').click()")
        await asyncio.sleep(1.5)
        print("installed:", await js(ws,
              "[...document.querySelectorAll('#downloads .packrow')].filter(r => r.textContent.includes('installed')).map(r => r.querySelector('.packtitle').textContent).join(', ')"))
        print("catalog rows:", await js(ws, "document.querySelectorAll('#downloads .packrow').length"))
        print("on device:", await js(ws, "(document.querySelector('#downloads .hint')?.textContent.match(/On this device now: [^.]*/) || [''])[0]"))
        print("version:", await js(ws, "document.querySelector('#settingsview .result-card p')?.textContent"))
        if "--install" in sys.argv:
            # install one catalog item from the bundled assets and confirm it lands
            title = sys.argv[sys.argv.index("--install") + 1]
            row = f"[...document.querySelectorAll('#downloads .packrow')].find(r => r.querySelector('.packtitle').textContent === {json.dumps(title)})"
            await js(ws, f"[...document.querySelectorAll('#downloads details')].forEach(d => d.open = true); {row}.querySelector('button').click()")
            t0 = time.time()
            await wait_for(ws, f"{row}.textContent.includes('installed')", 600, f"install {title}")
            print(f"installed {title!r} in {time.time() - t0:.1f}s")
            print("on device:", await js(ws, "(document.querySelector('#downloads .hint')?.textContent.match(/On this device now: [^.]*/) || [''])[0]"))
        await js(ws, "document.querySelector('#tab-read').click()")
    errors = [c for c in console if c[0] in ("error", "exception")]
    print("console errors:", len(errors))
    for c in errors[:5]:
        print("  ", (c[1] or "")[:200])
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
