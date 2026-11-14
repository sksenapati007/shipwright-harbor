// News feeds: the list file /data/feeds.json {"v":1,"feeds":[{"name","url"}]}. The device validates it on every load
// (net/feeds.h); these rules match so Harbor never writes a file the device would trim.
export const FEEDS_PATH = '/data/feeds.json';
export const MAX_FEEDS = 10;
export const URL_MAX = 200;
export const NAME_MAX = 39; // device name buffer is 40 with NUL

export interface Feed {
  name: string;
  url: string;
}

/** Bare hosts get https://. Returns the cleaned URL or null. */
export function normalizeFeedUrl(s: string): string | null {
  let u = s.trim();
  if (!u) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  if (!/^https?:\/\/[^\s/?#]+([/?#]\S*)?$/i.test(u)) return null;
  return new TextEncoder().encode(u).length <= URL_MAX ? u : null;
}

export type FeedCheck = { ok: true; feed: Feed } | { ok: false; error: string };
export function checkFeed(list: Feed[], name: string, url: string): FeedCheck {
  const u = normalizeFeedUrl(url);
  if (!u) return { ok: false, error: `Enter a web address (http or https) of at most ${URL_MAX} characters.` };
  if (list.length >= MAX_FEEDS) return { ok: false, error: `At most ${MAX_FEEDS} feeds. Remove one first.` };
  if (list.some((f) => f.url.toLowerCase() === u.toLowerCase())) return { ok: false, error: 'That feed is already in the list.' };
  return { ok: true, feed: { name: name.trim().slice(0, NAME_MAX), url: u } };
}

export function feedsFile(list: Feed[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: 1, feeds: list.slice(0, MAX_FEEDS) }));
}

/** Reads a feeds.json the way the device does: bare strings are URLs, bad entries are dropped. */
export function parseFeeds(bytes: Uint8Array): Feed[] {
  let j: unknown;
  try {
    j = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return [];
  }
  const arr = (j as { feeds?: unknown })?.feeds;
  if (!Array.isArray(arr)) return [];
  const out: Feed[] = [];
  for (const e of arr) {
    const name = typeof e === 'object' && e && typeof (e as Feed).name === 'string' ? (e as Feed).name : '';
    const raw = typeof e === 'string' ? e : typeof e === 'object' && e ? (e as Feed).url : '';
    const url = typeof raw === 'string' ? normalizeFeedUrl(raw) : null;
    if (url && !out.some((f) => f.url.toLowerCase() === url.toLowerCase())) out.push({ name: name.slice(0, NAME_MAX), url });
    if (out.length >= MAX_FEEDS) break;
  }
  return out;
}
