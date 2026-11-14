// Dock catalogue for Harbor: parse + validate (same rules as the device, plan 3.3), stale-while-revalidate cache,
// and a verified install. The catalogue host must allow cross-origin reads (static hosts such as GitHub Pages do).
import { LUA_MAX, pathOk } from '../../proto/client';
import type { Client } from '../../proto/client';
import { appStore } from '../../lib/store';
import { DOCK_CATALOG_URL } from '../../lib/config';

/** Same cap as firmware budget::DOCK_ASSET_MAX: one .sbm asset. */
export const ASSET_MAX = 256 * 1024;
export const CATALOG_MAX = 1024 * 1024;
export const DEFAULT_DOCK_URL = DOCK_CATALOG_URL; // GitHub Pages of sksenapati007 (docs/PUBLISH.md)
const CACHE_KEY = 'dock.cache';
const URL_KEY = 'dock.url';

export interface Asset {
  path: string;
  size: number;
  sha256: string;
}
export interface Item {
  id: string;
  kind: string;
  title: string;
  summary: string;
  author: string;
  version: string;
  api: number;
  tags: string[];
  accounts: string[];
  path?: string;
  url?: string;
  size: number;
  sha256: string;
  assets: Asset[];
}
export interface Catalog {
  updated: string;
  base: string;
  items: Item[];
}

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : -1);
const hex = (v: unknown): string => (typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : '');

/** Throws an Error with a message fit for the UI when the document is not a usable catalogue. */
export function parseCatalog(text: string): Catalog {
  if (text.length > CATALOG_MAX) throw new Error('The catalogue is larger than 1 MB.');
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('The catalogue is not valid JSON.');
  }
  if (!j || j.dock !== 1 || !Array.isArray(j.items)) throw new Error('This is not a Dock catalogue (version 1).');
  const items: Item[] = [];
  for (const r of j.items) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) continue;
    const assets: Asset[] = Array.isArray(r.assets)
      ? r.assets
          .map((a: any) => ({ path: str(a?.path), size: num(a?.size), sha256: hex(a?.sha256) }))
          .filter((a: Asset) => a.path && a.size >= 0 && a.sha256)
      : [];
    items.push({
      id: r.id,
      kind: str(r.kind),
      title: str(r.title, r.id),
      summary: str(r.summary),
      author: str(r.author),
      version: str(r.version),
      api: typeof r.api === 'number' ? r.api : 1,
      tags: Array.isArray(r.tags) ? r.tags.filter((t: unknown) => typeof t === 'string') : [],
      accounts: Array.isArray(r.accounts) ? r.accounts.filter((t: unknown) => typeof t === 'string') : [],
      path: typeof r.path === 'string' ? r.path : undefined,
      url: typeof r.url === 'string' ? r.url : undefined,
      size: num(r.size),
      sha256: hex(r.sha256),
      assets,
    });
  }
  return { updated: str(j.updated), base: str(j.base), items };
}

export interface Cached {
  url: string;
  text: string;
  fetchedAt: number; // ms
}

export async function readCache(): Promise<Cached | null> {
  try {
    return (await appStore().get<Cached>(CACHE_KEY)) ?? null;
  } catch {
    return null;
  }
}
async function writeCache(c: Cached): Promise<void> {
  try {
    await appStore().set(CACHE_KEY, c);
  } catch {
    // storage blocked: the catalogue still works for this visit
  }
}
/** The address the user saved, or null (Harbor never contacts a Dock host the user has not chosen). */
export async function readDockUrl(): Promise<string | null> {
  try {
    return (await appStore().get<string>(URL_KEY)) || null;
  } catch {
    return null;
  }
}
export async function writeDockUrl(u: string): Promise<void> {
  try {
    await appStore().set(URL_KEY, u);
  } catch {
    // ignore
  }
}

/** Catalogue address from a user-typed Dock URL (same rule as the device: ".json" as is, else add catalog.json). */
export function catalogUrl(u: string): string {
  const t = u.trim();
  if (/\.json(\?.*)?$/i.test(t)) return t;
  return t.replace(/\/*$/, '/') + 'catalog.json';
}

export function urlOk(u: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(u.trim());
}

export interface SwrHandlers {
  /** Called with the cached catalogue straight away (if any), and again with the fresh one. */
  onData: (c: Catalog, info: { fromCache: boolean; fetchedAt: number }) => void;
  onError: (msg: string, haveData: boolean) => void;
}

/**
 * Stale-while-revalidate: show the saved catalogue immediately, fetch the live one in the background, replace and
 * save it on success. A failed fetch (offline) keeps what is shown. Resolves when the revalidation finished.
 */
export async function loadCatalog(dockUrl: string, h: SwrHandlers, f: typeof fetch = fetch): Promise<void> {
  const url = catalogUrl(dockUrl);
  let have = false;
  const cached = await readCache();
  if (cached && cached.url === url) {
    try {
      h.onData(parseCatalog(cached.text), { fromCache: true, fetchedAt: cached.fetchedAt });
      have = true;
    } catch {
      // a bad cache entry is ignored
    }
  }
  try {
    const r = await f(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`The Dock server answered ${r.status}.`);
    const text = await r.text();
    const cat = parseCatalog(text);
    const now = Date.now();
    await writeCache({ url, text, fetchedAt: now });
    h.onData(cat, { fromCache: false, fetchedAt: now });
  } catch (e) {
    const m = e instanceof Error && !(e instanceof TypeError) ? e.message : 'Could not reach the Dock server.';
    h.onError(have ? `${m} Showing the saved catalogue.` : m, have);
  }
}

// ---- install ------------------------------------------------------------------------------------------------------

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('This page cannot check file hashes here (it needs https).');
  const d = await subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const nameOk = (n: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(n);

export function resolveUrl(cat: Catalog, catUrl: string, p: string | undefined, abs: string | undefined): string {
  if (abs) return abs;
  const base = cat.base || catUrl;
  return new URL(p ?? '', base.endsWith('/') || base === catUrl ? base : base + '/').toString();
}

export class InstallError extends Error {}

async function download(url: string, size: number, sha: string, f: typeof fetch): Promise<Uint8Array> {
  let r: Response;
  try {
    r = await f(url);
  } catch {
    throw new InstallError('Could not download the file. Check your connection.');
  }
  if (!r.ok) throw new InstallError(`The Dock server answered ${r.status} for the download.`);
  const b = new Uint8Array(await r.arrayBuffer());
  if (size >= 0 && b.length !== size) throw new InstallError('The downloaded file has the wrong size.');
  if (sha && (await sha256Hex(b)) !== sha) throw new InstallError('The downloaded file does not match its checksum, so it was not installed.');
  return b;
}

export interface InstallOptions {
  catalogUrl: string;
  fetch?: typeof fetch;
  onStep?: (what: string) => void;
}

/** Downloads, verifies and sends a ship (and its art) to the device. Nothing is sent until everything verified. */
export async function installShip(c: Pick<Client, 'put'>, cat: Catalog, item: Item, o: InstallOptions): Promise<string> {
  const f = o.fetch ?? fetch;
  if (item.kind !== 'ship') throw new InstallError('Only ships can be installed from here.');
  if (item.api > 1) throw new InstallError('This ship needs a newer Shipwright than the device runs.');
  if (!item.sha256) throw new InstallError('The catalogue entry has no checksum, so it was not installed.');
  const name = baseName(item.path ?? item.url ?? '');
  if (!/\.lua$/i.test(name) || !nameOk(name)) throw new InstallError('The catalogue entry has an unusable file name.');
  if (item.size > LUA_MAX) throw new InstallError(`That ship is larger than ${LUA_MAX / 1024} KB, the most the device accepts.`);
  o.onStep?.(`Downloading ${item.title}`);
  const lua = await download(resolveUrl(cat, o.catalogUrl, item.path, item.url), item.size, item.sha256, f);
  const assets: Array<{ path: string; data: Uint8Array }> = [];
  for (const a of item.assets) {
    const an = baseName(a.path);
    if (!/\.sbm$/i.test(an) || !nameOk(an)) throw new InstallError('The catalogue lists art with an unusable file name.');
    if (a.size > ASSET_MAX) throw new InstallError(`The art ${an} is larger than ${ASSET_MAX / 1024} KB, the most the device accepts.`);
    o.onStep?.(`Downloading ${an}`);
    assets.push({ path: `/ships/art/${an}`, data: await download(resolveUrl(cat, o.catalogUrl, a.path, undefined), a.size, a.sha256, f) });
  }
  const dest = `/ships/${name}`;
  if (!pathOk(dest)) throw new InstallError('The device does not accept that file name.');
  o.onStep?.('Sending to the device');
  for (const a of assets) await c.put(a.path, a.data);
  await c.put(dest, lua);
  return name;
}
