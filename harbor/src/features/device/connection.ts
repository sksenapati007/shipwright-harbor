// The one device connection Harbor holds. Features read it through getClient()/useConnection(); the device panel
// drives connect()/disconnect(). On every connect: HELLO, then TIME (clock + zone + next DST change) automatically.
//
// Test mode: a page opened with ?fake talks to an in-memory FakeDevice (exposed as window.__fake) instead of Web
// Bluetooth, so the Playwright tests run the real client against the device model. The fake is loaded on demand.
import { useEffect, useState } from 'preact/hooks';
import { Client, describeError, type Hello } from '../../proto/client';
import type { Transport } from '../../proto/transport';
import { WebBluetoothTransport } from '../../proto/webbluetooth';
import { appStore } from '../../lib/store';
import { provideClient } from '../backup/session';

export interface Connection {
  status: 'idle' | 'connecting' | 'connected';
  hello: Hello | null;
  /** null until TIME went through; a message if it failed (the link stays up). */
  timeNote: string | null;
  timeSynced: boolean;
  error: string | null;
  fake: boolean;
}

let state: Connection = { status: 'idle', hello: null, timeNote: null, timeSynced: false, error: null, fake: false };
let client: Client | null = null;
const listeners = new Set<() => void>();

function set(p: Partial<Connection>): void {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

export function getConnection(): Connection {
  return state;
}
export function getClient(): Client | null {
  return state.status === 'connected' && client && !client.closed ? client : null;
}
export function onConnection(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useConnection(): Connection {
  const [, bump] = useState(0);
  useEffect(() => onConnection(() => bump((n) => n + 1)), []);
  return state;
}

export function fakeMode(): boolean {
  if (!__HARBOR_FAKE__) return false;  // release build: no ?fake, and the FakeDevice chunk is not even emitted
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).has('fake');
  } catch {
    return false;
  }
}

async function openTransport(): Promise<Transport> {
  if (__HARBOR_FAKE__ && fakeMode()) {
    const w = window as unknown as { __fake?: import('../../proto/fake').FakeDevice };
    if (!w.__fake) {
      const { FakeDevice } = await import('../../proto/fake');
      w.__fake = new FakeDevice();
    }
    return w.__fake.connect();
  }
  return WebBluetoothTransport.request();
}

export async function connect(): Promise<void> {
  if (state.status !== 'idle') return;
  set({ status: 'connecting', error: null, timeNote: null, timeSynced: false, hello: null, fake: fakeMode() });
  let c: Client | null = null;
  try {
    const t = await openTransport();
    c = new Client(t);
    t.onClose((reason) => {
      if (client !== c) return;
      client = null;
      provideClient(null);
      set({ status: 'idle', hello: null, error: `The device disconnected${reason && reason !== 'closed' ? ` (${reason})` : ''}.` });
    });
    const hello = await c.connectHello();
    client = c;
    provideClient(c);
    set({ status: 'connected', hello });
    appStore()
      .patchSettings({ lastDevice: { id: hello.id, name: hello.name, lastSeen: Math.floor(Date.now() / 1000) } })
      .catch(() => {});
    try {
      await c.syncClock();
      set({ timeSynced: true, timeNote: null });
    } catch (e) {
      set({ timeNote: `Could not set the clock: ${describeError(e)}` });
    }
  } catch (e) {
    c?.close();
    client = null;
    provideClient(null);
    // The browser chooser being cancelled is not an error worth a red box.
    const cancelled = e instanceof Error && e.name === 'NotFoundError';
    set({ status: 'idle', hello: null, error: cancelled ? null : describeError(e) });
  }
}

export function disconnect(): void {
  const c = client;
  client = null;
  provideClient(null);
  c?.close();
  set({ status: 'idle', hello: null, error: null });
}
