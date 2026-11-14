// Web Bluetooth transport. This is the ONLY file that touches navigator.bluetooth (plan 6D acceptance).
// Web Bluetooth does not expose the ATT MTU: the transport reports 23 and the Client adopts the MTU the device
// reports in HELLO (it is the one that negotiated it and never exceeds mtu-3 per notification).
import type { Transport } from './transport';

export const SERVICE_UUID = '53484950-0001-4c1d-9e2a-575249474854';
export const RX_UUID = '53484950-0002-4c1d-9e2a-575249474854'; // Harbor writes here
export const TX_UUID = '53484950-0003-4c1d-9e2a-575249474854'; // device notifies here

// Just the corner of the Web Bluetooth API we use (lib.dom has no typings for it).
interface BtCharacteristic extends EventTarget {
  value?: DataView | null;
  startNotifications(): Promise<BtCharacteristic>;
  stopNotifications(): Promise<BtCharacteristic>;
  writeValueWithoutResponse?(v: BufferSource): Promise<void>;
  writeValue?(v: BufferSource): Promise<void>;
}
interface BtService {
  getCharacteristic(uuid: string): Promise<BtCharacteristic>;
}
interface BtServer {
  connected: boolean;
  connect(): Promise<BtServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BtService>;
}
interface BtDevice extends EventTarget {
  id: string;
  name?: string;
  gatt?: BtServer;
}
interface BtApi {
  requestDevice(o: unknown): Promise<BtDevice>;
}

function api(): BtApi | undefined {
  return (globalThis as { navigator?: { bluetooth?: BtApi } }).navigator?.bluetooth;
}

export function bluetoothAvailable(): boolean {
  return !!api();
}

export class WebBluetoothTransport implements Transport {
  readonly mtu = 23;
  private frameCbs = new Set<(f: Uint8Array) => void>();
  private closeCbs = new Set<(r?: string) => void>();
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly device: BtDevice,
    private readonly server: BtServer,
    private readonly rx: BtCharacteristic,
    private readonly tx: BtCharacteristic,
  ) {
    this.onNotify = this.onNotify.bind(this);
    this.onGone = this.onGone.bind(this);
    tx.addEventListener('characteristicvaluechanged', this.onNotify);
    device.addEventListener('gattserverdisconnected', this.onGone);
  }

  get name(): string {
    return this.device.name ?? '';
  }

  /** Shows the browser's device chooser (needs a user gesture) and connects. The OS shows the pairing prompt. */
  static async request(): Promise<WebBluetoothTransport> {
    const bt = api();
    if (!bt) throw new Error('Web Bluetooth is not available in this browser');
    const device = await bt.requestDevice({
      filters: [{ services: [SERVICE_UUID] }, { namePrefix: 'Shipwright-' }],
      optionalServices: [SERVICE_UUID],
    });
    return WebBluetoothTransport.open(device);
  }

  static async open(device: BtDevice): Promise<WebBluetoothTransport> {
    if (!device.gatt) throw new Error('device has no GATT server');
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(SERVICE_UUID);
    const rx = await svc.getCharacteristic(RX_UUID);
    const tx = await svc.getCharacteristic(TX_UUID);
    const t = new WebBluetoothTransport(device, server, rx, tx);
    await tx.startNotifications();
    return t;
  }

  private onNotify(ev: Event): void {
    const v = (ev.target as BtCharacteristic).value;
    if (!v) return;
    const frame = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    for (const cb of [...this.frameCbs]) cb(frame);
  }

  private onGone(): void {
    this.shutdown('disconnected');
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.tx.removeEventListener('characteristicvaluechanged', this.onNotify);
    this.device.removeEventListener('gattserverdisconnected', this.onGone);
    for (const cb of [...this.closeCbs]) cb(reason);
  }

  send(frame: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error('disconnected'));
    // GATT allows one operation at a time: chain the writes.
    const run = async (): Promise<void> => {
      if (this.closed) throw new Error('disconnected');
      if (this.rx.writeValueWithoutResponse) await this.rx.writeValueWithoutResponse(frame);
      else await this.rx.writeValue!(frame);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
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
    if (this.server.connected) this.server.disconnect();
    this.shutdown('closed');
  }
}
