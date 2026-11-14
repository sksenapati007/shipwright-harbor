// Pages end-to-end encryption in Harbor (Phase 8.5 task N4): the shared vectors in docs/protocol/pages-vectors.json (the
// firmware and the CLI check the same file), key generation and the secret / snippet that carry the key.
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AAD_PAGE,
  AAD_REPLY,
  agentSnippet,
  b64,
  b64decode,
  b64url,
  keyBytes,
  keyOk,
  newKey,
  openEnvelope,
  pagesSecret,
  rememberRecord,
  sealEnvelope,
} from '../src/features/pages/logic';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
type Vec = {
  key_hex: string;
  key_b64url: string;
  key_b64: string;
  aes_gcm: { name: string; key: string; nonce: string; aad: string; pt: string; ct: string; tag: string }[];
  envelopes: { name: string; aad: string; nonce: string; plain: string; envelope: string }[];
  bad_envelopes: { name: string; aad: string; envelope: string }[];
  keys: { valid: string[]; invalid: string[] };
  base64: { hex: string; b64: string }[];
  free_text_flag: string;
};
const VEC = JSON.parse(new TextDecoder().decode(readFileSync(resolve(ROOT, 'docs', 'protocol', 'pages-vectors.json')))) as Vec;
const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const KEY = hex(VEC.key_hex);

describe('pages vectors', () => {
  it('AES-256-GCM through WebCrypto gives the shared ciphertext and tag', async () => {
    expect(VEC.aes_gcm.length).toBeGreaterThanOrEqual(5);
    for (const v of VEC.aes_gcm) {
      const key = await crypto.subtle.importKey('raw', hex(v.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
      const params = { name: 'AES-GCM', iv: hex(v.nonce), additionalData: hex(v.aad), tagLength: 128 };
      const out = new Uint8Array(await crypto.subtle.encrypt(params, key, hex(v.pt)));
      expect(toHex(out), v.name).toBe(v.ct + v.tag);
      expect(toHex(new Uint8Array(await crypto.subtle.decrypt(params, key, out))), v.name).toBe(v.pt);
    }
  });

  it('base64 and key strings', () => {
    for (const c of VEC.base64) {
      expect(b64(hex(c.hex))).toBe(c.b64);
      expect(toHex(b64decode(c.b64) ?? new Uint8Array())).toBe(c.hex);
    }
    expect(toHex(b64decode('-_8') ?? new Uint8Array())).toBe('fbff');
    for (const bad of ['Zm 8=', 'Zm8===', 'Z', '!!!!']) expect(b64decode(bad), bad).toBeNull();
    for (const k of VEC.keys.valid) expect(keyOk(k), k).toBe(true);
    for (const k of VEC.keys.invalid) expect(keyOk(k), JSON.stringify(k)).toBe(false);
    expect(b64url(KEY)).toBe(VEC.key_b64url);
    expect(b64(KEY)).toBe(VEC.key_b64);
    expect(toHex(keyBytes(VEC.key_b64url)!)).toBe(VEC.key_hex);
  });

  it('seals the exact shared envelopes and opens them', async () => {
    for (const e of VEC.envelopes) {
      expect(await sealEnvelope(KEY, e.aad, e.plain, hex(e.nonce)), e.name).toBe(e.envelope);
      expect(await openEnvelope(KEY, e.aad, e.envelope), e.name).toBe(e.plain);
    }
  });

  it('refuses every bad envelope, another key and the wrong direction', async () => {
    for (const e of VEC.bad_envelopes) expect(await openEnvelope(KEY, e.aad, e.envelope), e.name).toBeNull();
    const other = Uint8Array.from(KEY);
    other[0] = (other[0] ?? 0) ^ 1;
    expect(await openEnvelope(other, AAD_PAGE, VEC.envelopes[0]!.envelope)).toBeNull();
    const reply = VEC.envelopes.find((e) => e.aad === AAD_REPLY)!;
    expect(await openEnvelope(KEY, AAD_PAGE, reply.envelope)).toBeNull();
    expect(await openEnvelope(KEY, AAD_REPLY, 'not json')).toBeNull();
  });

  it('every sealed message gets a new nonce', async () => {
    const a = JSON.parse(await sealEnvelope(KEY, AAD_PAGE, '{}'));
    const b = JSON.parse(await sealEnvelope(KEY, AAD_PAGE, '{}'));
    expect(a.n).not.toBe(b.n);
    expect(await openEnvelope(KEY, AAD_PAGE, JSON.stringify(a))).toBe('{}');
  });

  it('the free-text page flag is named text', () => {
    expect(VEC.free_text_flag).toBe('text');
  });
});

describe('pages key setup', () => {
  it('a new key is 256 random bits as 43 base64url characters', () => {
    const k = newKey();
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keyBytes(k)).toHaveLength(32);
    expect(newKey()).not.toBe(k);
    expect(newKey(() => new Uint8Array(32))).toBe('A'.repeat(43));
  });
  it('the secret and the snippet carry the key; without a key nothing changes', () => {
    const k = newKey();
    expect(pagesSecret('t', 'https://ntfy.sh', k)).toEqual({ topic: 't', key: k });
    expect(pagesSecret('t', 'https://n.example.com', k)).toEqual({ topic: 't', base: 'https://n.example.com', key: k });
    expect(pagesSecret('t', 'https://ntfy.sh')).toEqual({ topic: 't' });
    expect(agentSnippet('t', 'https://ntfy.sh', k)).toContain(`SHIPWRIGHT_PAGE_KEY=${k}`);
    expect(agentSnippet('t', 'https://ntfy.sh')).not.toContain('PAGE_KEY');
  });
  it('the secret stays within the 384 byte limit with the longest server', () => {
    const v = JSON.stringify(pagesSecret('sw-' + 'a'.repeat(32), 'https://' + 'x'.repeat(80) + '.example.com', newKey()));
    expect(new TextEncoder().encode(v).length).toBeLessThanOrEqual(384);
  });
});

describe('Pages never remembers the key', () => {
  it('the remembered record has no key, even when given one (also an old record that holds one)', () => {
    const key = newKey();
    const rec = rememberRecord({ topic: 'shipwright-abc', base: 'https://ntfy.sh', key });
    expect(Object.keys(rec).sort()).toEqual(['base', 'topic']);
    expect(JSON.stringify(rec)).not.toContain(key);
  });
  it('a remembered setup shows a snippet without SHIPWRIGHT_PAGE_KEY', () => {
    const rec = rememberRecord({ topic: 'shipwright-abc', base: 'https://ntfy.sh', key: newKey() });
    const snippet = agentSnippet(rec.topic, rec.base, (rec as { key?: string }).key);
    expect(snippet).toContain('SHIPWRIGHT_PAGE_TOPIC=shipwright-abc');
    expect(snippet).not.toContain('SHIPWRIGHT_PAGE_KEY');
  });
});
