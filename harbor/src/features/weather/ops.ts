// Weather sync: fetch from Open-Meteo in the browser, then PUT /data/weather.json and /data/place.json.
import type { Client } from '../../proto/client';
import { airUrl, forecastUrl, geocodeUrl, parseGeocode, toAirQuality, toPlaceFile, toWeatherFile, type AirQuality, type GeoHit, type Place, type Units } from '../../lib/openmeteo';

export const WEATHER_PATH = '/data/weather.json';
export const PLACE_PATH = '/data/place.json';
const enc = new TextEncoder();
/** Air quality is optional extra data: it gets this long, then the weather goes out without it. */
export const AIR_TIMEOUT_MS = 4000;

export async function searchCity(query: string, fetchFn: typeof fetch = fetch): Promise<GeoHit[]> {
  if (query.trim().length < 2) throw new Error('Type at least two letters of a city name.');
  const r = await fetchFn(geocodeUrl(query));
  if (!r.ok) throw new Error(`City search failed (${r.status}).`);
  return parseGeocode(await r.json());
}

export async function syncWeather(
  c: Pick<Client, 'put'>,
  p: Place,
  units: Units,
  opts: { fetchFn?: typeof fetch; nowUnix?: number; airTimeoutMs?: number } = {},
): Promise<{ days: number }> {
  const f = opts.fetchFn ?? fetch;
  const r = await f(forecastUrl(p, units));
  if (!r.ok) throw new Error(`Open-Meteo answered ${r.status}.`);
  const forecast = await r.json();
  const aq = await fetchAir(f, p, opts.airTimeoutMs ?? AIR_TIMEOUT_MS);
  const w = toWeatherFile(forecast, p, units, opts.nowUnix ?? Math.floor(Date.now() / 1000), aq);
  await c.put(PLACE_PATH, enc.encode(JSON.stringify(toPlaceFile(p, units))));
  await c.put(WEATHER_PATH, enc.encode(JSON.stringify(w)));
  return { days: w.days.length };
}

/** Air quality, or undefined on any failure (network, status, garbage, timeout): weather must not depend on it. */
async function fetchAir(f: typeof fetch, p: Place, timeoutMs: number): Promise<AirQuality | undefined> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await Promise.race([
      f(airUrl(p), { signal: ctl.signal }),
      new Promise<never>((_, rej) => ctl.signal.addEventListener('abort', () => rej(new Error('timeout')))),
    ]);
    if (!r.ok) return undefined;
    return toAirQuality(await r.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
