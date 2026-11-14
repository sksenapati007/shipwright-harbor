// Wi-Fi panel: send network credentials to the device. The password is never shown again; Harbor does not keep it.
import { useEffect, useState } from 'preact/hooks';
import { describeError, type SecretInfo } from '../../proto/client';
import { Icon } from '../../lib/icon';
import { registerPanel } from '../../lib/panels';
import { getClient, useConnection } from '../device/connection';
import { pickSlot, pskProblem, ssidProblem, wifiSecret } from './logic';

function WifiPanel() {
  const conn = useConnection();
  const connected = conn.status === 'connected';
  const [ssid, setSsid] = useState('');
  const [psk, setPsk] = useState('');
  const [list, setList] = useState<SecretInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const c = getClient();
    if (!c) return;
    try {
      setList((await c.secretList()).filter((s) => s.name.startsWith('wifi.')));
    } catch (e) {
      setErr(describeError(e));
    }
  };
  useEffect(() => {
    if (connected) void refresh();
    else setList(null);
  }, [connected]);

  const problem = ssidProblem(ssid) ?? pskProblem(psk);
  const send = async () => {
    const c = getClient();
    if (!c || problem) return;
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      const have = (await c.secretList()).filter((s) => s.name.startsWith('wifi.'));
      const slot = pickSlot(have, ssid);
      if (!slot) throw new Error('The device remembers six networks already. Remove one below first.');
      await c.secretSet(slot, wifiSecret(ssid, psk));
      setOk(`Sent ${ssid}.`);
      setPsk('');
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
    try {
      await c.secretDel(name);
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    }
  };

  return (
    <div data-testid="wifi-panel">
      <h2>
        <Icon name="wifi" size={24} /> Wi-Fi networks
      </h2>
      <p class="muted">Typing a password on the device is slow. Send it from here instead. The password goes to the device only; Harbor does not keep it.</p>
      {err && (
        <p role="alert" class="err" data-testid="wifi-error">
          {err}
        </p>
      )}
      {ok && (
        <p role="status" data-testid="wifi-ok">
          {ok}
        </p>
      )}
      <div class="row">
        <input class="field" aria-label="Network name" placeholder="Network name" data-testid="wifi-ssid" value={ssid} onInput={(e) => setSsid(e.currentTarget.value)} />
        <input
          class="field"
          type="password"
          autocomplete="off"
          aria-label="Password"
          placeholder="Password (empty for open)"
          data-testid="wifi-psk"
          value={psk}
          onInput={(e) => setPsk(e.currentTarget.value)}
        />
      </div>
      {(ssid || psk) && problem && (
        <p role="alert" class="err small" data-testid="wifi-problem">
          {problem}
        </p>
      )}
      <div class="row">
        <button class="btn" data-testid="wifi-send" disabled={!connected || !!problem || busy} onClick={() => void send()}>
          <Icon name="upload" /> Send to device
        </button>
        {!connected && <span class="muted small">Connect to your device first.</span>}
      </div>
      {connected && list && list.length > 0 && (
        <ul class="plain list" data-testid="wifi-list">
          {list.map((s) => (
            <li key={s.name}>
              <div class="grow">{s.label}</div>
              <button class="btn btn-ghost" data-testid="wifi-remove" aria-label={`Remove ${s.label}`} onClick={() => void remove(s.name)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

registerPanel({ id: 'wifi', title: 'Wi-Fi networks', order: 61, render: () => <WifiPanel /> });
