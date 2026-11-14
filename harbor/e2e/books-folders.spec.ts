// Books folders: browse sub-folders of /books and upload into any of them (page against the in-memory FakeDevice).
import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function open(page: Page) {
  await page.addInitScript(() => Object.defineProperty(navigator, 'bluetooth', { value: {}, configurable: true }));
  await page.goto('/?fake=1');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('connected')).toBeVisible();
}
const files = (page: Page) => page.evaluate(() => [...(window as any).__fake.files.keys()] as string[]);
const putFile = (page: Page, p: string, text: string) =>
  page.evaluate(([path, t]) => (window as any).__fake.files.set(path, new TextEncoder().encode(t)), [p, text]);

test('open a folder, upload into it and into a new sub-folder, go up', async ({ page }) => {
  await open(page);
  await putFile(page, '/books/Fiction/old.txt', 'hello');
  await page.getByTestId('books-refresh').click();
  // the folder shows at the top level and in the folder picker
  const rows = page.getByTestId('book-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Folder');
  await expect(page.getByTestId('books-folder').locator('option')).toHaveCount(2);
  await page.getByTestId('book-folder-open').click();
  await expect(page.getByTestId('books-folder')).toHaveValue('/books/Fiction');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('old.txt');
  // upload into this folder
  await page.getByTestId('book-file').setInputFiles({ name: 'new.txt', mimeType: 'text/plain', buffer: Buffer.from('abc') });
  await expect(rows).toHaveCount(2);
  expect(await files(page)).toContain('/books/Fiction/new.txt');
  // upload into a new sub-folder of this folder
  await page.getByTestId('book-newfolder').fill('Poetry');
  await page.getByTestId('book-file').setInputFiles({ name: 'ode.txt', mimeType: 'text/plain', buffer: Buffer.from('xyz') });
  await expect.poll(() => files(page)).toContain('/books/Fiction/Poetry/ode.txt');
  await expect(page.getByTestId('books-folder').locator('option')).toHaveCount(3);
  // up goes back to /books, and the picker jumps straight to a folder
  await page.getByTestId('books-up').click();
  await expect(page.getByTestId('books-folder')).toHaveValue('/books');
  await expect(page.getByTestId('books-up')).toBeDisabled();
  await page.getByTestId('books-folder').selectOption('/books/Fiction/Poetry');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('ode.txt');
});

test('Harbor shows the Google client ID guide link until an ID is typed', async ({ page }) => {
  await open(page);
  const link = page.getByTestId('google-guide-link').first();
  await expect(link).toBeAttached();
  await expect(link.locator('a')).toHaveAttribute('href', /docs\/guides\/GOOGLE-CLIENT-ID\.md/);
  const before = await page.getByTestId('google-guide-link').count();
  await page.getByTestId('google-client-id').fill('1234-abc.apps.googleusercontent.com');
  await expect(page.getByTestId('google-guide-link')).toHaveCount(before - 1);
});
