#!/usr/bin/env python3
"""Regenerate dock/catalog.json (plan 3.3): sizes and sha256 from the files, schema validation, `drydock lint` on
every ship.

  python3 dock/build_catalog.py [--ships DIR] [--out FILE] [--base URL] [--updated TS] [--firmware BIN --fw-version V]
                                [--no-lint] [--lint-cmd CMD] [--check]

Ships are DIR/*.lua (default dock/ships), published at <base>ships/<name>.lua. Art named by a ship's
`-- @art file.sbm` header lines is looked up in DIR/../art and listed as assets. Metadata that the ship header does not
carry (summary, author, tags) lives in META below. --check exits 1 when the committed catalogue is out of date.
"""
import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCHEMA = os.path.join(HERE, "catalog.schema.json")
DEFAULT_BASE = "https://sksenapati007.github.io/shipwright-harbor/dock/"
DEFAULT_UPDATED = "2026-11-13T00:00:00Z"
MAX_CATALOG = 1 << 20

# Per-ship metadata the header does not carry. A ship without an entry still publishes (title/version from its header).
META = {
    "snake": {"summary": "Classic snake on a dot-grid board. Arrows steer, OK pauses.", "author": "Shipwright", "tags": ["game", "arcade"]},
    "blockfall": {"summary": "Falling-blocks puzzle on a 10x20 dot grid. Move, turn, drop, clear rows.", "author": "Shipwright", "tags": ["game", "puzzle"]},
    "blackjack": {"summary": "Beat the dealer to 21. Hit, stand and double down.", "author": "Shipwright", "tags": ["game", "cards"]},
    "analytics": {"summary": "Chart any numeric series from a JSON URL you configure (no default URL).", "author": "Shipwright", "tags": ["finance", "chart"]},
    "github": {"summary": "Open issues, review requests and notifications from GitHub. Sign in under Connections.", "author": "Shipwright", "tags": ["tool", "dev"]},
    "coin": {"summary": "Toss a coin: heads or tails with a pixel-art coin, a decide mode with your own words, and your last 10 tosses.", "author": "Shipwright", "tags": ["game", "tool"]},
    "stocks": {"summary": "Indian markets by sector: Nifty, Sensex, NSE and BSE sector indices and large caps, day chart with MA10 and MA20. Free public data, no key (or your own JSON endpoint).", "author": "Shipwright", "tags": ["finance", "chart"]},
}


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def header(path):
    """`-- @key value` lines in the first 30 lines."""
    out = {}
    with open(path, encoding="utf-8") as f:
        for _ in range(30):
            line = f.readline()
            if not line:
                break
            m = re.match(r"^\ufeff?--\s*@(\w+)\s*(.*?)\s*$", line)
            if m:
                out.setdefault(m.group(1), m.group(2))
    return out


def lint(ship, cmd):
    argv = shlex.split(cmd) + ["lint", ship]
    r = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return r.returncode == 0, r.stdout


def default_lint_cmd():
    return os.path.join(ROOT, "drydock", "bin", "drydock")


def build(ships_dir, base, updated, do_lint=True, lint_cmd=None, firmware=None, fw_version=None):
    items = []
    errors = []
    names = sorted(n for n in os.listdir(ships_dir) if n.endswith(".lua"))
    art_dir = os.path.join(os.path.dirname(os.path.abspath(ships_dir)), "art")
    for name in names:
        path = os.path.join(ships_dir, name)
        sid = name[:-4]
        hd = header(path)
        meta = META.get(sid, {})
        if do_lint:
            ok, text = lint(path, lint_cmd or default_lint_cmd())
            if not ok:
                errors.append("drydock lint failed for %s:\n%s" % (name, text))
        item = {
            "id": sid,
            "kind": "ship",
            "title": hd.get("ship", sid),
            "summary": meta.get("summary", hd.get("ship", sid))[:100],
            "author": meta.get("author", ""),
            "version": hd.get("version", "1.0.0"),
            "api": int(hd.get("api", "1")),
            "tags": meta.get("tags", []),
            "accounts": hd.get("accounts", "").split() if hd.get("accounts") else [],
            "path": "ships/" + name,
            "size": os.path.getsize(path),
            "sha256": sha256_file(path),
        }
        if not item["author"]:
            del item["author"]
        assets = []
        for art in hd.get("art", "").split():
            ap = os.path.join(art_dir, art)
            if not os.path.isfile(ap):
                errors.append("%s: art file %s not found in %s" % (name, art, art_dir))
                continue
            assets.append({"path": "art/" + art, "size": os.path.getsize(ap), "sha256": sha256_file(ap)})
        if assets:
            item["assets"] = assets
        items.append(item)
    cat = {"dock": 1, "updated": updated, "base": base}
    if firmware:
        cat["firmware"] = {
            "board": "x4c",
            "version": fw_version or "0.0.0",
            "path": "fw/" + os.path.basename(firmware),
            "size": os.path.getsize(firmware),
            "sha256": sha256_file(firmware),
            "notes": "",
        }
    cat["items"] = items
    return cat, errors


def validate(cat):
    import jsonschema

    with open(SCHEMA, encoding="utf-8") as f:
        schema = json.load(f)
    jsonschema.Draft202012Validator.check_schema(schema)
    errs = sorted(jsonschema.Draft202012Validator(schema).iter_errors(cat), key=lambda e: list(e.path))
    return ["/".join(str(p) for p in e.path) + ": " + e.message for e in errs]


def dumps(cat):
    return json.dumps(cat, indent=2, ensure_ascii=False) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ships", default=os.path.join(HERE, "ships"))
    ap.add_argument("--out", default=os.path.join(HERE, "catalog.json"))
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--updated", default=DEFAULT_UPDATED)
    ap.add_argument("--firmware")
    ap.add_argument("--fw-version")
    ap.add_argument("--no-lint", action="store_true")
    ap.add_argument("--lint-cmd", help="command that accepts `lint SHIP` (default drydock/bin/drydock)")
    ap.add_argument("--check", action="store_true", help="do not write; exit 1 if --out differs")
    a = ap.parse_args(argv)
    cat, errors = build(a.ships, a.base, a.updated, not a.no_lint, a.lint_cmd, a.firmware, a.fw_version)
    errors += validate(cat)
    text = dumps(cat)
    if len(text.encode("utf-8")) > MAX_CATALOG:
        errors.append("catalogue is larger than 1 MiB")
    if errors:
        for e in errors:
            print("build_catalog: " + e, file=sys.stderr)
        return 1
    if a.check:
        try:
            with open(a.out, encoding="utf-8") as f:
                same = f.read() == text
        except OSError:
            same = False
        if not same:
            print("build_catalog: %s is out of date; run dock/build_catalog.py" % a.out, file=sys.stderr)
            return 1
        return 0
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(text)
    print("wrote %s (%d items)" % (a.out, len(cat["items"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
