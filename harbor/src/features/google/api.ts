// Gmail and Drive snapshots (Phase 8 task 8G). Harbor signs in to Google with the user's own client ID (Google Identity
// Services token model, like Calendar), fetches the newest 30 Gmail message headers and the 50 most recently modified
// Drive files, and PUTs them as /data/gmail.json and /data/drive.json. The token lives only in this module's memory and
// is sent only to googleapis.com; the device never holds it and never contacts Google. Harbor ships no client ID.
import type { Client } from '../../proto/client';
import { clientIdOk, loadGis } from '../../lib/google';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.metadata', // headers and snippet, never message bodies
  'https://www.googleapis.com/auth/drive.metadata.readonly', // names, types, dates, sizes, never contents
].join(' ');
export const MAIL_PATH = '/data/gmail.json';
export const DRIVE_PATH = '/data/drive.json';
export const MAX_MAIL = 30;
export const MAX_FILES = 50;
const LIST_URL = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${MAX_MAIL}&labelIds=INBOX`;
const MSG_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const enc = new TextEncoder();

export interface MailItem { from: string; subject: string; snippet: string; date: number }
export interface DriveItem { name: string; type: string; modified: number; size: number }
export class GoogleAuthError extends Error {}

// ---- token (memory only) ---------------------------------------------------------------------------------------

let token: { value: string; expires: number } | null = null;
export function currentToken(now = Date.now()): string | null {
  return token && token.expires > now + 30_000 ? token.value : null;
}
export function setToken(value: string, expiresInSec: number, now = Date.now()): void {
  token = { value, expires: now + expiresInSec * 1000 };
}
interface TokenResponse { access_token?: string; expires_in?: number | string; error?: string; error_description?: string }
interface Gis {
  accounts: {
    oauth2: {
      initTokenClient(cfg: {
        client_id: string;
        scope: string;
        callback: (r: TokenResponse) => void;
        error_callback?: (e: { type?: string; message?: string }) => void;
      }): { requestAccessToken(o?: { prompt?: string }): void };
      revoke?(token: string, done: () => void): void;
    };
  };
}
const gis = () => (globalThis as unknown as { google?: Gis }).google;

export function signOut(): void {
  const t = token?.value;
  token = null;
  try {
    if (t) gis()?.accounts.oauth2.revoke?.(t, () => {});
  } catch {
    // nothing to revoke
  }
}

/** Opens the Google consent popup (call from a click handler). Resolves with the in-memory token. */
export async function signIn(clientId: string): Promise<string> {
  if (!clientIdOk(clientId)) throw new Error('That does not look like a Google client ID (it ends in .apps.googleusercontent.com).');
  await loadGis();
  const g = gis()!;
  return new Promise<string>((resolve, reject) => {
    g.accounts.oauth2
      .initTokenClient({
        client_id: clientId.trim(),
        scope: SCOPES,
        callback: (r) => {
          if (r.error || !r.access_token) return reject(new Error(r.error_description ?? r.error ?? 'Google sign-in failed.'));
          setToken(r.access_token, Number(r.expires_in) || 3600);
          resolve(r.access_token);
        },
        error_callback: (e) => reject(new Error(e.type === 'popup_closed' ? 'The Google sign-in window was closed.' : e.message ?? 'Google sign-in failed.')),
      })
      .requestAccessToken({ prompt: currentToken() ? '' : 'consent' });
  });
}

// ---- mapping ---------------------------------------------------------------------------------------------------

const rec = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {});
const str = (x: unknown) => (typeof x === 'string' ? x : '');
const tidy = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  const cps = Array.from(t);
  return cps.length > max ? cps.slice(0, max - 1).join('') + '…' : t;
};

/** Gmail snippets arrive HTML-escaped. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const cp = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp < 0xe000) ? String.fromCodePoint(cp) : m;
  });
}

/** `"Ada L." <ada@x.org>` -> Ada L.; a bare address stays as it is. */
export function senderName(from: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]*)>\s*$/.exec(from);
  if (m) return (m[1] || m[2] || '').trim();
  return from.trim();
}

/** One messages.get (format=metadata) response to a device item; null when unusable. */
export function mapMessage(m: unknown): MailItem | null {
  const o = rec(m);
  const hdr = (name: string) => {
    const h = Array.isArray(rec(o.payload).headers) ? (rec(o.payload).headers as unknown[]) : [];
    for (const x of h) if (str(rec(x).name).toLowerCase() === name) return str(rec(x).value);
    return '';
  };
  const ms = Number(o.internalDate);
  return {
    from: tidy(senderName(hdr('from')), 48),
    subject: tidy(hdr('subject'), 112) || '(no subject)',
    snippet: tidy(decodeEntities(str(o.snippet)), 160),
    date: Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0,
  };
}

const TYPES: Record<string, string> = {
  'application/vnd.google-apps.document': 'Doc',
  'application/vnd.google-apps.spreadsheet': 'Sheet',
  'application/vnd.google-apps.presentation': 'Slides',
  'application/vnd.google-apps.folder': 'Folder',
  'application/vnd.google-apps.form': 'Form',
  'application/vnd.google-apps.drawing': 'Drawing',
  'application/pdf': 'PDF',
  'application/zip': 'ZIP',
  'text/plain': 'Text',
  'text/csv': 'CSV',
};
export function typeLabel(mime: string): string {
  if (TYPES[mime]) return TYPES[mime]!;
  if (mime.startsWith('image/')) return 'Image';
  if (mime.startsWith('video/')) return 'Video';
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime.includes('wordprocessingml')) return 'Word';
  if (mime.includes('spreadsheetml')) return 'Excel';
  if (mime.includes('presentationml')) return 'PowerPoint';
  return 'File';
}

export function mapFiles(files: unknown): DriveItem[] {
  const out: DriveItem[] = [];
  if (!Array.isArray(files)) return out;
  for (const f0 of files) {
    const f = rec(f0);
    const name = tidy(str(f.name), 96);
    if (!name) continue;
    const t = Math.floor(Date.parse(str(f.modifiedTime)) / 1000);
    const size = Number(f.size); // Drive sends size as a string, and omits it for Google-native files
    out.push({
      name,
      type: typeLabel(str(f.mimeType)),
      modified: Number.isFinite(t) && t > 0 ? t : 0,
      size: Number.isFinite(size) && size > 0 ? Math.floor(size) : 0,
    });
  }
  return out.slice(0, MAX_FILES);
}

export const mailJson = (items: MailItem[], fetched: number) =>
  JSON.stringify({ v: 1, fetched, items: items.slice(0, MAX_MAIL) }) + '\n';
export const driveJson = (items: DriveItem[], fetched: number) =>
  JSON.stringify({ v: 1, fetched, items: items.slice(0, MAX_FILES) }) + '\n';

// ---- fetching --------------------------------------------------------------------------------------------------

type Fetch = typeof fetch;
async function getJson(f: Fetch, url: string, tok: string): Promise<Record<string, unknown>> {
  const r = await f(url, { headers: { Authorization: `Bearer ${tok}` } });
  if (r.status === 401 || r.status === 403)
    throw new GoogleAuthError('Google refused the request. Sign in again, and check that the Gmail API and the Drive API are enabled for your client ID.');
  if (!r.ok) throw new Error(`Google answered ${r.status}.`);
  return rec(await r.json());
}

/** The newest 30 inbox headers. Messages are fetched six at a time. */
export async function fetchMail(tok: string, f: Fetch = fetch): Promise<MailItem[]> {
  const list = rec(await getJson(f, LIST_URL, tok));
  const ids = (Array.isArray(list.messages) ? list.messages : []).map((m) => str(rec(m).id)).filter(Boolean).slice(0, MAX_MAIL);
  const fields = 'id,snippet,internalDate,payload/headers';
  const out: (MailItem | null)[] = [];
  for (let i = 0; i < ids.length; i += 6) {
    const batch = ids.slice(i, i + 6).map((id) =>
      getJson(f, `${MSG_URL}${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&fields=${encodeURIComponent(fields)}`, tok).then(mapMessage),
    );
    out.push(...(await Promise.all(batch)));
  }
  return (out.filter(Boolean) as MailItem[]).sort((a, b) => b.date - a.date);
}

export async function fetchDrive(tok: string, f: Fetch = fetch): Promise<DriveItem[]> {
  const q = new URLSearchParams({
    pageSize: String(MAX_FILES),
    orderBy: 'modifiedTime desc',
    q: 'trashed=false',
    fields: 'files(name,mimeType,modifiedTime,size)',
  });
  return mapFiles((await getJson(f, `${FILES_URL}?${q}`, tok)).files);
}

// ---- push ------------------------------------------------------------------------------------------------------

export async function pushMail(c: Pick<Client, 'put'>, items: MailItem[], now = Math.floor(Date.now() / 1000)): Promise<void> {
  await c.put(MAIL_PATH, enc.encode(mailJson(items, now)));
}
export async function pushDrive(c: Pick<Client, 'put'>, items: DriveItem[], now = Math.floor(Date.now() / 1000)): Promise<void> {
  await c.put(DRIVE_PATH, enc.encode(driveJson(items, now)));
}
