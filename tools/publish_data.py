"""Publish the current app/data/ bundle as a GitHub release and pin it for deploys.

The data bundle (~270 MB of chunked SQLite databases) is too large and too
churny to live in git, so it travels as release assets:

  1. `pixi run build-data`      rebuilds db/ + app/data/ (ends in the check-db gate)
  2. `pixi run publish-data`    THIS: uploads app/data/* as release `data-<date>-<hash>`
                                and writes that tag into app/version.json `data_release`
  3. commit app/version.json (+ whatever app/ changed), push to main
  4. .github/workflows/deploy.yml downloads exactly that release, assembles
     the site and deploys it to Cloudflare

Idempotent: re-running with an unchanged bundle reuses the existing release.
Needs the GitHub CLI (`gh`) logged in to the account that owns the repo.
"""
import hashlib
import json
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "app" / "data"
VERSION = ROOT / "app" / "version.json"
# releases live on the PUBLIC repo (anyone can download them; the deploy
# workflow fetches them without a token)
PUBLIC_REPO = "JacobSlattery/library422"


def run(*args, check=True, capture=False):
    return subprocess.run(args, check=check, text=True,
                          capture_output=capture)


def main() -> int:
    manifest = DATA / "manifest.json"
    if not manifest.exists():
        print("app/data/manifest.json missing — run `pixi run build-data` first",
              file=sys.stderr)
        return 1
    files = sorted(p for p in DATA.iterdir() if p.is_file())
    total = sum(p.stat().st_size for p in files)
    digest = hashlib.sha256(manifest.read_bytes()).hexdigest()[:10]
    tag = f"data-{date.today():%Y%m%d}-{digest}"
    # an unchanged bundle republished on another day must map to the SAME
    # release: look for any existing release carrying this manifest hash
    existing = run("gh", "release", "list", "--repo", PUBLIC_REPO, "--limit", "200",
                   "--json", "tagName", "--jq", ".[].tagName",
                   capture=True, check=False).stdout.split()
    prior = [t for t in existing if t.endswith(f"-{digest}")]
    if prior:
        tag = sorted(prior)[-1]
        print(f"Bundle unchanged — reusing release {tag}")
    else:
        ver = json.loads(VERSION.read_text(encoding="utf-8"))
        notes = (f"Data bundle for Library 422 v{ver.get('version', '?')}: chunked "
                 "SQLite databases (bible, works, vectors) + manifest.json. "
                 "Downloaded by the deploy workflow; the app fetches it from the "
                 "site, not from here.")
        print(f"Uploading {len(files)} files ({total/1e6:.0f} MB) as release {tag} on {PUBLIC_REPO}…")
        run("gh", "release", "create", tag, "--repo", PUBLIC_REPO, "--title", f"Data bundle {tag}",
            "--notes", notes, "--prerelease", "--latest=false", *[str(p) for p in files])
    ver = json.loads(VERSION.read_text(encoding="utf-8"))
    if ver.get("data_release") != tag:
        ver["data_release"] = tag
        VERSION.write_text(json.dumps(ver, indent=2) + "\n", encoding="utf-8")
        print(f"Pinned {tag} in app/version.json — commit it and push to main to deploy.")
    else:
        print(f"app/version.json already pins {tag}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
