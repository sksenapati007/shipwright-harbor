"""Stocks ships the Yahoo chart URL as default source (no key), grouped Indian symbols, and fetches only the visible group."""
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
WANT_GROUPS = {
    "Indices": ["^NSEI", "^BSESN"],
    "NSE sectors": ["^NSEBANK", "^CNXIT", "^CNXAUTO", "^CNXPHARMA", "^CNXFMCG", "^CNXMETAL", "^CNXENERGY", "^CNXREALTY",
                    "^CNXMEDIA", "^CNXPSUBANK", "NIFTY_FIN_SERVICE.NS"],
    "BSE sectors": ["BSE-BANK.BO", "BSE-IT.BO", "BSE-AUTO.BO", "BSE-HC.BO", "BSE-METAL.BO", "BSE-OILGAS.BO", "BSE-REALTY.BO",
                    "BSE-POWER.BO", "BSE-CG.BO", "BSE-CD.BO", "BSE-TECK.BO", "BSE-PSU.BO"],
    "Stocks": ["RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS"],
}


def test_default_groups_and_yahoo_source_no_key():
    src = open(ST).read()
    block = src[src.index("local GROUPS = {"):src.index("local COLS")]
    got = {}
    for m in re.finditer(r'\{ name = "([^"]+)", syms = \{(.*?)\} \},?\n', block + "\n", re.S):
        got[m.group(1)] = re.findall(r'\{ "([^"]+)", "[^"]+" \}', m.group(2))
    assert got == WANT_GROUPS
    for pair in re.findall(r'\{ "[^"]+", "([^"]+)" \}', block):
        assert len(pair) <= 14
    assert re.search(r'^local SOURCE = ""', src, re.M)  # override stays empty
    assert re.search(r'^local SYMBOLS = ""', src, re.M)  # user override stays empty
    assert 'DEFAULT_SOURCE = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=5m&range=1d"' in src
    assert not re.search(r"api[_-]?key|apikey|token=", src, re.I)


def test_default_group_symbols_are_fetched_with_caret_encoded(tmp_path):
    def shot(name, *extra):
        out = tmp_path / name
        r = subprocess.run([sys.executable, DRYDOCK, "shot", ST, "--seed", "1", "--keys", "ok,wait:300", "-o", str(out)] + list(extra),
                           capture_output=True, text=True, timeout=300)
        assert r.returncode == 0, r.stderr
        return hashlib.sha256(out.read_bytes()).hexdigest()

    # First group is Indices: the fixture exists only under the %5E-encoded Yahoo URL.
    assert shot("fetched.png", "--fixtures", FIX) != shot("offline.png")
