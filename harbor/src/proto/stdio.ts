// Transport over a pair of byte streams: the child process of `drydock sync --sd <dir>` (contract tests, plan 6F).
// Framing matches the host ble HAL (hal/host/ble_host.cpp): 2-byte big-endian length, then the frame.
// No node imports: the streams are described structurally so this file typechecks without @types/node and the
// app bundle never pulls it in.
import type { Transport } from './transport';

export interface ByteReader {
  on(ev: 'data', cb: (chunk: Uint8Array) => void): unknown;
  on(ev: 'end' | 'close', cb: () => void): unknown;
}
export interface ByteWriter {
  write(chunk: Uint8Array, cb?: (err?: Error | null) => void): unknown;
}

export class StdioTransport implements Transport {
  private frameCbs = new Set<(f: Uint8Array) => void>();
  private closeCbs = new Set<(r?: string) => void>();
  private closed = false;
  private buf = new Uint8Array(0);

  /** `onShutdown` runs on close() so the caller can end the child process. */
  constructor(
    input: ByteReader,
    private readonly output: ByteWriter,
    readonly mtu = 512,
    private readonly onShutdown?: () => void,
  ) {
    input.on('data', (c) => this.feed(c));
    input.on('end', () => this.shutdown('end of stream'));
    input.on('close', () => this.shutdown('stream closed'));
  }

  private feed(chunk: Uint8Array): void {
    const nb = new Uint8Array(this.buf.length + chunk.length);
    nb.set(this.buf, 0);
    nb.set(chunk, this.buf.length);
    this.buf = nb;
    for (;;) {
      if (this.buf.length < 2) return;
      const n = (this.buf[0]! << 8) | this.buf[1]!;
      if (this.buf.length < 2 + n) return;
      const frame = this.buf.slice(2, 2 + n);
      this.buf = this.buf.subarray(2 + n);
      for (const cb of [...this.frameCbs]) cb(frame);
    }
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of [...this.closeCbs]) cb(reason);
  }

  send(frame: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error('disconnected'));
    if (frame.length > 0xffff) return Promise.reject(new Error('frame too large'));
    const out = new Uint8Array(2 + frame.length);
    out[0] = frame.length >> 8;
    out[1] = frame.length & 0xff;
    out.set(frame, 2);
    return new Promise<void>((resolve, reject) => {
      try {
        this.output.write(out, (err) => (err ? reject(err) : resolve()));
      } catch (e) {
        reject(e);
      }
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
    this.shutdown('closed');
    this.onShutdown?.();
  }
}
