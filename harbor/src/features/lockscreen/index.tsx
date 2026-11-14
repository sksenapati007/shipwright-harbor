// Lock screen panel: choose what the lock screen shows. Sent as a settings patch; the device applies it at its next start.
import { useEffect, useState } from 'preact/hooks';
import { describeError } from '../../proto/client';
import { Icon } from '../../lib/icon';
import { registerPanel } from '../../lib/panels';
import { appStore } from '../../lib/store';
import { getClient, useConnection } from '../device/connection';
import { DEFAULT_LOCK, LOCK_EVERY, LOCK_MODES, PATCH_PATH, lockPatch, prefsProblem, type LockMode, type LockPrefs } from './logic';

const KEY = 'lock.prefs';

function LockPanel() {
  const conn = useConnection();
  const connected = conn.status === 'connected';
  const [p, setP] = useState<LockPrefs>(DEFAULT_LOCK);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    appStore()
      .get<LockPrefs>(KEY)
      .then((s) => s && setP({ ...DEFAULT_LOCK, ...s }))
      .catch(() => {});
  }, []);
  const change = (n: Partial<LockPrefs>) => {
    const v = { ...p, ...n };
    setP(v);
    setOk(null);
    appStore().set(KEY, v).catch(() => {});
  };
  const problem = prefsProblem(p);
  const send = async () => {
    const c = getClient();
    if (!c || problem) return;
    setErr(null);
    setBusy(true);
    try {
      await c.put(PATCH_PATH, lockPatch(p));
      setOk('Sent. The lock screen changes the next time the device starts.');
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="lock-panel">
      <h2>
        <Icon name="tablet" size={24} /> Lock screen
      </h2>
      <p class="muted">Pick what shows on the lock screen. Changes apply the next time the device starts.</p>
      {err && (
        <p role="alert" class="err" data-testid="lock-error">
          {err}
        </p>
      )}
      {ok && (
        <p role="status" data-testid="lock-ok">
          {ok}
        </p>
      )}
      <div class="row">
        <label>
          Show{' '}
          <select data-testid="lock-mode" value={p.mode} onChange={(e) => change({ mode: e.currentTarget.value as LockMode })}>
            {LOCK_MODES.map((m) => (
              <option value={m.key}>{m.label}</option>
            ))}
          </select>
        </label>
        <label>
          Refresh{' '}
          <select data-testid="lock-every" value={String(p.every)} onChange={(e) => change({ every: Number(e.currentTarget.value) })}>
            {LOCK_EVERY.map((m) => (
              <option value={String(m.value)}>{m.label}</option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" data-testid="lock-quiet" checked={p.quiet} onChange={(e) => change({ quiet: e.currentTarget.checked })} /> Quiet hours (no
          fetches 22:00 to 07:00)
        </label>
      </div>
      {problem && (
        <p role="alert" class="err small" data-testid="lock-problem">
          {problem}
        </p>
      )}
      <div class="row">
        <button class="btn" data-testid="lock-send" disabled={!connected || !!problem || busy} onClick={() => void send()}>
          <Icon name="upload" /> Send to device
        </button>
        {!connected && <span class="muted small">Connect to your device first.</span>}
      </div>
    </div>
  );
}

registerPanel({ id: 'lockscreen', title: 'Lock screen', order: 64, render: () => <LockPanel /> });
