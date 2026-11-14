// Backup panel: download the device's newest settings backup, restore from a backup file, and set the Dock catalogue URL.
// Restore and the Dock URL are written as small files the device applies at its next start (firmware sys/backup).
import { useEffect, useState } from 'preact/hooks';
import { describeError } from '../../proto/client';
import { Icon } from '../../lib/icon';
import { registerPanel } from '../../lib/panels';
import { BackupProblem, fetchNewestBackup, uploadDockUrl, uploadRestore } from './ops';
import { currentClient, onClientChange } from './session';

/** Hands the bytes to the browser as a file download. */
export function saveFile(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const problem = (e: unknown) => (e instanceof BackupProblem ? e.message : describeError(e));
const row = 'display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:0 0 16px';
const input =
  'flex:1 1 16rem;min-height:44px;padding:8px 10px;font:0.9rem var(--mono);color:var(--fg);background:var(--bg);border:2px solid var(--line)';

function BackupPanel() {
  const [, bump] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dock, setDock] = useState('');
  useEffect(() => onClientChange(() => bump((n) => n + 1)), []);
  const client = currentClient();

  const run = async (f: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await f() });
    } catch (e) {
      setMsg({ ok: false, text: problem(e) });
    } finally {
      setBusy(false);
    }
  };
  const need = () => {
    if (!client) throw new BackupProblem('Connect to your device first.');
    return client;
  };

  return (
    <div data-testid="backup-panel">
      <h2>
        <Icon name="download" size={24} /> Backup &amp; restore
      </h2>
      <p class="muted">
        Settings only: Wi-Fi networks and accounts are never saved. To make a fresh backup, open Settings, Backup &amp; restore on the
        device.
      </p>
      {!client && <p class="muted" data-testid="backup-connect">Connect to your device to use these.</p>}
      <div style={row}>
        <button
          class="btn"
          data-testid="backup-download"
          disabled={busy || !client}
          onClick={() =>
            run(async () => {
              const { name, bytes } = await fetchNewestBackup(need());
              saveFile(name, bytes);
              return `Downloaded ${name}.`;
            })
          }
        >
          <Icon name="download" /> Back up
        </button>
        <label class="btn" style="cursor:pointer" aria-disabled={busy || !client}>
          <Icon name="upload" /> Restore from file
          <input
            type="file"
            accept="application/json,.json"
            data-testid="backup-file"
            disabled={busy || !client}
            style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden"
            onChange={(ev) => {
              const f = (ev.currentTarget as HTMLInputElement).files?.[0];
              (ev.currentTarget as HTMLInputElement).value = '';
              if (!f) return;
              void run(async () => {
                const bytes = new Uint8Array(await f.arrayBuffer());
                await uploadRestore(need(), bytes);
                return 'Sent. Restart the device to apply the settings.';
              });
            }}
          />
        </label>
      </div>
      <h3>
        <Icon name="link" /> Dock catalogue URL
      </h3>
      <div style={row}>
        <input
          style={input}
          type="url"
          inputMode="url"
          placeholder="https://example.org/dock/"
          aria-label="Dock catalogue URL"
          data-testid="dock-url"
          value={dock}
          onInput={(e) => setDock((e.currentTarget as HTMLInputElement).value)}
        />
        <button
          class="btn"
          data-testid="dock-save"
          disabled={busy || !client}
          onClick={() =>
            run(async () => {
              await uploadDockUrl(need(), dock);
              return 'Sent. Restart the device to use the new Dock address.';
            })
          }
        >
          <Icon name="upload" /> Send
        </button>
      </div>
      <p class="muted">Leave it empty and press Send to go back to the built-in catalogue.</p>
      {msg && (
        <p role="status" data-testid="backup-msg" style={msg.ok ? '' : 'color:var(--danger, #b00020)'}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

registerPanel({ id: 'backup', title: 'Backup & restore', order: 80, render: () => <BackupPanel /> });
