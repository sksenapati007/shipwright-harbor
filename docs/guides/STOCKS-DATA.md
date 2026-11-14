# Stocks: where the prices come from

The Stocks ship ships with a default symbol list and **no data source and no key**:

```
^NSEI  ^BSESN  RELIANCE.NS  TCS.NS  HDFCBANK.NS  INFY.NS  ICICIBANK.NS
```

(Nifty 50, Sensex, and five large caps, written the Yahoo way: `.NS` is NSE, `^` marks an index.)
Until you give it a data source the ship shows "Set a data source in Harbor or edit stocks.lua".
You can replace the symbol list with the stash key `symbols` (comma separated) from Harbor.

## What the ship needs from a URL

One HTTPS GET per symbol. `{symbol}` in the URL template is replaced by the current symbol (letters, digits, `. - _` and `^`;
`^` is sent as `%5E`). The answer must be HTTP 200 with this JSON, oldest point first, `t` in Unix seconds:

```json
{ "symbol": "RELIANCE.NS", "points": [ { "t": 1700000000, "close": 2450.5 }, { "t": 1700000300, "close": 2451.1 } ] }
```

Only the last 240 points are used. Most providers answer in a different shape and put the key in the URL, which you
do not want to bake into a script on a device. The clean fix is a tiny proxy that holds the key and reshapes the answer.
Store the proxy's URL as the ship's `src` stash key (Harbor can write it), for example
`https://stocks.example.workers.dev/q/{symbol}`.

## Free providers (each needs a free key; check current limits on their sites)

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
