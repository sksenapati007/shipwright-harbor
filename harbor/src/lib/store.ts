// Persistent key-value store for Harbor (IndexedDB via idb-keyval). Device-local
// only: nothing here is ever sent anywhere.
import { createStore, del, entries, get, keys, set, type UseStore } from 'idb-keyval';

export type ThemePref = 'system' | 'light' | 'dark';

export interface KnownDevice {
  id: string;
  name: string;
  lastSeen: number; // unix seconds
}

export interface Settings {
  theme: ThemePref;
  lastDevice: KnownDevice | null;
}

export const DEFAULT_SETTINGS: Settings = { theme: 'system', lastDevice: null };

export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
  entries<T>(): Promise<Array<[string, T]>>;
  getSettings(): Promise<Settings>;
  patchSettings(patch: Partial<Settings>): Promise<Settings>;
}

const SETTINGS_KEY = 'settings';

/** Open (or create) a named IndexedDB-backed store. Same name = same data. */
export function openStore(dbName = 'harbor', storeName = 'kv'): Store {
  const db: UseStore = createStore(dbName, storeName);
  const store: Store = {
    get: <T>(key: string) => get<T>(key, db),
    set: <T>(key: string, value: T) => set(key, value, db),
    del: (key) => del(key, db),
    keys: async () => (await keys(db)).map(String),
    entries: async <T>() => (await entries<IDBValidKey, T>(db)).map(([k, v]) => [String(k), v] as [string, T]),
    async getSettings() {
      const saved = await get<Partial<Settings>>(SETTINGS_KEY, db);
      return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
    },
    async patchSettings(patch) {
      const next = { ...(await store.getSettings()), ...patch };
      await set(SETTINGS_KEY, next, db);
      return next;
    },
  };
  return store;
}

let shared: Store | undefined;
/** App-wide singleton. */
export function appStore(): Store {
  return (shared ??= openStore());
}
