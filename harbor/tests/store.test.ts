import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, openStore } from '../src/lib/store';

let n = 0;
let db: string;
beforeEach(() => {
  db = `harbor-test-${n++}`;
});

describe('store', () => {
  it('round-trips values, binary data and keys', async () => {
    const s = openStore(db);
    expect(await s.get('missing')).toBeUndefined();
    await s.set('a', { x: 1, y: ['z'] });
    await s.set('bin', new Uint8Array([1, 2, 255]));
    expect(await s.get('a')).toEqual({ x: 1, y: ['z'] });
    expect(Array.from((await s.get<Uint8Array>('bin'))!)).toEqual([1, 2, 255]);
    expect((await s.keys()).sort()).toEqual(['a', 'bin']);
    await s.del('a');
    expect(await s.get('a')).toBeUndefined();
  });

  it('persists across a reopen of the same database', async () => {
    await openStore(db).set('k', 'v');
    expect(await openStore(db).get('k')).toBe('v');
    expect(await openStore(db + '-other').get('k')).toBeUndefined();
  });

  it('settings default, patch and survive reopen', async () => {
    const s = openStore(db);
    expect(await s.getSettings()).toEqual(DEFAULT_SETTINGS);
    await s.patchSettings({ theme: 'dark' });
    const dev = { id: 'aa:bb', name: 'Shipwright-1234', lastSeen: 1700000000 };
    await s.patchSettings({ lastDevice: dev });
    expect(await openStore(db).getSettings()).toEqual({ theme: 'dark', lastDevice: dev });
  });
});
