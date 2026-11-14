// Harbor sync framing (plan 3.2). Mirror of firmware/src/sync/codec.*; both are tested against
// docs/protocol/vectors.json. Pure functions, no I/O, no DOM.

export const Op = {
  Hello: 0x01,
  Time: 0x02,
  List: 0x10,
  PutBegin: 0x11,
  PutData: 0x12,
  PutEnd: 0x13,
  PutAck: 0x14,
  Get: 0x15,
  GetData: 0x16,
  GetEnd: 0x17,
  Delete: 0x18,
  SecretSet: 0x20,
  SecretDel: 0x21,
  SecretList: 0x22,
} as const;

export const Flag = { More: 1, Resp: 2, Err: 4 } as const;

export const HEADER_BYTES = 4;
export const ATT_OVERHEAD = 3;
export const MAX_CONTROL = 4096;
export const ACK_EVERY = 32768;
export const WINDOW = 65536;
export const MTU_MIN = 23;
export const MTU_MAX = 512;

/** Error codes the device sends in {"code":...}. */
export const DEVICE_ERRORS = [
  'bad_path',
  'no_space',
  'too_large',
  'crc',
  'busy',
  'not_found',
  'bad_request',
  'unsupported',
] as const;
export type DeviceErrorCode = (typeof DEVICE_ERRORS)[number];

export interface Frame {
  op: number;
  flags: number;
  rid: number;
  payload: Uint8Array;
}

/** Null when shorter than a header. The payload is a view into `bytes`, not a copy. */
export function decode(bytes: Uint8Array): Frame | null {
  if (bytes.length < HEADER_BYTES) return null;
  return {
    op: bytes[0]!,
    flags: bytes[1]!,
    rid: bytes[2]! | (bytes[3]! << 8),
    payload: bytes.subarray(HEADER_BYTES),
  };
}

export function encode(op: number, flags: number, rid: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  out[0] = op;
  out[1] = flags;
  out[2] = rid & 0xff;
  out[3] = (rid >> 8) & 0xff;
  out.set(payload, HEADER_BYTES);
  return out;
}

/** Payload bytes one frame can carry at this MTU (0 when the MTU is unusable). */
export function maxPayload(mtu: number): number {
  const m = Math.min(mtu, MTU_MAX);
  return Math.max(0, m - ATT_OVERHEAD - HEADER_BYTES);
}

/** Splits a message into frames of at most mtu-3 bytes; MORE on every frame but the last. */
export function split(op: number, flags: number, rid: number, payload: Uint8Array, mtu: number): Uint8Array[] {
  const per = maxPayload(mtu);
  if (per === 0) throw new RangeError(`mtu ${mtu} too small`);
  const base = flags & ~Flag.More;
  const frames: Uint8Array[] = [];
  let off = 0;
  do {
    const n = Math.min(per, payload.length - off);
    const last = off + n >= payload.length;
    frames.push(encode(op, base | (last ? 0 : Flag.More), rid, payload.subarray(off, off + n)));
    off += n;
  } while (off < payload.length);
  return frames;
}

export type ReassemblyResult = 'partial' | 'complete' | 'too_long' | 'dropped';

/** Joins the frames of one message (same op and rid, MORE on all but the last). Same rules as the C++ class. */
export class Reassembler {
  private chunks: Uint8Array[] = [];
  private len = 0;
  private open = false;
  private dropping = false;
  private _op = 0;
  private _rid = 0;
  private _flags = 0;
  /** ponytail: 4096 matches the device; LIST responses are unbounded so the client raises this for them. */
  limit: number;

  constructor(limit = MAX_CONTROL) {
    this.limit = limit;
  }

  get op(): number {
    return this._op;
  }
  get rid(): number {
    return this._rid;
  }
  get flags(): number {
    return this._flags;
  }
  get size(): number {
    return this.len;
  }
  /** The joined message; valid after 'complete'. */
  data(): Uint8Array {
    if (this.chunks.length === 1) return this.chunks[0]!;
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  reset(): void {
    this.chunks = [];
    this.len = 0;
    this.open = false;
    this.dropping = false;
  }

  feed(f: Frame): ReassemblyResult {
    if ((this.open || this.dropping) && (f.op !== this._op || f.rid !== this._rid)) this.reset();
    if (!this.open && !this.dropping) {
      this._op = f.op;
      this._rid = f.rid;
      this.chunks = [];
      this.len = 0;
      this.open = true;
    }
    const more = (f.flags & Flag.More) !== 0;
    if (this.dropping) {
      if (!more) this.reset();
      return 'dropped';
    }
    if (this.len + f.payload.length > this.limit) {
      this.chunks = [];
      this.len = 0;
      this.open = false;
      if (more) this.dropping = true;
      return 'too_long';
    }
    if (f.payload.length) {
      this.chunks.push(f.payload);
      this.len += f.payload.length;
    }
    if (more) return 'partial';
    this._flags = f.flags & ~Flag.More;
    this.open = false;
    return 'complete';
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE, as zlib). crc32Update(crc32Update(0, a), b) === crc32(a ++ b). Result is unsigned. */
export function crc32Update(crc: number, data: Uint8Array): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

export function crc32(data: Uint8Array): number {
  return crc32Update(0, data);
}

/** PUT_ACK is due when the stream crossed a multiple of ACK_EVERY, or reached `size`. */
export function ackDue(before: number, after: number, size: number): boolean {
  if (after > before && Math.floor(after / ACK_EVERY) !== Math.floor(before / ACK_EVERY)) return true;
  return after === size && after !== before;
}

/** Bytes Harbor may still send: window minus unacknowledged (sent - acked), never negative. */
export function windowAvail(window: number, sent: number, acked: number): number {
  const unacked = sent >= acked ? sent - acked : 0;
  return unacked >= window ? 0 : window - unacked;
}

export function ackOffset(payload: Uint8Array): number | null {
  if (payload.length < 4) return null;
  return (payload[0]! | (payload[1]! << 8) | (payload[2]! << 16) | (payload[3]! << 24)) >>> 0;
}

export function ackPayload(off: number): Uint8Array {
  return new Uint8Array([off & 0xff, (off >>> 8) & 0xff, (off >>> 16) & 0xff, (off >>> 24) & 0xff]);
}

export function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
