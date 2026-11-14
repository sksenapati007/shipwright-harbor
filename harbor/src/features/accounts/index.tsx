// Accounts panel: add a bearer-token connection (GitHub preset or custom host) and list what the device holds.
import { useEffect, useState } from 'preact/hooks';
import { describeError, SECRET_MAX, type SecretInfo } from '../../proto/client';
import { Icon } from '../../lib/icon';
import { registerPanel } from '../../lib/panels';
import { appStore } from '../../lib/store';
import { getClient, useConnection } from '../device/connection';
import { PRESETS, buildAccount } from './logic';
import { addAccount, listAccounts } from './ops';

const REMEMBER = 'accounts.remember';

function AccountsPanel() {
  const conn = useConnection();
  const connected = conn.status === 'connected';
  const [presetId, setPresetId] = useState('github');
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]!;
  const [label, setLabel] = useState('GitHub');
  const [host, setHost] = useState('api.github.com');
  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(false);
  const [list, setList] = useState<SecretInfo[] | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const c = getClient();
    if (!c) return;
    try {
      setList(await listAccounts(c));
    } catch (e) {
      setErr(describeError(e));
    }
  };
  useEffect(() => {
    if (connected) void refresh();
    else setList(null);
  }, [connected]);
  useEffect(() => {
    appStore()
      .get<{ [id: string]: { label: string; host: string; token: string } }>(REMEMBER)
      .then((m) => {
        const r = m?.[presetId];
        if (r) {
          setLabel(r.label);
          setHost(r.host);
          setToken(r.token);
          setRemember(true);
        }
      })
      .catch(() => {});
  }, [presetId]);

  const pick = (id: string) => {
    const p = PRESETS.find((x) => x.id === id) ?? PRESETS[0]!;
    setPresetId(p.id);
    setLabel(p.label === 'Custom connection' ? '' : p.label);
    setHost(p.host);
    setToken('');
    setRemember(false);
  };
  const input = { name: preset.name || label, label, host, token };
  const check = buildAccount(input);

  const save = async () => {
    const c = getClient();
    if (!c) return;
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      const key = await addAccount(c, input);
      // Tokens are held in Harbor only until sent, unless "remember" is ticked.
      try {
        const st = appStore();
        const m = (await st.get<Record<string, unknown>>(REMEMBER)) ?? {};
        if (remember) m[presetId] = { label, host, token };
        else delete m[presetId];
        await st.set(REMEMBER, m);
      } catch {
        /* storage unavailable: nothing remembered */
      }
      if (!remember) setToken('');
      setOk(`Sent ${key}.`);
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (name: string) => {
    const c = getClient();
    if (!c) return;
    setArmed(null);
    try {
      await c.secretDel(name);
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    }
  };

  return (
    <div data-testid="accounts-panel">
      <h2>
        <Icon name="link" size={24} /> Accounts
      </h2>
      <p class="muted">
        A token lets a ship call a service as you. It is sent to the device and kept there; the device never shows it again.
        Harbor forgets it after sending unless you tick Remember.
      </p>
      {err && (
        <p role="alert" class="err" data-testid="accounts-error">
          {err}
        </p>
      )}
      {ok && (
        <p role="status" data-testid="accounts-ok">
          {ok}
        </p>
      )}
      <div class="row">
        <select aria-label="Service" data-testid="acct-preset" value={presetId} onChange={(e) => pick(e.currentTarget.value)}>
          {PRESETS.map((p) => (
            <option value={p.id} key={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <input class="field" aria-label="Label" placeholder="Label" data-testid="acct-label" value={label} onInput={(e) => setLabel(e.currentTarget.value)} />
      </div>
      <div class="row">
        <input
          class="field"
          aria-label="Host"
          placeholder="api.example.com"
          data-testid="acct-host"
          value={host}
          readOnly={presetId !== 'custom'}
          onInput={(e) => setHost(e.currentTarget.value)}
        />
        <input
          class="field"
          type="password"
          autocomplete="off"
          aria-label="Token"
          placeholder="Token"
          data-testid="acct-token"
          value={token}
          onInput={(e) => setToken(e.currentTarget.value)}
        />
      </div>
      <p class="muted small" data-testid="acct-size">
        {check.ok ? `${check.bytes} of ${SECRET_MAX} bytes` : ' '}
      </p>
      {token && !check.ok && (
        <p role="alert" class="err small" data-testid="acct-problem">
          {check.error}
        </p>
      )}
      <div class="row">
        <label>
          <input type="checkbox" data-testid="acct-remember" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} /> Remember
          this token in Harbor
        </label>
        <button class="btn" data-testid="acct-save" disabled={!connected || !check.ok || busy} onClick={() => void save()}>
          <Icon name="upload" /> Send to device
        </button>
        {!connected && <span class="muted small">Connect to your device first.</span>}
      </div>
      {connected && list && (
        <>
          <h3>On the device</h3>
          {list.length === 0 && <p class="muted">No connections yet.</p>}
          <ul class="plain list" data-testid="acct-list">
            {list.map((s) => (
              <li key={s.name}>
                <div class="grow">
                  <strong>{s.label}</strong>
                  <div class="muted small">
                    {s.name} {s.hosts?.join(', ')}
                  </div>
                </div>
                {armed === s.name ? (
                  <span class="row">
                    <button class="btn" data-testid="acct-remove-confirm" onClick={() => void remove(s.name)}>
                      Remove
                    </button>
                    <button class="btn btn-ghost" onClick={() => setArmed(null)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <button class="btn btn-ghost" data-testid="acct-remove" aria-label={`Remove ${s.label}`} onClick={() => setArmed(s.name)}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

registerPanel({ id: 'accounts', title: 'Accounts', order: 60, render: () => <AccountsPanel /> });
