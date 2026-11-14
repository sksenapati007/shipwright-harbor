// Phase 7D: "Sync weather" and "Import .ics" produce the right PUTs on the fake device.
import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block', timezoneId: 'Europe/Lisbon' });

const cors = { 'access-control-allow-origin': '*' };
const FORECAST = {
  current: { temperature_2m: 18.2, weather_code: 3 },
  daily: {
    time: ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'],
    weather_code: [61, 3, 0, 80, 95, 45, 1],
    temperature_2m_max: [19.4, 18, 17, 16.5, 15, 14, 13],
    temperature_2m_min: [12.2, 11, 10, 9, 8, 7, 6],
    precipitation_probability_max: [70, 40, 0, 20, 90, 10, 0],
    wind_speed_10m_max: [21.6, 10, 5, 8, 30, 12, 9],
  },
};

async function open(page: Page) {
  await page.addInitScript(() => Object.defineProperty(navigator, 'bluetooth', { value: {}, configurable: true }));
  await page.goto('/?fake=1');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('connected')).toBeVisible();
}

const text = (page: Page, p: string) =>
  page.evaluate((path) => {
    const b = (window as any).__fake.files.get(path) as Uint8Array | undefined;
    return b ? new TextDecoder().decode(b) : null;
  }, p);

test('Sync weather: search a city, then weather.json and place.json are PUT', async ({ page }) => {
  const urls: string[] = [];
  await page.route('https://geocoding-api.open-meteo.com/**', (r) => {
    urls.push(r.request().url());
    return r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ results: [{ name: 'Lisbon', latitude: 38.7167, longitude: -9.1333, admin1: 'Lisbon', country: 'Portugal' }] }) });
  });
  await page.route('https://air-quality-api.open-meteo.com/**', (r) => r.abort());
  await page.route('https://api.open-meteo.com/**', (r) => {
    urls.push(r.request().url());
    return r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(FORECAST) });
  });
  await open(page);
  await expect(page.getByTestId('weather-sync')).toBeDisabled(); // no city yet
  await page.getByTestId('weather-query').fill('Lisbon');
  await page.getByTestId('weather-search').click();
  await page.getByTestId('weather-pick').click();
  await expect(page.getByTestId('weather-place')).toHaveText('Lisbon');
  await page.getByTestId('weather-units').selectOption('us');
  await page.getByTestId('weather-sync').click();
  await expect(page.getByTestId('weather-ok')).toContainText('Sent 6 days for Lisbon');
  const w = JSON.parse((await text(page, '/data/weather.json'))!);
  expect(w).toMatchObject({ v: 1, place: 'Lisbon', lat: 38.72, lon: -9.13, units: 'us', now: { t: 18.2, code: 3 } });
  expect(w.days).toHaveLength(6);
  expect(w.days[0]).toEqual({ d: '2026-11-13', code: 61, hi: 19, lo: 12, pop: 70, wind: 22 });
  expect(JSON.parse((await text(page, '/data/place.json'))!)).toEqual({ v: 1, place: 'Lisbon', lat: 38.72, lon: -9.13, units: 'us' });
  expect(urls.find((u) => u.includes('/v1/forecast'))).toContain('temperature_unit=fahrenheit');
});

test('Import .ics: expanded events are PUT to calendar.jsonl', async ({ page }) => {
  await open(page);
  const d = new Date(Date.now() + 2 * 86400000);
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const body = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:a', `DTSTART:${ymd}T090000Z`, `DTEND:${ymd}T100000Z`, 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Standup', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', `DTSTART;VALUE=DATE:${ymd}`, 'SUMMARY:Holiday', 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n');
  await page.getByTestId('ics-file').setInputFiles({ name: 'cal.ics', mimeType: 'text/calendar', buffer: Buffer.from(body) });
  await expect(page.getByTestId('calendar-ok')).toContainText('Sent 4 events');
  const lines = (await text(page, '/data/calendar.jsonl'))!.trim().split('\n').map((l) => JSON.parse(l));
  expect(lines[0]).toMatchObject({ v: 1, source: 'ics' });
  expect(lines.slice(1).map((e) => e.t).sort()).toEqual(['Holiday', 'Standup', 'Standup', 'Standup']);
  expect(lines.slice(1).find((e) => e.t === 'Holiday').all).toBe(true);
  const times = lines.slice(1).map((e) => e.s);
  expect([...times].sort((a, b) => a - b)).toEqual(times); // sorted by start
  // a non-calendar file is refused with a message and nothing more is sent
  await page.getByTestId('ics-file').setInputFiles({ name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  await expect(page.getByTestId('calendar-error')).toContainText('.ics');
});

test('Google sync needs a client ID that looks right; none is shipped', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('google-client-id')).toHaveValue('');
  await expect(page.getByTestId('google-sync')).toBeDisabled();
  await page.getByTestId('google-client-id').fill('123-abc.apps.googleusercontent.com');
  await expect(page.getByTestId('google-sync')).toBeEnabled();
});
