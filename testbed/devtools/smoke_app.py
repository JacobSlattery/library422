"""End-to-end smoke test of the app UI in headless Chrome (deterministic
features only — no AI generation). Boots the PWA from the dev server, waits
for the databases, then drives the real DOM through CDP and asserts that each
panel renders what the data layers promise. Also exercises the Ask AI (beta)
toggle and the on-request AI search data download (vectors.db + embedder,
both semantic routes), then removes it again. Console errors and uncaught
exceptions fail the run.

Usage (dev server on :8000 first — `pixi run dev`):
    pixi run python testbed/devtools/smoke_app.py [--fresh] [--url https://library422.org/]
--fresh wipes the Chrome profile (forces a full DB download, ~1-2 min).
--url runs the same checks against another origin (e.g. the live site) in a
separate profile per origin, so a live run never disturbs the local one.
"""
import asyncio, json, shutil, subprocess, sys, time, urllib.request
from pathlib import Path
import websockets

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
URL = "http://localhost:8000/"
if "--url" in sys.argv:
    URL = sys.argv[sys.argv.index("--url") + 1].rstrip("/") + "/"
PROFILE = Path(r"C:\Users\timbe\AppData\Local\Temp\atb-cdp-profile"
               + ("" if URL.startswith("http://localhost") else
                  "-" + "".join(c if c.isalnum() else "_" for c in URL.split("//", 1)[1].strip("/"))))

_id = 0
console = []      # (level, text)


async def cmd(ws, method, params=None, timeout=60):
    global _id
    _id += 1
    await ws.send(json.dumps({"id": _id, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout))
        if msg.get("method") == "Runtime.consoleAPICalled":
            p = msg["params"]
            text = " ".join(str(a.get("value", a.get("description", ""))) for a in p.get("args", []))
            console.append((p.get("type"), text))
        elif msg.get("method") == "Runtime.exceptionThrown":
            d = msg["params"]["exceptionDetails"]
            console.append(("exception", (d.get("exception") or {}).get("description") or d.get("text")))
        if msg.get("id") == _id:
            return msg.get("result", {})


async def js(ws, expr, timeout=120):
    r = await cmd(ws, "Runtime.evaluate",
                  {"expression": expr, "returnByValue": True, "awaitPromise": True}, timeout)
    res = r.get("result", {})
    if "exceptionDetails" in r:
        raise RuntimeError("JS: " + json.dumps(r["exceptionDetails"])[:500])
    return res.get("value")


async def wait_for(ws, expr, timeout=180, label=""):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if await js(ws, expr):
            return True
        await asyncio.sleep(0.5)
    raise TimeoutError(f"timed out waiting for {label or expr}")


# a real tap: the app ignores synthetic click() on words (pointer timing)
TAP = """
(sel, nth=0) => { const n = document.querySelectorAll(sel)[nth]; if (!n) return false;
  const r = n.getBoundingClientRect(); const o = {bubbles:true, clientX:r.left+2, clientY:r.top+2, pointerId:1};
  n.dispatchEvent(new PointerEvent('pointerdown', o)); n.dispatchEvent(new PointerEvent('pointerup', o)); return true; }
"""

results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("  ok   " if ok else "  FAIL ") + name + (f" — {detail}" if detail and not ok else ""))


async def run(ws):
    await cmd(ws, "Runtime.enable")
    await cmd(ws, "Page.enable")
    await cmd(ws, "Page.navigate", {"url": URL})
    print("booting (first run downloads the databases)…")
    await wait_for(ws, "!!document.querySelector('#reader') && !document.querySelector('#reader').hidden", 600, "boot")
    await wait_for(ws, "document.querySelectorAll('.verse-row').length > 5", 60, "chapter render")
    check("boots to the reader", True)
    # a newer data bundle on the server: take the update (PWA route asks first)
    if await js(ws, "!!document.querySelector('.updatebar')"):
        print("   applying pending data update…")
        await js(ws, "[...document.querySelectorAll('.updatebar button')].find(b => b.textContent.startsWith('Update')).click()")
        await asyncio.sleep(3)
        await wait_for(ws, "!document.querySelector('.updatebar') && document.querySelectorAll('.verse-row').length > 5", 600, "data update + reload")
        check("pending data update applied", True)
    # catalog: a first launch installs the core databases + the default Bibles
    # (WEB, YLT); the rest of the checks need everything, so take Settings ->
    # Catalog -> "Download everything"
    await js(ws, "document.querySelector('#tab-settings').click()")
    await wait_for(ws, "!!document.querySelector('#downloads')", 30, "catalog card")
    check("catalog: groups and items listed", await js(ws,
          "document.querySelectorAll('#downloads .packgroup').length >= 10 && document.querySelectorAll('#downloads .packrow').length >= 80"))
    have = await js(ws, "[...document.querySelectorAll('#downloads .packrow')].filter(r => r.textContent.includes('installed')).length")
    if have <= 2:
        check("catalog: first launch has just the default Bibles (WEB, YLT)", await js(ws,
              "[...document.querySelectorAll('#downloads .packrow')].filter(r => r.textContent.includes('installed')).map(r => r.querySelector('.packtitle').textContent).sort().join('|')") == "World English Bible|Young's Literal Translation")
    if await js(ws, "!![...document.querySelectorAll('#downloads button')].find(b => b.textContent.startsWith('Download everything'))"):
        print(f"   {have} item(s) installed — downloading everything…")
        await js(ws, "[...document.querySelectorAll('#downloads button')].find(b => b.textContent.startsWith('Download everything')).click()")
        await wait_for(ws, "![...document.querySelectorAll('#downloads button')].find(b => b.textContent.startsWith('Download everything'))", 1500, "download everything")
        check("catalog: download everything completes", True)
    check("catalog: every item installed", await js(ws,
          "[...document.querySelectorAll('#downloads .packrow')].every(r => r.textContent.includes('installed'))"))
    # remove one Bible and put it back: rows leave and return (FTS included)
    await js(ws, "[...document.querySelectorAll('#downloads .packrow')].find(r => r.querySelector('.packtitle').textContent === 'Tyndale (1525/1530)').querySelector('button').click()")
    await wait_for(ws, "[...document.querySelectorAll('#downloads .packrow')].find(r => r.querySelector('.packtitle').textContent === 'Tyndale (1525/1530)').textContent.includes(' MB') && ![...document.querySelectorAll('#downloads .packrow')].find(r => r.querySelector('.packtitle').textContent === 'Tyndale (1525/1530)').textContent.includes('installed')", 60, "remove tyndale")
    n = await js(ws, "import('./js/db.js').then(m => m.searchText('\"loue\"', 'tyndale', 5)).then(r => r.length)")
    check("catalog: removed text gone from search", n == 0, str(n))
    await js(ws, "[...document.querySelectorAll('#downloads .packrow')].find(r => r.querySelector('.packtitle').textContent === 'Tyndale (1525/1530)').querySelector('button').click()")
    await wait_for(ws, "[...document.querySelectorAll('#downloads .packrow')].find(r => r.querySelector('.packtitle').textContent === 'Tyndale (1525/1530)').textContent.includes('installed')", 120, "reinstall tyndale")
    n = await js(ws, "import('./js/db.js').then(m => m.searchText('\"loue\"', 'tyndale', 5)).then(r => r.length)")
    check("catalog: reinstalled text searchable again", n > 0, str(n))
    await js(ws, "document.querySelector('#tab-read').click()")

    # start every run from no annotations (the profile is reused between runs)
    await js(ws, "new Promise(r => { const q = indexedDB.deleteDatabase('atb-user'); q.onsuccess = q.onerror = q.onblocked = () => r(true); })")
    await js(ws, "localStorage.removeItem('atb-annotations'); localStorage.setItem('atb-reader', JSON.stringify({book:43, chapter:1, textA:'kjv', textB:'tagged-grc', tagMode:'plain', readerMax:30}))")
    await cmd(ws, "Page.navigate", {"url": URL})
    await wait_for(ws, "document.querySelectorAll('.verse-row').length > 5", 120, "reload after reset")

    # ---- verse sheet: John 3:16 -------------------------------------------
    # navigate via the reader state: use the book picker path = simplest is the URL of functions not exported; use vnum click on current chapter (John 1)
    await js(ws, "document.querySelector('.verse-row[data-verse=\"1\"] .vnum').click()")
    await wait_for(ws, "document.querySelector('#wordpanel') && !document.querySelector('#wordpanel').hidden && document.querySelector('#wordpanel').textContent.includes('Cross-references')", 30, "verse sheet")
    await asyncio.sleep(2.5)     # async sections
    txt = await js(ws, "document.querySelector('#wordpanel').textContent")
    check("verse sheet: parallel texts", "KJV" in txt or "World English" in txt)
    check("verse sheet: annotation bar", await js(ws, "!!document.querySelector('#wordpanel .annbar .swatch')"))
    check("verse sheet: share link points at the deep link", await js(ws,
          "([...document.querySelectorAll('#wordpanel .annbar button')].find(b => b.textContent === 'Link')?.title || '').endsWith('/read/john/1/1')"))
    check("verse sheet: OT background", "Old Testament background" in txt, txt[:200])
    check("verse sheet: people/places/events", "People, places & events" in txt)
    check("verse sheet: In the Library", "In the Library" in txt)
    check("verse sheet: Greek edition diff", "Compare Greek editions" in txt)

    # ---- annotations: highlight verse 1 yellow, verify row + reload persistence
    await js(ws, "document.querySelector('#wordpanel .swatch.sw-yellow').click()")
    await asyncio.sleep(0.6)
    check("annotation: row highlighted", await js(ws, "document.querySelector('.verse-row[data-verse=\"1\"]').classList.contains('hl-yellow')"))
    await js(ws, "document.querySelector('#wordpanel .close').click()")

    # ---- entity sheet ------------------------------------------------------
    await js(ws, "document.querySelector('.verse-row[data-verse=\"1\"] .vnum').click()")
    await wait_for(ws, "!!document.querySelector('#wordpanel .kindchip')", 20, "entity links")
    await js(ws, "document.querySelector('#wordpanel .kindchip').nextSibling.click()")
    await wait_for(ws, "document.querySelector('#wordpanel').textContent.includes('Verses')", 20, "entity sheet")
    etxt = await js(ws, "document.querySelector('#wordpanel').textContent")
    check("entity sheet renders with sources line", "Theographic" in etxt)
    await js(ws, "document.querySelector('#wordpanel .close').click()")

    # ---- word panel: tap a Greek word (text B = tagged-grc by default) ------
    tapped = await js(ws, f"({TAP})('.line.lang-grc .word', 1)")
    check("tap a tagged Greek word", tapped)
    await wait_for(ws, "document.querySelector('#wordpanel').textContent.includes('Parsing')", 20, "word panel")
    await asyncio.sleep(2)
    wtxt = await js(ws, "document.querySelector('#wordpanel').textContent")
    check("word panel: plain-English parsing", any(k in wtxt for k in ("Noun", "Verb", "Preposition", "Conjunction", "Article", "Pronoun", "Adjective", "Adverb", "Particle")), wtxt[:160])
    check("word panel: full lexicon section", "Abbott-Smith" in wtxt or "Liddell" in wtxt or "Brown-Driver" in wtxt)
    await js(ws, "document.querySelector('#wordpanel .close').click()")

    # ---- English word tap: dictionary + reverse interlinear needs WEB ------
    # switch text A to web through the settings? The source picker is custom; use localStorage + reload instead
    await js(ws, "localStorage.setItem('atb-reader', JSON.stringify({book:43, chapter:1, textA:'web', textB:'tagged-grc', tagMode:'interlinear', readerMax:30}))")
    await cmd(ws, "Page.navigate", {"url": URL})
    await wait_for(ws, "document.querySelectorAll('.verse-row').length > 5 && document.querySelector('#textA').textContent.includes('World')", 120, "reload with WEB")
    check("interlinear mode renders glosses", await js(ws, "document.querySelectorAll('.iw .gloss').length > 20"))
    tapped = await js(ws, f"({TAP})('.line.lang-en .eword', 4)")
    await wait_for(ws, "document.querySelector('#wordpanel').textContent.length > 40", 20, "english word panel")
    await asyncio.sleep(2)
    ewtxt = await js(ws, "document.querySelector('#wordpanel').textContent")
    check("English word: dictionary or entry", "entry" in ewtxt or "No dictionary" in ewtxt or len(ewtxt) > 60)
    check("English word: behind this word (WEB tagging)", "Behind this word" in ewtxt, ewtxt[:160])
    await js(ws, "document.querySelector('#wordpanel .close').click()")

    # ---- variant markers present somewhere in John 1 ----------------------
    check("variant markers in tagged reader", await js(ws, "document.querySelectorAll('.word.variant').length > 0"))

    # ---- Library: timeline, map, notes list --------------------------------
    await js(ws, "document.querySelector('#tab-library').click()")
    await wait_for(ws, "!!document.querySelector('#libraryview .bookhead')", 20, "library")
    check("library: Intertestamental Texts shelf", await js(ws, "[...document.querySelectorAll('#libraryview .bookhead')].some(b => b.textContent.startsWith('Intertestamental'))"))
    await js(ws, "[...document.querySelectorAll('#libraryview .bookhead')].find(b => b.textContent.startsWith('Timeline')).click()")
    await wait_for(ws, "document.querySelectorAll('#wordpanel .tlrow').length > 100", 20, "timeline")
    check("timeline lists events", True)
    await js(ws, "[...document.querySelectorAll('#libraryview .bookhead')].find(b => b.textContent.startsWith('Map')).click()")
    await wait_for(ws, "!!document.querySelector('#wordpanel canvas.mapcanvas')", 20, "map canvas")
    check("map renders a canvas", await js(ws, "document.querySelector('#wordpanel canvas.mapcanvas').width > 100"))
    await js(ws, "[...document.querySelectorAll('#libraryview .bookhead')].find(b => b.textContent.startsWith('My notes')).click()")
    await wait_for(ws, "document.querySelector('#wordpanel').textContent.includes('John 1:1')", 20, "notes list")
    check("notes list shows the saved highlight", True)
    await js(ws, "document.querySelector('#wordpanel .close').click()")

    # ---- work page: In-the-Library jump + notes bar -------------------------
    await js(ws, "document.querySelector('#tab-read').click()")
    await js(ws, "document.querySelector('.verse-row[data-verse=\"1\"] .vnum').click()")
    await wait_for(ws, "document.querySelector('#wordpanel').textContent.includes('In the Library')", 30, "library refs")
    await js(ws, "[...document.querySelectorAll('#wordpanel .occ a')].find(a => /p\\. \\d+/.test(a.textContent)).click()")
    if await js(ws, "document.body.classList.contains('wide')"):
        # wide screens read the citation in the side pane first; hand over to the full view
        await wait_for(ws, "!document.querySelector('#wordpanel').hidden && !!document.querySelector('#wordpanel .workbody')", 60, "citation pane")
        check("wide: citation opens in the side pane", await js(ws, "document.querySelector('#wordpanel .workbody').textContent.length > 200"))
        await js(ws, "[...document.querySelectorAll('#wordpanel button')].find(b => b.textContent === 'Open in Library').click()")
    try:
        await wait_for(ws, "!document.querySelector('#workview').hidden && !!document.querySelector('#workview .workbody')", 60, "work view")
    except TimeoutError:
        print("   views:", await js(ws, "[...document.querySelectorAll('main')].map(m => m.id + ':' + (m.hidden ? 'hidden' : 'shown')).join(' ')"))
        print("   panel:", (await js(ws, "document.querySelector('#wordpanel').textContent.slice(0, 200)")))
        raise
    await asyncio.sleep(1)
    check("work page opens on the citation", await js(ws, "!!document.querySelector('#workview .jumpref') || document.querySelector('#workview .workbody').textContent.length > 200"))
    check("work page has annotation bar", await js(ws, "!!document.querySelector('#workview .annbar')"))
    if await js(ws, "document.body.classList.contains('wide') && !!document.querySelector('#workview .workbody a.vref')"):
        # wide screens: a scripture reference inside the work opens the verse pane, the work stays
        await js(ws, "document.querySelector('#workview .workbody a.vref').click()")
        await wait_for(ws, "!document.querySelector('#wordpanel').hidden && document.querySelector('#wordpanel').textContent.includes('Cross-references') && !document.querySelector('#workview').hidden", 30, "verse pane beside the work")
        check("wide: scripture reference in a work opens the verse pane beside it", True)
        await js(ws, "document.querySelector('#wordpanel .close').click()")

    # ---- search: entities + parsing search ---------------------------------
    await js(ws, "document.querySelector('#tab-search').click()")
    await js(ws, "document.querySelector('#q').value = 'Nicodemus'; document.querySelector('#gobtn').click()")
    await wait_for(ws, "document.querySelector('#results').textContent.includes('People & places')", 30, "entity search")
    check("search: people & places section", True)
    await js(ws, "document.querySelector('#morphsearch').open = true; document.querySelector('#mq-morph').value = 'V-A?M*'; document.querySelector('#mq-from').value='45'; document.querySelector('#mq-to').value='45'; document.querySelector('#mq-go').click()")
    await wait_for(ws, "/\\d+ matches/.test(document.querySelector('#results').textContent)", 30, "parsing search")
    ptxt = await js(ws, "document.querySelector('#results').textContent")
    check("parsing search: aorist imperatives in Romans", "matches" in ptxt, ptxt[:120])

    # ---- settings: licences card, display mode selector ---------------------
    await js(ws, "document.querySelector('#tab-settings').click()")
    stxt = await js(ws, "document.querySelector('#settingsview').textContent")
    check("settings: sources & licences", "Sources & licences" in stxt and "CC BY 4.0" in stxt)
    check("settings: display mode", "Reader's edition" in stxt)

    # ---- Ask AI (beta): off by default, the toggle brings the tab in/out ------
    check("settings: Ask AI (beta) card", "Ask AI (beta)" in stxt)
    check("ask tab hidden by default", await js(ws, "document.querySelector('#tab-ask').hidden === true"))
    await js(ws, "document.querySelector('#aibeta').click()")
    await asyncio.sleep(0.5)
    check("ask tab appears when enabled", await js(ws, "document.querySelector('#tab-ask').hidden === false"))
    check("settings: AI search data not downloaded by default",
          await js(ws, "document.querySelector('#aicard').textContent.includes('not downloaded')"))
    # download the AI search data from the dev server (vectors.db + embedder),
    # prove both semantic routes, then remove it so the profile returns to baseline.
    # import('./js/db.js') yields the SAME module instance app.js uses (same worker).
    await js(ws, "[...document.querySelectorAll('#aicard button')].find(b => b.textContent === 'Download').click()")
    await wait_for(ws, "document.querySelector('#aicard').textContent.includes('installed (')", 300, "AI search data download")
    check("AI search data: downloads + installs", True)
    n = await js(ws, "import('./js/db.js').then(m => m.semanticSearch('the martyrdom of Polycarp', 3)).then(r => r.length)", 120)
    check("semantic Library search after download", n == 3, str(n))
    v = await js(ws, "import('./js/db.js').then(m => m.semanticVerses('the Lord is my shepherd, I shall not want', 3)).then(r => r.map(x => x.book + ' ' + x.chapter).join(','))", 120)
    check("semantic verse search after download", "Psalm" in (v or ""), str(v))
    await js(ws, "[...document.querySelectorAll('#aicard button')].find(b => b.textContent === 'Remove').click()")
    await wait_for(ws, "document.querySelector('#aicard').textContent.includes('not downloaded')", 60, "AI search data removal")
    check("AI search data: removed", True)
    await js(ws, "document.querySelector('#aibeta').click()")
    await asyncio.sleep(0.2)
    check("ask tab hides when disabled", await js(ws, "document.querySelector('#tab-ask').hidden === true"))

    # ---- deep links: shareable paths open the right place ------------------------
    await cmd(ws, "Page.navigate", {"url": URL + "read/1-corinthians/13/4"})
    await wait_for(ws, "document.querySelectorAll('.verse-row').length > 5 && document.querySelector('#locbtn').textContent.includes('1 Corinthians 13')", 120, "deep link to 1 Cor 13")
    check("deep link: /read/1-corinthians/13/4 opens the chapter", True)
    check("deep link: verse 4 highlighted", await js(ws, "!!document.querySelector('.verse-row[data-verse=\"4\"].flash') || window.scrollY > 0"))
    check("deep link: URL follows navigation", await js(ws, "location.pathname === '/read/1-corinthians/13'"))
    await js(ws, "document.querySelector('#next').click()")
    await wait_for(ws, "location.pathname === '/read/1-corinthians/14'", 20, "url after next")
    check("deep link: URL updates on next chapter", True)
    await cmd(ws, "Page.navigate", {"url": URL + "library/anf01/5"})
    await wait_for(ws, "!document.querySelector('#workview').hidden && document.querySelector('#locbtn').textContent.includes('5/')", 120, "deep link to a work page")
    check("deep link: /library/anf01/5 opens the work at page 5", True)
    await cmd(ws, "Page.navigate", {"url": URL + "search/shepherd"})
    await wait_for(ws, "!document.querySelector('#searchview').hidden && document.querySelectorAll('#results .occ').length > 3", 120, "deep link to a search")
    check("deep link: /search/shepherd runs the search", True)
    await cmd(ws, "Page.navigate", {"url": URL + "word/G3056"})
    await wait_for(ws, "!document.querySelector('#wordpanel').hidden && document.querySelector('#wordpanel').textContent.includes('G3056')", 120, "deep link to a Strong's number")
    check("deep link: /word/G3056 opens the concordance", True)

    # ---- offline: the shell (and a deep link) must open with no network ----------
    await cmd(ws, "Network.enable")
    await cmd(ws, "Network.emulateNetworkConditions", {"offline": True, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})
    try:
        await cmd(ws, "Page.navigate", {"url": URL + "read/john/1"})
        await wait_for(ws, "document.querySelectorAll('.verse-row').length > 5 && document.querySelector('#locbtn').textContent.includes('John 1')", 60, "offline deep link")
        check("offline: shell + deep link open from the service worker cache", True)
    except Exception as e:
        check("offline: shell + deep link open from the service worker cache", False, repr(e)[:200])
    finally:
        await cmd(ws, "Network.emulateNetworkConditions", {"offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})
        await cmd(ws, "Network.disable")

    # ---- coverage notice: the Septuagint has no New Testament -----------------
    await js(ws, "localStorage.setItem('atb-reader', JSON.stringify({book:43, chapter:1, textA:'web', textB:'lxx', tagMode:'plain', readerMax:30}))")
    await cmd(ws, "Page.navigate", {"url": URL})
    await wait_for(ws, "document.querySelectorAll('.verse-row').length > 5", 120, "john 1 web + lxx")
    ctxt = await js(ws, "document.querySelector('#content').textContent")
    check("reader: LXX on John explains it covers the Old Testament", "doesn't include John" in ctxt and "Old Testament" in ctxt, ctxt[:160])

    # ---- versification: Psalm 23 in LXX lines up -----------------------------
    await js(ws, "localStorage.setItem('atb-reader', JSON.stringify({book:19, chapter:23, textA:'kjv', textB:'lxx', tagMode:'plain', readerMax:30}))")
    await cmd(ws, "Page.navigate", {"url": URL})
    await wait_for(ws, "document.querySelectorAll('.verse-row').length >= 6 && document.querySelector('#textB').textContent.includes('Septuagint')", 120, "psalm 23")
    ltxt = await js(ws, "document.querySelector('.verse-row[data-verse=\"1\"] .line.lang-grc')?.textContent ?? ''")
    check("versification: LXX Psalm 22 shown beside KJV Psalm 23", "ποιμαίνει" in ltxt, ltxt[:80])

    # ---- restore default reader state ------------------------------------
    await js(ws, "localStorage.setItem('atb-reader', JSON.stringify({book:43, chapter:1, textA:'kjv', textB:'tagged-grc', tagMode:'plain', readerMax:30}))")


async def main():
    fresh = "--fresh" in sys.argv
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "
                    "? CommandLine -like '*atb-cdp-profile*' | % { Stop-Process -Id $_.ProcessId -Force }"],
                   capture_output=True)
    if fresh and PROFILE.exists():
        shutil.rmtree(PROFILE, ignore_errors=True)
    # --wide runs the same checks at a desktop size (sidebar + side pane layout)
    size = "1400,900" if "--wide" in sys.argv else "900,1400"
    proc = subprocess.Popen([CHROME, "--headless=new", "--no-sandbox", "--disable-gpu",
                             "--remote-debugging-port=9222", f"--window-size={size}",
                             f"--user-data-dir={PROFILE}", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ok = False
    try:
        target = None
        for _ in range(60):
            try:
                with urllib.request.urlopen("http://localhost:9222/json") as r:
                    target = next(t for t in json.load(r) if t["type"] == "page")
                break
            except Exception:
                time.sleep(0.5)
        if not target:
            print("Chrome did not start"); return 2
        async with websockets.connect(target["webSocketDebuggerUrl"], max_size=50_000_000,
                                      ping_interval=None) as ws:
            try:
                await run(ws)
            except Exception as e:
                check("run completed", False, repr(e)[:300])
        errors = [c for c in console if c[0] in ("error", "exception")
                  and "sw.js" not in (c[1] or "") and "favicon" not in (c[1] or "")]
        check("no console errors / uncaught exceptions", not errors,
              "; ".join((c[1] or "")[:160] for c in errors[:5]))
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
