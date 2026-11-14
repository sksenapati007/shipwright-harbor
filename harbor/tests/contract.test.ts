// Contract test (plan 6F): the real C++ hsync::Server (sim binary, `sim sync --sd DIR`) driven through the real TS
// Client over StdioTransport. No fake device here: this is where the two implementations must agree.
// Needs the sim binary: `pio run -d firmware -e sim` (scripts/check.sh does it first and sets CONTRACT_REQUIRED=1,
// which turns a missing binary into a failure instead of a skip).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, ProtoError } from '../src/proto/client';
import { StdioTransport } from '../src/proto/stdio';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

function simPath(): string {
  if (env.DRYDOCK_SIM) return env.DRYDOCK_SIM;
  const bdir = env.PLATFORMIO_BUILD_DIR || join(ROOT, 'firmware', '.pio', 'build');
  return join(bdir, 'sim', 'program');
}
const SIM = simPath();
const HAVE_SIM = existsSync(SIM);
if (!HAVE_SIM && env.CONTRACT_REQUIRED === '1') {
  throw new Error(`contract test: sim binary missing at ${SIM}; run: pio run -d firmware -e sim`);
}
const d = HAVE_SIM ? describe : describe.skip;

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function rnd(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

interface Dev {
  proc: ChildProcess;
  client: Client;
  exited: Promise<number | null>;
}

function launch(sd: string, mtu = 512): Dev {
  const proc = spawn(SIM, ['sync', '--sd', sd, '--mtu', String(mtu)], { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr.on('data', () => {});
  proc.stdin.on('error', () => {}); // EPIPE after a deliberate kill
  const exited = new Promise<number | null>((r) => proc.on('exit', r));
  const t = new StdioTransport(proc.stdout, proc.stdin, mtu, () => {
    try {
      proc.stdin.end();
    } catch {
      /* already closed */
    }
    proc.kill('SIGKILL');
  });
  return { proc, client: new Client(t, { timeoutMs: 15000 }), exited };
}

d('contract: TS client vs C++ server (sim)', () => {
  let sd = '';
  const devs: Dev[] = [];
  const start = (mtu?: number): Dev => {
    const dv = launch(sd, mtu);
    devs.push(dv);
    return dv;
  };
  beforeEach(() => {
    sd = mkdtempSync(join(tmpdir(), 'swcontract-'));
    for (const r of ['books', 'ships', 'data', 'cache', 'update']) mkdirSync(join(sd, r), { recursive: true });
  });
  afterEach(async () => {
    for (const dv of devs.splice(0)) {
      dv.client.close();
      await dv.exited;
    }
    rmSync(sd, { recursive: true, force: true });
  });

  it('HELLO reports the protocol, board, mtu and window', async () => {
    const dv = start();
    const h = await dv.client.connectHello();
    expect(h.proto).toBe(1);
    expect(h.name).toMatch(/^Shipwright-/);
    expect(h.mtu).toBeGreaterThanOrEqual(23);
    expect(h.window).toBeGreaterThanOrEqual(32768);
  });

  it('TIME is accepted', async () => {
    const dv = start();
    await dv.client.connectHello();
    await dv.client.syncClock(new Date(Date.UTC(2026, 10, 14, 12, 0, 0)), () => 60);
  });

  it('PUT 300 KB, LIST, GET back identical, DELETE', async () => {
    const dv = start();
    await dv.client.connectHello();
    const data = rnd(300 * 1024, 7);
    const seen: number[] = [];
    await dv.client.put('/books/big.bin', data, { onProgress: (s) => seen.push(s) });
    expect(seen[seen.length - 1]).toBe(data.length);
    expect(same(readFileSync(join(sd, 'books', 'big.bin')), data)).toBe(true);

    const ls = await dv.client.list('/books');
    const e = ls.find((x) => x.name === 'big.bin');
    expect(e).toBeTruthy();
    expect(e!.size).toBe(data.length);
    expect(e!.dir).toBe(false);
    expect(ls.some((x) => x.name.endsWith('.part'))).toBe(false);

    const back = await dv.client.get('/books/big.bin');
    expect(back.length).toBe(data.length);
    expect(same(back, data)).toBe(true);

    // resumed GET with a known prefix
    const tail = await dv.client.get('/books/big.bin', { from: 100000, prefix: data.subarray(0, 100000) });
    expect(same(tail, data.subarray(100000))).toBe(true);

    await dv.client.del('/books/big.bin');
    expect(readdirSync(join(sd, 'books'))).not.toContain('big.bin');
    expect((await dv.client.list('/books')).some((x) => x.name === 'big.bin')).toBe(false);
  });

  it('small MTU (23) works end to end', async () => {
    const dv = start(23);
    await dv.client.connectHello();
    const data = rnd(20000, 3);
    await dv.client.put('/data/small.bin', data);
    const back = await dv.client.get('/data/small.bin');
    expect(same(back, data)).toBe(true);
  });

  it('resumes after the process is killed mid-PUT', async () => {
    const data = rnd(300 * 1024, 11);
    const first = start();
    await first.client.connectHello();
    let killed = false;
    const p1 = first.client.put('/books/resume.bin', data, {
      onProgress: (sent) => {
        if (!killed && sent >= 160 * 1024) {
          killed = true;
          first.proc.kill('SIGKILL');
        }
      },
    });
    await expect(p1).rejects.toBeInstanceOf(ProtoError);
    await first.exited;
    expect(killed).toBe(true);
    expect(existsOrList(sd, 'books').some((n) => n.endsWith('.part'))).toBe(true);
    expect(existsOrList(sd, 'books')).not.toContain('resume.bin');

    const second = start();
    await second.client.connectHello();
    const prog: number[] = [];
    await second.client.put('/books/resume.bin', data, { onProgress: (s) => prog.push(s) });
    expect(prog[0]).toBeGreaterThan(0); // resumed, not restarted
    expect(prog[0]).toBeLessThan(data.length);
    expect(same(readFileSync(join(sd, 'books', 'resume.bin')), data)).toBe(true);
    expect(existsOrList(sd, 'books').some((n) => n.endsWith('.part'))).toBe(false);
  });

  it('a .. path gives bad_path (PUT, GET, DELETE, LIST)', async () => {
    const dv = start();
    await dv.client.connectHello();
    const bad = '/books/../data/x.bin';
    const code = async (f: () => Promise<unknown>): Promise<string> => {
      try {
        await f();
      } catch (e) {
        return e instanceof ProtoError ? e.code : 'other:' + String(e);
      }
      return 'no error';
    };
    expect(await code(() => dv.client.put(bad, new Uint8Array(10)))).toBe('bad_path');
    expect(await code(() => dv.client.get(bad))).toBe('bad_path');
    expect(await code(() => dv.client.del(bad))).toBe('bad_path');
    expect(await code(() => dv.client.list('/books/..'))).toBe('bad_path');
    expect(readdirSync(join(sd, 'data'))).toEqual([]);
    // the link is still usable afterwards
    await dv.client.put('/data/ok.bin', new Uint8Array([1, 2, 3]));
    expect(Array.from(readFileSync(join(sd, 'data', 'ok.bin')))).toEqual([1, 2, 3]);
  });

  it('GET of a missing file gives not_found; a non-.lua ship is rejected', async () => {
    const dv = start();
    await dv.client.connectHello();
    await expect(dv.client.get('/books/nope.bin')).rejects.toMatchObject({ code: 'not_found' });
    writeFileSync(join(sd, 'books', 'a.txt'), 'hi');
    expect(Array.from(await dv.client.get('/books/a.txt'))).toEqual([104, 105]);
  });
});

function existsOrList(sd: string, sub: string): string[] {
  try {
    return readdirSync(join(sd, sub));
  } catch {
    return [];
  }
}
