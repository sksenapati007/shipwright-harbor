// DEV/TEST ONLY: reachable solely through connection.ts behind __HARBOR_FAKE__ (see vite.config.ts); release builds drop it.
// FakeDevice: an in-memory Shipwright device that speaks the Harbor sync protocol over a Transport. Used by the
// client tests (6D) and the Playwright feature tests (6E). Mirrors firmware/src/sync/server.cpp behaviour:
// same error codes, `<path>.<crc8hex>.part` resume, acks every 32 KB, secrets never listed with values.
// Runs in browsers and node: no node imports. Fault injection knobs are public fields.
import {
  ackDue,
  ackPayload,
  crc32Update,
  decode,
  encode,
  Flag,
  maxPayload,
  Op,
  Reassembler,
  split,
  WINDOW,
  MAX_CONTROL,
  type Frame,
} from './codec';
import { keyOk } from '../features/pages/logic';
import { LUA_MAX, pathOk, SECRET_MAX, secretNameOk } from './client';
import type { Transport } from './transport';

const enc = new TextEncoder();
const dec = new TextDecoder();
const FREE_MARGIN = 4 * 1024 * 1024;

export interface FakeOptions {
  mtu?: number;
  name?: string;
  id?: string;
  freeBytes?: number;
}

interface PutState {
  rid: number;
  path: string;
  part: string;
  size: number;
  crcWant: number;
  crc: number;
  buf: Uint8Array;
  off: number;
}

class FakeLink implements Transport {
  private frameCbs = new Set<(f: Uint8Array) => void>();
  private closeCbs = new Set<(r?: string) => void>();
  closed = false;
  constructor(
    readonly mtu: number,
    private readonly dev: FakeDevice,
  ) {}
  send(frame: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error('disconnected'));
    const copy = frame.slice();
    return Promise.resolve().then(() => {
      if (!this.closed) this.dev.receive(this, copy);
    });
  }
  /** Device to host, delivered asynchronously like a notification. */
  deliver(frame: Uint8Array): void {
    if (this.closed) return;
    const copy = frame.slice();
    queueMicrotask(() => {
      if (this.closed) return;
      for (const cb of [...this.frameCbs]) cb(copy);
    });
  }
  onFrame(cb: (f: Uint8Array) => void): () => void {
    this.frameCbs.add(cb);
    return () => this.frameCbs.delete(cb);
  }
  onClose(cb: (r?: string) => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }
  close(): void {
    this.drop('closed');
  }
  drop(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.dev.linkClosed(this);
    queueMicrotask(() => {
      for (const cb of [...this.closeCbs]) cb(reason);
    });
  }
}

export class FakeDevice {
  /** Complete files by absolute path. */
  files = new Map<string, Uint8Array>();
  /** Half uploads, keyed `<path>.<crc8hex>.part`, kept across disconnects. */
  parts = new Map<string, Uint8Array>();
  secrets = new Map<string, Record<string, unknown>>();
  clock: { unix: number; off: number; next?: number; next_off?: number } | null = null;
  opts: Required<FakeOptions>;

  // Fault injection.
  /** Cut the link once this many PUT payload bytes have arrived (counted across the device's life); then disarm. */
  dropAfterPutBytes: number | null = null;
  /** Ops that are received and ignored (the client should time out). */
  silentOps = new Set<number>();
  /** Don't send PUT_ACKs (a stuck window). */
  suppressAcks = false;
  /** Flip the low bit of the PUT byte at this absolute file offset as it arrives (a checksum mismatch at PUT_END). */
  corruptPutByteAt: number | null = null;
  /** Cut the link after this many GET_DATA frames were sent; then disarm. */
  dropAfterGetFrames: number | null = null;

  // Observation.
  readonly log: Array<{ op: number; flags: number; rid: number; len: number }> = [];
  maxUnacked = 0;
  putBytesReceived = 0;

  private link: FakeLink | null = null;
  private rx = new Reassembler(MAX_CONTROL);
  private put: PutState | null = null;
  private lastAck = 0;

  constructor(o: FakeOptions = {}) {
    this.opts = {
      mtu: o.mtu ?? 185,
      name: o.name ?? 'Shipwright-A1B2',
      id: o.id ?? 'AA:BB:CC:DD:A1:B2',
      freeBytes: o.freeBytes ?? 64 * 1024 * 1024,
    };
  }

  /** A new connection; any earlier one is dropped (one connection at a time). */
  connect(): Transport {
    this.link?.drop('replaced');
    const l = new FakeLink(this.opts.mtu, this);
    this.link = l;
    this.rx = new Reassembler(MAX_CONTROL);
    this.put = null;
    return l;
  }

  /** Cut the current link from the device side. A half PUT keeps its part file. */
  disconnect(): void {
    this.link?.drop('device dropped');
  }

  /** @internal */
  linkClosed(l: FakeLink): void {
    if (this.link !== l) return;
    this.link = null;
    if (this.put) this.parts.set(this.put.part, this.put.buf.slice(0, this.put.off));
    this.put = null;
  }

  /** @internal */
  receive(l: FakeLink, bytes: Uint8Array): void {
    if (l !== this.link) return;
    const f = decode(bytes);
    if (!f || f.flags & Flag.Resp) return;
    this.log.push({ op: f.op, flags: f.flags, rid: f.rid, len: f.payload.length });
    if (this.silentOps.has(f.op)) return;
    if (f.op === Op.PutData) return this.putData(l, f);
    const r = this.rx.feed(f);
    if (r === 'too_long') return this.fail(l, f.op, f.rid, 'too_large', 'message over 4096 bytes');
    if (r !== 'complete') return;
    let body: Record<string, unknown> = {};
    try {
      const txt = dec.decode(this.rx.data());
      body = txt ? (JSON.parse(txt) as Record<string, unknown>) : {};
    } catch {
      return this.fail(l, f.op, f.rid, 'bad_request', 'not JSON');
    }
    this.handle(l, this.rx.op, this.rx.rid, body);
  }

  // ---- output helpers ---------------------------------------------------------------------------------------

  private respond(l: FakeLink, op: number, rid: number, body: unknown): void {
    this.respondRaw(l, op, rid, enc.encode(JSON.stringify(body)));
  }
  private respondRaw(l: FakeLink, op: number, rid: number, payload: Uint8Array): void {
    for (const fr of split(op, Flag.Resp, rid, payload, l.mtu)) l.deliver(fr);
  }
  private fail(l: FakeLink, op: number, rid: number, code: string, msg: string): void {
    for (const fr of split(op, Flag.Resp | Flag.Err, rid, enc.encode(JSON.stringify({ code, msg })), l.mtu))
      l.deliver(fr);
  }

  private freeNow(): number {
    let used = 0;
    for (const v of this.files.values()) used += v.length;
    for (const v of this.parts.values()) used += v.length;
    return Math.max(0, this.opts.freeBytes - used);
  }

  // ---- ops --------------------------------------------------------------------------------------------------

  private handle(l: FakeLink, op: number, rid: number, b: Record<string, unknown>): void {
    switch (op) {
      case Op.Hello:
        if (b.proto !== 1) return this.fail(l, op, rid, 'unsupported', 'protocol version');
        return this.respond(l, op, rid, {
          proto: 1,
          fw: '1.0.0',
          board: 'x4c',
          panel: 'UC8279',
          id: this.opts.id,
          name: this.opts.name,
          mtu: l.mtu,
          batt: 87,
          charging: false,
          time: this.clock?.unix ?? 0,
          free_kb: Math.floor(this.freeNow() / 1024),
          window: WINDOW,
        });
      case Op.Time: {
        const unix = b.unix;
        const off = b.off;
        if (typeof unix !== 'number' || typeof off !== 'number') return this.fail(l, op, rid, 'bad_request', 'unix and off needed');
        const hasNext = 'next' in b;
        if (hasNext !== 'next_off' in b) return this.fail(l, op, rid, 'bad_request', 'next and next_off go together');
        if (unix < 946684800 || off < -720 || off > 840) return this.fail(l, op, rid, 'bad_request', 'time out of range');
        this.clock = { unix, off };
        if (hasNext) {
          this.clock.next = b.next as number;
          this.clock.next_off = b.next_off as number;
        }
        return this.respond(l, op, rid, {});
      }
      case Op.List: {
        const dir = String(b.dir ?? '');
        if (!/^\/[^/]/.test(dir) || dir.includes('..') || !['books', 'ships', 'data', 'cache', 'update'].includes(dir.split('/')[1]!))
          return this.fail(l, op, rid, 'bad_path', 'path not allowed');
        const pre = dir.endsWith('/') ? dir : dir + '/';
        const seen = new Map<string, { s: number; d: boolean }>();
        for (const [p, v] of this.files) {
          if (!p.startsWith(pre)) continue;
          const rest = p.slice(pre.length);
          const i = rest.indexOf('/');
          if (i < 0) seen.set(rest, { s: v.length, d: false });
          else if (!seen.has(rest.slice(0, i))) seen.set(rest.slice(0, i), { s: 0, d: true });
        }
        const lines = [...seen].map(([n, v]) => JSON.stringify({ n, s: v.s, d: v.d }) + '\n').join('');
        return this.respondRaw(l, op, rid, enc.encode(lines));
      }
      case Op.PutBegin:
        return this.putBegin(l, rid, b);
      case Op.PutEnd:
        return this.putEnd(l, rid);
      case Op.Get:
        return this.get(l, rid, b);
      case Op.Delete: {
        const path = String(b.path ?? '');
        if (!pathOk(path)) return this.fail(l, op, rid, 'bad_path', 'path not allowed');
        if (!this.files.delete(path)) return this.fail(l, op, rid, 'not_found', 'no such file');
        return this.respond(l, op, rid, {});
      }
      case Op.SecretSet: {
        const name = String(b.name ?? '');
        if (!secretNameOk(name)) return this.fail(l, op, rid, 'bad_request', 'secret name not allowed');
        const v = b.value;
        if (!v || typeof v !== 'object' || Array.isArray(v)) return this.fail(l, op, rid, 'bad_request', 'value must be an object');
        if (enc.encode(JSON.stringify(v)).length > SECRET_MAX) return this.fail(l, op, rid, 'too_large', 'value over 384 bytes');
        const o = v as Record<string, unknown>;
        // The device's rules (sys/secrets acct_set, net/ntfy secret_valid), so e2e matches the C++ server.
        if (name.startsWith('acct.')) {
          if (typeof o.token !== 'string' || !o.token) return this.fail(l, op, rid, 'bad_request', 'bad account value');
          if (!Array.isArray(o.hosts) || o.hosts.length < 1) return this.fail(l, op, rid, 'bad_request', 'bad account value');
          const count = [...this.secrets.keys()].filter((k) => k.startsWith('acct.')).length;
          if (!this.secrets.has(name) && count >= 6) return this.fail(l, op, rid, 'bad_request', 'too many accounts');
        }
        if (name === 'pages') {
          const base = o.base;
          const baseOk = base === undefined || base === '' || (typeof base === 'string' && /^https?:\/\/[^\s/]+/.test(base));
          if (typeof o.topic !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(o.topic) || !baseOk || ('key' in o && !(typeof o.key === 'string' && keyOk(o.key))))
            return this.fail(l, op, rid, 'bad_request', 'bad Pages setup (topic, server or key)');
        }
        this.secrets.set(name, o);
        return this.respond(l, op, rid, {});
      }
      case Op.SecretDel: {
        const name = String(b.name ?? '');
        if (!secretNameOk(name)) return this.fail(l, op, rid, 'bad_request', 'secret name not allowed');
        if (!this.secrets.delete(name)) return this.fail(l, op, rid, 'not_found', 'no such secret');
        return this.respond(l, op, rid, {});
      }
      case Op.SecretList: {
        const out = [...this.secrets].map(([name, v]) => {
          const label = name.startsWith('wifi.') ? String(v.ssid ?? '') : name === 'pages' ? 'Pages' : String(v.label ?? '');
          const e: Record<string, unknown> = { name, label };
          if (Array.isArray(v.hosts)) e.hosts = v.hosts;
          if (typeof v.added === 'number') e.added = v.added;
          return e;
        });
        return this.respond(l, op, rid, out);
      }
      default:
        return this.fail(l, op, rid, 'unsupported', 'unknown op');
    }
  }

  private putBegin(l: FakeLink, rid: number, b: Record<string, unknown>): void {
    const { path, size, crc } = b;
    if (typeof path !== 'string' || typeof size !== 'number' || typeof crc !== 'number' || size < 0 || crc < 0 || crc > 0xffffffff)
      return this.fail(l, Op.PutBegin, rid, 'bad_request', 'path, size and crc needed');
    if (!pathOk(path) || path.toLowerCase().endsWith('.part')) return this.fail(l, Op.PutBegin, rid, 'bad_path', 'path not allowed');
    if (path.toLowerCase().endsWith('.lua') && size > LUA_MAX) return this.fail(l, Op.PutBegin, rid, 'too_large', 'script over 128 KB');
    if (this.put) return this.fail(l, Op.PutBegin, rid, 'busy', 'transfer in progress');
    const part = `${path}.${crc.toString(16).padStart(8, '0')}.part`;
    let from = 0;
    let crcHave = 0;
    const old = this.parts.get(part);
    if (old && old.length > 0 && old.length <= size) {
      from = old.length;
      crcHave = crc32Update(0, old);
    } else this.parts.delete(part);
    if (size - from + FREE_MARGIN > this.freeNow()) return this.fail(l, Op.PutBegin, rid, 'no_space', 'not enough space on the card');
    const buf = new Uint8Array(size);
    if (old && from) buf.set(old);
    this.put = { rid, path, part, size, crcWant: crc, crc: crcHave, buf, off: from };
    this.lastAck = from;
    this.respond(l, Op.PutBegin, rid, { from });
  }

  private putData(l: FakeLink, f: Frame): void {
    const p = this.put;
    if (!p || f.rid !== p.rid) return this.fail(l, Op.PutData, f.rid, 'bad_request', 'no upload in progress');
    const n = f.payload.length;
    if (n === 0) return;
    if (p.off + n > p.size) {
      this.put = null;
      this.parts.delete(p.part);
      return this.fail(l, Op.PutData, f.rid, 'too_large', 'more data than announced');
    }
    p.buf.set(f.payload, p.off);
    const c = this.corruptPutByteAt;
    if (c !== null && c >= p.off && c < p.off + n) p.buf[c] = p.buf[c]! ^ 1; // device CRC is of what it received
    const before = p.off;
    p.off += n;
    p.crc = crc32Update(p.crc, p.buf.subarray(p.off - n, p.off));
    this.putBytesReceived += n;
    this.maxUnacked = Math.max(this.maxUnacked, p.off - this.lastAck);
    if (ackDue(before, p.off, p.size) && !this.suppressAcks) {
      this.lastAck = p.off;
      l.deliver(encode(Op.PutAck, 0, f.rid, ackPayload(p.off)));
    }
    if (this.dropAfterPutBytes !== null && this.putBytesReceived >= this.dropAfterPutBytes) {
      this.dropAfterPutBytes = null;
      l.drop('injected drop');
    }
  }

  private putEnd(l: FakeLink, rid: number): void {
    const p = this.put;
    if (!p) return this.fail(l, Op.PutEnd, rid, 'bad_request', 'no upload in progress');
    this.put = null;
    if (p.off !== p.size || p.crc !== p.crcWant) {
      this.parts.delete(p.part);
      return this.fail(l, Op.PutEnd, rid, 'crc', p.off < p.size ? 'file incomplete' : 'checksum mismatch');
    }
    this.parts.delete(p.part);
    this.files.set(p.path, p.buf);
    this.respond(l, Op.PutEnd, rid, {});
  }

  private get(l: FakeLink, rid: number, b: Record<string, unknown>): void {
    const path = String(b.path ?? '');
    const from = b.from === undefined ? 0 : b.from;
    if (typeof b.path !== 'string') return this.fail(l, Op.Get, rid, 'bad_request', 'path missing');
    if (typeof from !== 'number') return this.fail(l, Op.Get, rid, 'bad_request', 'from must be a number');
    if (!pathOk(path)) return this.fail(l, Op.Get, rid, 'bad_path', 'path not allowed');
    if (this.put) return this.fail(l, Op.Get, rid, 'busy', 'transfer in progress');
    const data = this.files.get(path);
    if (!data) return this.fail(l, Op.Get, rid, 'not_found', 'no such file');
    if (from < 0 || from > data.length) return this.fail(l, Op.Get, rid, 'bad_request', 'from is past the end');
    const per = maxPayload(l.mtu);
    let frames = 0;
    for (let o = from; o < data.length; o += per) {
      l.deliver(encode(Op.GetData, Flag.Resp, rid, data.subarray(o, Math.min(data.length, o + per))));
      frames++;
      if (this.dropAfterGetFrames !== null && frames >= this.dropAfterGetFrames) {
        this.dropAfterGetFrames = null;
        l.drop('injected drop');
        return;
      }
    }
    this.respond(l, Op.GetEnd, rid, { size: data.length, crc: crc32Update(0, data) });
  }
}
