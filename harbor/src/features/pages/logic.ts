// Pages setup: a 128-bit random ntfy topic, a 256-bit end-to-end key, the "pages" secret and the snippet an agent session
// needs. Message bodies are AES-256-GCM encrypted (v2 envelope, docs/protocol/pages-vectors.json); the server, topic and
// message timing stay visible to the relay. The key is made here (WebCrypto), sent to the device as part of the secret and
// shown to the user once; it is never read back from the device (SECRET_LIST has no such field).
export const DEFAULT_BASE = 'https://ntfy.sh';
export const AAD_PAGE = 'shipwright-pages-v2:page';
export const AAD_REPLY = 'shipwright-pages-v2:reply';

const enc = (s: string) => new TextEncoder().encode(s);

/** Base64, standard alphabet with padding. */
export function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
/** Base64 in either alphabet, padding optional; null when it is not base64. */
export function b64decode(text: string): Uint8Array | null {
  const t = text.replace(/=+$/, '');
  if (text.length - t.length > 2 || t.length % 4 === 1 || !/^[A-Za-z0-9+/_-]*$/.test(t)) return null;
  const bin = atob(t.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
/** Base64url without padding: the form the key is shown and stored in. */
export const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A fresh 256-bit key as 43 base64url characters. `rand` is injectable for tests. */
export function newKey(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return b64url(rand(32));
}
/** The 32 key bytes of a key string, or null when it is not exactly 32 bytes of base64. */
export function keyBytes(text: string): Uint8Array | null {
  const raw = b64decode(text.trim());
  return raw && raw.length === 32 ? raw : null;
}
export const keyOk = (text: string) => keyBytes(text) !== null;

async function aesKey(key: Uint8Array, usage: 'encrypt' | 'decrypt') {
  return crypto.subtle.importKey('raw', key, 'AES-GCM', false, [usage]);
}
/** {"v":2,"n":..,"c":..} (compact JSON) for a v1 JSON text. `nonce` is for tests; the default is 12 random bytes. */
export async function sealEnvelope(
  key: Uint8Array,
  aad: string,
  plain: string,
  nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(12)),
): Promise<string> {
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc(aad), tagLength: 128 }, await aesKey(key, 'encrypt'), enc(plain)));
  return JSON.stringify({ v: 2, n: b64(nonce), c: b64(ct) });
}
/** The plaintext of an envelope, or null when it is malformed or does not authenticate. */
export async function openEnvelope(key: Uint8Array, aad: string, text: string): Promise<string | null> {
  let env: unknown;
  try {
    env = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof env !== 'object' || env === null) return null;
  const e = env as { v?: unknown; n?: unknown; c?: unknown };
  if (e.v !== 2 || typeof e.n !== 'string' || typeof e.c !== 'string') return null;
  const n = b64decode(e.n);
  const c = b64decode(e.c);
  if (!n || n.length !== 12 || !c || c.length < 16) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: n, additionalData: enc(aad), tagLength: 128 }, await aesKey(key, 'decrypt'), c);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** "sw-" + 32 hex digits = 128 random bits. `rand` is injectable for tests. */
export function newTopic(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return 'sw-' + [...rand(16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const topicOk = (t: string) => /^[A-Za-z0-9_-]{1,64}$/.test(t);

/** Normalises a server address. '' means the default. Returns null when it is not an http(s) origin. */
export function normalizeBase(s: string): string | null {
  const t = s.trim().replace(/\/+$/, '');
  if (t === '') return DEFAULT_BASE;
  return /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(t) && t.length <= 100 ? t : null;
}

/** The "pages" secret value. `key` (43 base64url characters) switches end-to-end encryption on. */
export function pagesSecret(topic: string, base: string, key?: string): Record<string, unknown> {
  const v: Record<string, unknown> = base === DEFAULT_BASE ? { topic } : { topic, base };
  if (key) v.key = key;
  return v;
}

export function agentSnippet(topic: string, base: string, key?: string): string {
  return [
    `export SHIPWRIGHT_PAGE_TOPIC=${topic}`,
    ...(key ? [`export SHIPWRIGHT_PAGE_KEY=${key}`] : []),
    ...(base === DEFAULT_BASE ? [] : [`export SHIPWRIGHT_PAGE_BASE=${base}`]),
    'shipwright-page send "Build finished"',
    'shipwright-page ask "Deploy?" --choices yes,no --wait 600',
  ].join('\n');
}

// What Harbor may remember between visits: the topic and server only. The shared key is shown once at setup and never stored.
export function rememberRecord(rec: { topic: string; base: string; key?: string }): { topic: string; base: string } {
  return { topic: rec.topic, base: rec.base };
}
