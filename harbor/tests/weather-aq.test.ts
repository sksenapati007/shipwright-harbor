// Phase 9.1 W1: sunrise / sunset and air quality in Harbor's weather sync (fixtures for both Open-Meteo APIs).
import { describe, expect, it } from 'vitest';
import { airUrl, forecastUrl, toAirQuality, toWeatherFile } from '../src/lib/openmeteo';
import { syncWeather } from '../src/features/weather/ops';
import { Client } from '../src/proto/client';
import { FakeDevice } from '../src/proto/fake';

const place = { place: 'Lisbon', lat: 38.72, lon: -9.14 };
const forecast = {
  current: { temperature_2m: 18.24, weather_code: 3 },
  daily: {
    time: ['2026-11-13', '2026-11-14', '2026-11-15'],
    weather_code: [61, 3, 0],
    temperature_2m_max: [19.4, 18, 17],
    temperature_2m_min: [12.2, 11, 10],
    precipitation_probability_max: [70, null, 0],
    wind_speed_10m_max: [21.6, 10, 5],
    sunrise: ['2026-11-13T06:58', '2026-11-14T06:59', null],
    sunset: ['2026-11-13T17:21', '2026-11-14T17:20', '2026-11-15T17:19'],
  },
};
const air = {
  latitude: 38.7,
  current: { time: '2026-11-13T09:00', interval: 3600, us_aqi: 42, european_aqi: 25.4, pm2_5: 10.44, pm10: 18, ozone: 62, nitrogen_dioxide: 14.2, sulphur_dioxide: null, carbon_monoxide: 180 },
};
const dec = new TextDecoder();

describe('sunrise / sunset and air quality', () => {
  it('forecast URL asks for sunrise and sunset in local time', () => {
    const u = new URL(forecastUrl(place, 'metric'));
    expect(u.searchParams.get('daily')).toMatch(/,sunrise,sunset$/);
    expect(u.searchParams.get('timezone')).toBe('auto');
  });
  it('air-quality URL lists the pollutants and needs no key', () => {
    const u = new URL(airUrl(place));
    expect(u.origin + u.pathname).toBe('https://air-quality-api.open-meteo.com/v1/air-quality');
    expect(u.searchParams.get('current')).toBe('us_aqi,european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide');
    expect(u.search).not.toMatch(/key/i);
  });
  it('days carry sr / ss as HH:MM, omitted when null', () => {
    const w = toWeatherFile(forecast, place, 'metric', 1);
    expect(w.days[0]).toMatchObject({ d: '2026-11-13', sr: '06:58', ss: '17:21' });
    expect(w.days[2]!.sr).toBeUndefined();
    expect(w.days[2]!.ss).toBe('17:19');
    expect(w.aq).toBeUndefined();
  });
  it('air-quality response becomes the aq block; nulls are dropped', () => {
    expect(toAirQuality(air)).toEqual({ us: 42, eu: 25, pm25: 10.4, pm10: 18, o3: 62, no2: 14.2, co: 180 });
    expect(toAirQuality({})).toBeUndefined();
    expect(toAirQuality({ current: { us_aqi: null } })).toBeUndefined();
    expect(toWeatherFile(forecast, place, 'metric', 1, toAirQuality(air)).aq?.us).toBe(42);
  });
  async function sync(fetchFn: typeof fetch, extra: { airTimeoutMs?: number } = {}) {
    const dev = new FakeDevice();
    const c = new Client(dev.connect());
    await c.connectHello();
    await syncWeather(c, place, 'metric', { fetchFn, nowUnix: 5, ...extra });
    c.close();
    return JSON.parse(dec.decode(dev.files.get('/data/weather.json')!));
  }
  const routed = (airRes: () => Promise<Response>) =>
    (async (url: string) => (String(url).includes('air-quality') ? airRes() : new Response(JSON.stringify(forecast)))) as unknown as typeof fetch;
  it('syncWeather pushes sun times and aq in weather.json', async () => {
    const w = await sync(routed(async () => new Response(JSON.stringify(air))));
    expect(w.days[0].sr).toBe('06:58');
    expect(w.aq).toEqual({ us: 42, eu: 25, pm25: 10.4, pm10: 18, o3: 62, no2: 14.2, co: 180 });
  });
  it('AQI failure (500, garbage, network error, hang) still pushes the weather without aq', async () => {
    for (const res of [
      async () => new Response('oops', { status: 500 }),
      async () => new Response('<html>'),
      async () => { throw new Error('offline'); },
      () => new Promise<Response>(() => {}), // never answers
    ]) {
      const w = await sync(routed(res), { airTimeoutMs: 20 });
      expect(w.days).toHaveLength(3);
      expect(w.days[0].sr).toBe('06:58');
      expect(w.aq).toBeUndefined();
    }
  });
});

describe('toAirQuality clamp', () => {
  it('clamps AQI to 0..999 and drops negatives', () => {
    expect(toAirQuality({ current: { us_aqi: 123456, european_aqi: 1000.4 } })).toEqual({ us: 999, eu: 999 });
    expect(toAirQuality({ current: { us_aqi: -5 } })).toBeUndefined();
  });
});
