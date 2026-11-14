// Harbor sync client (plan 3.2): request/response calls, PUT with window + acks + resume, GET, secrets, time.
// Talks to any Transport (Web Bluetooth, the FakeDevice, drydock over stdio). One connection, one transfer at a
// time (the device answers `busy` otherwise), any number of small control calls in between.
import {
  ackOffset,
  crc32,
  crc32Update,
  decode,
  DEVICE_ERRORS,
  encode,
  Flag,
  Op,
  Reassembler,
  split,
  maxPayload,
  windowAvail,
  WINDOW,
  MAX_CONTROL,
  MTU_MIN,
  MTU_MAX,
  type DeviceErrorCode,
  type Frame,
} from './codec';
import type { Transport } from './transport';

export type ErrorCode = DeviceErrorCode | 'timeout' | 'disconnected' | 'protocol';

export class ProtoError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'ProtoError';
    this.code = code;
  }
}

/** Human line for a code, for the UI. */
export function describeError(e: unknown): string {
  if (!(e instanceof ProtoError)) return e instanceof Error ? e.message : String(e);
  switch (e.code) {
    case 'bad_path': return 'The device does not accept that file name or location.';
    case 'no_space': return 'The device has no room for that.';
    case 'too_large': return 'That is too large for the device.';
    case 'crc': return 'The file arrived damaged. Try again.';
    case 'busy': return 'The device is busy with another transfer.';
    case 'not_found': return 'The device could not find that.';
    case 'bad_request': return 'The device did not understand the request.';
    case 'unsupported': return 'The device does not support that.';
    case 'timeout': return 'The device stopped answering.';
    case 'disconnected': return 'The device disconnected.';
    default: return 'Unexpected reply from the device.';
  }
}

export interface Hello {
  proto: number;
  fw: string;
  board: string;
  panel: string;
  id: string;
  name: string;
  mtu: number;
  batt: number;
  charging: boolean;
  time: number;
  free_kb: number;
  window: number;
}

export interface Entry {
  name: string;
  size: number;
  dir: boolean;
}

export interface SecretInfo {
  name: string;
  label: string;
  hosts?: string[];
  added?: number;
}

export interface ClientOptions {
  /** Inactivity limit per call in ms (any frame for that call resets it). 0 disables. Default 10000. */
  timeoutMs?: number;
}

export interface TimePayload {
  unix: number;
  off: number;
  next?: number;
  next_off?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- trust-boundary mirrors (same rules as firmware sync/server.cpp; the device is still the authority) ----------

const ROOTS = ['books', 'ships', 'data', 'cache', 'update'];

export function pathOk(path: string): boolean {
  const b = enc.encode(path);
  if (b.length === 0 || b.length > 120 || path[0] !== '/') return false;
  for (const c of b) if (c < 0x20 || c === 0x7f || c === 0x5c) return false;
  if (/[:*?"<>|]/.test(path)) return false;
  const parts = path.slice(1).split('/');
  if (parts.length < 2) return false; // something below a root directory
  for (const p of parts) if (p === '' || p === '.' || p === '..') return false;
  return ROOTS.includes(parts[0]!);
}

/** acct.<a-z0-9_>{1,10} | wifi.<0-5> | pages. ponytail: plan says {1,12}; NVS keys are 15 chars, so 10 (see 6A). */
export function secretNameOk(name: string): boolean {
  return name === 'pages' || /^wifi\.[0-5]$/.test(name) || /^acct\.[a-z0-9_]{1,10}$/.test(name);
}

// Mirrors budget::LUA_SOURCE_MAX (firmware/src/budget.h).
export const LUA_MAX = 131072;
// Mirrors budget::NVS_ACCOUNT_BYTES (firmware/src/budget.h).
export const SECRET_MAX = 384;

// ---- DST-aware time payload -------------------------------------------------------------------------------------

/** UTC offset in minutes east of Greenwich at an instant (ms since epoch), from the browser's zone. */
export function browserOffsetAt(ms: number): number {
  return -new Date(ms).getTimezoneOffset();
}

/** Builds the TIME payload; `next`/`next_off` are the next offset change within ~400 days (found to the millisecond, reported in seconds). */
export function timePayload(nowMs: number, offsetAt: (ms: number) => number = browserOffsetAt): TimePayload {
  const unix = Math.floor(nowMs / 1000);
  const off = offsetAt(nowMs);
  const out: TimePayload = { unix, off };
  const DAY = 86_400_000;
  let lo = nowMs;
  for (let d = 1; d <= 400; d++) {
    const hi = nowMs + d * DAY;
    if (offsetAt(hi) !== off) {
      let a = lo;
      let b = hi;
      while (b - a > 1) {
        const m = Math.floor((a + b) / 2);
        if (offsetAt(m) === off) a = m;
        else b = m;
      }
      out.next = Math.ceil(b / 1000);
      out.next_off = offsetAt(b);
      break;
    }
    lo = hi;
  }
  return out;
}

// ---- call plumbing ----------------------------------------------------------------------------------------------

class Call {
  err: ProtoError | null = null;
  private errReasm = new Reassembler();
  onFrame: (f: Frame) => void = () => {};
  private wake: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    readonly rid: number,
    private readonly ms: number,
    private readonly release: (rid: number) => void,
  ) {
    this.touch();
  }
  touch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ms > 0 && !this.err) this.timer = setTimeout(() => this.fail(new ProtoError('timeout')), this.ms);
  }
  /** True when `f` is an error reply (they can span several frames at a small MTU); fails the call once whole. */
  takeError(f: Frame): boolean {
    if (!(f.flags & Flag.Err)) return false;
    const r = this.errReasm.feed(f);
    if (r === 'complete') this.fail(parseError(this.errReasm.data()));
    else if (r !== 'partial') this.fail(new ProtoError('protocol', 'error reply too long'));
    return true;
  }
  signal(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }
  fail(e: ProtoError): void {
    if (this.err) return;
    this.err = e;
    this.finish();
    this.signal();
  }
  finish(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.release(this.rid);
  }
  async until(cond: () => boolean): Promise<void> {
    for (;;) {
      if (this.err) throw this.err;
      if (cond()) return;
      await new Promise<void>((r) => {
        this.wake = r;
      });
    }
  }
}

function parseError(payload: Uint8Array): ProtoError {
  try {
    const j = JSON.parse(dec.decode(payload)) as { code?: string; msg?: string };
    const code = (DEVICE_ERRORS as readonly string[]).includes(j.code ?? '') ? (j.code as DeviceErrorCode) : 'protocol';
    return new ProtoError(code, j.msg);
  } catch {
    return new ProtoError('protocol', 'unreadable error reply');
  }
}

function parseJson<T>(b: Uint8Array): T {
  try {
    return JSON.parse(dec.decode(b)) as T;
  } catch {
    throw new ProtoError('protocol', 'unreadable reply');
  }
}

export interface PutOptions {
  /** Called as bytes are handed to the radio: (sent, total). After a resume the first value is the resume point. */
  onProgress?: (sent: number, total: number) => void;
}

export interface GetOptions {
  /** Resume point: the returned bytes start here. */
  from?: number;
  /** The first `from` bytes already held, so the whole-file CRC can be checked after a resumed GET. */
  prefix?: Uint8Array;
  onProgress?: (received: number) => void;
}

export class Client {
  private readonly pending = new Map<number, Call>();
  private nextRid = 1;
  private sendLock: Promise<void> = Promise.resolve();
  private _mtu: number;
  private _window = WINDOW;
  private _closed = false;
  private readonly timeoutMs: number;
  private readonly unsub: Array<() => void> = [];
  hello: Hello | null = null;

  constructor(
    private readonly t: Transport,
    opts: ClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this._mtu = Math.min(MTU_MAX, Math.max(MTU_MIN, t.mtu));
    this.unsub.push(t.onFrame((b) => this.rx(b)));
    this.unsub.push(t.onClose((r) => this.dropAll(r)));
  }

  get mtu(): number {
    return this._mtu;
  }
  get window(): number {
    return this._window;
  }
  get closed(): boolean {
    return this._closed;
  }

  close(): void {
    this.t.close();
    this.dropAll('closed');
  }

  private dropAll(reason?: string): void {
    this._closed = true;
    for (const c of [...this.pending.values()]) c.fail(new ProtoError('disconnected', reason));
    for (const u of this.unsub.splice(0)) u();
  }

  private rx(bytes: Uint8Array): void {
    const f = decode(bytes);
    if (!f) return;
    const c = this.pending.get(f.rid);
    if (!c) return; // late frame of a finished or unknown call
    c.touch();
    c.onFrame(f);
  }

  private newCall(): Call {
    if (this._closed) throw new ProtoError('disconnected');
    for (let i = 0; i < 0x10000; i++) {
      const rid = this.nextRid;
      this.nextRid = this.nextRid >= 0xffff ? 1 : this.nextRid + 1;
      if (!this.pending.has(rid)) {
        const c = new Call(rid, this.timeoutMs, (r) => this.pending.delete(r));
        this.pending.set(rid, c);
        return c;
      }
    }
    throw new ProtoError('busy', 'too many calls in flight');
  }

  /**
   * Sends the frames of one message back to back. The device has a single reassembler, so two multi-frame messages
   * must never interleave: the whole message is sent under a lock (PUT_DATA frames take it one frame at a time).
   */
  private async sendFrames(call: Call, frames: Uint8Array[]): Promise<void> {
    const prev = this.sendLock;
    let release!: () => void;
    this.sendLock = new Promise<void>((r) => (release = r));
    await prev;
    try {
      for (const f of frames) {
        if (call.err) throw call.err;
        try {
          await this.t.send(f);
        } catch (e) {
          const err = new ProtoError('disconnected', e instanceof Error ? e.message : undefined);
          call.fail(err);
          throw err;
        }
        call.touch();
      }
    } finally {
      release();
    }
  }

  /** One control request and its (possibly multi-frame) response. */
  private async request(op: number, body: unknown, unbounded = false): Promise<Uint8Array> {
    const call = this.newCall();
    const reasm = new Reassembler(unbounded ? Infinity : MAX_CONTROL);
    let result: Uint8Array | null = null;
    call.onFrame = (f) => {
      if (call.takeError(f)) return;
      if (!(f.flags & Flag.Resp) || f.op !== op) return;
      const r = reasm.feed(f);
      if (r === 'complete') {
        result = reasm.data();
        call.signal();
      } else if (r === 'too_long' || r === 'dropped') {
        call.fail(new ProtoError('protocol', 'reply too long'));
      }
    };
    try {
      await this.sendFrames(call, split(op, 0, call.rid, enc.encode(JSON.stringify(body)), this._mtu));
      await call.until(() => result !== null);
      return result!;
    } finally {
      call.finish();
    }
  }

  async connectHello(app = 'harbor/1.0'): Promise<Hello> {
    const h = parseJson<Hello>(await this.request(Op.Hello, { proto: 1, app }));
    if (h.proto !== 1) throw new ProtoError('unsupported', 'protocol version');
    this.hello = h;
    if (Number.isFinite(h.mtu)) this._mtu = Math.min(MTU_MAX, Math.max(MTU_MIN, h.mtu));
    if (Number.isFinite(h.window) && h.window > 0) this._window = h.window;
    return h;
  }

  async setTime(p: TimePayload): Promise<void> {
    await this.request(Op.Time, p);
  }

  /** Sends the clock and zone of this browser (with the next DST change when there is one). */
  async syncClock(now: Date = new Date(), offsetAt: (ms: number) => number = browserOffsetAt): Promise<void> {
    await this.setTime(timePayload(now.getTime(), offsetAt));
  }

  async list(dir: string): Promise<Entry[]> {
    // ponytail: the whole listing is buffered; directories of tens of thousands of files would want a streaming API.
    const raw = dec.decode(await this.request(Op.List, { dir }, true));
    const out: Entry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const j = parseJson<{ n: string; s: number; d: boolean }>(enc.encode(line));
      out.push({ name: j.n, size: j.s, dir: !!j.d });
    }
    return out;
  }

  async del(path: string): Promise<void> {
    await this.request(Op.Delete, { path });
  }

  async secretSet(name: string, value: Record<string, unknown>): Promise<void> {
    await this.request(Op.SecretSet, { name, value });
  }
  async secretDel(name: string): Promise<void> {
    await this.request(Op.SecretDel, { name });
  }
  async secretList(): Promise<SecretInfo[]> {
    return parseJson<SecretInfo[]>(await this.request(Op.SecretList, {}));
  }

  /**
   * Uploads a whole file. If the link drops, call again on a new Client: PUT_BEGIN returns the resume point of the
   * matching `.part` and only the rest is sent. Resolves after the device verified size and CRC and renamed it.
   */
  async put(path: string, data: Uint8Array, opts: PutOptions = {}): Promise<void> {
    const size = data.length;
    const call = this.newCall();
    let from: number | null = null;
    let acked = 0;
    let ended = false;
    call.onFrame = (f) => {
      if (call.takeError(f)) return;
      if (f.op === Op.PutAck && !(f.flags & Flag.Resp)) {
        const o = ackOffset(f.payload);
        if (o !== null && o > acked) acked = o;
        call.signal();
      } else if (f.op === Op.PutBegin && f.flags & Flag.Resp) {
        const j = parseJson<{ from?: number }>(f.payload);
        from = typeof j.from === 'number' ? j.from : 0;
        call.signal();
      } else if (f.op === Op.PutEnd && f.flags & Flag.Resp) {
        ended = true;
        call.signal();
      }
    };
    try {
      const begin = { path, size, crc: crc32(data) };
      await this.sendFrames(call, split(Op.PutBegin, 0, call.rid, enc.encode(JSON.stringify(begin)), this._mtu));
      await call.until(() => from !== null);
      if (from! > size) throw new ProtoError('protocol', 'resume point past the end');
      let sent = from!;
      acked = sent;
      opts.onProgress?.(sent, size);
      const chunk = maxPayload(this._mtu);
      while (sent < size) {
        const avail = windowAvail(this._window, sent, acked);
        if (avail === 0) {
          await call.until(() => windowAvail(this._window, sent, acked) > 0);
          continue;
        }
        const n = Math.min(chunk, size - sent, avail);
        await this.sendFrames(call, [encode(Op.PutData, 0, call.rid, data.subarray(sent, sent + n))]);
        sent += n;
        opts.onProgress?.(sent, size);
      }
      await this.sendFrames(call, split(Op.PutEnd, 0, call.rid, enc.encode('{}'), this._mtu));
      await call.until(() => ended);
    } finally {
      call.finish();
    }
  }

  /**
   * Downloads a file (from `opts.from` when resuming). Verifies size, and the CRC when it can (from 0, or with
   * `opts.prefix`). ponytail: a link drop loses the bytes received so far; keep them via onProgress + a resume call.
   */
  async get(path: string, opts: GetOptions = {}): Promise<Uint8Array> {
    const from = opts.from ?? 0;
    const call = this.newCall();
    const chunks: Uint8Array[] = [];
    let got = 0;
    let end: { size: number; crc: number } | null = null;
    call.onFrame = (f) => {
      if (call.takeError(f)) return;
      if (!(f.flags & Flag.Resp)) return;
      if (f.op === Op.GetData) {
        chunks.push(f.payload.slice());
        got += f.payload.length;
        opts.onProgress?.(from + got);
      } else if (f.op === Op.GetEnd) {
        end = parseJson<{ size: number; crc: number }>(f.payload);
        call.signal();
      }
    };
    try {
      const body = enc.encode(JSON.stringify({ path, from }));
      await this.sendFrames(call, split(Op.Get, 0, call.rid, body, this._mtu));
      await call.until(() => end !== null);
      const out = new Uint8Array(got);
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.length;
      }
      const e = end!;
      if (e.size !== from + got) throw new ProtoError('crc', 'size mismatch');
      if (from === 0) {
        if (crc32(out) !== e.crc) throw new ProtoError('crc', 'checksum mismatch');
      } else if (opts.prefix && opts.prefix.length === from) {
        if (crc32Update(crc32(opts.prefix), out) !== e.crc) throw new ProtoError('crc', 'checksum mismatch');
      }
      return out;
    } finally {
      call.finish();
    }
  }
}
