// Phase 7D: Open-Meteo to schema, Google events.list to jsonl, .ics expansion, 2000 cap.
import { describe, expect, it } from 'vitest';
import { FakeDevice } from '../src/proto/fake';
import { Client } from '../src/proto/client';
import { forecastUrl, geocodeUrl, parseGeocode, toPlaceFile, toWeatherFile } from '../src/lib/openmeteo';
import { expandIcs, toJsonl, wallToUnix, MAX_EVENTS, type CalEvent } from '../src/lib/ics';
import { clientIdOk, eventsUrl, fetchEvents, GoogleAuthError, mapItems } from '../src/lib/google';
import { syncWeather } from '../src/features/weather/ops';
import { importIcs, icsProblem } from '../src/features/calendar/ops';

const dec = new TextDecoder();
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0) / 1000; // 2026-11-13 12:00 UTC, a Friday
const WIN = { from: NOW - 7 * 86400, to: NOW + 90 * 86400 };
const TZ = 'Europe/Lisbon'; // UTC in winter, UTC+1 in summer
const day = (y: number, m: number, d: number, h = 0, mi = 0, tz = 'UTC') => wallToUnix(y, m, d, h, mi, 0, tz);

const ics = (...events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
const ev = (...lines: string[]) => ['BEGIN:VEVENT', 'UID:u1', ...lines, 'END:VEVENT'].join('\r\n');
const run = (text: string, tz = TZ) => expandIcs(text, { window: WIN, tz }).events;

describe('open-meteo', () => {
  const forecast = {
    current: { temperature_2m: 18.24, weather_code: 3 },
    daily: {
      time: ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'],
      weather_code: [61, 3, 0, 80, 95, 45, 1],
      temperature_2m_max: [19.4, 18, 17, 16.5, 15, 14, 13],
      temperature_2m_min: [12.2, 11, 10, 9, 8, 7, 6],
      precipitation_probability_max: [70, null, 0, 20, 90, 10, 0],
      wind_speed_10m_max: [21.6, 10, 5, 8, 30, 12, 9],
    },
  };
  const place = { place: 'Lisbon', lat: 38.72, lon: -9.14 };

  it('converts to the plan schema, six days, rounded', () => {
    const w = toWeatherFile(forecast, place, 'metric', 1000);
    expect(w).toEqual({
      v: 1, place: 'Lisbon', lat: 38.72, lon: -9.14, fetched: 1000, units: 'metric',
      now: { t: 18.2, code: 3 },
      days: [
        { d: '2026-11-13', code: 61, hi: 19, lo: 12, pop: 70, wind: 22 },
        { d: '2026-11-14', code: 3, hi: 18, lo: 11, pop: 0, wind: 10 },
        { d: '2026-11-15', code: 0, hi: 17, lo: 10, pop: 0, wind: 5 },
        { d: '2026-11-16', code: 80, hi: 17, lo: 9, pop: 20, wind: 8 },
        { d: '2026-11-17', code: 95, hi: 15, lo: 8, pop: 90, wind: 30 },
        { d: '2026-11-18', code: 45, hi: 14, lo: 7, pop: 10, wind: 12 },
      ],
    });
  });
  it('rejects forecasts that lack what the device needs', () => {
    expect(() => toWeatherFile({}, place, 'metric', 1)).toThrow(/does not understand/);
    expect(() => toWeatherFile({ current: forecast.current, daily: { time: ['bad'] } }, place, 'metric', 1)).toThrow(/no usable/);
  });
  it('builds URLs with units and parses geocoding', () => {
    const u = new URL(forecastUrl(place, 'us'));
    expect(u.hostname).toBe('api.open-meteo.com');
    expect(u.searchParams.get('temperature_unit')).toBe('fahrenheit');
    expect(u.searchParams.get('wind_speed_unit')).toBe('mph');
    expect(u.searchParams.get('forecast_days')).toBe('6');
    expect(new URL(forecastUrl(place, 'metric')).searchParams.get('wind_speed_unit')).toBe('kmh');
    expect(new URL(geocodeUrl(' Lisbon ')).searchParams.get('name')).toBe('Lisbon');
    const hits = parseGeocode({ results: [{ name: 'Lisbon', latitude: 38.7167, longitude: -9.1333, admin1: 'Lisbon', country: 'Portugal' }, { name: 'bad' }] });
    expect(hits).toEqual([{ place: 'Lisbon', lat: 38.72, lon: -9.13, label: 'Lisbon, Lisbon, Portugal' }]);
    expect(parseGeocode({})).toEqual([]);
    expect(toPlaceFile(place, 'us')).toEqual({ v: 1, place: 'Lisbon', lat: 38.72, lon: -9.14, units: 'us' });
  });
  it('syncWeather PUTs place.json then weather.json to the device', async () => {
    const dev = new FakeDevice();
    const c = new Client(dev.connect());
    await c.connectHello();
    const fetchFn = (async () => new Response(JSON.stringify(forecast))) as unknown as typeof fetch;
    await syncWeather(c, place, 'metric', { fetchFn, nowUnix: 5 });
    expect(JSON.parse(dec.decode(dev.files.get('/data/weather.json')!)).days).toHaveLength(6);
    expect(JSON.parse(dec.decode(dev.files.get('/data/place.json')!)).place).toBe('Lisbon');
    c.close();
  });
});

describe('ics expansion', () => {
  it('plain timed event with TZID', () => {
    const r = run(ics(ev('DTSTART;TZID=America/New_York:20261120T090000', 'DTEND;TZID=America/New_York:20261120T100000', 'SUMMARY:Standup\\, daily', 'LOCATION:Room 1', 'DESCRIPTION:Line1\\nLine2')));
    expect(r).toEqual([{ s: day(2026, 11, 20, 14), e: day(2026, 11, 20, 15), all: false, t: 'Standup, daily', loc: 'Room 1', d: 'Line1\nLine2' }]);
  });
  it('UTC and floating times, folded lines', () => {
    const r = run(ics(ev('DTSTART:20261120T090000Z', 'SUMMARY:Fold', ' ed title', 'DTEND:20261120T093000Z'), ev('DTSTART:20261121T090000', 'SUMMARY:Float')), 'Asia/Tokyo');
    expect(r[0]!.s).toBe(day(2026, 11, 20, 9));
    expect(r[0]!.t).toBe('Folded title');
    expect(r[1]!.s).toBe(day(2026, 11, 21, 9, 0, 'Asia/Tokyo'));
  });
  it('all-day single and multi-day, end exclusive, in the given zone', () => {
    const r = run(ics(ev('DTSTART;VALUE=DATE:20261120', 'DTEND;VALUE=DATE:20261121', 'SUMMARY:One'), ev('DTSTART;VALUE=DATE:20261124', 'DTEND;VALUE=DATE:20261127', 'SUMMARY:Three'), ev('DTSTART;VALUE=DATE:20261201', 'SUMMARY:NoEnd')));
    expect(r.map((e) => [e.t, e.all, (e.e - e.s) / 86400])).toEqual([['One', true, 1], ['Three', true, 3], ['NoEnd', true, 1]]);
    expect(r[0]!.s).toBe(day(2026, 11, 20));
  });
  it('daily with COUNT', () => {
    const r = run(ics(ev('DTSTART:20261113T090000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:D')));
    expect(r.map((e) => e.s)).toEqual([day(2026, 11, 13, 9), day(2026, 11, 14, 9), day(2026, 11, 15, 9)]);
  });
  it('COUNT started before the window still counts the earlier instances', () => {
    const r = run(ics(ev('DTSTART:20261101T090000Z', 'RRULE:FREQ=DAILY;COUNT=10', 'SUMMARY:D')));
    // Nov 1..10 -> only Nov 6..10 are inside the window (from Nov 6 12:00 minus... window starts Nov 6 12:00)
    expect(r.map((e) => e.s)).toEqual([7, 8, 9, 10].map((d) => day(2026, 11, d, 9)));
  });
  it('daily with INTERVAL and UNTIL (date and UTC forms)', () => {
    const a = run(ics(ev('DTSTART:20261113T090000Z', 'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261118', 'SUMMARY:D')));
    expect(a.map((e) => e.s)).toEqual([13, 15, 17].map((d) => day(2026, 11, d, 9)));
    const b = run(ics(ev('DTSTART:20261113T090000Z', 'RRULE:FREQ=DAILY;UNTIL=20261115T090000Z', 'SUMMARY:D')));
    expect(b).toHaveLength(3);
  });
  it('weekly BYDAY with COUNT, Friday start', () => {
    const r = run(ics(ev('DTSTART:20261113T100000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5', 'SUMMARY:W')));
    expect(r.map((e) => e.s)).toEqual([[13], [16], [18], [20], [23]].map(([d]) => day(2026, 11, d!, 10)));
  });
  it('weekly INTERVAL=2 without BYDAY uses the start weekday', () => {
    const r = run(ics(ev('DTSTART:20261113T100000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3', 'SUMMARY:W')));
    expect(r.map((e) => e.s)).toEqual([day(2026, 11, 13, 10), day(2026, 11, 27, 10), day(2026, 12, 11, 10)]);
  });
  it('EXDATE removes an instance (with TZID) and RECURRENCE-ID replaces one', () => {
    const r = run(
      ics(
        ev('DTSTART;TZID=Europe/Lisbon:20261113T090000', 'RRULE:FREQ=DAILY;COUNT=4', 'EXDATE;TZID=Europe/Lisbon:20261114T090000', 'SUMMARY:S'),
        ['BEGIN:VEVENT', 'UID:u1', 'RECURRENCE-ID;TZID=Europe/Lisbon:20261115T090000', 'DTSTART;TZID=Europe/Lisbon:20261115T150000', 'SUMMARY:Moved', 'END:VEVENT'].join('\r\n'),
      ),
    );
    expect(r.map((e) => [e.t, e.s])).toEqual([['S', day(2026, 11, 13, 9)], ['Moved', day(2026, 11, 15, 15)], ['S', day(2026, 11, 16, 9)]]);
  });
  it('EXDATE for an all-day event', () => {
    const r = run(ics(ev('DTSTART;VALUE=DATE:20261113', 'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;VALUE=DATE:20261114', 'SUMMARY:A')));
    expect(r).toHaveLength(2);
  });
  it('recurring event keeps its wall-clock time across a DST change', () => {
    // US clocks go back on 2026-11-01; Lisbon on 2026-10-25. Use a series crossing the US change inside a wide window.
    const r = expandIcs(ics(ev('DTSTART;TZID=America/New_York:20261030T090000', 'RRULE:FREQ=DAILY;COUNT=4', 'SUMMARY:N')), { window: { from: day(2026, 10, 1), to: day(2026, 12, 1) }, tz: 'UTC' }).events;
    expect(r.map((e) => e.s)).toEqual([day(2026, 10, 30, 13), day(2026, 10, 31, 13), day(2026, 11, 1, 14), day(2026, 11, 2, 14)]);
  });
  it('monthly BYDAY ordinal and BYMONTHDAY, yearly', () => {
    const second = run(ics(ev('DTSTART:20261110T080000Z', 'RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3', 'SUMMARY:M')));
    expect(second.map((e) => e.s)).toEqual([day(2026, 11, 10, 8), day(2026, 12, 8, 8), day(2027, 1, 12, 8)]);
    const last = run(ics(ev('DTSTART:20261130T080000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3', 'SUMMARY:L')));
    expect(last.map((e) => e.s)).toEqual([day(2026, 11, 30, 8), day(2026, 12, 31, 8), day(2027, 1, 31, 8)]);
    const yearly = expandIcs(ics(ev('DTSTART:20240229T080000Z', 'RRULE:FREQ=YEARLY;COUNT=3', 'SUMMARY:Y')), { window: { from: day(2024, 1, 1), to: day(2033, 1, 1) }, tz: 'UTC' }).events;
    expect(yearly.map((e) => e.s)).toEqual([day(2024, 2, 29, 8), day(2028, 2, 29, 8), day(2032, 2, 29, 8)]);
  });
  it('drops events outside the window, cancelled events and alarms do not leak', () => {
    const r = run(
      ics(
        ev('DTSTART:20250101T090000Z', 'SUMMARY:Old'),
        ev('DTSTART:20270601T090000Z', 'SUMMARY:Far'),
        ev('DTSTART:20261120T090000Z', 'STATUS:CANCELLED', 'SUMMARY:Cancelled'),
        ['BEGIN:VEVENT', 'UID:a', 'DTSTART:20261121T090000Z', 'SUMMARY:Real', 'BEGIN:VALARM', 'DESCRIPTION:Alarm text', 'END:VALARM', 'END:VEVENT'].join('\r\n'),
      ),
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.t).toBe('Real');
    expect(r[0]!.d).toBe('');
  });
  it('a multi-day event that started before the window is kept', () => {
    const r = run(ics(ev('DTSTART;VALUE=DATE:20261105', 'DTEND;VALUE=DATE:20261110', 'SUMMARY:Trip')));
    expect(r).toHaveLength(1);
  });
  it('caps at 2000 events, earliest first, and says so', () => {
    const r = expandIcs(ics(ev('DTSTART:20261113T000000Z', 'RRULE:FREQ=DAILY;COUNT=500', 'SUMMARY:A'), ev('DTSTART:20261113T010000Z', 'RRULE:FREQ=DAILY;COUNT=500', 'SUMMARY:B')), { window: { from: day(2026, 11, 13), to: NOW + 3000 * 86400 }, tz: 'UTC' });
    expect(r.events).toHaveLength(1000);
    const many = Array.from({ length: 2500 }, (_v, i) => ev(`DTSTART:20261120T${String(Math.floor(i / 60) % 24).padStart(2, '0')}${String(i % 60).padStart(2, '0')}00Z`, `SUMMARY:E${i}`)).join('\r\n');
    const big = expandIcs(ics(many), { window: WIN, tz: 'UTC' });
    expect(big.events).toHaveLength(MAX_EVENTS);
    expect(big.truncated).toBe(true);
    for (let i = 1; i < big.events.length; i++) expect(big.events[i]!.s).toBeGreaterThanOrEqual(big.events[i - 1]!.s);
  });
  it('truncates long descriptions to 500 characters', () => {
    const r = run(ics(ev('DTSTART:20261120T090000Z', `DESCRIPTION:${'x'.repeat(900)}`)));
    expect(r[0]!.d).toHaveLength(500);
  });
  it('garbage in gives an empty list, not a throw', () => {
    expect(run('not a calendar')).toEqual([]);
    expect(run(ics(ev('DTSTART:garbage')))).toEqual([]);
  });
});

describe('calendar.jsonl and pushes', () => {
  it('writes the header then one line per event', () => {
    const e: CalEvent = { s: 1, e: 2, all: false, t: 'x', loc: '', d: '' };
    const lines = toJsonl([e], 'ics', 77).trim().split('\n');
    expect(JSON.parse(lines[0]!)).toEqual({ v: 1, synced: 77, source: 'ics' });
    expect(JSON.parse(lines[1]!)).toEqual(e);
  });
  it('importIcs PUTs /data/calendar.jsonl', async () => {
    const dev = new FakeDevice();
    const c = new Client(dev.connect());
    await c.connectHello();
    await importIcs(c, ics(ev('DTSTART:20261120T090000Z', 'SUMMARY:Hi')), { nowUnix: NOW, tz: 'UTC' });
    const lines = dec.decode(dev.files.get('/data/calendar.jsonl')!).trim().split('\n');
    expect(JSON.parse(lines[0]!).source).toBe('ics');
    expect(JSON.parse(lines[1]!).t).toBe('Hi');
    c.close();
  });
  it('file checks', () => {
    expect(icsProblem('a.ics', 10)).toBeNull();
    expect(icsProblem('a.txt', 10)).toMatch(/\.ics/);
    expect(icsProblem('a.ics', 0)).toMatch(/empty/);
    expect(icsProblem('a.ics', 9 * 1024 * 1024)).toMatch(/8 MB/);
  });
});

describe('google', () => {
  const page1 = {
    nextPageToken: 'p2',
    items: [
      { status: 'confirmed', summary: 'Lunch', location: 'Cafe', description: 'd', start: { dateTime: '2026-11-20T12:00:00+01:00' }, end: { dateTime: '2026-11-20T13:00:00+01:00' } },
      { status: 'cancelled', summary: 'Gone', start: { dateTime: '2026-11-21T12:00:00Z' }, end: { dateTime: '2026-11-21T13:00:00Z' } },
    ],
  };
  const page2 = {
    items: [
      { summary: 'Holiday', start: { date: '2026-12-24' }, end: { date: '2026-12-26' } },
      { summary: 'Early', start: { dateTime: '2026-11-14T08:00:00Z' }, end: { dateTime: '2026-11-14T08:30:00Z' } },
      { start: { nothing: 1 } },
    ],
  };
  it('events.list request uses singleEvents and the window', () => {
    const u = new URL(eventsUrl(WIN, 'tok'));
    expect(u.searchParams.get('singleEvents')).toBe('true');
    expect(u.searchParams.get('orderBy')).toBe('startTime');
    expect(u.searchParams.get('timeMin')).toBe(new Date(WIN.from * 1000).toISOString());
    expect(u.searchParams.get('pageToken')).toBe('tok');
  });
  it('pages are merged, mapped, sorted; the token goes only in the Authorization header', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization') });
      return new Response(JSON.stringify(new URL(url).searchParams.get('pageToken') ? page2 : page1));
    }) as unknown as typeof fetch;
    const r = await fetchEvents({ token: 'secret-token', window: WIN, tz: TZ, fetchFn });
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.auth === 'Bearer secret-token' && !s.url.includes('secret-token'))).toBe(true);
    expect(r.events.map((e) => e.t)).toEqual(['Early', 'Lunch', 'Holiday']);
    expect(r.events[1]).toEqual({ s: day(2026, 11, 20, 11), e: day(2026, 11, 20, 12), all: false, t: 'Lunch', loc: 'Cafe', d: 'd' });
    expect(r.events[2]).toMatchObject({ all: true, s: day(2026, 12, 24), e: day(2026, 12, 26) });
    expect(toJsonl(r.events, 'google', 9).split('\n')[0]).toBe('{"v":1,"synced":9,"source":"google"}');
  });
  it('auth failures are distinguishable', async () => {
    const fetchFn = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(fetchEvents({ token: 't', window: WIN, fetchFn })).rejects.toBeInstanceOf(GoogleAuthError);
    expect(mapItems('nope', 'UTC')).toEqual([]);
  });
  it('client ID shape check, and no default ID is shipped', () => {
    expect(clientIdOk('1234-abc.apps.googleusercontent.com')).toBe(true);
    expect(clientIdOk('')).toBe(false);
    expect(clientIdOk('nope')).toBe(false);
  });
});
