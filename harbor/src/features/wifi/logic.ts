// Wi-Fi credentials: SECRET_SET wifi.<0-5> {"ssid","psk","n"}. Mirrors sys::secrets (32-byte SSID, 63-byte password).
export const WIFI_SLOTS = 6;
const enc = new TextEncoder();

export function ssidProblem(s: string): string | null {
  const n = enc.encode(s).length;
  if (n === 0) return 'Type the network name.';
  if (n > 32) return 'A network name is at most 32 bytes.';
  if (/[\x00-\x1f\x7f]/.test(s)) return 'The network name has a control character.';
  return null;
}
export function pskProblem(p: string): string | null {
  if (p === '') return null; // open network
  const n = enc.encode(p).length;
  if (n < 8) return 'A WPA password is at least 8 characters (leave it empty for an open network).';
  if (n > 63) return 'A password is at most 63 bytes.';
  if (/[\x00-\x1f\x7f]/.test(p)) return 'The password has a control character.';
  return null;
}

export interface Slot {
  name: string;
  label: string;
}
/** Slot to write: the one already holding this SSID, else the lowest free; null when all six are used by other networks. */
export function pickSlot(existing: Slot[], ssid: string): string | null {
  const same = existing.find((s) => s.label === ssid);
  if (same) return same.name;
  for (let i = 0; i < WIFI_SLOTS; i++) if (!existing.some((s) => s.name === `wifi.${i}`)) return `wifi.${i}`;
  return null;
}
export function wifiSecret(ssid: string, psk: string, now: number = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  // ponytail: n = unix seconds so a Harbor-sent network is the newest; the device continues from the highest n.
  return { ssid, psk, n: now };
}
