import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { acctName, buildAccount, normalizeHost } from '../src/features/accounts/logic';
import { agentSnippet, newTopic, normalizeBase, pagesSecret } from '../src/features/pages/logic';
import { pickSlot, pskProblem, ssidProblem } from '../src/features/wifi/logic';
import { checkFeed, feedsFile, normalizeFeedUrl, parseFeeds } from '../src/features/news/logic';
import { LOCK_MODES, lockPatch, prefsProblem } from '../src/features/lockscreen/logic';
import { validateBackup } from '../src/features/backup/validate';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

describe('accounts', () => {
  it('names and hosts', () => {
    expect(acctName('My GitHub!')).toBe('my_github');
    expect(acctName('a'.repeat(30))).toHaveLength(10);
    expect(normalizeHost('API.GitHub.com')).toBe('api.github.com');
    for (const bad of ['https://x.com', 'x.com/path', 'localhost', 'a b.com', '*.x.com', '']) expect(normalizeHost(bad)).toBeNull();
  });
  it('builds the plan 3.2 record and enforces 384 bytes', () => {
    const b = buildAccount({ name: 'github', label: 'GitHub', host: 'api.github.com', token: 'ghp_x' }, 5);
    expect(b.ok && b.key).toBe('acct.github');
    expect(b.ok && b.value).toEqual({ label: 'GitHub', hosts: ['api.github.com'], header: 'Authorization', prefix: 'Bearer ', token: 'ghp_x', added: 5 });
    const edge = (n: number) => buildAccount({ name: 'c', label: 'C', host: 'a.io', token: 'x'.repeat(n) }, 5);
    let n = 1;
    while (edge(n + 1).ok) n++;
    expect(edge(n).ok).toBe(true);
    const over = edge(n + 1);
    expect(!over.ok && over.error).toMatch(/384/);
    expect(buildAccount({ name: 'c', label: 'C', host: 'bad host', token: 't' }).ok).toBe(false);
    expect(buildAccount({ name: 'c', label: 'C', host: 'a.io', token: '' }).ok).toBe(false);
  });
});

describe('pages', () => {
  it('topic is 128 random bits in hex', () => {
    const t = newTopic();
    expect(t).toMatch(/^sw-[0-9a-f]{32}$/);
    expect(newTopic()).not.toBe(t);
  });
  it('base and snippet', () => {
    expect(normalizeBase('')).toBe('https://ntfy.sh');
    expect(normalizeBase('https://n.example.com/')).toBe('https://n.example.com');
    expect(normalizeBase('ftp://x')).toBeNull();
    expect(pagesSecret('t', 'https://ntfy.sh')).toEqual({ topic: 't' });
    expect(agentSnippet('t', 'https://n.example.com')).toContain('SHIPWRIGHT_PAGE_BASE=https://n.example.com');
    expect(agentSnippet('t', 'https://ntfy.sh')).not.toContain('PAGE_BASE');
  });
});

describe('wifi', () => {
  it('validates', () => {
    expect(ssidProblem('')).toBeTruthy();
    expect(ssidProblem('a'.repeat(33))).toBeTruthy();
    expect(ssidProblem('Home')).toBeNull();
    expect(pskProblem('')).toBeNull();
    expect(pskProblem('short')).toBeTruthy();
    expect(pskProblem('x'.repeat(64))).toBeTruthy();
    expect(pskProblem('x'.repeat(63))).toBeNull();
  });
  it('picks slots', () => {
    expect(pickSlot([], 'A')).toBe('wifi.0');
    expect(pickSlot([{ name: 'wifi.0', label: 'A' }, { name: 'wifi.2', label: 'B' }], 'C')).toBe('wifi.1');
    expect(pickSlot([{ name: 'wifi.0', label: 'A' }, { name: 'wifi.2', label: 'B' }], 'B')).toBe('wifi.2');
    const full = [0, 1, 2, 3, 4, 5].map((i) => ({ name: `wifi.${i}`, label: `N${i}` }));
    expect(pickSlot(full, 'X')).toBeNull();
  });
});

describe('news feeds', () => {
  it('normalises, dedupes, caps', () => {
    expect(normalizeFeedUrl('example.com/rss')).toBe('https://example.com/rss');
    expect(normalizeFeedUrl('ftp://x.com')).toBeNull();
    expect(normalizeFeedUrl('https://x.com/' + 'a'.repeat(200))).toBeNull();
    const l = [{ name: '', url: 'https://a.com/f' }];
    expect(checkFeed(l, '', 'HTTPS://A.com/f').ok).toBe(false);
    const ten = Array.from({ length: 10 }, (_, i) => ({ name: '', url: `https://a.com/${i}` }));
    expect(checkFeed(ten, '', 'https://b.com').ok).toBe(false);
  });
  it('file round trip, bare strings accepted', () => {
    const f = [{ name: 'BBC', url: 'https://bbc.co.uk/rss' }];
    expect(parseFeeds(feedsFile(f))).toEqual(f);
    expect(parseFeeds(new TextEncoder().encode('{"feeds":["a.com/x","ftp://y.com/z",{"url":"https://a.com/x"}]}'))).toEqual([{ name: '', url: 'https://a.com/x' }]);
    expect(parseFeeds(new TextEncoder().encode('junk'))).toEqual([]);
  });
});

describe('lock screen', () => {
  it('patch is a settings patch', () => {
    const j = JSON.parse(new TextDecoder().decode(lockPatch({ mode: 'news', every: 30, quiet: true })));
    expect(j.kind).toBe('shipwright-settings');
    expect(j.settings).toEqual({ 'lock.mode': 'news', 'lock.every': 30, 'lock.quiet': true });
    expect(prefsProblem({ mode: 'news', every: 7, quiet: false })).toBeTruthy();
    expect(() => lockPatch({ mode: 'hologram' as never, every: -1, quiet: false })).toThrow();
  });
  it('keys are in the shared backup rules (validate.ts and sys/backup.cpp)', () => {
    expect(validateBackup(lockPatch({ mode: 'book', every: -1, quiet: false })).ok).toBe(true);
    expect(validateBackup(lockPatch({ mode: 'ship', every: 0, quiet: true })).ok).toBe(true);
    expect(validateBackup(lockPatch({ mode: 'smart', every: -1, quiet: false })).ok).toBe(true);
  });
  it('lists Time & weather right after Smart and accepts its intervals', () => {
    const keys = LOCK_MODES.map((m) => m.key);
    expect(keys[keys.indexOf('smart') + 1]).toBe('timeweather');
    expect(LOCK_MODES.find((m) => m.key === 'timeweather')?.label).toBe('Time & weather');
    for (const every of [-1, 0, 1, 5, 15]) {
      expect(validateBackup(lockPatch({ mode: 'timeweather', every, quiet: false })).ok).toBe(true);
    }
    const j = JSON.parse(new TextDecoder().decode(lockPatch({ mode: 'timeweather', every: 1, quiet: true })));
    expect(j.settings).toEqual({ 'lock.mode': 'timeweather', 'lock.every': 1, 'lock.quiet': true });
    expect(prefsProblem({ mode: 'timeweather', every: 7, quiet: false })).toBeTruthy();
  });
  it('lists Smart right after Clock', () => {
    const keys = LOCK_MODES.map((m) => m.key);
    expect(keys[keys.indexOf('clock') + 1]).toBe('smart');
    expect(LOCK_MODES.find((m) => m.key === 'smart')?.label).toBe('Smart');
  });
});
