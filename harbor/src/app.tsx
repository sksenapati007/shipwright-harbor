import { useEffect, useState } from 'preact/hooks';
import { hasWebBluetooth } from './lib/env';
import { Icon } from './lib/icon';
import { listPanels, onPanelsChange } from './lib/panels';
import { appStore, type ThemePref } from './lib/store';

function applyTheme(pref: ThemePref) {
  const el = document.documentElement;
  if (pref === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', pref);
}

function ThemeToggle({ pref, onChange }: { pref: ThemePref; onChange: (p: ThemePref) => void }) {
  const order: ThemePref[] = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(pref) + 1) % order.length] ?? 'system';
  return (
    <button class="btn btn-ghost" onClick={() => onChange(next)} aria-label={`Theme: ${pref}. Switch to ${next}.`} data-testid="theme-toggle">
      <Icon name={pref === 'dark' ? 'moon' : pref === 'light' ? 'sun' : 'cpu'} />
      <span>{pref}</span>
    </button>
  );
}

export function UnsupportedPanel() {
  return (
    <section class="card card-warn" id="no-bluetooth" aria-labelledby="nb-h">
      <h2 id="nb-h">
        <Icon name="square-alert" size={24} /> This browser cannot talk to the device over Bluetooth
      </h2>
      <p>Harbor needs Web Bluetooth. These browsers have it:</p>
      <ul class="plain" data-testid="supported-browsers">
        <li>Chrome on Android, Windows, macOS, ChromeOS and Linux (Linux may need a flag)</li>
        <li>Microsoft Edge on Windows, macOS and Linux</li>
        <li>Opera and Samsung Internet on Android</li>
      </ul>
      <p class="muted">Safari, every browser on iOS and iPadOS, and Firefox do not support it.</p>
      <h3>Other ways to move files</h3>
      <ul class="plain" data-testid="alternatives">
        <li>
          <Icon name="wifi" /> <strong>Wi-Fi transfer</strong>: open Wi-Fi transfer on the device, join the same
          network, then browse to <code>http://shipwright.local</code> from any browser, including iOS Safari.
        </li>
        <li>
          <Icon name="usb" /> <strong>USB Drive</strong>: open USB Drive on the device and plug it into a computer;
          the card shows up as a disk.
        </li>
      </ul>
    </section>
  );
}

function Welcome() {
  return (
    <section class="card" aria-labelledby="w-h">
      <h2 id="w-h">
        <Icon name="tablet" size={24} /> Your device
      </h2>
      <p>
        Open <strong>Harbor</strong> on the device, then connect from here. Books, ships, the clock and settings are
        sent directly over Bluetooth. Nothing goes through a server.
      </p>
    </section>
  );
}

export function App() {
  const [pref, setPref] = useState<ThemePref>('system');
  const [, bump] = useState(0);
  const bt = hasWebBluetooth();

  useEffect(() => {
    appStore()
      .getSettings()
      .then((s) => {
        setPref(s.theme);
        applyTheme(s.theme);
      })
      .catch(() => {}); // storage can be blocked; the app still works
    return onPanelsChange(() => bump((n) => n + 1));
  }, []);

  const changeTheme = (p: ThemePref) => {
    setPref(p);
    applyTheme(p);
    appStore()
      .patchSettings({ theme: p })
      .catch(() => {});
  };

  const panels = listPanels().filter((p) => bt || p.requiresBluetooth === false);

  return (
    <div class="shell">
      <header class="top">
        <h1>
          <span class="logo" aria-hidden="true">H</span> Harbor
        </h1>
        <ThemeToggle pref={pref} onChange={changeTheme} />
      </header>
      <main>
        {bt ? <Welcome /> : <UnsupportedPanel />}
        {panels.map((p) => (
          <section class="card" key={p.id} id={`panel-${p.id}`} aria-label={p.title}>
            {p.render()}
          </section>
        ))}
      </main>
      <footer class="foot muted">
        Harbor for Shipwright OS. Works offline once loaded. No account, no tracking.
      </footer>
    </div>
  );
}
