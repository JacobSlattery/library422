"""Verify source files against integrity/MANIFEST.sha256.

Reports files that are MODIFIED (hash mismatch), MISSING (in manifest but not on
disk), or NEW (on disk under texts//resources/ but not in the manifest).
Exit code 0 = clean, 1 = any discrepancy.

Usage (from repo root):
    python tools/verify_manifest.py

Stdlib only. Read-only: never modifies anything.
"""
import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIRS = ["texts", "resources"]
MANIFEST = ROOT / "integrity" / "MANIFEST.sha256"
CHUNK = 1 << 20


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    if not MANIFEST.is_file():
        print("No manifest found. Run: python tools/build_manifest.py", file=sys.stderr)
        return 1

    expected = {}
    with open(MANIFEST, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if line:
                digest, rel = line.split("  ", 1)
                expected[rel] = digest

    on_disk = set()
    for d in SOURCE_DIRS:
        base = ROOT / d
        if base.is_dir():
            for p in base.rglob("*"):
                if p.is_file() and ".git" not in p.parts:
                    on_disk.add(p.relative_to(ROOT).as_posix())

    modified, missing = [], []
    for rel, digest in expected.items():
        p = ROOT / rel
        if not p.is_file():
            missing.append(rel)
        elif sha256_of(p) != digest:
            modified.append(rel)
    new = sorted(on_disk - expected.keys())

    for rel in sorted(modified):
        print(f"MODIFIED: {rel}")
    for rel in sorted(missing):
        print(f"MISSING:  {rel}")
    for rel in new:
        print(f"NEW:      {rel}")

    ok = len(expected) - len(modified) - len(missing)
    print(f"\nChecked {len(expected)} manifest entries: "
          f"{ok} OK, {len(modified)} modified, {len(missing)} missing, {len(new)} new.")
    if modified or missing:
        print("INTEGRITY FAILURE — investigate before trusting source files.")
        return 1
    if new:
        print("New files found (not a failure). After acquiring new sources, rebuild "
              "the manifest: python tools/build_manifest.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
