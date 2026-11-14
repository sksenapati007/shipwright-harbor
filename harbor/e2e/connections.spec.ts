// Phase 8D: accounts, pages, Wi-Fi, news feeds and lock screen against the FakeDevice.
import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function open(page: Page) {
  await page.addInitScript(() => Object.defineProperty(navigator, 'bluetooth', { value: {}, configurable: true }));
  await page.goto('/?fake=1');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('connected')).toBeVisible();
}
const secrets = (page: Page) => page.evaluate(() => Object.fromEntries((window as any).__fake.secrets) as Record<string, any>);
const text = (page: Page, p: string) =>
  page.evaluate((path) => {
    const b = (window as any).__fake.files.get(path) as Uint8Array | undefined;
    return b ? new TextDecoder().decode(b) : null;
  }, p);

test('add a GitHub token: stored on the device, listed without the token, field cleared', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('acct-host')).toHaveValue('api.github.com');
  await expect(page.getByTestId('acct-save')).toBeDisabled();
  await page.getByTestId('acct-token').fill('ghp_secret123');
  await page.getByTestId('acct-save').click();
  await expect(page.getByTestId('accounts-ok')).toContainText('acct.github');
  const s = await secrets(page);
  expect(s['acct.github']).toMatchObject({ label: 'GitHub', hosts: ['api.github.com'], token: 'ghp_secret123', header: 'Authorization', prefix: 'Bearer ' });
  const list = page.getByTestId('acct-list');
  await expect(list).toContainText('GitHub');
  await expect(list).toContainText('api.github.com');
  expect(await page.getByTestId('accounts-panel').innerText()).not.toContain('ghp_secret123');
  await expect(page.getByTestId('acct-token')).toHaveValue('');
  // remove, with a confirm step
  await page.getByTestId('acct-remove').click();
  await page.getByTestId('acct-remove-confirm').click();
  await expect(page.getByTestId('acct-list').locator('li')).toHaveCount(0);
  expect(Object.keys(await secrets(page))).not.toContain('acct.github');
});

test('remember keeps the token in Harbor across a reload; without it nothing is kept', async ({ page }) => {
  await open(page);
  await page.getByTestId('acct-token').fill('ghp_keepme');
  await page.getByTestId('acct-remember').check();
  await page.getByTestId('acct-save').click();
  await expect(page.getByTestId('accounts-ok')).toBeVisible();
  await expect(page.getByTestId('acct-token')).toHaveValue('ghp_keepme');
  await page.reload();
  await expect(page.getByTestId('acct-token')).toHaveValue('ghp_keepme');
  await page.getByTestId('acct-remember').uncheck();
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('connected')).toBeVisible();
  await page.getByTestId('acct-save').click();
  await expect(page.getByTestId('accounts-ok')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('acct-token')).toHaveValue('');
});

test('custom connection validates the host and the 384-byte limit', async ({ page }) => {
  await open(page);
  await page.getByTestId('acct-preset').selectOption('custom');
  await page.getByTestId('acct-label').fill('Mine');
  await page.getByTestId('acct-host').fill('https://bad.example.com/x');
  await page.getByTestId('acct-token').fill('tok');
  await expect(page.getByTestId('acct-problem')).toContainText('plain name');
  await expect(page.getByTestId('acct-save')).toBeDisabled();
  await page.getByTestId('acct-host').fill('api.example.com');
  await expect(page.getByTestId('acct-save')).toBeEnabled();
  await page.getByTestId('acct-token').fill('x'.repeat(400));
  await expect(page.getByTestId('acct-problem')).toContainText('384');
  await expect(page.getByTestId('acct-save')).toBeDisabled();
  await page.getByTestId('acct-token').fill('x'.repeat(200));
  await page.getByTestId('acct-save').click();
  await expect(page.getByTestId('accounts-ok')).toContainText('acct.mine');
  expect((await secrets(page))['acct.mine'].hosts).toEqual(['api.example.com']);
});

test('Set up Pages: 128-bit topic sent as the pages secret, agent snippet shown', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('pages-state')).toHaveText('Pages is not set up.');
  await page.getByTestId('pages-setup').click();
  await expect(page.getByTestId('pages-state')).toHaveText('Pages is set up on this device.');
  const topic = (await secrets(page)).pages.topic as string;
  expect(topic).toMatch(/^sw-[0-9a-f]{32}$/);
  const snip = await page.getByTestId('pages-snippet').innerText();
  expect(snip).toContain(`SHIPWRIGHT_PAGE_TOPIC=${topic}`);
  expect(snip).toContain('shipwright-page ask');
  const key = (await secrets(page)).pages.key as string;
  expect(key).toHaveLength(43);
  expect(snip).toContain(`SHIPWRIGHT_PAGE_KEY=${key}`);
  // a bad server is refused before anything is sent
  await page.getByTestId('pages-base').fill('nonsense');
  await expect(page.getByTestId('pages-base-problem')).toBeVisible();
  await expect(page.getByTestId('pages-setup')).toBeDisabled();
  await page.getByTestId('pages-base').fill('https://ntfy.example.com');
  await page.getByTestId('pages-setup').click(); // first click arms
  await page.getByTestId('pages-setup').click();
  const s = (await secrets(page)).pages;
  expect(s.base).toBe('https://ntfy.example.com');
  expect(s.topic).not.toBe(topic);
  await page.getByTestId('pages-remove').click();
  await expect(page.getByTestId('pages-state')).toHaveText('Pages is not set up.');
});

test('send Wi-Fi credentials, reuse the slot for the same name, remove', async ({ page }) => {
  await open(page);
  await page.getByTestId('wifi-ssid').fill('Home');
  await page.getByTestId('wifi-psk').fill('short');
  await expect(page.getByTestId('wifi-problem')).toContainText('8 characters');
  await expect(page.getByTestId('wifi-send')).toBeDisabled();
  await page.getByTestId('wifi-psk').fill('hunter2hunter2');
  await page.getByTestId('wifi-send').click();
  await expect(page.getByTestId('wifi-ok')).toContainText('Home');
  let s = await secrets(page);
  expect(s['wifi.0']).toMatchObject({ ssid: 'Home', psk: 'hunter2hunter2' });
  expect(await page.getByTestId('wifi-panel').innerText()).not.toContain('hunter2hunter2');
  await page.getByTestId('wifi-psk').fill('anotherpassword');
  await page.getByTestId('wifi-send').click();
  await expect(page.getByTestId('wifi-ok')).toBeVisible();
  s = await secrets(page);
  expect(Object.keys(s).filter((k) => k.startsWith('wifi.'))).toEqual(['wifi.0']);
  expect(s['wifi.0'].psk).toBe('anotherpassword');
  await page.getByTestId('wifi-ssid').fill('Cafe');
  await page.getByTestId('wifi-psk').fill('');
  await page.getByTestId('wifi-send').click();
  await expect(page.getByTestId('wifi-list')).toContainText('Cafe');
  await page.getByTestId('wifi-remove').first().click();
  expect(Object.keys(await secrets(page))).not.toContain('wifi.0');
});

test('news feeds: add, validate, send feeds.json, reload from the device', async ({ page }) => {
  await open(page);
  await page.getByTestId('news-url').fill('ftp://nope');
  await page.getByTestId('news-add').click();
  await expect(page.getByTestId('news-error')).toBeVisible();
  await page.getByTestId('news-name').fill('BBC');
  await page.getByTestId('news-url').fill('feeds.bbci.co.uk/news/rss.xml');
  await page.getByTestId('news-add').click();
  await page.getByTestId('news-url').fill('https://example.com/atom.xml');
  await page.getByTestId('news-add').click();
  await page.getByTestId('news-url').fill('https://example.com/atom.xml');
  await page.getByTestId('news-add').click();
  await expect(page.getByTestId('news-error')).toContainText('already');
  await page.getByTestId('news-send').click();
  await expect(page.getByTestId('news-ok')).toContainText('Sent 2 feeds');
  const f = JSON.parse((await text(page, '/data/feeds.json'))!);
  expect(f).toEqual({ v: 1, feeds: [{ name: 'BBC', url: 'https://feeds.bbci.co.uk/news/rss.xml' }, { name: '', url: 'https://example.com/atom.xml' }] });
  // reconnect: the list comes back from the device
  await page.getByTestId('disconnect').click();
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('news-list')).toContainText('BBC');
  await expect(page.getByTestId('news-list').locator('li')).toHaveCount(2);
});

test('lock screen preferences go out as a settings patch', async ({ page }) => {
  await open(page);
  await page.getByTestId('lock-mode').selectOption('news');
  await page.getByTestId('lock-every').selectOption('30');
  await page.getByTestId('lock-quiet').check();
  await page.getByTestId('lock-send').click();
  await expect(page.getByTestId('lock-ok')).toBeVisible();
  const j = JSON.parse((await text(page, '/data/backup/patch.json'))!);
  expect(j.kind).toBe('shipwright-settings');
  expect(j.settings).toEqual({ 'lock.mode': 'news', 'lock.every': 30, 'lock.quiet': true });
});
