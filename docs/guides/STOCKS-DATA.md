# Stocks: where the prices come from

The Stocks ship works out of the box for Indian markets, with **no key and nothing to set up**. The default source is
Yahoo Finance's public chart endpoint:

```
https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=5m&range=1d
```

Notes, please read:

- It is **unofficial**. Yahoo can change it, block it or rate-limit it at any time. If it breaks, use one of the alternatives below.
- For personal use only. The device fetches the data for you; nothing is stored or republished.
- It needs the User-Agent `Shipwright/1` (the device sends it). A request with no User-Agent is answered with HTTP 429.
- The ship asks only for the symbols of the group on screen, one request at a time (about 6.5 KB each), when you open or
  change a group, and then at most once a minute while the ship stays open. Nothing runs in the background.
- Quotes are delayed (about 15 minutes) and the chart is the current day in 5-minute steps.

## Groups and symbols

Keys: in the list, Up and Down pick a row, Left and Right change group, OK opens the chart (or loads an empty group).
In the chart, OK fetches again, Left and Right move to the previous and next symbol, Up or Down returns to the list.

| Group | Screen name: symbol |
| --- | --- |
| Indices | Nifty 50: `^NSEI`, Sensex: `^BSESN` |
| NSE sectors | Nifty Bank `^NSEBANK`, Nifty IT `^CNXIT`, Nifty Auto `^CNXAUTO`, Nifty Pharma `^CNXPHARMA`, Nifty FMCG `^CNXFMCG`, Nifty Metal `^CNXMETAL`, Nifty Energy `^CNXENERGY`, Nifty Realty `^CNXREALTY`, Nifty Media `^CNXMEDIA`, PSU Bank `^CNXPSUBANK`, Fin Services `NIFTY_FIN_SERVICE.NS` |
| BSE sectors | BSE Bankex `BSE-BANK.BO`, BSE IT `BSE-IT.BO`, BSE Auto `BSE-AUTO.BO`, BSE Health `BSE-HC.BO`, BSE Metal `BSE-METAL.BO`, BSE Oil Gas `BSE-OILGAS.BO`, BSE Realty `BSE-REALTY.BO`, BSE Power `BSE-POWER.BO`, BSE Cap Goods `BSE-CG.BO`, BSE Durables `BSE-CD.BO`, BSE Teck `BSE-TECK.BO`, BSE PSU `BSE-PSU.BO` |
| Stocks | Reliance `RELIANCE.NS`, TCS `TCS.NS`, HDFC Bank `HDFCBANK.NS`, Infosys `INFY.NS`, ICICI Bank `ICICIBANK.NS` |
| My list | your own symbols (stash key `symbols`, comma separated, Yahoo style; `.NS` is NSE, `.BO` is BSE, `^` marks an index) |

BSE FMCG and BSE Finance have no working Yahoo symbol, so they are not listed. A symbol Yahoo does not know shows
"no data for <symbol>" and the rest of the group still loads.

## Using another source

The ship reads two answer shapes: Yahoo's chart JSON (null closes are skipped; `longName` or `shortName` is the title) and
the simple shape below. Set the stash key `src` (Harbor can write it) or edit `SOURCE` in `stocks.lua` to switch.

## What the ship needs from a URL (simple shape)

One HTTPS GET per symbol. `{symbol}` in the URL template is replaced by the current symbol (letters, digits, `. - _` and `^`;
`^` is sent as `%5E`). The answer must be HTTP 200 with this JSON, oldest point first, `t` in Unix seconds:

```json
{ "symbol": "RELIANCE.NS", "points": [ { "t": 1700000000, "close": 2450.5 }, { "t": 1700000300, "close": 2451.1 } ] }
```

Only the last 240 points are used. Most providers answer in a different shape and put the key in the URL, which you
do not want to bake into a script on a device. The clean fix is a tiny proxy that holds the key and reshapes the answer.
Store the proxy's URL as the ship's `src` stash key (Harbor can write it), for example
`https://stocks.example.workers.dev/q/{symbol}`.

## Alternative providers (each needs a free key; check current limits on their sites)

I could not test these offline; coverage of Indian symbols on free tiers changes, so confirm the symbol in the provider's
own symbol search before relying on it.

| Provider | Free key | Intraday call | Notes |
| --- | --- | --- | --- |
| Twelve Data (twelvedata.com) | yes, sign up | `https://api.twelvedata.com/time_series?symbol=RELIANCE&exchange=NSE&interval=5min&outputsize=240&timezone=UTC&apikey=KEY` | Answer: `{"values":[{"datetime":"2025-01-02 09:55:00","close":"1234.50"}, ...]}`, newest first. NSE and BSE equities are listed; index availability on the free plan varies. |
| Alpha Vantage (alphavantage.co) | yes, claim a free key | `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=RELIANCE.BSE&interval=5min&outputsize=compact&apikey=KEY` | Answer: `{"Time Series (5min)":{"2025-01-02 09:55:00":{"4. close":"1234.50"}, ...}}`. Indian coverage is mostly `.BSE` symbols. Very small daily quota. |
| Marketstack (marketstack.com) | yes, free plan | `https://api.marketstack.com/v1/eod?access_key=KEY&symbols=RELIANCE.XNSE&limit=240` | End-of-day bars on the free plan (not intraday), `{"data":[{"date":"2025-01-02T00:00:00+0000","close":1234.5}, ...]}`. The chart then shows days rather than minutes. |

## A proxy in 25 lines (Cloudflare Worker, free plan)

Keep the key as a Worker secret (`wrangler secret put TD_KEY`), never in the code. This reshapes Twelve Data:

```js
// GET /q/<symbol>  ->  { symbol, points: [{ t, close }] }
const MAP = { '^NSEI': { symbol: 'NIFTY', exchange: 'NSE' }, '^BSESN': { symbol: 'SENSEX', exchange: 'BSE' } }; // check names in the provider's search
export default {
  async fetch(req, env) {
    const sym = decodeURIComponent(new URL(req.url).pathname.split('/').pop() || '');
    const m = MAP[sym] || { symbol: sym.replace(/\.NS$/, ''), exchange: 'NSE' };
    const url = 'https://api.twelvedata.com/time_series?interval=5min&outputsize=240&timezone=UTC' +
      `&symbol=${encodeURIComponent(m.symbol)}&exchange=${m.exchange}&apikey=${env.TD_KEY}`;
    const j = await (await fetch(url)).json();
    if (j.status !== 'ok' || !Array.isArray(j.values)) return new Response('upstream error', { status: 502 });
    const points = j.values.map((v) => ({ t: Date.parse(v.datetime.replace(' ', 'T') + 'Z') / 1000, close: Number(v.close) })).reverse();
    return Response.json({ symbol: sym, points }, { headers: { 'cache-control': 'max-age=60' } });
  },
};
```

Then in Harbor (Ships, Stocks, stash) set `src` to `https://<your-worker>.workers.dev/q/{symbol}`. Limit the Worker to your
own use: it spends your free quota, so do not publish its URL.

If you would rather not run anything, edit `SOURCE` at the top of `stocks.lua` with a URL that already answers in the shape
above (for example your own static JSON file on GitHub Pages, refreshed by a scheduled job).
