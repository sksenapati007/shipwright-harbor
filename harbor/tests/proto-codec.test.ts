import { describe, expect, it } from 'vitest';
import vectors from '../../docs/protocol/vectors.json';
import {
  ackDue,
  ackOffset,
  ackPayload,
  crc32,
  crc32Update,
  decode,
  encode,
  fromHex,
  hex,
  Reassembler,
  split,
  windowAvail,
  type Frame,
} from '../src/proto/codec';

const frameOf = (h: string): Frame => {
  const f = decode(fromHex(h));
  if (!f) throw new Error('short frame in vector');
  return f;
};

describe('vectors.json: frames', () => {
  for (const v of vectors.frames) {
    it(`encodes and decodes: ${v.name}`, () => {
      const payload = fromHex(v.payload_hex);
      expect(hex(encode(v.op, v.flags, v.rid, payload))).toBe(v.hex);
      const f = frameOf(v.hex);
      expect([f.op, f.flags, f.rid]).toEqual([v.op, v.flags, v.rid]);
      expect(hex(f.payload)).toBe(v.payload_hex);
    });
  }
  it('rejects a frame shorter than the header', () => {
    expect(decode(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(decode(new Uint8Array([1, 2, 3, 4]))).not.toBeNull();
  });
});

describe('vectors.json: splits', () => {
  for (const v of vectors.splits) {
    it(v.name, () => {
      const frames = split(v.op, v.flags, v.rid, fromHex(v.payload_hex), v.mtu);
      expect(frames.map(hex)).toEqual(v.frames);
      for (const f of frames) expect(f.length).toBeLessThanOrEqual(v.mtu - 3);
    });
  }
  it('refuses an unusable MTU', () => {
    expect(() => split(1, 0, 1, new Uint8Array(3), 7)).toThrow();
  });
});

describe('vectors.json: reassembly', () => {
  for (const v of vectors.reassembly) {
    it(v.name, () => {
      const r = new Reassembler();
      const got = v.frames.map((h) => r.feed(frameOf(h)));
      expect(got).toEqual(v.results);
      expect(hex(r.data())).toBe(v.payload_hex);
    });
  }
  it('a control message over 4096 bytes is too_long, and its tail is dropped', () => {
    const g = vectors.reassembly_overlong.generate;
    const payload = new Uint8Array(g.count).fill(parseInt(g.fill_hex, 16));
    const r = new Reassembler();
    const results = split(g.op, 0, g.rid, payload, g.mtu).map((f) => r.feed(frameOf(hex(f))));
    expect(results[results.length - 1]).toBe(vectors.reassembly_overlong.results_last);
    // A raised limit (LIST responses) takes the same bytes.
    const big = new Reassembler(Infinity);
    const res2 = split(g.op, 0, g.rid, payload, g.mtu).map((f) => big.feed(frameOf(hex(f))));
    expect(res2[res2.length - 1]).toBe('complete');
    expect(big.size).toBe(g.count);
  });
  it('recovers after a too-long message', () => {
    const r = new Reassembler(10);
    expect(r.feed({ op: 1, flags: 1, rid: 1, payload: new Uint8Array(8) })).toBe('partial');
    expect(r.feed({ op: 1, flags: 1, rid: 1, payload: new Uint8Array(8) })).toBe('too_long');
    expect(r.feed({ op: 1, flags: 0, rid: 1, payload: new Uint8Array(1) })).toBe('dropped');
    expect(r.feed({ op: 1, flags: 0, rid: 2, payload: new Uint8Array(2) })).toBe('complete');
  });
});

describe('vectors.json: acks, window, crc32', () => {
  for (const v of vectors.acks) {
    it(`acks for size ${v.size} steps ${v.steps.join(',')}`, () => {
      let off = 0;
      const got = v.steps.map((s) => {
        const before = off;
        off += s;
        return ackDue(before, off, v.size) ? off : null;
      });
      expect(got).toEqual(v.acks);
    });
  }
  for (const v of vectors.window) {
    it(`window ${v.window} sent ${v.sent} acked ${v.acked}`, () => {
      expect(windowAvail(v.window, v.sent, v.acked)).toBe(v.avail);
    });
  }
  const te = new TextEncoder();
  for (const v of vectors.crc32) {
    it(`crc32 of "${v.text}"`, () => {
      expect(crc32(te.encode(v.text))).toBe(v.crc);
    });
  }
  it('crc32 is incremental', () => {
    const a = te.encode('Ship');
    const b = te.encode('wright');
    expect(crc32Update(crc32(a), b)).toBe(286368330);
  });
  it('ack payload round-trips u32le, including the top bit', () => {
    for (const n of [0, 32768, 70000, 0xfffffffe]) expect(ackOffset(ackPayload(n))).toBe(n);
    expect(ackOffset(new Uint8Array(3))).toBeNull();
  });
});
