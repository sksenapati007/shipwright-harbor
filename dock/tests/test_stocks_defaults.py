"""Stocks ships default symbols (Indian indices and large caps) and no default data source or key."""
import hashlib
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
ST = os.path.join(ROOT, "dock", "ships", "stocks.lua")
DRYDOCK = os.path.join(ROOT, "drydock", "bin", "drydock")
FIX = os.path.join(HERE, "fixtures", "stocks_defaults")
WANT = ["^NSEI", "^BSESN", "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS"]


def test_default_symbols_listed_and_no_source_or_key():
    src = open(ST).read()
    m = re.search(r'^local DEFAULT_SYMBOLS = "([^"]*)"', src, re.M)
    assert m and m.group(1).split(",") == WANT
    assert re.search(r'^local SOURCE = ""', src, re.M)  # no default data source
    assert re.search(r'^local SYMBOLS = ""', src, re.M)  # user override stays empty
    assert not re.search(r"api[_-]?key|apikey|token=", src, re.I)


def test_default_symbols_are_fetched_with_caret_encoded(tmp_path):
    text = open(ST).read().replace('local SOURCE = ""', 'local SOURCE = "https://data.test/q/{symbol}.json"', 1)
    p = tmp_path / "stocks.lua"
    p.write_text(text)

    def shot(name, *extra):
        out = tmp_path / name
        r = subprocess.run([sys.executable, DRYDOCK, "shot", str(p), "--seed", "1", "--keys", "ok,wait:300", "-o", str(out)] + list(extra),
                           capture_output=True, text=True, timeout=300)
        assert r.returncode == 0, r.stderr
        return hashlib.sha256(out.read_bytes()).hexdigest()

    # First default symbol is ^NSEI: the fixture exists only under the %5E-encoded URL.
    assert shot("fetched.png", "--fixtures", FIX) != shot("offline.png")
