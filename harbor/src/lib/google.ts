// Google Calendar via Google Identity Services (token model). The user supplies their own OAuth client ID; Harbor ships
// none. The access token lives only in this module's memory: never stored, never sent anywhere but googleapis.com.
import { MAX_EVENTS, wallToUnix, systemTz, type CalEvent, type ExpandResult, type Window } from './ics';

export const GIS_SRC = 'https://accounts.google.com/gsi/client';
export const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/** A Google OAuth web client ID looks like 123-abc.apps.googleusercontent.com. */
export function clientIdOk(id: string): boolean {
  return /^[0-9]+-[a-z0-9_]+\.apps\.googleusercontent\.com$/i.test(id.trim());
}

// ---- token (memory only) ---------------------------------------------------------------------------------------

let token: { value: string; expires: number } | null = null;
export function currentToken(now = Date.now()): string | null {
  return token && token.expires > now + 30_000 ? token.value : null;
}
export function setToken(value: string, expiresInSec: number, now = Date.now()): void {
  token = { value, expires: now + expiresInSec * 1000 };
}
export function signOut(): void {
  const t = token?.value;
  token = null;
  try {
    const g = (globalThis as unknown as { google?: GoogleGlobal }).google;
    if (t && g?.accounts.oauth2.revoke) g.accounts.oauth2.revoke(t, () => {});
  } catch {
    // nothing to revoke
  }
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}
interface GoogleGlobal {
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

let gisLoading: Promise<void> | null = null;
export function loadGis(): Promise<void> {
  const w = globalThis as unknown as { google?: GoogleGlobal; document?: Document };
  if (w.google?.accounts?.oauth2) return Promise.resolve();
  return (gisLoading ??= new Promise<void>((resolve, reject) => {
    const s = w.document!.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisLoading = null;
      reject(new Error('Could not load Google sign-in. Check your connection.'));
    };
    w.document!.head.appendChild(s);
  }));
}

/** Opens the Google consent popup. Must be called from a click handler. Resolves with the in-memory token. */
export async function signIn(clientId: string): Promise<string> {
  if (!clientIdOk(clientId)) throw new Error('That does not look like a Google client ID (it ends in .apps.googleusercontent.com).');
  await loadGis();
  const g = (globalThis as unknown as { google: GoogleGlobal }).google;
  return new Promise<string>((resolve, reject) => {
    const client = g.accounts.oauth2.initTokenClient({
      client_id: clientId.trim(),
      scope: SCOPE,
      callback: (r) => {
        if (r.error || !r.access_token) return reject(new Error(r.error_description ?? r.error ?? 'Google sign-in failed.'));
        setToken(r.access_token, Number(r.expires_in) || 3600);
        resolve(r.access_token);
      },
      error_callback: (e) => reject(new Error(e.type === 'popup_closed' ? 'The Google sign-in window was closed.' : e.message ?? 'Google sign-in failed.')),
    });
    client.requestAccessToken({ prompt: currentToken() ? '' : 'consent' });
  });
}

// ---- events.list -----------------------------------------------------------------------------------------------

export function eventsUrl(win: Window, pageToken?: string): string {
  const q = new URLSearchParams({
    singleEvents: 'true', // Google expands recurrences for us
    orderBy: 'startTime',
    timeMin: new Date(win.from * 1000).toISOString(),
    timeMax: new Date(win.to * 1000).toISOString(),
    maxResults: '250',
    fields: 'nextPageToken,items(status,summary,location,description,start,end)',
  });
  if (pageToken) q.set('pageToken', pageToken);
  return `${EVENTS_URL}?${q}`;
}

const rec = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {});
const str = (x: unknown) => (typeof x === 'string' ? x : '');

/** One events.list page (items) to device events. Cancelled and malformed items are dropped. */
export function mapItems(items: unknown, tz: string): CalEvent[] {
  const out: CalEvent[] = [];
  if (!Array.isArray(items)) return out;
  for (const it0 of items) {
    const it = rec(it0);
    if (it.status === 'cancelled') continue;
    const st = rec(it.start);
    const en = rec(it.end);
    let s: number;
    let e: number;
    let all = false;
    if (typeof st.dateTime === 'string') {
      s = Math.floor(Date.parse(st.dateTime) / 1000);
      e = typeof en.dateTime === 'string' ? Math.floor(Date.parse(en.dateTime) / 1000) : s;
    } else if (typeof st.date === 'string') {
      all = true;
      const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(st.date);
      if (!a) continue;
      s = wallToUnix(+a[1]!, +a[2]!, +a[3]!, 0, 0, 0, tz);
      const b = typeof en.date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(en.date) : null;
      e = b ? wallToUnix(+b[1]!, +b[2]!, +b[3]!, 0, 0, 0, tz) : wallToUnix(+a[1]!, +a[2]!, +a[3]! + 1, 0, 0, 0, tz);
    } else continue;
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    out.push({
      s,
      e: Math.max(s, e),
      all,
      t: str(it.summary).replace(/\s+/g, ' ').trim().slice(0, 120) || '(no title)',
      loc: str(it.location).replace(/\s+/g, ' ').trim().slice(0, 120),
      d: str(it.description).trim().slice(0, 500),
    });
  }
  return out;
}

export class GoogleAuthError extends Error {}

export interface FetchOptions {
  token: string;
  window: Window;
  tz?: string;
  fetchFn?: typeof fetch;
}

/** All pages of events.list for the primary calendar, sorted, capped at 2000. */
export async function fetchEvents(o: FetchOptions): Promise<ExpandResult> {
  const f = o.fetchFn ?? fetch;
  const tz = o.tz ?? systemTz();
  const all: CalEvent[] = [];
  let page: string | undefined;
  for (let i = 0; i < 20; i++) {
    const r = await f(eventsUrl(o.window, page), { headers: { Authorization: `Bearer ${o.token}` } });
    if (r.status === 401 || r.status === 403) throw new GoogleAuthError('Google refused the request. Sign in again, and check that the Calendar API is enabled for your client ID.');
    if (!r.ok) throw new Error(`Google Calendar answered ${r.status}.`);
    const j = rec(await r.json());
    all.push(...mapItems(j.items, tz));
    page = typeof j.nextPageToken === 'string' ? j.nextPageToken : undefined;
    if (!page || all.length > MAX_EVENTS * 2) break;
  }
  all.sort((a, b) => a.s - b.s || a.t.localeCompare(b.t));
  return { events: all.slice(0, MAX_EVENTS), truncated: all.length > MAX_EVENTS };
}
