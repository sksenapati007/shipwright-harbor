// Panel registry. Feature modules (src/features/<name>/index.ts[x]) call
// registerPanel() at import time; main.tsx imports them all with import.meta.glob,
// so adding a feature never requires editing the shell.
import type { ComponentChild } from 'preact';

export interface Panel {
  id: string;
  title: string;
  /** Lower comes first. Default 100. */
  order?: number;
  /**
   * true (default): shown only when the browser has Web Bluetooth.
   * false: always shown (e.g. offline tools, or features driven by a fake device).
   */
  requiresBluetooth?: boolean;
  render: () => ComponentChild;
}

const panels = new Map<string, Panel>();
const listeners = new Set<() => void>();

export function registerPanel(p: Panel): void {
  panels.set(p.id, p);
  listeners.forEach((l) => l());
}

export function listPanels(): Panel[] {
  return [...panels.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

export function onPanelsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test helper. */
export function clearPanels(): void {
  panels.clear();
}
