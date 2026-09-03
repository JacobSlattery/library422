"""Assemble the static site that library422.org serves.

Copies app/ (the PWA: shell, service worker, vendored runtimes) plus the data
bundle in app/data/ (chunked databases + manifest) into one output folder,
drops files that are not part of the app (DESIGN.md), refuses any file over
Cloudflare's 25 MiB per-asset limit, and writes the host header rules
(_headers). Stdlib only, so the same script runs locally and in CI.

    pixi run site                                  # -> dist/site/ (requires app/data)
    python3 tools/build_site.py --out site         # CI: custom output folder
    python3 tools/build_site.py --allow-no-data    # shell only (no data bundle)
    pixi run landing                               # site/ -> dist/landing/ (library422.org)

The app (app.library422.org) and the landing site (library422.org) are two
origins on purpose — see wrangler.app.jsonc / wrangler.site.jsonc.
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
LANDING = ROOT / "site"
MAX_ASSET = 25 * 1024 * 1024          # Cloudflare Workers/Pages static asset cap
SKIP_NAMES = {"DESIGN.md"}

# Cloudflare `_headers` (Workers static assets + Pages honour this file).
# MIME types for .wasm/.mjs/.webmanifest are set by the host from the
# extension. The service worker and the two version files must never be
# served stale, or a deploy would not reach installed copies; the data chunks
# are fetched by the app with cache:"no-store" and verified by SHA-256, so
# they need no special rule.
HEADERS = """\
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

/sw.js
  Cache-Control: no-cache

/version.json
  Cache-Control: no-cache

/data/manifest.json
  Cache-Control: no-cache
"""

LANDING_HEADERS = """\
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
"""


def copy_tree(src_root: Path, out: Path) -> tuple[int, int, list]:
    """Copy every file under src_root into out; return (count, bytes, too_big)."""
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    total = count = 0
    too_big = []
    for src in sorted(src_root.rglob("*")):
        if src.is_dir():
            continue
        rel = src.relative_to(src_root)
        if src.name in SKIP_NAMES or any(p.startswith(".") for p in rel.parts):
            continue
        size = src.stat().st_size
        if size > MAX_ASSET:
            too_big.append((rel.as_posix(), size))
        dst = out / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        total += size
        count += 1
    return count, total, too_big


APP_URL = "https://app.library422.org"

PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — Library 422</title>
<meta name="description" content="{description}">
<meta name="theme-color" content="#1a1d27">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Library 422">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:image" content="https://library422.org/img/reader-desktop.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/site.css">
</head>
<body>
<main>
<header><a class="home" href="/"><img src="/icon.svg" alt=""> Library 422</a></header>
<nav class="crumbs">{crumbs}</nav>
{body}
<footer>Library 422 · free, public-domain and open-licensed · <a href="/">home</a> · <a href="/guide/">guide</a> · <a href="{app}/">open the app</a></footer>
</main>
</body>
</html>
"""


def html(s) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def page(out: Path, rel: str, title: str, description: str, crumbs: str, body: str) -> None:
    dst = out / rel / "index.html"
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(PAGE.format(title=html(title), description=html(description), crumbs=crumbs,
                               body=body, app=APP_URL), encoding="utf-8")


def slug_of(name: str) -> str:
    import re
    return re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9]+", "-", name.lower()))


def generate_catalog_pages(out: Path) -> int:
    """One page per Library work and per Bible text from site/catalog.json
    (written by build_app_bundle.py), each with a deep link into the app.
    Returns the number of files written."""
    src = LANDING / "catalog.json"
    if not src.exists():
        print("site/catalog.json missing — run `pixi run bundle` (no catalog pages generated)")
        return 0
    cat = json.loads(src.read_text(encoding="utf-8"))
    n = 0
    home = '<a href="/">Home</a>'
    # ---- works
    cats = []
    for w in cat["works"]:
        if w["category"] not in cats:
            cats.append(w["category"])
    rows = []
    for c in cats:
        rows.append(f"<h2>{html(c)}</h2><ul class=\"list\">")
        for w in cat["works"]:
            if w["category"] != c:
                continue
            rows.append(f'<li><a href="/works/{html(w["slug"])}/">{html(w["title"])}</a> '
                        f'<span class="meta">{w["pages"]} pages · {w["mb"]} MB</span></li>')
        rows.append("</ul>")
    page(out, "works", "The Library", "Every work in the Library 422 Library: the Church Fathers, "
         "Josephus, Philo, Aquinas and the intertestamental texts, free to read in the app.",
         f'{home} › Library', "<h1>The Library</h1><p>Fifty-nine works, all public domain, each one "
         "a separate download in the app so you keep only what you want.</p>" + "".join(rows))
    n += 1
    def edition(w):
        s, slug = w["source"], w["slug"]
        if "church-fathers" in s or "aquinas" in s:
            return "the Christian Classics Ethereal Library (CCEL) edition"
        if slug.startswith("pg") or "pg7" in slug:
            return "the Project Gutenberg edition"
        if "philo" in s:
            return "C. D. Yonge's translation (Archive.org scan)"
        return "an Archive.org scan of the printed edition"
    for w in cat["works"]:
        body = (f'<h1>{html(w["title"])}</h1>'
                f'<p class="meta">{html(w["category"])} · {w["pages"]} pages · {w["mb"]} MB download</p>'
                f'<p><a class="cta" href="{APP_URL}/library/{html(w["slug"])}/1">Read it in Library 422</a></p>'
                f'<p>Opens the app in your browser; the first visit installs about 15 MB, and this work is '
                f'a separate download you can keep offline or remove later. Public domain, from '
                f'{edition(w)}.</p>')
        page(out, f"works/{w['slug']}", w["title"], f'{w["title"]} — read free in Library 422.',
             f'{home} › <a href="/works/">Library</a> › {html(w["title"])}', body)
        n += 1
    # ---- Bible texts
    groups = []
    for t in cat["texts"]:
        if t["group"] not in groups:
            groups.append(t["group"])
    rows = []
    for g in groups:
        rows.append(f"<h2>{html(g)}</h2><ul class=\"list\">")
        for t in cat["texts"]:
            if t["group"] != g:
                continue
            rows.append(f'<li><a href="/bibles/{html(t["id"])}/">{html(t["title"])}</a> '
                        f'<span class="meta">{t["books"]} books · {t["mb"]} MB</span></li>')
        rows.append("</ul>")
    page(out, "bibles", "Bible texts", "The eighteen Bible texts in Library 422: English translations, "
         "the Greek and Hebrew originals, the Septuagint, Vulgate and Peshitta.",
         f'{home} › Bible texts', "<h1>Bible texts</h1><p>Read any of them side by side in the app; each "
         "is its own small download.</p>" + "".join(rows))
    n += 1
    for t in cat["texts"]:
        body = (f'<h1>{html(t["title"])}</h1>'
                f'<p class="meta">{html(t["group"])} · {t["books"]} books · {t["mb"]} MB download</p>'
                f'<p>{html(t["blurb"])}</p>'
                f'<p><a class="cta" href="{APP_URL}/read/genesis/1">Read it in Library 422</a></p>'
                f'<p>Open the app, then choose this text in the reader (the tap at the top of the page); '
                f'it downloads in seconds and stays on your device.</p>')
        page(out, f"bibles/{t['id']}", t["title"], f'{t["title"]} — read free in Library 422.',
             f'{home} › <a href="/bibles/">Bible texts</a> › {html(t["title"])}', body)
        n += 1
    print(f"catalog pages: {n}")
    return n


SITE_URL = "https://library422.org"


def write_sitemap(out: Path) -> int:
    """sitemap.xml + robots.txt over every index.html the landing build holds."""
    urls = []
    for f in sorted(out.rglob("index.html")):
        rel = f.parent.relative_to(out).as_posix()
        urls.append(SITE_URL + "/" + (rel + "/" if rel != "." else ""))
    body = "".join(f"  <url><loc>{html(u)}</loc></url>\n" for u in urls)
    (out / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + body + "</urlset>\n",
        encoding="utf-8")
    (out / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {SITE_URL}/sitemap.xml\n",
                                    encoding="utf-8")
    print(f"sitemap: {len(urls)} urls")
    return 2


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=None)
    ap.add_argument("--allow-no-data", action="store_true",
                    help="build without app/data (default: fail)")
    ap.add_argument("--landing", action="store_true",
                    help="assemble the landing site (site/) instead of the app")
    args = ap.parse_args()
    out = Path(args.out or (ROOT / "dist" / ("landing" if args.landing else "site"))).resolve()

    if args.landing:
        count, total, too_big = copy_tree(LANDING, out)
        (out / "_headers").write_text(LANDING_HEADERS, encoding="utf-8")
        count += generate_catalog_pages(out)
        count += write_sitemap(out)
        label = "Landing site"
        manifest = None
    else:
        manifest = APP / "data" / "manifest.json"
        if not manifest.exists() and not args.allow_no_data:
            print("app/data/manifest.json missing — run `pixi run build-data` "
                  "(or fetch the data release) first", file=sys.stderr)
            return 1
        count, total, too_big = copy_tree(APP, out)
        (out / "_headers").write_text(HEADERS, encoding="utf-8")
        label = "Site"

    if too_big:
        for rel, size in too_big:
            print(f"{rel}: {size/1e6:.1f} MB exceeds the 25 MiB asset limit",
                  file=sys.stderr)
        return 1
    print(f"{label}: {out} — {count} files, {total/1e6:.0f} MB"
          + ("" if args.landing or manifest.exists() else " (NO data bundle)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
