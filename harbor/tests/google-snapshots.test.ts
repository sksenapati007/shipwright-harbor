// Phase 8G: Gmail headers and Drive files to /data/gmail.json and /data/drive.json.
import { describe, expect, it } from 'vitest';
import { FakeDevice } from '../src/proto/fake';
import { Client } from '../src/proto/client';
import {
  currentToken, decodeEntities, driveJson, fetchDrive, fetchMail, GoogleAuthError, mapFiles, mapMessage, pushDrive,
  pushMail, senderName, setToken, signOut, typeLabel, SCOPES,
} from '../src/features/google/api';

const dec = new TextDecoder();
const msg = (id: string, ms: number, from: string, subject: string, snippet: string) => ({
  id, internalDate: String(ms), snippet, payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }] },
});
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

describe('mapping', () => {
  it('sender names, entities, dates', () => {
    expect(senderName('"Ada L." <ada@x.org>')).toBe('Ada L.');
    expect(senderName('Bob <bob@x.org>')).toBe('Bob');
    expect(senderName('<c@x.org>')).toBe('c@x.org');
    expect(senderName('d@x.org')).toBe('d@x.org');
    expect(decodeEntities('It&#39;s &amp; &lt;b&gt; &quot;q&quot; &#x1F600; &bogus; &#0;')).toBe('It\'s & <b> "q" \u{1F600} &bogus; &#0;');
    const m = mapMessage(msg('1', 1700000000999, 'Ada <a@x>', '  Hi\n there ', 'Don&#39;t miss')) ;
    expect(m).toEqual({ from: 'Ada', subject: 'Hi there', snippet: "Don't miss", date: 1700000000 });
  });
  it('missing headers do not break it and long text is cut', () => {
    const m = mapMessage({ id: 'x', snippet: 's'.repeat(500) })!;
    expect(m.subject).toBe('(no subject)');
    expect(m.date).toBe(0);
    expect(Array.from(m.snippet).length).toBe(160);
    expect(m.snippet.endsWith('…')).toBe(true);
  });
  it('drive files: types, string sizes, bad rows', () => {
    const f = mapFiles([
      { name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-11-13T08:00:00.000Z' },
      { name: 'a.pdf', mimeType: 'application/pdf', modifiedTime: '2026-11-12T08:00:00Z', size: '482113' },
      { name: '', mimeType: 'x' },
      { name: 'weird', mimeType: 'application/x-foo', modifiedTime: 'nope', size: 'NaN' },
    ]);
    expect(f.map((x) => x.type)).toEqual(['Sheet', 'PDF', 'File']);
    expect(f[1]).toEqual({ name: 'a.pdf', type: 'PDF', modified: Date.parse('2026-11-12T08:00:00Z') / 1000, size: 482113 });
    expect(f[2]!.modified).toBe(0);
    expect(typeLabel('image/png')).toBe('Image');
    expect(mapFiles('nope')).toEqual([]);
  });
  it('asks only for metadata scopes', () => {
    expect(SCOPES).toContain('gmail.metadata');
    expect(SCOPES).toContain('drive.metadata.readonly');
    expect(SCOPES.split(' ').sort()).toEqual([
      'https://www.googleapis.com/auth/drive.metadata.readonly',
      'https://www.googleapis.com/auth/gmail.metadata',
    ]);
  });
});

describe('fetching', () => {
  it('lists 30 ids, fetches each as metadata with the bearer token, sorts newest first', async () => {
    const calls: { url: string; auth: string }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization! });
      if (url.includes('/messages?')) return reply({ messages: Array.from({ length: 40 }, (_, i) => ({ id: `m${i}` })) });
      const id = /messages\/(m\d+)/.exec(url)![1]!;
      const n = Number(id.slice(1));
      return reply(msg(id, 1700000000000 + n * 1000, 'A <a@x>', `S${n}`, 'x'));
    }) as unknown as typeof fetch;
    const mail = await fetchMail('TOK', f);
    expect(mail).toHaveLength(30);
    expect(mail[0]!.subject).toBe('S29'); // newest first
    expect(calls.every((c) => c.auth === 'Bearer TOK' && c.url.startsWith('https://gmail.googleapis.com/'))).toBe(true);
    expect(calls[1]!.url).toContain('format=metadata');
    expect(calls[1]!.url).not.toContain('format=full');
  });
  it('401/403 is an auth error, other statuses a plain one', async () => {
    await expect(fetchMail('t', (async () => reply({}, 401)) as unknown as typeof fetch)).rejects.toBeInstanceOf(GoogleAuthError);
    await expect(fetchDrive('t', (async () => reply({}, 403)) as unknown as typeof fetch)).rejects.toBeInstanceOf(GoogleAuthError);
    const e = await fetchDrive('t', (async () => reply({}, 500)) as unknown as typeof fetch).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(GoogleAuthError);
  });
  it('drive asks for the 50 newest non-trashed files', async () => {
    let url = '';
    const f = (async (u: string) => {
      url = u;
      return reply({ files: [{ name: 'n', mimeType: 'application/pdf', modifiedTime: '2026-11-12T08:00:00Z' }] });
    }) as unknown as typeof fetch;
    expect(await fetchDrive('t', f)).toHaveLength(1);
    expect(decodeURIComponent(url.replace(/\+/g, ' '))).toContain('orderBy=modifiedTime desc');
    expect(url).toContain('pageSize=50');
  });
});

describe('push and token', () => {
  it('PUTs the two files the device reads', async () => {
    const dev = new FakeDevice();
    const c = new Client(dev.connect());
    await c.connectHello();
    await pushMail(c, [{ from: 'Ada', subject: 'Hi', snippet: 's', date: 5 }], 1000);
    await pushDrive(c, [{ name: 'n', type: 'Doc', modified: 6, size: 0 }], 1001);
    expect(JSON.parse(dec.decode(dev.files.get('/data/gmail.json')!))).toEqual({
      v: 1, fetched: 1000, items: [{ from: 'Ada', subject: 'Hi', snippet: 's', date: 5 }],
    });
    expect(JSON.parse(dec.decode(dev.files.get('/data/drive.json')!)).items[0]).toEqual({ name: 'n', type: 'Doc', modified: 6, size: 0 });
  });
  it('documents stay well under the device 96 KB cap', () => {
    const items = Array.from({ length: 80 }, () => ({ name: '\u{1F600}'.repeat(96), type: 'Doc', modified: 1, size: 1 }));
    expect(driveJson(items, 1).length).toBeLessThan(96 * 1024);
  });
  it('the token is in memory only and expires', () => {
    signOut();
    expect(currentToken()).toBeNull();
    setToken('abc', 3600, 1000);
    expect(currentToken(2000)).toBe('abc');
    expect(currentToken(1000 + 3600_000)).toBeNull();
    signOut();
    expect(currentToken(2000)).toBeNull();
  });
});
