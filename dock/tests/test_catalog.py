"""Dock catalogue tests (plan 3.3, task 5F): schema validation, hashes match the files, every ship lints,
build_catalog regenerates the committed file."""
import copy
import hashlib
import json
import os
import subprocess
import sys

import pytest

jsonschema = pytest.importorskip("jsonschema")

HERE = os.path.dirname(os.path.abspath(__file__))
DOCK = os.path.dirname(HERE)
ROOT = os.path.dirname(DOCK)
sys.path.insert(0, DOCK)
import build_catalog as bc  # noqa: E402

with open(os.path.join(DOCK, "catalog.schema.json"), encoding="utf-8") as f:
    SCHEMA = json.load(f)
with open(os.path.join(DOCK, "catalog.json"), encoding="utf-8") as f:
    CATALOG = json.load(f)
VALIDATOR = jsonschema.Draft202012Validator(SCHEMA)
SHA_A = "a" * 64


def errors(doc):
    return list(VALIDATOR.iter_errors(doc))


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def ship_item(i=0, **kw):
    it = {"id": "s%d" % i, "kind": "ship", "title": "Ship %d" % i, "summary": "x", "version": "1.0.0", "api": 1,
          "tags": ["game"], "path": "ships/s%d.lua" % i, "size": 100, "sha256": SHA_A}
    it.update(kw)
    return it


def doc_with(*items):
    return {"dock": 1, "updated": "2026-11-13T00:00:00Z", "base": "https://example.invalid/dock/", "items": list(items)}


def test_schema_itself_is_valid():
    jsonschema.Draft202012Validator.check_schema(SCHEMA)


def test_committed_catalog_is_valid():
    assert errors(CATALOG) == []
    assert CATALOG["dock"] == 1
    assert CATALOG["base"] == "https://sksenapati007.github.io/shipwright-harbor/dock/"
    assert len(json.dumps(CATALOG).encode()) <= 1 << 20


def test_300_item_catalog_is_valid_and_small():
    doc = doc_with(*[ship_item(i) for i in range(300)])
    assert errors(doc) == []
    assert len(json.dumps(doc).encode()) < 1 << 20


def test_book_and_art_and_firmware_shapes():
    book = {"id": "pg1342", "kind": "book", "title": "P&P", "summary": "x", "author": "JA", "version": "1",
            "url": "https://example.org/pg1342.epub", "size": 512000, "sha256": SHA_A}
    art = {"id": "pic", "kind": "art", "title": "Pic", "summary": "x", "version": "1", "path": "art/pic.sbm", "size": 900, "sha256": SHA_A}
    ship = ship_item(1, assets=[{"path": "art/pic.sbm", "size": 900, "sha256": SHA_A}], accounts=[])
    doc = doc_with(book, art, ship)
    doc["firmware"] = {"board": "x4c", "version": "1.0.0", "path": "fw/x.bin", "size": 3200000, "sha256": SHA_A, "notes": "n"}
    assert errors(doc) == []


@pytest.mark.parametrize("mutate", [
    lambda d: d.update(dock=2),
    lambda d: d.pop("items"),
    lambda d: d.update(base="https://example.invalid/dock"),  # needs a trailing slash
    lambda d: d.update(extra=1),
    lambda d: d["items"][0].update(sha256="xyz"),
    lambda d: d["items"][0].update(sha256="A" * 64),
    lambda d: d["items"][0].update(kind="zip"),
    lambda d: d["items"][0].update(id="../evil"),
    lambda d: d["items"][0].update(id="Upper"),
    lambda d: d["items"][0].update(size=0),
    lambda d: d["items"][0].update(size=131073),  # a ship over 128 KiB
    lambda d: d["items"][0].update(path="../x.lua"),
    lambda d: d["items"][0].update(path="/abs.lua"),
    lambda d: d["items"][0].update(api=0),
    lambda d: d["items"][0].update(summary="x" * 101),
    lambda d: d["items"][0].pop("path"),
    lambda d: d["items"][0].update(url="ftp://x/y"),
    lambda d: d["items"][0].update(assets=[{"path": "a.sbm", "size": 1}]),
    lambda d: d["items"][0].update(tags=["Bad Tag"]),
    lambda d: d["items"][0].pop("title"),
    lambda d: d.update(firmware={"board": "x3", "version": "1", "path": "p", "size": 1, "sha256": SHA_A}),
])
def test_schema_rejects(mutate):
    doc = doc_with(ship_item(0))
    mutate(doc)
    assert errors(doc), "mutation was accepted"


def test_book_over_64mib_and_books_with_assets_rejected():
    book = {"id": "b", "kind": "book", "title": "B", "summary": "", "version": "1", "url": "https://x.test/b.epub",
            "size": 64 * 1024 * 1024 + 1, "sha256": SHA_A}
    assert errors(doc_with(book))
    book["size"] = 10
    book["assets"] = [{"path": "a.sbm", "size": 1, "sha256": SHA_A}]
    assert errors(doc_with(book))


def test_hashes_and_sizes_match_files():
    assert CATALOG["items"], "catalogue has no items"
    for it in CATALOG["items"]:
        if "path" not in it:
            continue  # off-site url items cannot be checked offline
        p = os.path.join(DOCK, it["path"])
        assert os.path.isfile(p), it["path"]
        assert os.path.getsize(p) == it["size"], it["id"]
        assert sha(p) == it["sha256"], it["id"]
        for a in it.get("assets", []):
            ap = os.path.join(DOCK, a["path"])
            assert os.path.isfile(ap), a["path"]
            assert os.path.getsize(ap) == a["size"]
            assert sha(ap) == a["sha256"]


def test_committed_catalog_is_up_to_date():
    r = bc.main(["--no-lint", "--check"])
    assert r == 0, "run: python3 dock/build_catalog.py"


def test_ship_headers_agree_with_catalog():
    for it in CATALOG["items"]:
        if it["kind"] != "ship":
            continue
        hd = bc.header(os.path.join(DOCK, it["path"]))
        assert hd.get("ship") == it["title"]
        assert hd.get("version", "1.0.0") == it["version"]
        assert int(hd.get("api", "1")) == it["api"] == 1


def test_every_ship_lints():
    """Runs the real linter (the sim binary; drydock rebuilds it when stale, honour PLATFORMIO_BUILD_DIR/DRYDOCK_SIM)."""
    ships = sorted(f for f in os.listdir(os.path.join(DOCK, "ships")) if f.endswith(".lua"))
    assert ships
    for name in ships:
        r = subprocess.run([sys.executable, os.path.join(ROOT, "drydock", "bin", "drydock"), "lint", os.path.join(DOCK, "ships", name)],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert r.returncode == 0, "%s:\n%s" % (name, r.stdout)


# ---- build_catalog on a scratch tree ----
def make_tree(tmp_path, ships):
    d = tmp_path / "ships"
    d.mkdir()
    for n, body in ships.items():
        (d / n).write_text(body, encoding="utf-8")
    return str(d)


GOOD = "-- @ship Demo\n-- @api 1\n-- @version 2.3.4\nship.render = function() end\n"


def test_build_computes_hash_size_and_art(tmp_path):
    ships = make_tree(tmp_path, {"demo.lua": GOOD.replace("-- @api 1", "-- @api 1\n-- @art demo.sbm")})
    (tmp_path / "art").mkdir()
    (tmp_path / "art" / "demo.sbm").write_bytes(b"SBM1" + b"\x00" * 60)
    out = tmp_path / "catalog.json"
    assert bc.main(["--ships", ships, "--out", str(out), "--no-lint", "--base", "https://h.test/d/"]) == 0
    cat = json.loads(out.read_text())
    it = cat["items"][0]
    assert it["id"] == "demo" and it["version"] == "2.3.4" and it["title"] == "Demo"
    assert it["size"] == len(GOOD) + len("-- @art demo.sbm\n")
    assert it["sha256"] == sha(os.path.join(ships, "demo.lua"))
    assert it["assets"][0]["size"] == 64
    assert errors(cat) == []


def test_build_fails_when_lint_fails(tmp_path):
    ships = make_tree(tmp_path, {"demo.lua": GOOD})
    out = tmp_path / "catalog.json"
    assert bc.main(["--ships", ships, "--out", str(out), "--lint-cmd", "false"]) == 1
    assert not out.exists()
    assert bc.main(["--ships", ships, "--out", str(out), "--lint-cmd", "true"]) == 0


def test_build_fails_on_missing_art_and_bad_schema(tmp_path):
    ships = make_tree(tmp_path, {"demo.lua": GOOD + "-- @art gone.sbm\n"})
    assert bc.main(["--ships", ships, "--out", str(tmp_path / "c.json"), "--no-lint"]) == 1
    (tmp_path / "x").mkdir()
    ships2 = make_tree(tmp_path / "x", {"Bad Name.lua": GOOD})
    assert bc.main(["--ships", ships2, "--out", str(tmp_path / "c2.json"), "--no-lint"]) == 1  # id "Bad Name" breaks the schema


def test_check_detects_stale(tmp_path):
    ships = make_tree(tmp_path, {"demo.lua": GOOD})
    out = tmp_path / "catalog.json"
    assert bc.main(["--ships", ships, "--out", str(out), "--no-lint"]) == 0
    assert bc.main(["--ships", ships, "--out", str(out), "--no-lint", "--check"]) == 0
    (tmp_path / "ships" / "demo.lua").write_text(GOOD + "-- changed\n")
    assert bc.main(["--ships", ships, "--out", str(out), "--no-lint", "--check"]) == 1
