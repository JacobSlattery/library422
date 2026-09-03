"""Build a SHA-256 checksum manifest of all source files under texts/ and resources/.

Deterministic: files are walked and written in sorted order, paths are stored
POSIX-style relative to the repo root. Output: integrity/MANIFEST.sha256
(one line per file: "<sha256>  <relative-path>", same format sha256sum uses).

Usage (from repo root):
    python tools/build_manifest.py

Stdlib only. Never modifies source files.
"""
import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIRS = ["texts", "resources"]
OUT = ROOT / "integrity" / "MANIFEST.sha256"
CHUNK = 1 << 20  # 1 MiB


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    files = []
    for d in SOURCE_DIRS:
        base = ROOT / d
        if not base.is_dir():
            print(f"warning: {d}/ not found, skipping", file=sys.stderr)
            continue
        for p in base.rglob("*"):
            # .git internals belong to the nested clones, not to the source data
            if p.is_file() and ".git" not in p.parts:
                files.append(p)

    files.sort(key=lambda p: p.relative_to(ROOT).as_posix())

    OUT.parent.mkdir(exist_ok=True)
    n = 0
    with open(OUT, "w", encoding="utf-8", newline="\n") as out:
        for p in files:
            rel = p.relative_to(ROOT).as_posix()
            out.write(f"{sha256_of(p)}  {rel}\n")
            n += 1

    print(f"Wrote {n} entries to {OUT.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
