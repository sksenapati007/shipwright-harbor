// Ships panel: ships on the device (list, delete), upload a local .lua, and browse/install from the Dock catalogue.
// The catalogue is shown from the saved copy first and refreshed in the background (stale-while-revalidate).
import { useCallback, useEffect, useState } from 'preact/hooks';
import { describeError, LUA_MAX, pathOk, type Entry } from '../../proto/client';
import { Icon } from '../../lib/icon';
import { registerPanel } from '../../lib/panels';
import { getClient, useConnection } from '../device/connection';
import { fmtSize } from '../books/logic';
import {
  InstallError,
  installShip,
  loadCatalog,
  readDockUrl,
  urlOk,
  writeDockUrl,
  catalogUrl,
  DEFAULT_DOCK_URL,
  type Catalog,
  type Item,
} from './dock';

/** Message for a local file that cannot be a ship, or null when it can. */
export function luaProblem(name: string, size: number): string | null {
  if (!/\.lua$/i.test(name)) return 'Ships are .lua files.';
  if (size > LUA_MAX) return `That file is ${fmtSize(size)}. Ships can be at most ${LUA_MAX / 1024} KB.`;
  if (size === 0) return 'That file is empty.';
  const dest = shipPath(name);
  if (!dest) return 'That file name cannot be used on the device. Use letters, digits, dots, dashes and underscores.';
  return null;
}

export function shipPath(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}\.lua$/i.test(name)) return null;
  const p = `/ships/${name}`;
  return pathOk(p) ? p : null;
}

function ShipsPanel() {
  const conn = useConnection();
  const connected = conn.status === 'connected';
  const [ships, setShips] = useState<Entry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [dockUrl, setDockUrl] = useState('');
  const [cat, setCat] = useState<{ cat: Catalog; fromCache: boolean; at: number } | null>(null);
  const [catErr, setCatErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    const c = getClient();
    if (!c) return setShips(null);
    try {
      const all = await c.list('/ships');
      setShips(all.filter((e) => !e.dir && /\.lua$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e) {
      setErr(describeError(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [connected, refresh]);

  const fetchCatalog = useCallback(async (u: string) => {
    if (!urlOk(u)) {
      setCatErr('The Dock address must start with http:// or https://.');
      return;
    }
    setLoading(true);
    setCatErr(null);
    await loadCatalog(u, {
      onData: (c, info) => setCat({ cat: c, fromCache: info.fromCache, at: info.fetchedAt }),
      onError: (m) => setCatErr(m),
    });
    setLoading(false);
  }, []);
  useEffect(() => {
    void readDockUrl().then((u) => {
      if (!u) return setDockUrl(DEFAULT_DOCK_URL); // nothing is fetched until the user presses Load
      setDockUrl(u);
      void fetchCatalog(u);
    });
  }, [fetchCatalog]);

  const upload = async (f: File) => {
    const c = getClient();
    if (!c) return;
    setErr(null);
    setOk(null);
    const problem = luaProblem(f.name, f.size);
    if (problem) return setErr(problem);
    setBusy(`Sending ${f.name}`);
    try {
      await c.put(shipPath(f.name)!, new Uint8Array(await f.arrayBuffer()));
      setOk(`Sent ${f.name}.`);
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const install = async (item: Item) => {
    const c = getClient();
    if (!c || !cat) return;
    setErr(null);
    setOk(null);
    setBusy(`Installing ${item.title}`);
    try {
      const name = await installShip(c, cat.cat, item, {
        catalogUrl: catalogUrl(dockUrl),
        onStep: (s) => setBusy(s),
      });
      setOk(`Installed ${item.title} (${name}).`);
      await refresh();
    } catch (e) {
      setErr(e instanceof InstallError ? e.message : describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (name: string) => {
    const c = getClient();
    if (!c) return;
    setArmed(null);
    try {
      await c.del(`/ships/${name}`);
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    }
  };

  const installed = new Set((ships ?? []).map((s) => s.name));
  const shipItems = cat?.cat.items.filter((i) => i.kind === 'ship') ?? [];

  return (
    <div data-testid="ships-panel">
      <h2>
        <Icon name="code" size={24} /> Ships
      </h2>
      {err && (
        <p role="alert" class="err" data-testid="ships-error">
          {err}
        </p>
      )}
      {ok && (
        <p role="status" data-testid="ships-ok">
          {ok}
        </p>
      )}
      {busy && (
        <p role="status" data-testid="ships-busy">
          {busy}...
        </p>
      )}

      <h3>On the device</h3>
      {!connected && <p class="muted">Connect to your device to see and add ships.</p>}
      {connected && (
        <>
          <div class="row">
            <label class="btn" style="cursor:pointer">
              <Icon name="upload" /> Upload .lua
              <input
                type="file"
                accept=".lua,text/plain"
                data-testid="ship-file"
                disabled={!!busy}
                style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden"
                onChange={(ev) => {
                  const f = ev.currentTarget.files?.[0];
                  ev.currentTarget.value = '';
                  if (f) void upload(f);
                }}
              />
            </label>
            <button class="btn btn-ghost" data-testid="ships-refresh" disabled={!!busy} onClick={() => void refresh()}>
              <Icon name="reload" /> Refresh
            </button>
            <span class="muted small">Up to {LUA_MAX / 1024} KB</span>
          </div>
          {ships && ships.length === 0 && <p class="muted">No ships installed yet.</p>}
          {ships && ships.length > 0 && (
            <ul class="plain list" data-testid="ships-list">
              {ships.map((s) => (
                <li key={s.name} data-testid="ship-row">
                  <div class="grow">
                    <strong>{s.name}</strong>
                    <div class="muted small">{fmtSize(s.size)}</div>
                  </div>
                  {armed === s.name ? (
                    <span class="row">
                      <button class="btn" data-testid="ship-delete-confirm" onClick={() => void remove(s.name)}>
                        Delete for sure
                      </button>
                      <button class="btn btn-ghost" onClick={() => setArmed(null)}>
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button class="btn btn-ghost" data-testid="ship-delete" aria-label={`Delete ${s.name}`} onClick={() => setArmed(s.name)}>
                      Delete
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <h3>Dock catalogue</h3>
      <div class="row">
        <input
          class="field"
          type="url"
          inputMode="url"
          aria-label="Dock catalogue address"
          data-testid="dockcat-url"
          value={dockUrl}
          onInput={(e) => setDockUrl(e.currentTarget.value)}
        />
        <button
          class="btn"
          data-testid="dockcat-load"
          disabled={loading}
          onClick={() => {
            void writeDockUrl(dockUrl.trim());
            void fetchCatalog(dockUrl.trim());
          }}
        >
          <Icon name="reload" /> Load
        </button>
      </div>
      {catErr && (
        <p class="muted" role="status" data-testid="dock-note">
          {catErr}
        </p>
      )}
      {cat && (
        <p class="muted small" data-testid="dock-state">
          {cat.fromCache ? 'Saved copy' : 'Up to date'} · {shipItems.length} ship{shipItems.length === 1 ? '' : 's'}
        </p>
      )}
      {cat && shipItems.length === 0 && <p class="muted">This catalogue has no ships.</p>}
      {shipItems.length > 0 && (
        <ul class="plain list" data-testid="dock-list">
          {shipItems.map((i) => (
            <li key={i.id} data-testid="dock-item">
              <div class="grow">
                <strong>{i.title}</strong> <span class="muted small">v{i.version}{i.author ? ` · ${i.author}` : ''}</span>
                <div class="small">{i.summary}</div>
                {i.tags.length > 0 && <div class="muted small">{i.tags.join(', ')}</div>}
              </div>
              <button
                class="btn"
                data-testid="dock-install"
                aria-label={`Install ${i.title}`}
                disabled={!connected || !!busy || i.api > 1}
                title={!connected ? 'Connect to your device first' : undefined}
                onClick={() => void install(i)}
              >
                <Icon name="download" />{' '}
                {i.api > 1 ? 'Needs newer OS' : installed.has((i.path ?? '').slice((i.path ?? '').lastIndexOf('/') + 1)) ? 'Update' : 'Install'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

registerPanel({ id: 'ships', title: 'Ships', order: 30, render: () => <ShipsPanel /> });
