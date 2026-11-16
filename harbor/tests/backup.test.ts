import { describe, expect, it } from 'vitest';
import vectorsFile from '../../docs/protocol/backup-vectors.json';
import { Client, ProtoError } from '../src/proto/client';
import { FakeDevice } from '../src/proto/fake';
import { fetchNewestBackup, uploadDockUrl, uploadRestore, BackupProblem } from '../src/features/backup/ops';
import { MAX_BYTES, dockUrlPatch, newestBackup, validateBackup } from '../src/features/backup/validate';

interface Vec {
  name: string;
  hex: string;
  ok: boolean;
  error?: string;
  keys?: string;
}
const vectors = vectorsFile as { max_bytes: number; cases: Vec[] };
const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const enc = new TextEncoder();

describe('backup validation vectors (shared with firmware sys/backup)', () => {
  it('uses the same size cap', () => expect(vectors.max_bytes).toBe(MAX_BYTES));
  for (const c of vectors.cases) {
    it(c.name, () => {
      const r = validateBackup(unhex(c.hex));
      if (c.ok) {
        expect(r).toEqual({ ok: true, keys: c.keys ? c.keys.split(',') : [] });
      } else {
        expect(r).toEqual({ ok: false, error: c.error });
      }
    });
  }
});

describe('helpers', () => {
  it('dock url patch validates and holds only dock_url', () => {
    const p = dockUrlPatch('https://example.org/dock/');
    expect(JSON.parse(p).settings).toEqual({ dock_url: 'https://example.org/dock/' });
    expect(validateBackup(p)).toEqual({ ok: true, keys: ['dock_url'] });
  });
  it('accepts the Phase 9.7 weather.cur setting (the city on screen, 0..4) and refuses the rest', () => {
    const doc = (v: unknown) => JSON.stringify({ schema: 1, kind: 'shipwright-settings', settings: { 'weather.cur': v } });
    for (const v of [0, 2, 4]) expect(validateBackup(doc(v))).toEqual({ ok: true, keys: ['weather.cur'] });
    for (const v of [5, -1, 1.5, '2', null, true]) expect(validateBackup(doc(v))).toEqual({ ok: false, error: 'bad_value' });
  });
  it('newest backup picks the latest settings-* file and ignores the rest', () => {
    const e = (name: string, dir = false) => ({ name, dir });
    expect(newestBackup([])).toBeUndefined();
    expect(
      newestBackup([
        e('settings-20260101-0000.json'),
        e('settings-20261113-1200.json'),
        e('settings-20261113-1159.json'),
        e('restore-applied-20270101-0000.json'),
        e('settings-20271231-2359.json.tmp'),
        e('settings-20280101-0000.json', true),
      ]),
    ).toBe('settings-20261113-1200.json');
  });
});

function connect(dev: FakeDevice) {
  const c = new Client(dev.connect(), { timeoutMs: 2000 });
  return c;
}
const good = (extra: object = {}) => enc.encode(JSON.stringify({ schema: 1, kind: 'shipwright-settings', settings: { 'sleep.idle_s': 600 }, ...extra }));

describe('backup operations against the fake device', () => {
  it('downloads the newest backup, byte for byte', async () => {
    const dev = new FakeDevice();
    dev.files.set('/data/backup/settings-20260101-0000.json', good());
    const newest = enc.encode(JSON.stringify({ schema: 1, kind: 'shipwright-settings', settings: { 'text.size': 2 } }));
    dev.files.set('/data/backup/settings-20261113-1200.json', newest);
    dev.files.set('/data/backup/notes.txt', enc.encode('x'));
    const r = await fetchNewestBackup(connect(dev));
    expect(r.name).toBe('settings-20261113-1200.json');
    expect(Array.from(r.bytes)).toEqual(Array.from(newest));
  });

  it('says so when the device has no backup (also when the folder is missing)', async () => {
    const dev = new FakeDevice();
    await expect(fetchNewestBackup(connect(dev))).rejects.toThrow(BackupProblem);
    await expect(fetchNewestBackup(connect(dev))).rejects.toThrow(/No backup on the device/);
  });

  it('refuses to hand over a backup file that fails validation', async () => {
    const dev = new FakeDevice();
    dev.files.set('/data/backup/settings-20261113-1200.json', enc.encode('{"schema":1}'));
    await expect(fetchNewestBackup(connect(dev))).rejects.toThrow(/not usable/);
  });

  it('a disconnect is reported as the protocol error, not "no backup"', async () => {
    const dev = new FakeDevice();
    const c = connect(dev);
    dev.disconnect();
    await expect(fetchNewestBackup(c)).rejects.toBeInstanceOf(ProtoError);
  });

  it('uploads a chosen backup as /data/backup/restore.json', async () => {
    const dev = new FakeDevice();
    const bytes = good({ created: '20261113-1200' });
    await uploadRestore(connect(dev), bytes);
    expect(Array.from(dev.files.get('/data/backup/restore.json')!)).toEqual(Array.from(bytes));
  });

  it('does not upload an invalid or secret-bearing file', async () => {
    const dev = new FakeDevice();
    const secret = enc.encode(JSON.stringify({ schema: 1, kind: 'shipwright-settings', settings: { 'wifi.0': 'x' } }));
    await expect(uploadRestore(connect(dev), secret)).rejects.toThrow(/does not know/);
    await expect(uploadRestore(connect(dev), enc.encode('nope'))).rejects.toThrow(/not valid JSON/);
    expect(dev.files.size).toBe(0);
  });

  it('writes the Dock URL as a patch file with only dock_url', async () => {
    const dev = new FakeDevice();
    await uploadDockUrl(connect(dev), '  https://example.org/dock/  ');
    const body = new TextDecoder().decode(dev.files.get('/data/backup/patch.json')!);
    expect(JSON.parse(body)).toEqual({ schema: 1, kind: 'shipwright-settings', settings: { dock_url: 'https://example.org/dock/' } });
    await uploadDockUrl(connect(dev), '');
    expect(JSON.parse(new TextDecoder().decode(dev.files.get('/data/backup/patch.json')!)).settings).toEqual({ dock_url: '' });
  });

  it('rejects a bad Dock URL before sending anything', async () => {
    const dev = new FakeDevice();
    for (const u of ['ftp://x/', 'https://a b/', 'example.org', 'https://']) await expect(uploadDockUrl(connect(dev), u)).rejects.toThrow(BackupProblem);
    expect(dev.files.size).toBe(0);
  });
});
