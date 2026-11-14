// Open-Meteo (no API key): city search and 6-day forecast, converted to the device schema
// (/data/weather.json and /data/place.json, plan 3.2). Pure functions; the caller does the fetching.

export type Units = 'metric' | 'us';

export interface Place {
  place: string;
  lat: number;
  lon: number;
}

export interface WeatherDay {
  d: string;
  code: number;
  hi: number;
  lo: number;
  pop: number;
  wind: number;
  /** Local "HH:MM"; omitted when the API did not report it. */
  sr?: string;
  ss?: string;
}

/** Air quality block of weather.json ("aq"); every field optional, omitted when not reported. */
export interface AirQuality {
  us?: number;
  eu?: number;
  pm25?: number;
  pm10?: number;
  o3?: number;
  no2?: number;
  so2?: number;
  co?: number;
}

export interface WeatherFile {
  v: 1;
  place: string;
  lat: number;
  lon: number;
  fetched: number;
  units: Units;
  now: { t: number; code: number };
  days: WeatherDay[];
  aq?: AirQuality;
}

export const GEOCODE_BASE = 'https://geocoding-api.open-meteo.com/v1/search';
export const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';
export const AIR_BASE = 'https://air-quality-api.open-meteo.com/v1/air-quality';
export const FORECAST_DAYS = 6;

export function geocodeUrl(query: string): string {
  const q = new URLSearchParams({ name: query.trim(), count: '6', language: 'en', format: 'json' });
  return `${GEOCODE_BASE}?${q}`;
}

export function forecastUrl(p: Place, units: Units): string {
  const q = new URLSearchParams({
    latitude: String(p.lat),
    longitude: String(p.lon),
    current: 'temperature_2m,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset',
    timezone: 'auto',
    forecast_days: String(FORECAST_DAYS),
    temperature_unit: units === 'us' ? 'fahrenheit' : 'celsius',
    wind_speed_unit: units === 'us' ? 'mph' : 'kmh',
  });
  return `${FORECAST_BASE}?${q}`;
}

export function airUrl(p: Place): string {
  const q = new URLSearchParams({
    latitude: String(p.lat),
    longitude: String(p.lon),
    current: 'us_aqi,european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide',
    timezone: 'auto',
  });
  return `${AIR_BASE}?${q}`;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const rec = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {});

export interface GeoHit extends Place {
  label: string;
}

/** Geocoding response to a short list of places. Anything malformed is dropped. */
export function parseGeocode(json: unknown): GeoHit[] {
  const res = rec(json).results;
  if (!Array.isArray(res)) return [];
  const out: GeoHit[] = [];
  for (const r0 of res) {
    const r = rec(r0);
    if (typeof r.name !== 'string' || !isNum(r.latitude) || !isNum(r.longitude)) continue;
    const bits = [r.name, typeof r.admin1 === 'string' ? r.admin1 : '', typeof r.country === 'string' ? r.country : ''].filter(Boolean);
    out.push({ place: r.name.slice(0, 40), lat: round2(r.latitude), lon: round2(r.longitude), label: bits.join(', ') });
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Forecast response to weather.json. Throws a readable Error when the response lacks what the device needs. */
export function toWeatherFile(json: unknown, p: Place, units: Units, nowUnix: number, aq?: AirQuality): WeatherFile {
  const j = rec(json);
  const cur = rec(j.current);
  const daily = rec(j.daily);
  const time = daily.time;
  if (!Array.isArray(time) || time.length === 0 || !isNum(cur.temperature_2m) || !isNum(cur.weather_code)) {
    throw new Error('Open-Meteo sent a forecast Harbor does not understand.');
  }
  const col = (k: string): unknown[] => (Array.isArray(daily[k]) ? (daily[k] as unknown[]) : []);
  const code = col('weather_code');
  const hi = col('temperature_2m_max');
  const lo = col('temperature_2m_min');
  const pop = col('precipitation_probability_max');
  const wind = col('wind_speed_10m_max');
  const sunrise = col('sunrise');
  const sunset = col('sunset');
  const days: WeatherDay[] = [];
  for (let i = 0; i < time.length && days.length < FORECAST_DAYS; i++) {
    const d = time[i];
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || !isNum(code[i]) || !isNum(hi[i]) || !isNum(lo[i])) continue;
    const day: WeatherDay = {
      d,
      code: code[i] as number,
      hi: Math.round(hi[i] as number),
      lo: Math.round(lo[i] as number),
      pop: isNum(pop[i]) ? Math.round(pop[i] as number) : 0, // null when the model has no value
      wind: isNum(wind[i]) ? Math.round(wind[i] as number) : 0,
    };
    const sr = hhmm(sunrise[i]);
    const ss = hhmm(sunset[i]);
    if (sr) day.sr = sr;
    if (ss) day.ss = ss;
    days.push(day);
  }
  if (days.length === 0) throw new Error('Open-Meteo sent no usable forecast days.');
  const file: WeatherFile = {
    v: 1,
    place: p.place,
    lat: p.lat,
    lon: p.lon,
    fetched: nowUnix,
    units,
    now: { t: Math.round(cur.temperature_2m * 10) / 10, code: cur.weather_code },
    days,
  };
  if (aq && Object.keys(aq).length > 0) file.aq = aq;
  return file;
}

/** "2026-11-13T06:58" (or "06:58") to "06:58"; undefined for anything else (null = not reported). */
function hhmm(x: unknown): string | undefined {
  if (typeof x !== 'string') return undefined;
  const m = /(?:T|^)([01]\d|2[0-3]):([0-5]\d)$/.exec(x);
  return m ? `${m[1]}:${m[2]}` : undefined;
}

/** Air-quality response to the device's "aq" block; undefined when the response has no usable "current" values. */
export function toAirQuality(json: unknown): AirQuality | undefined {
  const cur = rec(rec(json).current);
  const out: AirQuality = {};
  const int = (k: string, to: keyof AirQuality) => {
    const v = cur[k];
    if (isNum(v) && v >= 0) out[to] = Math.min(999, Math.round(v)); // same 0..999 clamp as the device
  };
  const dec = (k: string, to: keyof AirQuality) => {
    const v = cur[k];
    if (isNum(v) && v >= 0) out[to] = Math.round(v * 10) / 10;
  };
  int('us_aqi', 'us');
  int('european_aqi', 'eu');
  dec('pm2_5', 'pm25');
  dec('pm10', 'pm10');
  dec('ozone', 'o3');
  dec('nitrogen_dioxide', 'no2');
  dec('sulphur_dioxide', 'so2');
  dec('carbon_monoxide', 'co');
  return Object.keys(out).length > 0 ? out : undefined;
}

/** place.json: what the device needs to refresh weather itself over Wi-Fi. */
export function toPlaceFile(p: Place, units: Units): { v: 1; place: string; lat: number; lon: number; units: Units } {
  return { v: 1, place: p.place, lat: p.lat, lon: p.lon, units };
}
