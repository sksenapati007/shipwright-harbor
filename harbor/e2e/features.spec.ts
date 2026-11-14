// Feature tests: the real Harbor page and client against the in-memory FakeDevice (page opened with ?fake).
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { stateFile } from '../src/features/books/logic';

test.use({ serviceWorkers: 'block' });

const CAT_URL = 'https://dock.test/dock/catalog.json';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const HELLO = Buffer.from('function ship.render() ui.text(10,10,"hello") end\n');
const BAD = Buffer.from('print("tampered")\n');

function catalog() {
  return {
    dock: 1,
    updated: '2026-11-13T00:00:00Z',
    base: 'https://dock.test/dock/',
    items: [
      { id: 'hello', kind: 'ship', title: 'Hello Ship', summary: 'Says hello.', author: 'Me', version: '1.0.0', api: 1, tags: ['demo'], accounts: [], path: 'ships/hello.lua', size: HELLO.length, sha256: sha(HELLO) },
      { id: 'evil', kind: 'ship', title: 'Tampered Ship', summary: 'Wrong hash.', author: 'X', version: '1', api: 1, tags: [], accounts: [], path: 'ships/evil.lua', size: BAD.length, sha256: sha(HELLO) },
      { id: 'future', kind: 'ship', title: 'Future Ship', summary: 'Needs api 2.', author: 'X', version: '1', api: 2, tags: [], accounts: [], path: 'ships/future.lua', size: 5, sha256: sha(HELLO) },
      { id: 'pg1', kind: 'book', title: 'A Book', summary: 'not a ship', author: 'X', version: '1', url: 'https://x/y.epub', size: 5, sha256: sha(HELLO) },
    ],
  };
}

async function route(page: Page, opts: { offline?: () => boolean } = {}) {
  const cors = { 'access-control-allow-origin': '*' };
  await page.route('https://dock.test/**', async (r) => {
    if (opts.offline?.()) return r.abort('internetdisconnected');
    const u = r.request().url();
    if (u === CAT_URL) return r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(catalog()) });
    if (u.endsWith('/ships/hello.lua')) return r.fulfill({ status: 200, headers: cors, body: HELLO });
    if (u.endsWith('/ships/evil.lua')) return r.fulfill({ status: 200, headers: cors, body: BAD });
    return r.fulfill({ status: 404, headers: cors, body: '' });
  });
}

async function open(page: Page) {
  await page.addInitScript(() => Object.defineProperty(navigator, 'bluetooth', { value: {}, configurable: true }));
  await page.goto('/?fake=1');
}

async function connect(page: Page) {
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('connected')).toBeVisible();
}

const files = (page: Page) => page.evaluate(() => [...(window as any).__fake.files.keys()] as string[]);
const fileBytes = (page: Page, p: string) =>
  page.evaluate((path) => {
    const b = (window as any).__fake.files.get(path) as Uint8Array | undefined;
    return b ? Array.from(b) : null;
  }, p);
const putFile = (page: Page, p: string, text: string) =>
  page.evaluate(([path, t]) => (window as any).__fake.files.set(path, new TextEncoder().encode(t)), [p, text]);

test('connect shows the device and sets the clock automatically', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('books-panel')).toContainText('Connect to your device');
  const before = Math.floor(Date.now() / 1000);
  await connect(page);
  await expect(page.getByTestId('device-name')).toHaveText('Shipwright-A1B2');
  await expect(page.getByTestId('device-info')).toContainText('Battery');
  await expect(page.getByTestId('clock-state')).toHaveText('Set from this device');
  const clock = await page.evaluate(() => (window as any).__fake.clock);
  expect(clock.unix).toBeGreaterThanOrEqual(before);
  expect(clock.unix).toBeLessThan(before + 60);
  expect(typeof clock.off).toBe('number');
  await page.getByTestId('disconnect').click();
  await expect(page.getByTestId('connect')).toBeVisible();
});

test('a dropped link shows a message and reconnects', async ({ page }) => {
  await open(page);
  await connect(page);
  await page.evaluate(() => (window as any).__fake.disconnect());
  await expect(page.getByTestId('device-error')).toContainText('disconnected');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('connected')).toBeVisible();
});

test('add an EPUB with progress, see it listed, delete it', async ({ page }) => {
  await open(page);
  await connect(page);
  await expect(page.getByTestId('books-empty')).toBeVisible();
  // Slow the fake link a little so the progress bar can be observed.
  await page.evaluate(() => {
    const link = (window as any).__fake.link;
    const send = link.send.bind(link);
    link.send = (f: Uint8Array) => new Promise((res) => setTimeout(() => res(send(f)), 2));
  });
  const data = Buffer.alloc(300 * 1024, 7);
  await page.getByTestId('book-file').setInputFiles({ name: 'Moby Dick.epub', mimeType: 'application/epub+zip', buffer: data });
  await expect(page.getByTestId('book-progress')).toContainText('Sending Moby Dick.epub');
  await expect(page.getByTestId('book-progress')).toContainText('%');
  await expect(page.getByTestId('book-row')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('book-row')).toContainText('Moby Dick.epub');
  await expect(page.getByTestId('book-row')).toContainText('Not started');
  expect(await fileBytes(page, '/books/Moby Dick.epub')).toHaveLength(data.length);
  // delete needs a second press
  await page.getByTestId('book-delete').click();
  await expect(page.getByTestId('book-row')).toHaveCount(1);
  await page.getByTestId('book-delete-confirm').click();
  await expect(page.getByTestId('books-empty')).toBeVisible();
  expect(await files(page)).not.toContain('/books/Moby Dick.epub');
});

test('reading progress comes from the book state.json', async ({ page }) => {
  await open(page);
  await connect(page);
  const text = 'x'.repeat(2000);
  await putFile(page, '/books/story.epub', text);
  await putFile(
    page,
    stateFile('/books/story.epub', 2000),
    JSON.stringify({ v: 1, path: '/books/story.epub', title: 'The Story', spine: 3, char: 10, pct: 41, updated: 1, marks: [{ spine: 1, char: 2, pct: 5, label: 'a', at: 1 }] }),
  );
  await putFile(page, '/books/other.txt', 'hello');
  await page.getByTestId('books-refresh').click();
  const rows = page.getByTestId('book-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'The Story' })).toContainText('41% read');
  await expect(rows.filter({ hasText: 'The Story' })).toContainText('1 bookmark');
  await expect(rows.filter({ hasText: 'other.txt' })).toContainText('Not started');
});

test('browse the Dock catalogue and install a ship; a bad checksum installs nothing', async ({ page }) => {
  await route(page);
  await open(page);
  await expect(page.getByTestId('dock-note')).toHaveCount(0); // nothing is fetched until asked
  await page.getByTestId('dockcat-url').fill(CAT_URL);
  await page.getByTestId('dockcat-load').click();
  const items = page.getByTestId('dock-item');
  await expect(items).toHaveCount(3); // the book entry is not offered
  await expect(items.first()).toContainText('Hello Ship');
  await expect(page.getByTestId('dock-install').first()).toBeDisabled(); // not connected yet
  await connect(page);
  await expect(page.getByTestId('dock-item').filter({ hasText: 'Future Ship' }).getByTestId('dock-install')).toBeDisabled();

  await page.getByTestId('dock-item').filter({ hasText: 'Tampered Ship' }).getByTestId('dock-install').click();
  await expect(page.getByTestId('ships-error')).toContainText('checksum');
  expect(await files(page)).not.toContain('/ships/evil.lua');

  await page.getByTestId('dock-item').filter({ hasText: 'Hello Ship' }).getByTestId('dock-install').click();
  await expect(page.getByTestId('ships-ok')).toContainText('Installed Hello Ship');
  await expect(page.getByTestId('ship-row')).toContainText('hello.lua');
  expect(await fileBytes(page, '/ships/hello.lua')).toEqual(Array.from(HELLO));
});

test('catalogue is cached and shown stale while it revalidates, and offline', async ({ page }) => {
  let offline = false;
  await route(page, { offline: () => offline });
  await open(page);
  await page.getByTestId('dockcat-url').fill(CAT_URL);
  await page.getByTestId('dockcat-load').click();
  await expect(page.getByTestId('dock-item')).toHaveCount(3);
  await expect(page.getByTestId('dock-state')).toContainText('Up to date');

  // Offline reload: the saved copy shows, with a note.
  offline = true;
  await page.reload();
  await expect(page.getByTestId('dock-item')).toHaveCount(3);
  await expect(page.getByTestId('dock-state')).toContainText('Saved copy');
  await expect(page.getByTestId('dock-note')).toContainText('saved catalogue');

  // Slow network: the saved copy shows at once, before the fresh answer arrives.
  offline = false;
  await page.unroute('https://dock.test/**');
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route('https://dock.test/**', async (r) => {
    await gate;
    await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify(catalog()) });
  });
  await page.reload();
  await expect(page.getByTestId('dock-state')).toContainText('Saved copy');
  release();
  await expect(page.getByTestId('dock-state')).toContainText('Up to date');
});

test('upload a local .lua; over the size cap gives a message and sends nothing', async ({ page }) => {
  await open(page);
  await connect(page);
  await page.getByTestId('ship-file').setInputFiles({ name: 'big.lua', mimeType: 'text/plain', buffer: Buffer.alloc(140 * 1024, 0x2d) });
  await expect(page.getByTestId('ships-error')).toContainText('at most 128 KB');
  expect(await files(page)).not.toContain('/ships/big.lua');

  await page.getByTestId('ship-file').setInputFiles({ name: 'mine.lua', mimeType: 'text/plain', buffer: HELLO });
  await expect(page.getByTestId('ships-ok')).toContainText('Sent mine.lua');
  await expect(page.getByTestId('ship-row')).toContainText('mine.lua');
  expect(await fileBytes(page, '/ships/mine.lua')).toEqual(Array.from(HELLO));

  await page.getByTestId('ship-delete').click();
  await page.getByTestId('ship-delete-confirm').click();
  await expect(page.getByTestId('ship-row')).toHaveCount(0);
});

test('without Web Bluetooth the feature panels are not shown', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true }));
  await page.goto('/?fake=1');
  await expect(page.locator('#no-bluetooth')).toBeVisible();
  await expect(page.getByTestId('device-panel')).toHaveCount(0);
});
