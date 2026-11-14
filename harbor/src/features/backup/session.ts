// The panel needs the connected sync client. The device feature (6E) calls provideClient() when it connects and
// provideClient(null) when the link closes; until then the panel says to connect first.
import type { SyncLike } from './ops';

let provider: (() => SyncLike | null) | null = null;
const listeners = new Set<() => void>();

export function provideClient(p: (() => SyncLike | null) | SyncLike | null): void {
  provider = p === null ? null : typeof p === 'function' ? (p as () => SyncLike | null) : () => p;
  listeners.forEach((l) => l());
}
export function currentClient(): SyncLike | null {
  return provider ? provider() : null;
}
export function onClientChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
