"""Deterministic formatting cleanup for Archive.org OCR texts (Rule 1: writes a
NEW derived file, never touches the source). Content is never changed — only
page furniture and OCR line-wrapping artefacts are removed:

  * optional slice between a --start and --end regex (first match of each),
    so introductions / indexes are left out of the Library
  * running page headers / footers: lines matching any --header regex, and
    lines that are only a page number (arabic or roman)
  * archive.org front matter is outside the slice anyway
  * hyphenated line breaks re-joined ("pre-\\nsupposes" -> "presupposes")
  * double-spaced OCR ("the  Jewish  nation") collapsed to single spaces
  * hard-wrapped lines re-flowed into paragraphs (blank line = paragraph)

Usage:
  pixi run python tools/clean_ocr.py IN OUT [--after RX] [--start RX] [--end RX] [--header RX ...]
The exact command used for each derived file is recorded in
resources/historical-texts/pseudepigrapha/CLEANUP.txt.
"""
import argparse
import re
import sys
from pathlib import Path


def clean(text, start=None, end=None, headers=(), after=None):
    lines = text.split("\n")
    if after:
        # look for --start only past the first --after match (a work's
        # translation title repeats the title that opens its introduction)
        for i, ln in enumerate(lines):
            if re.search(after, ln):
                lines = lines[i:]
                break
    if start:
        for i, ln in enumerate(lines):
            if re.search(start, ln):
                lines = lines[i:]
                break
    if end:
        for i, ln in enumerate(lines):
            if re.search(end, ln):
                lines = lines[:i]
                break
    hdr = [re.compile(h) for h in headers]
    page_no = re.compile(r"^\s*(\d{1,4}|[ivxlcdm]{1,8})\s*$", re.I)
    out = []
    for ln in lines:
        s = ln.rstrip()
        if page_no.match(s) or any(h.search(s) for h in hdr):
            continue
        out.append(s)
    # paragraphs: blank line separated; re-flow the hard wraps inside each
    paras, buf = [], []
    for ln in out:
        if not ln.strip():
            if buf:
                paras.append(buf)
                buf = []
        else:
            buf.append(ln.strip())
    if buf:
        paras.append(buf)
    result = []
    for p in paras:
        joined = ""
        for piece in p:
            piece = re.sub(r"\s{2,}", " ", piece)
            if joined.endswith("-") and piece and piece[0].islower():
                joined = joined[:-1] + piece        # re-join a hyphenated break
            else:
                joined = (joined + " " + piece) if joined else piece
        result.append(joined.strip())
    return "\n\n".join(result) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--after", help="only look for --start past the first match of this regex")
    ap.add_argument("--header", action="append", default=[])
    a = ap.parse_args()
    src, dst = Path(a.src), Path(a.dst)
    if src.resolve() == dst.resolve():
        sys.exit("refusing to overwrite the source (Rule 1)")
    text = src.read_text(encoding="utf-8-sig", errors="strict")
    dst.write_text(clean(text, a.start, a.end, a.header, a.after), encoding="utf-8")
    print(f"{src.name} -> {dst.name}: {dst.stat().st_size} bytes")


if __name__ == "__main__":
    main()
