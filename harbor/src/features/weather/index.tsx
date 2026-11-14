// Weather panel: pick a city (Open-Meteo search), choose units, "Sync weather" pushes the forecast to the device.
import { useEffect, useState } from 'preact/hooks';
import { describeError } from '../../proto/client';
import { Icon } from '../../lib/icon';
import { registerPanel } from '../../lib/panels';
import { appStore } from '../../lib/store';
import type { GeoHit, Place, Units } from '../../lib/openmeteo';
import { getClient, useConnection } from '../device/connection';
import { searchCity, syncWeather } from './ops';

const KEY = 'weather.prefs';
interface Prefs {
  place: Place | null;
  units: Units;
}

function WeatherPanel() {
  const conn = useConnection();
  const connected = conn.status === 'connected';
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<GeoHit[]>([]);
  const [prefs, setPrefs] = useState<Prefs>({ place: null, units: 'metric' });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    appStore()
      .get<Prefs>(KEY)
      .then((p) => p && setPrefs({ place: p.place ?? null, units: p.units === 'us' ? 'us' : 'metric' }))
      .catch(() => {});
  }, []);
  const save = (p: Prefs) => {
    setPrefs(p);
    appStore().set(KEY, p).catch(() => {});
  };

  const search = async () => {
    setErr(null);
    setOk(null);
    setBusy('Searching');
    try {
      const r = await searchCity(q);
      setHits(r);
      if (r.length === 0) setErr('No city found with that name.');
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    const c = getClient();
    if (!c || !prefs.place) return;
    setErr(null);
    setOk(null);
    setBusy('Syncing weather');
    try {
      const r = await syncWeather(c, prefs.place, prefs.units);
      setOk(`Sent ${r.days} days for ${prefs.place.place}.`);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="weather-panel">
      <h2>
        <Icon name="sun" size={24} /> Weather
      </h2>
      <p class="muted">
        Harbor fetches the forecast from Open-Meteo (no account, no key) and sends it to the device, so the device can
        show it with Wi-Fi off.
      </p>
      {err && (
        <p role="alert" class="err" data-testid="weather-error">
          {err}
        </p>
      )}
      {ok && (
        <p role="status" data-testid="weather-ok">
          {ok}
        </p>
      )}
      {busy && (
        <p role="status" data-testid="weather-busy">
          {busy}...
        </p>
      )}
      <div class="row">
        <input
          class="field"
          type="search"
          aria-label="City"
          placeholder="City name"
          data-testid="weather-query"
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && void search()}
        />
        <button class="btn" data-testid="weather-search" disabled={!!busy} onClick={() => void search()}>
          Search
        </button>
      </div>
      {hits.length > 0 && (
        <ul class="plain list" data-testid="weather-hits">
          {hits.map((h, i) => (
            <li key={`${h.lat},${h.lon},${i}`}>
              <div class="grow">{h.label}</div>
              <button
                class="btn btn-ghost"
                data-testid="weather-pick"
                onClick={() => {
                  save({ ...prefs, place: { place: h.place, lat: h.lat, lon: h.lon } });
                  setHits([]);
                }}
              >
                Use
              </button>
            </li>
          ))}
        </ul>
      )}
      <dl class="kv">
        <dt>Place</dt>
        <dd data-testid="weather-place">{prefs.place ? prefs.place.place : 'none chosen'}</dd>
        <dt>Units</dt>
        <dd>
          <select
            aria-label="Units"
            data-testid="weather-units"
            value={prefs.units}
            onChange={(e) => save({ ...prefs, units: e.currentTarget.value === 'us' ? 'us' : 'metric' })}
          >
            <option value="metric">Metric (C, km/h)</option>
            <option value="us">US (F, mph)</option>
          </select>
        </dd>
      </dl>
      <div class="row">
        <button class="btn" data-testid="weather-sync" disabled={!connected || !prefs.place || !!busy} onClick={() => void sync()}>
          <Icon name="upload" /> Sync weather
        </button>
        {!connected && <span class="muted small">Connect to your device first.</span>}
      </div>
    </div>
  );
}

registerPanel({ id: 'weather', title: 'Weather', order: 50, render: () => <WeatherPanel /> });
