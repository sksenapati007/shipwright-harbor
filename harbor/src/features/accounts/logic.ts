// Accounts: pure helpers. The device stores a bearer-style account as SECRET_SET acct.<name>; SECRET_LIST never returns
// the token, so once sent it cannot be read back (Harbor keeps it only if "remember" is ticked).
import { SECRET_MAX } from '../../proto/client';

export const ACCT_MAX = 6; // mirrors sys::secrets kAcctMax
export interface Preset {
  id: string;
  label: string;
  host: string;
  name: string;
}
export const PRESETS: Preset[] = [
  { id: 'github', label: 'GitHub', host: 'api.github.com', name: 'github' },
  { id: 'custom', label: 'Custom connection', host: '', name: '' },
];

const enc = new TextEncoder();
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** A plain host name (no scheme, port, path or wildcard). Returns the lower-cased host or null. */
export function normalizeHost(h: string): string | null {
  const s = h.trim().toLowerCase();
  return s.length <= 100 && HOST.test(s) ? s : null;
}

/** Lower-cases, maps other characters to '_' and clips to the 10 characters the device allows. */
export function acctName(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 10);
}

export interface AcctInput {
  name: string;
  label: string;
  host: string;
  token: string;
}
export type Built = { ok: true; key: string; value: Record<string, unknown>; bytes: number } | { ok: false; error: string };

export function buildAccount(i: AcctInput, now: number = Math.floor(Date.now() / 1000)): Built {
  const name = acctName(i.name || i.label);
  if (!name) return { ok: false, error: 'Give the connection a name (letters and digits).' };
  const label = i.label.trim() || name;
  const host = normalizeHost(i.host);
  if (!host) return { ok: false, error: 'The host must be a plain name such as api.example.com, with no https:// and no path.' };
  const token = i.token.trim();
  if (!token) return { ok: false, error: 'Paste the token.' };
  if (/[\x00-\x1f\x7f]/.test(token)) return { ok: false, error: 'The token has a line break or control character.' };
  const value = { label, hosts: [host], header: 'Authorization', prefix: 'Bearer ', token, added: now };
  const bytes = enc.encode(JSON.stringify(value)).length;
  if (bytes > SECRET_MAX) return { ok: false, error: `Too long: ${bytes} bytes, the device accepts at most ${SECRET_MAX}.` };
  return { ok: true, key: `acct.${name}`, value, bytes };
}
