import { bluetoothAvailable } from '../proto/webbluetooth';

/** True when this browser exposes Web Bluetooth. Delegates: proto/webbluetooth.ts is the only code that touches it. */
export function hasWebBluetooth(): boolean {
  return bluetoothAvailable();
}
