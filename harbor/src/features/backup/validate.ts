// Settings backup validation: the same rules as firmware/src/sys/backup.cpp (the device stays the authority).
// Both are tested against docs/protocol/backup-vectors.json. Wi-Fi networks and account tokens are never in a backup;
// a file that names them is refused (unknown_key), not trimmed.
// Known gap: JSON.parse reads 1.0 as the integer 1 where the device says bad_value, and a \uXXXX escape that decodes to
// printable ASCII is accepted here but not by the device. Harbor never writes either.

export const MAX_BYTES = 8192;
export const KIND = 'shipwright-settings';
export const BACKUP_DIR = '/data/backup';
export const RESTORE_PATH = `${BACKUP_DIR}/restore.json`;
export const PATCH_PATH = `${BACKUP_DIR}/patch.json`;
export const BACKUP_NAME = /^settings-\d{8}-\d{4}\.json$/;

export type BackupError = 'too_large' | 'not_json' | 'bad_schema' | 'unknown_key' | 'bad_value';
export type Validation = { ok: true; keys: string[] } | { ok: false; error: BackupError };

type Rule =
  | { t: 'bool' }
  | { t: 'int'; lo: number; hi: number }
  | { t: 'enum'; values: string[] }
  | { t: 'str'; max: number; url?: boolean }
  | { t: 'tz' };

const RULES: Record<string, Rule> = {
  'disp.fast': { t: 'bool' },
  'disp.clean_every': { t: 'int', lo: 1, hi: 30 },
  'sleep.idle_s': { t: 'int', lo: 30, hi: 7200 },
  'sleep.usb_awake': { t: 'bool' },
  'wifi.stay_on': { t: 'bool' },
  'text.size': { t: 'int', lo: 0, hi: 3 },
  'text.justify': { t: 'bool' },
  'cal.week_start': { t: 'int', lo: 0, hi: 6 },
  'clock.24h': { t: 'bool' },
  'weather.units': { t: 'enum', values: ['metric', 'us'] },
  'weather.aqi': { t: 'enum', values: ['us', 'in', 'eu'] },
  'weather.city': { t: 'str', max: 60 },
  'display.invert': { t: 'bool' },
  'keys.layout': { t: 'enum', values: ['default', 'swap_sides', 'left_handed'] },
  'reader.font': { t: 'enum', values: ['mono', 'serif'] },
  'reader.spacing': { t: 'enum', values: ['normal', 'roomy'] },
  'reader.tilt': { t: 'bool' },
  dock_url: { t: 'str', max: 200, url: true },
  'home.pins': { t: 'str', max: 200 },
  'browser.search': { t: 'str', max: 200 },
  'lock.mode': { t: 'enum', values: ['ship', 'todo', 'reminders', 'github', 'weather', 'news', 'book'] },
  'lock.every': { t: 'int', lo: -1, hi: 60 },
  'lock.quiet': { t: 'bool' },
  tz: { t: 'tz' },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) < 1e10;
const printable = (s: string) => /^[\x20-\x7e]*$/.test(s);

export function dockUrlOk(s: string): boolean {
  return s === '' || (/^https?:\/\/[\x21-\x7e]+$/.test(s) && s.length <= 200 && !/^https?:\/\/$/.test(s));
}

function valueOk(r: Rule, v: unknown): boolean {
  switch (r.t) {
    case 'bool':
      return typeof v === 'boolean' || v === 0 || v === 1;
    case 'int':
      return isInt(v) && v >= r.lo && v <= r.hi;
    case 'enum':
      return typeof v === 'string' && r.values.includes(v);
    case 'str':
      return typeof v === 'string' && printable(v) && v.length <= r.max && (!r.url || dockUrlOk(v));
    case 'tz': {
      if (!isObj(v)) return false;
      const ks = Object.keys(v);
      if (ks.length !== 3 || !['offset_min', 'next_change_unix', 'next_offset_min'].every((k) => k in v)) return false;
      const off = v.offset_min,
        nc = v.next_change_unix,
        no = v.next_offset_min;
      return (
        isInt(off) && off >= -720 && off <= 840 && isInt(no) && no >= -720 && no <= 840 && isInt(nc) && nc >= 0 && nc <= 4102444800
      );
    }
  }
}

const NVS_KEY = /^e[0-3]_[0-3]$/;

export function validateBackup(input: Uint8Array | string): Validation {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (bytes.length > MAX_BYTES) return { ok: false, error: 'too_large' };
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
  } catch {
    return { ok: false, error: 'not_json' };
  }
  const fail = (error: BackupError): Validation => ({ ok: false, error });
  if (!isObj(doc)) return fail('bad_schema');
  const keys: string[] = [];
  let schema = false,
    kind = false;
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'schema') {
      if (v !== 1) return fail('bad_schema');
      schema = true;
    } else if (k === 'kind') {
      if (v !== KIND) return fail('bad_schema');
      kind = true;
    } else if (k === 'created') {
      if (typeof v !== 'string' || v.length > 32 || !printable(v)) return fail('bad_schema');
    } else if (k === 'settings') {
      if (!isObj(v)) return fail('bad_schema');
      for (const [sk, sv] of Object.entries(v)) {
        const rule = Object.prototype.hasOwnProperty.call(RULES, sk) ? RULES[sk] : undefined;
        if (!rule) return fail('unknown_key');
        if (!valueOk(rule, sv)) return fail('bad_value');
        keys.push(sk);
      }
    } else if (k === 'nvs') {
      if (!isObj(v)) return fail('bad_schema');
      for (const [ns, nv] of Object.entries(v)) {
        if (ns !== 'sw_disp') return fail('unknown_key');
        if (!isObj(nv)) return fail('bad_schema');
        for (const [nk, x] of Object.entries(nv)) {
          if (!NVS_KEY.test(nk)) return fail('unknown_key');
          if (typeof x !== 'string' || !/^[0-9]{1,10}$/.test(x)) return fail('bad_value');
          keys.push(`nvs:${ns}.${nk}`);
        }
      }
    } else {
      return fail('unknown_key');
    }
  }
  if (!schema || !kind) return fail('bad_schema');
  return { ok: true, keys };
}

/** A settings-patch file that sets only the Dock catalogue URL ("" restores the built-in catalogue). */
export function dockUrlPatch(url: string): string {
  return JSON.stringify({ schema: 1, kind: KIND, settings: { dock_url: url } });
}

/** Newest backup file name from a directory listing (names sort by time), or undefined. */
export function newestBackup(entries: Array<{ name: string; dir: boolean }>): string | undefined {
  return entries
    .filter((e) => !e.dir && BACKUP_NAME.test(e.name))
    .map((e) => e.name)
    .sort()
    .pop();
}

const REASONS: Record<BackupError, string> = {
  too_large: 'The file is larger than 8 KB.',
  not_json: 'The file is not valid JSON.',
  bad_schema: 'This is not a Shipwright settings backup.',
  unknown_key: 'It names a setting the device does not know (Wi-Fi networks and accounts are never part of a backup).',
  bad_value: 'A value in it is out of range.',
};
export const describeBackupError = (e: BackupError): string => REASONS[e];
