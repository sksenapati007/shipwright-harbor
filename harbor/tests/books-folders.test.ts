import { describe, expect, it } from 'vitest';
import { FakeDevice } from '../src/proto/fake';
import { Client } from '../src/proto/client';
import { bookPathIn, BOOKS_ROOT, folderTree, inBooks, parentDir, safeFolderName } from '../src/features/books/logic';
import { DOCK_CATALOG_URL, GOOGLE_GUIDE_URL, PAGES_URL } from '../src/lib/config';
import { DEFAULT_DOCK_URL } from '../src/features/ships/dock';

describe('published locations', () => {
  it('point at GitHub Pages of sksenapati007, no placeholders', () => {
    expect(PAGES_URL).toBe('https://sksenapati007.github.io/shipwright-harbor/');
    expect(DOCK_CATALOG_URL).toBe('https://sksenapati007.github.io/shipwright-harbor/dock/catalog.json');
    expect(DEFAULT_DOCK_URL).toBe(DOCK_CATALOG_URL);
    expect(GOOGLE_GUIDE_URL).toContain('docs/guides/GOOGLE-CLIENT-ID.md');
    expect(`${PAGES_URL}${DOCK_CATALOG_URL}${GOOGLE_GUIDE_URL}`).not.toContain('invalid');
  });
});

describe('books folders logic', () => {
  it('knows what is inside /books', () => {
    expect(inBooks('/books')).toBe(true);
    expect(inBooks('/books/Fiction/SciFi')).toBe(true);
    expect(inBooks('/books/../data')).toBe(false);
    expect(inBooks('/booksX')).toBe(false);
    expect(inBooks('/data/books')).toBe(false);
    expect(inBooks('/books//x')).toBe(false);
  });
  it('goes up but never above /books', () => {
    expect(parentDir('/books/a/b')).toBe('/books/a');
    expect(parentDir('/books/a')).toBe(BOOKS_ROOT);
    expect(parentDir('/books')).toBe(BOOKS_ROOT);
    expect(parentDir('/data/x')).toBe(BOOKS_ROOT);
  });
  it('builds upload paths in any folder, optionally a new sub-folder', () => {
    expect(bookPathIn('/books', 'a.epub')).toBe('/books/a.epub');
    expect(bookPathIn('/books/Fiction', 'a:b.epub')).toBe('/books/Fiction/a_b.epub');
    expect(bookPathIn('/books/Fiction', 'a.txt', 'Poetry')).toBe('/books/Fiction/Poetry/a.txt');
    expect(bookPathIn('/books', 'a.txt', '../x')).toBe('/books/_x/a.txt'); // slashes become underscores, leading dots stripped
    expect(bookPathIn('/books', 'a.txt', '...')).toBeNull();
    expect(bookPathIn('/data', 'a.txt')).toBeNull();
    expect(bookPathIn('/books/..', 'a.txt')).toBeNull();
    expect(bookPathIn('/books/' + 'd'.repeat(120), 'a.txt')).toBeNull(); // over the 120 byte device limit
  });
  it('cleans folder names', () => {
    expect(safeFolderName('  a/b*c ')).toBe('a_b_c');
    expect(safeFolderName('.hidden')).toBe('hidden');
    expect(new TextEncoder().encode(safeFolderName('x'.repeat(200))).length).toBe(60);
  });
  it('lists the folder tree from a device, sorted, depth limited', async () => {
    const dev = new FakeDevice();
    for (const p of ['/books/b/x.epub', '/books/a/deep/er/est/z.txt', '/books/a/deep/y.txt', '/books/top.txt'])
      dev.files.set(p, new Uint8Array([1]));
    const c = new Client(dev.connect());
    await c.connectHello();
    const tree = await folderTree((d) => c.list(d), 3);
    expect(tree.map((n) => `${n.depth}:${n.path}`)).toEqual(['1:/books/a', '2:/books/a/deep', '3:/books/a/deep/er', '1:/books/b']);
    expect((await folderTree((d) => c.list(d), 3, 2)).length).toBe(2);
  });
});
