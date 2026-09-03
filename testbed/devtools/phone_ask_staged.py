"""On-phone ask with stage monitoring: proves it's working, times each stage."""
import asyncio, json, subprocess, sys, time, urllib.request
import websockets

def sh(cmd):
    return subprocess.run(["adb"] + cmd, capture_output=True, text=True).stdout

_id = 0
async def cmd(ws, m, p=None, t=None):
    global _id
    _id += 1
    await ws.send(json.dumps({"id": _id, "method": m, "params": p or {}}))
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), t))
        if msg.get("id") == _id:
            return msg.get("result", {})

async def evaljs(ws, e, t=120):
    r = await cmd(ws, "Runtime.evaluate",
                  {"expression": e, "returnByValue": True, "awaitPromise": True}, t)
    return r.get("result", {}).get("value")

async def wait_js(ws, e, timeout, poll=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if (await evaljs(ws, e)) is True:
            return True
        await asyncio.sleep(poll)
    return False

async def main():
    sock = None
    for _ in range(30):
        out = sh(["shell", "cat", "/proc/net/unix"])
        for line in out.splitlines():
            if "webview_devtools_remote_" in line:
                sock = line.split("@")[-1].strip()
        if sock:
            break
        time.sleep(2)
    sh(["forward", "tcp:9444", f"localabstract:{sock}"])
    targets = json.load(urllib.request.urlopen("http://localhost:9444/json"))
    page = next(t for t in targets if t.get("type") == "page")
    async with websockets.connect(page["webSocketDebuggerUrl"],
                                  max_size=50_000_000, ping_interval=None) as ws:
        await cmd(ws, "Runtime.enable")
        ok = await wait_js(ws,
            "document.querySelectorAll('.verse-row, .workbody').length > 0", 300)
        print("app ready:", ok)
        await evaljs(ws, "document.querySelector('#tab-ask').click()")
        await asyncio.sleep(2)
        # load model if needed
        await evaljs(ws, """
            (() => { const b = [...document.querySelectorAll('#askmodel button')]
              .find(x => x.textContent.includes('Load'));
              if (b) b.click(); })()""")
        loaded = await wait_js(ws,
            "document.querySelector('#askmodel')?.textContent.includes('Model loaded')",
            600)
        print("model loaded:", loaded)
        t0 = time.time()
        await evaljs(ws, """
            (() => { document.querySelector('#askq').value =
              'What fruit did Augustine confess to stealing as a boy?';
              document.querySelector('#askgo').click(); })()""")
        last_stage = ""
        while time.time() - t0 < 900:
            stage = await evaljs(ws,
                "document.querySelector('.thinking .stage')?.textContent")
            done = await evaljs(ws,
                "document.querySelectorAll('.asksources').length > 0")
            if stage and stage != last_stage:
                print(f"  [{time.time()-t0:5.0f}s] stage: {stage}")
                last_stage = stage
            if done:
                break
            await asyncio.sleep(3)
        print(f"done in {time.time()-t0:.0f}s")
        print("ANSWER:", (await evaljs(ws,
            "[...document.querySelectorAll('.msg.a')].at(-1)?.textContent") or "")[:400])
    return 0

sys.exit(asyncio.run(main()))
