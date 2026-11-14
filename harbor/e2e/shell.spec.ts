import { expect, test, type Page } from '@playwright/test';

const NO_BT = () => {
  Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true });
};

async function swReady(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // wait until the SW controls the page or at least finished precaching
  await page.waitForFunction(async () => {
    const keys = await caches.keys();
    for (const k of keys) if ((await (await caches.open(k)).keys()).length > 3) return true;
    return false;
  });
}

test('shell loads with title and heading', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Harbor');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Harbor');
});

test('without Web Bluetooth: explanation, browsers, Wi-Fi and USB alternatives', async ({ page }) => {
  await page.addInitScript(NO_BT);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'This browser cannot talk to the device over Bluetooth' }),
  ).toBeVisible();
  const browsers = page.getByTestId('supported-browsers');
  await expect(browsers).toContainText('Chrome');
  await expect(browsers).toContainText('Edge');
  const alts = page.getByTestId('alternatives');
  await expect(alts).toContainText('Wi-Fi transfer');
  await expect(alts).toContainText('shipwright.local');
  await expect(alts).toContainText('USB Drive');
});

test('with Web Bluetooth present the explanation panel is hidden', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'bluetooth', { value: {}, configurable: true });
  });
  await page.goto('/');
  await expect(page.locator('#no-bluetooth')).toHaveCount(0);
});

test('theme toggle sets data-theme and persists across reload', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  const toggle = page.getByTestId('theme-toggle');
  await toggle.click(); // system -> light
  await expect(html).toHaveAttribute('data-theme', 'light');
  await toggle.click(); // -> dark
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');
});

test('works offline after first load', async ({ page, context }) => {
  await page.addInitScript(NO_BT);
  await page.goto('/');
  await swReady(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Harbor');
  await expect(page.locator('#no-bluetooth')).toBeVisible();
  // self-hosted font made it from the cache
  const fontOk = await page.evaluate(() => document.fonts.check('700 16px "JetBrains Mono"'));
  expect(fontOk).toBe(true);
});

test('manifest is installable: name, icons 192/512, standalone', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel=manifest]').getAttribute('href');
  const res = await request.get(new URL(href!, page.url()).toString());
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m.name).toBeTruthy();
  expect(m.display).toBe('standalone');
  const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
  for (const icon of m.icons) {
    const r = await request.get(new URL(icon.src, new URL(href!, page.url())).toString());
    expect(r.ok()).toBe(true);
    expect(r.headers()['content-type']).toContain('image/png');
  }
});

test('no cross-origin requests at runtime', async ({ page }) => {
  const foreign: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://localhost:4173') && !r.url().startsWith('data:')) foreign.push(r.url());
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(foreign).toEqual([]);
});
