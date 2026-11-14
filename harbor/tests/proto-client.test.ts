import { describe, expect, it } from 'vitest';
import { Client, describeError, pathOk, ProtoError, secretNameOk, timePayload } from '../src/proto/client';
import { crc32, Op, WINDOW } from '../src/proto/codec';
import { FakeDevice } from '../src/proto/fake';
import { bluetoothAvailable, WebBluetoothTransport } from '../src/proto/webbluetooth';
import { StdioTransport, type ByteReader, type ByteWriter } from '../src/proto/stdio';

const te = new TextEncoder();
const bytes = (n: number, seed = 1): Uint8Array => {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    b[i] = x >>> 16;
  }
  return b;
};
const eq = (a: Uint8Array | undefined, b: Uint8Array): boolean =>
  !!a && a.length === b.length && a.every((v, i) => v === b[i]);
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return e instanceof ProtoError ? e.code : `other:${String(e)}`;
  }
  return 'resolved';
};
const setup = (o: ConstructorParameters<typeof FakeDevice>[0] = {}, timeoutMs = 2000) => {
  const dev = new FakeDevice(o);
  const client = new Client(dev.connect(), { timeoutMs });
  return { dev, client };
};

describe('HELLO and TIME', () => {
  it('returns the device fields and adopts mtu and window', async () => {
    const { client } = setup({ mtu: 247 });
    const h = await client.connectHello();
    expect(h).toMatchObject({ proto: 1, board: 'x4c', name: 'Shipwright-A1B2', mtu: 247, window: WINDOW });
    expect(client.mtu).toBe(247);
    expect(client.window).toBe(WINDOW);
  });

  it('works at the minimum MTU (multi-frame requests and replies)', async () => {
    const { client } = setup({ mtu: 23 });
    expect((await client.connectHello()).mtu).toBe(23);
  });

  it('sets the clock and zone', async () => {
    const { dev, client } = setup();
    await client.setTime({ unix: 1_800_000_000, off: 60, next: 1_810_000_000, next_off: 120 });
    expect(dev.clock).toEqual({ unix: 1_800_000_000, off: 60, next: 1_810_000_000, next_off: 120 });
    await client.syncClock(new Date(1_800_000_000_000), () => 330);
    expect(dev.clock).toEqual({ unix: 1_800_000_000, off: 330 });
  });

  it('maps an out-of-range time to bad_request', async () => {
    const { client } = setup();
    expect(await code(client.setTime({ unix: 5, off: 0 }))).toBe('bad_request');
  });

  it('finds the next offset change to the minute', () => {
    const change = Date.UTC(2026, 9, 25, 1, 0, 0); // an instant mid-year
    const offsetAt = (ms: number) => (ms < change ? 60 : 0);
    const now = Date.UTC(2026, 5, 1, 12, 0, 0);
    const p = timePayload(now, offsetAt);
    expect(p).toEqual({ unix: now / 1000, off: 60, next: change / 1000, next_off: 0 });
    expect(timePayload(now, () => 0)).toEqual({ unix: now / 1000, off: 0 });
  });
});

describe('LIST, DELETE, secrets', () => {
  it('lists a directory far larger than one control message', async () => {
    const { dev, client } = setup({ mtu: 23 });
    for (let i = 0; i < 400; i++) dev.files.set(`/books/book-number-${i}.epub`, new Uint8Array(i));
    dev.files.set('/books/sub/a.txt', new Uint8Array(1));
    const ents = await client.list('/books');
    expect(ents.length).toBe(401);
    expect(ents.find((e) => e.name === 'book-number-7.epub')).toEqual({ name: 'book-number-7.epub', size: 7, dir: false });
    expect(ents.find((e) => e.name === 'sub')?.dir).toBe(true);
  });

  it('lists an empty directory', async () => {
    const { client } = setup();
    expect(await client.list('/ships')).toEqual([]);
  });

  it('deletes, and maps not_found and bad_path', async () => {
    const { dev, client } = setup();
    dev.files.set('/books/a.epub', new Uint8Array(3));
    await client.del('/books/a.epub');
    expect(dev.files.size).toBe(0);
    expect(await code(client.del('/books/a.epub'))).toBe('not_found');
    expect(await code(client.del('/books/../log.txt'))).toBe('bad_path');
    expect(await code(client.list('/etc'))).toBe('bad_path');
  });

  it('stores, lists without values, and deletes secrets', async () => {
    const { dev, client } = setup();
    await client.secretSet('acct.github', { label: 'GitHub', hosts: ['api.github.com'], token: 'ghp_SECRET', added: 5 });
    await client.secretSet('wifi.0', { ssid: 'Home', psk: 'hunter22' });
    const list = await client.secretList();
    expect(JSON.stringify(list)).not.toMatch(/ghp_SECRET|hunter22|token|psk/);
    expect(list).toContainEqual({ name: 'acct.github', label: 'GitHub', hosts: ['api.github.com'], added: 5 });
    expect(list).toContainEqual({ name: 'wifi.0', label: 'Home' });
    await client.secretDel('acct.github');
    expect(dev.secrets.has('acct.github')).toBe(false);
    expect(await code(client.secretDel('acct.github'))).toBe('not_found');
  });

  it('maps secret rule violations', async () => {
    const { client } = setup();
    expect(await code(client.secretSet('acct.Bad Name', {}))).toBe('bad_request');
    expect(await code(client.secretSet('acct.a', { token: 'x'.repeat(400) }))).toBe('too_large');
  });
});

describe('PUT', () => {
  it('uploads a small file and verifies it', async () => {
    const { dev, client } = setup();
    await client.connectHello();
    const d = bytes(1000);
    await client.put('/books/a.epub', d);
    expect(eq(dev.files.get('/books/a.epub'), d)).toBe(true);
    expect(dev.parts.size).toBe(0);
  });

  it('uploads an empty file', async () => {
    const { dev, client } = setup();
    await client.put('/data/empty.json', new Uint8Array(0));
    expect(dev.files.get('/data/empty.json')?.length).toBe(0);
  });

  it('keeps unacknowledged bytes within the window and reports monotonic progress', async () => {
    const { dev, client } = setup({ mtu: 512 });
    await client.connectHello();
    const d = bytes(300_000, 7);
    const marks: number[] = [];
    await client.put('/books/big.epub', d, { onProgress: (s, t) => (expect(t).toBe(d.length), marks.push(s)) });
    expect(eq(dev.files.get('/books/big.epub'), d)).toBe(true);
    expect(dev.maxUnacked).toBeLessThanOrEqual(WINDOW);
    expect(marks[0]).toBe(0);
    expect(marks[marks.length - 1]).toBe(d.length);
    expect(marks.every((m, i) => i === 0 || m > marks[i - 1]!)).toBe(true);
  });

  it('stops at the window when acks never come, then times out', async () => {
    const { dev, client } = setup({ mtu: 512 }, 150);
    await client.connectHello();
    dev.suppressAcks = true;
    expect(await code(client.put('/books/big.epub', bytes(200_000)))).toBe('timeout');
    expect(dev.putBytesReceived).toBeLessThanOrEqual(WINDOW);
    expect(dev.putBytesReceived).toBeGreaterThan(WINDOW - 600);
  });

  it('uses the device window (65536 by default)', async () => {
    const { client } = setup();
    expect(client.window).toBe(WINDOW);
  });

  it('resumes after a mid-file disconnect on a new connection', async () => {
    const dev = new FakeDevice({ mtu: 247 });
    const d = bytes(150_000, 3);
    dev.dropAfterPutBytes = 90_000;
    const c1 = new Client(dev.connect(), { timeoutMs: 2000 });
    await c1.connectHello();
    expect(await code(c1.put('/books/r.epub', d))).toBe('disconnected');
    expect(dev.files.has('/books/r.epub')).toBe(false);
    const kept = [...dev.parts.values()][0]!.length;
    expect(kept).toBeGreaterThanOrEqual(90_000);
    const before = dev.putBytesReceived;

    const c2 = new Client(dev.connect(), { timeoutMs: 2000 });
    await c2.connectHello();
    const firsts: number[] = [];
    await c2.put('/books/r.epub', d, { onProgress: (s) => firsts.push(s) });
    expect(firsts[0]).toBe(kept);
    expect(dev.putBytesReceived - before).toBe(d.length - kept);
    expect(eq(dev.files.get('/books/r.epub'), d)).toBe(true);
    expect(dev.parts.size).toBe(0);
  });

  it('a different file with the same name does not resume from the old part', async () => {
    const dev = new FakeDevice({ mtu: 247 });
    dev.dropAfterPutBytes = 60_000;
    const c1 = new Client(dev.connect(), { timeoutMs: 2000 });
    await code(c1.put('/books/x.epub', bytes(120_000, 1)));
    const c2 = new Client(dev.connect(), { timeoutMs: 2000 });
    const firsts: number[] = [];
    const d2 = bytes(120_000, 2);
    await c2.put('/books/x.epub', d2, { onProgress: (s) => firsts.push(s) });
    expect(firsts[0]).toBe(0);
    expect(eq(dev.files.get('/books/x.epub'), d2)).toBe(true);
  });

  it('a link that drops reports disconnected and later calls fail the same way', async () => {
    const { dev, client } = setup();
    dev.disconnect();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(client.closed).toBe(true);
    expect(await code(client.list('/books'))).toBe('disconnected');
  });

  it('maps a checksum mismatch to crc and leaves no file or part', async () => {
    const { dev, client } = setup();
    dev.corruptPutByteAt = 500;
    expect(await code(client.put('/books/c.epub', bytes(2000)))).toBe('crc');
    expect(dev.files.size).toBe(0);
    expect(dev.parts.size).toBe(0);
  });

  it('maps device refusals', async () => {
    const { client, dev } = setup();
    expect(await code(client.put('/etc/passwd', bytes(10)))).toBe('bad_path');
    expect(await code(client.put('/books/../x', bytes(10)))).toBe('bad_path');
    expect(await code(client.put('/ships/big.lua', bytes(131073)))).toBe('too_large');
    await client.put('/ships/ok.lua', bytes(131072));
    expect(dev.files.has('/ships/ok.lua')).toBe(true);
    const tiny = setup({ freeBytes: 5 * 1024 * 1024 });
    expect(await code(tiny.client.put('/books/b.epub', bytes(2 * 1024 * 1024)))).toBe('no_space');
  });

  it('a second concurrent PUT gets busy and the first still completes', async () => {
    const { dev, client } = setup({ mtu: 23 });
    const a = client.put('/books/a.epub', bytes(5000, 1));
    const b = client.put('/books/b.epub', bytes(10, 2));
    expect(await code(b)).toBe('busy');
    await a;
    expect(dev.files.has('/books/a.epub')).toBe(true);
  });
});

describe('GET', () => {
  it('downloads and verifies a file', async () => {
    const { dev, client } = setup({ mtu: 100 });
    const d = bytes(5000, 9);
    dev.files.set('/data/books/abcd1234/state.json', d);
    const seen: number[] = [];
    const out = await client.get('/data/books/abcd1234/state.json', { onProgress: (n) => seen.push(n) });
    expect(eq(out, d)).toBe(true);
    expect(seen[seen.length - 1]).toBe(5000);
  });

  it('starts at an offset and checks the CRC over a supplied prefix', async () => {
    const { dev, client } = setup();
    const d = bytes(1000, 4);
    dev.files.set('/data/f.bin', d);
    const tail = await client.get('/data/f.bin', { from: 400, prefix: d.subarray(0, 400) });
    expect(eq(tail, d.subarray(400))).toBe(true);
    expect(await code(client.get('/data/f.bin', { from: 400, prefix: new Uint8Array(400) }))).toBe('crc');
    expect((await client.get('/data/f.bin', { from: 1000 })).length).toBe(0);
  });

  it('maps not_found, bad_path and an offset past the end', async () => {
    const { dev, client } = setup();
    dev.files.set('/data/f.bin', new Uint8Array(10));
    expect(await code(client.get('/data/nope'))).toBe('not_found');
    expect(await code(client.get('/log.txt'))).toBe('bad_path');
    expect(await code(client.get('/data/f.bin', { from: 11 }))).toBe('bad_request');
  });

  it('reports disconnected when the link drops mid-download', async () => {
    const { dev, client } = setup({ mtu: 50 });
    dev.files.set('/data/f.bin', bytes(5000));
    dev.dropAfterGetFrames = 20;
    expect(await code(client.get('/data/f.bin'))).toBe('disconnected');
  });
});

describe('timeouts and errors', () => {
  it('times out when the device never answers', async () => {
    const { dev, client } = setup({}, 60);
    dev.silentOps.add(Op.Hello);
    const t0 = Date.now();
    expect(await code(client.connectHello())).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(1500);
    // The client stays usable for other calls.
    expect(await client.list('/books')).toEqual([]);
  });

  it('an old call that timed out does not swallow a later reply', async () => {
    const { dev, client } = setup({}, 60);
    dev.silentOps.add(Op.List);
    expect(await code(client.list('/books'))).toBe('timeout');
    dev.silentOps.clear();
    expect(await client.list('/books')).toEqual([]);
  });

  it('describeError gives a line for every code', () => {
    for (const c of ['bad_path', 'no_space', 'too_large', 'crc', 'busy', 'not_found', 'bad_request', 'unsupported', 'timeout', 'disconnected', 'protocol'] as const)
      expect(describeError(new ProtoError(c)).length).toBeGreaterThan(10);
    expect(describeError(new Error('x'))).toBe('x');
  });
});

describe('client-side rule mirrors', () => {
  it('pathOk', () => {
    for (const p of ['/books/a.epub', '/ships/art/x.sbm', '/data/weather.json', '/cache/x', '/update/fw.bin'])
      expect(pathOk(p), p).toBe(true);
    for (const p of ['', 'books/a', '/books', '/books/', '/log.txt', '/etc/x', '/books/../x', '/books/./x', '/books//x', '/books/a\\b', '/books/a:b', '/books/a\u0001', '/books/' + 'a'.repeat(120)])
      expect(pathOk(p), p).toBe(false);
  });
  it('secretNameOk', () => {
    for (const n of ['pages', 'wifi.0', 'wifi.5', 'acct.a', 'acct.github_1', 'acct.abcdefghij']) expect(secretNameOk(n), n).toBe(true);
    for (const n of ['wifi.6', 'wifi.', 'acct.', 'acct.abcdefghijk', 'acct.A', 'acct.a-b', 'page', 'x']) expect(secretNameOk(n), n).toBe(false);
  });
});

describe('transports', () => {
  it('Web Bluetooth is reported missing in node and request() rejects', async () => {
    expect(bluetoothAvailable()).toBe(false);
    await expect(WebBluetoothTransport.request()).rejects.toThrow(/not available/);
  });

  it('only webbluetooth.ts touches .bluetooth', () => {
    const files = import.meta.glob('../src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const hits = Object.entries(files)
      .filter(([, src]) => /\.\s*bluetooth\b|\bbluetooth\s*\?\s*:/.test(src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')))
      .map(([p]) => p);
    expect(hits.every((p) => p.endsWith('/proto/webbluetooth.ts'))).toBe(true);
  });

  it('stdio framing: 2-byte big-endian length, frames split across chunks', async () => {
    type Cb = (c: Uint8Array) => void;
    let onData: Cb = () => {};
    const written: Uint8Array[] = [];
    const reader: ByteReader = {
      on(ev: string, cb: never) {
        if (ev === 'data') onData = cb as Cb;
        return this;
      },
    } as ByteReader;
    const writer: ByteWriter = {
      write(c, cb) {
        written.push(c);
        cb?.();
        return true;
      },
    };
    const t = new StdioTransport(reader, writer, 512);
    const got: number[][] = [];
    t.onFrame((f) => got.push([...f]));
    await t.send(new Uint8Array([1, 2, 3, 4, 5]));
    expect([...written[0]!]).toEqual([0, 5, 1, 2, 3, 4, 5]);
    const wire = new Uint8Array([0, 4, 9, 8, 7, 6, 0, 5, 1, 1, 1, 1, 1]);
    onData(wire.subarray(0, 3));
    expect(got).toEqual([]);
    onData(wire.subarray(3, 8));
    onData(wire.subarray(8));
    expect(got).toEqual([[9, 8, 7, 6], [1, 1, 1, 1, 1]]);
  });

  it('crc of data used for PUT_BEGIN matches the helper', () => {
    expect(crc32(te.encode('123456789'))).toBe(0xcbf43926);
  });
});
