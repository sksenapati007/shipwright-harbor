import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeDevice } from '../src/proto/fake';
import { Client } from '../src/proto/client';
import { bookPath, id8, isBookFile, notesDownloadName, notesFile, parseState, safeBookName, stateFile } from '../src/features/books/logic';
import { catalogUrl, installShip, InstallError, parseCatalog, resolveUrl, sha256Hex, type Catalog } from '../src/features/ships/dock';
import { luaProblem, shipPath } from '../src/features/ships';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto }); // Node 18 has no global
const enc = new TextEncoder();

describe('books logic', () => {
  it('id8 matches zlib.crc32 of "path|size" (vectors made with python zlib)', () => {
    expect(id8('/books/x.epub', 1234)).toBe('b6a02e1a');
    expect(id8('/books/Pride and Prejudice.epub', 512000)).toBe('9a52459c');
    expect(id8('/books/a.txt', 0)).toBe('396410a7');
    expect(stateFile('/books/a.txt', 0)).toBe(`/data/books/${id8('/books/a.txt', 0)}/state.json`);
  });
  it('parses progress and ignores junk', () => {
    const s = parseState(enc.encode('{"v":1,"title":"T","pct":41.6,"marks":[{},{}],"updated":5}'));
    expect(s).toEqual({ title: 'T', pct: 42, marks: 2, updated: 5 });
    expect(parseState(enc.encode('nope'))).toBeNull();
    expect(parseState(enc.encode('{"pct":250}'))?.pct).toBe(100);
  });
  it('makes device-safe names', () => {
    expect(safeBookName('a/b:c?.epub')).toBe('a_b_c_.epub');
    expect(safeBookName('...')).toBe('book');
    expect(bookPath('Moby Dick.epub')).toBe('/books/Moby Dick.epub');
    expect(enc.encode(safeBookName('é'.repeat(120) + '.epub')).length).toBeLessThanOrEqual(100);
    expect(isBookFile('X.EPUB')).toBe(true);
    expect(isBookFile('x.pdf')).toBe(false);
  });
});

describe('ships logic', () => {
  it('size cap and name rules', () => {
    expect(luaProblem('a.lua', 10)).toBeNull();
    expect(luaProblem('a.lua', 131073)).toMatch(/at most 128 KB/);
    expect(luaProblem('a.txt', 10)).toMatch(/\.lua/);
    expect(luaProblem('a b.lua', 10)).toMatch(/file name/);
    expect(shipPath('snake.lua')).toBe('/ships/snake.lua');
    expect(shipPath('../x.lua')).toBeNull();
  });
  it('catalogue parsing', () => {
    expect(() => parseCatalog('x')).toThrow(/JSON/);
    expect(() => parseCatalog('{"dock":2,"items":[]}')).toThrow(/Dock catalogue/);
    expect(() => parseCatalog(' '.repeat(1024 * 1024 + 1))).toThrow(/1 MB/);
    const c = parseCatalog('{"dock":1,"base":"https://h/d/","items":[{"id":"a","kind":"ship","title":"A","path":"ships/a.lua","size":3,"sha256":"' + 'a'.repeat(64) + '"},{"x":1}]}');
    expect(c.items.length).toBe(1);
    expect(catalogUrl('https://h/d/')).toBe('https://h/d/catalog.json');
    expect(catalogUrl('https://h/d')).toBe('https://h/d/catalog.json');
    expect(catalogUrl('https://h/x/c.json')).toBe('https://h/x/c.json');
    expect(resolveUrl(c, 'https://h/d/catalog.json', 'ships/a.lua', undefined)).toBe('https://h/d/ships/a.lua');
  });
});

describe('install', () => {
  async function setup(body: Uint8Array, sha?: string) {
    const lua = body;
    const art = new Uint8Array([1, 2, 3, 4]);
    const cat: Catalog = {
      updated: '',
      base: 'https://dock.test/d/',
      items: [
        {
          id: 'hello', kind: 'ship', title: 'Hello', summary: '', author: '', version: '1', api: 1, tags: [], accounts: [],
          path: 'ships/hello.lua', size: lua.length, sha256: sha ?? (await sha256Hex(lua)),
          assets: [{ path: 'art/hello.sbm', size: 4, sha256: await sha256Hex(art) }],
        },
      ],
    };
    const f = (async (u: string) => {
      const b = u.endsWith('hello.lua') ? lua : u.endsWith('hello.sbm') ? art : null;
      return b ? new Response(b as BodyInit) : new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const dev = new FakeDevice();
    const c = new Client(dev.connect());
    await c.connectHello();
    return { cat, f, dev, c, lua, art };
  }
  it('verifies, then sends art and ship', async () => {
    const { cat, f, dev, c, lua } = await setup(enc.encode('print("hi")'));
    const name = await installShip(c, cat, cat.items[0]!, { catalogUrl: 'https://dock.test/d/catalog.json', fetch: f });
    expect(name).toBe('hello.lua');
    expect(dev.files.get('/ships/hello.lua')).toEqual(lua);
    expect(dev.files.get('/ships/art/hello.sbm')).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
  it('a bad checksum sends nothing', async () => {
    const { cat, f, dev, c } = await setup(enc.encode('print("hi")'), 'f'.repeat(64));
    await expect(installShip(c, cat, cat.items[0]!, { catalogUrl: 'x', fetch: f })).rejects.toThrow(InstallError);
    expect(dev.files.size).toBe(0);
  });
  it('refuses an art asset over the 256 KB device cap and sends nothing', async () => {
    const { cat, f, dev, c } = await setup(enc.encode('print("hi")'));
    const item = { ...cat.items[0]!, assets: [{ ...cat.items[0]!.assets[0]!, size: 256 * 1024 + 1 }] };
    await expect(installShip(c, cat, item, { catalogUrl: 'x', fetch: f })).rejects.toThrow(/256 KB/);
    expect(dev.files.size).toBe(0);
  });
  it('refuses newer api and non-ships', async () => {
    const { cat, f, c } = await setup(enc.encode('x'));
    await expect(installShip(c, cat, { ...cat.items[0]!, api: 2 }, { catalogUrl: 'x', fetch: f })).rejects.toThrow(/newer/);
    await expect(installShip(c, cat, { ...cat.items[0]!, kind: 'book' }, { catalogUrl: 'x', fetch: f })).rejects.toThrow(/ships/);
  });
});

describe('books export notes', () => {
  it('finds the notes.md of a book and names the download', () => {
    expect(notesFile('/books/a.txt', 0)).toBe(`/data/books/${id8('/books/a.txt', 0)}/notes.md`);
    expect(notesDownloadName('Moby: Dick / or "the Whale"')).toBe('Moby Dick or the Whale-notes.md');
    expect(notesDownloadName('  ')).toBe('book-notes.md');
    expect(notesDownloadName('x'.repeat(100))).toBe(`${'x'.repeat(60)}-notes.md`);
  });
  it('reads the exported file from the device and reports a missing one as not_found', async () => {
    const dev = new FakeDevice();
    const c = new Client(dev.connect());
    await c.connectHello();
    const md = enc.encode('# T\n\n> quote\n\nNote: n\n');
    dev.files.set(notesFile('/books/a.txt', 10), md);
    expect(await c.get(notesFile('/books/a.txt', 10))).toEqual(md);
    await expect(c.get(notesFile('/books/b.txt', 10))).rejects.toMatchObject({ code: 'not_found' });
  });
});
