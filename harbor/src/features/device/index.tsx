// Device panel: connect, show what the device told us in HELLO, and keep the clock in step (automatic on connect).
import './features.css';
import { Icon } from '../../lib/icon';
import { registerPanel } from '../../lib/panels';
import { connect, disconnect, getClient, useConnection } from './connection';
import { describeError } from '../../proto/client';
import { useState } from 'preact/hooks';

export function fmtMb(kb: number): string {
  return kb >= 1024 ? `${(kb / 1024).toFixed(kb >= 10240 ? 0 : 1)} MB` : `${kb} KB`;
}

function DevicePanel() {
  const c = useConnection();
  const [note, setNote] = useState<string | null>(null);
  const h = c.hello;
  const resync = async () => {
    const cl = getClient();
    if (!cl) return;
    try {
      await cl.syncClock();
      setNote('Clock set.');
    } catch (e) {
      setNote(describeError(e));
    }
  };
  return (
    <div data-testid="device-panel">
      <h2>
        <Icon name="tablet" size={24} /> Device
      </h2>
      {c.status === 'idle' && (
        <>
          <p class="muted">
            Open <strong>Harbor</strong> on the device first. It shows a name and a 6-digit code; pick the device in the
            browser and type the code when asked.
          </p>
          <button class="btn" data-testid="connect" onClick={() => void connect()}>
            <Icon name="link" /> Connect
          </button>
        </>
      )}
      {c.status === 'connecting' && (
        <p role="status" data-testid="connecting">
          Connecting...
        </p>
      )}
      {c.status === 'connected' && h && (
        <>
          <p role="status" data-testid="connected">
            <Icon name="check" /> Connected to <strong data-testid="device-name">{h.name}</strong>
          </p>
          <dl class="kv" data-testid="device-info">
            <dt>Firmware</dt>
            <dd>{h.fw}</dd>
            <dt>Battery</dt>
            <dd>
              {h.batt}%{h.charging ? ' (charging)' : ''}
            </dd>
            <dt>Free on card</dt>
            <dd>{fmtMb(h.free_kb)}</dd>
            <dt>Clock</dt>
            <dd data-testid="clock-state">
              {c.timeSynced ? 'Set from this device' : c.timeNote ?? 'Setting...'}
            </dd>
          </dl>
          <div class="row">
            <button class="btn" data-testid="resync" onClick={() => void resync()}>
              <Icon name="clock" /> Set clock again
            </button>
            <button class="btn btn-ghost" data-testid="disconnect" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>
          {note && <p class="muted">{note}</p>}
        </>
      )}
      {c.error && (
        <p role="alert" class="err" data-testid="device-error">
          {c.error}
        </p>
      )}
    </div>
  );
}

registerPanel({ id: 'device', title: 'Device', order: 10, render: () => <DevicePanel /> });
