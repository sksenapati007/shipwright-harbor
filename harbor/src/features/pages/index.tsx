// Pages panel: "Set up Pages" makes a private topic and an end-to-end encryption key, sends both to the device as the "pages"
// secret and shows the agent snippet and the key once.
import { useEffect, useState } from 'preact/hooks';
import { describeError } from '../../proto/client';
import { Icon } from '../../lib/icon';
import { registerPanel } from '../../lib/panels';
import { appStore } from '../../lib/store';
import { getClient, useConnection } from '../device/connection';
import { DEFAULT_BASE, agentSnippet, newKey, newTopic, normalizeBase, pagesSecret, rememberRecord } from './logic';

const REMEMBER = 'pages.remember';

function PagesPanel() {
  const conn = useConnection();
  const connected = conn.status === 'connected';
  const [base, setBase] = useState('');
  const [remember, setRemember] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [sent, setSent] = useState<{ topic: string; base: string; key?: string } | null>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    const c = getClient();
    if (!c) return;
    try {
      setConfigured((await c.secretList()).some((s) => s.name === 'pages'));
    } catch (e) {
      setErr(describeError(e));
    }
  };
  useEffect(() => {
    if (connected) void refresh();
    else setConfigured(null);
  }, [connected]);
  useEffect(() => {
    appStore()
      .get<{ topic: string; base: string; key?: string }>(REMEMBER)
      .then((r) => {
        if (r) {
          // A record from an older Harbor may hold a key: drop it from the store and never show it.
          const clean = rememberRecord(r);
          if ('key' in r) void appStore().set(REMEMBER, clean).catch(() => {});
          setSent(clean);
          setRemember(true);
        }
      })
      .catch(() => {});
  }, []);

  const b = normalizeBase(base);
  const setup = async () => {
    const c = getClient();
    if (!c || !b) return;
    setErr(null);
    setBusy(true);
    try {
      const topic = newTopic();
      const key = newKey();
      await c.secretSet('pages', pagesSecret(topic, b, key));
      setSent({ topic, base: b, key });
      setArmed(false);
      try {
        if (remember) await appStore().set(REMEMBER, rememberRecord({ topic, base: b, key }));
        else await appStore().del(REMEMBER);
      } catch {
        /* nothing remembered */
      }
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const c = getClient();
    if (!c) return;
    try {
      await c.secretDel('pages');
      setSent(null);
      setArmed(false);
      await appStore().del(REMEMBER).catch(() => {});
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    }
  };

  return (
    <div data-testid="pages-panel">
      <h2>
        <Icon name="download" size={24} /> Pages
      </h2>
      <p class="muted">
        Pages lets a script or coding agent send your device a short message and wait for your answer. Messages go through an ntfy server
        (the public {DEFAULT_BASE} unless you give your own) under a private random topic, and the text of every message and answer is
        encrypted end to end with a key only your device and your agent have. The server operator can still see that messages exist:
        the topic, when they were sent and how long they are.
      </p>
      {err && (
        <p role="alert" class="err" data-testid="pages-error">
          {err}
        </p>
      )}
      <p data-testid="pages-state">
        {configured === null ? 'Connect to see whether Pages is set up.' : configured ? 'Pages is set up on this device.' : 'Pages is not set up.'}
      </p>
      <div class="row">
        <input
          class="field"
          aria-label="ntfy server"
          placeholder={`Server (default ${DEFAULT_BASE})`}
          data-testid="pages-base"
          value={base}
          onInput={(e) => setBase(e.currentTarget.value)}
        />
      </div>
      {base && !b && (
        <p role="alert" class="err small" data-testid="pages-base-problem">
          The server must look like https://ntfy.example.com
        </p>
      )}
      <div class="row">
        <label>
          <input type="checkbox" data-testid="pages-remember" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} /> Remember the
          topic in Harbor
        </label>
      </div>
      <div class="row">
        {configured && !armed ? (
          <button class="btn" data-testid="pages-setup" disabled={!connected || !b || busy} onClick={() => setArmed(true)}>
            Make a new topic
          </button>
        ) : (
          <button class="btn" data-testid="pages-setup" disabled={!connected || !b || busy} onClick={() => void setup()}>
            <Icon name="upload" /> {configured ? 'Replace the topic' : 'Set up Pages'}
          </button>
        )}
        {configured && (
          <button class="btn btn-ghost" data-testid="pages-remove" onClick={() => void remove()}>
            Turn off Pages
          </button>
        )}
        {!connected && <span class="muted small">Connect to your device first.</span>}
      </div>
      {armed && <p class="muted small">A new topic stops the old one working. Agents need the new snippet. Press Replace the topic to go on.</p>}
      {sent && (
        <>
          <h3>Agent snippet</h3>
          <p class="muted small">
            Put this in the shell where your agent runs.{' '}
            {sent.key
              ? 'It includes the encryption key. Harbor shows the key once and never stores it: keep it like a password. The device cannot show it again.'
              : 'The key was shown once at setup and Harbor does not keep it. Replace the topic to get a new one.'}
          </p>
          <pre data-testid="pages-snippet">{agentSnippet(sent.topic, sent.base, sent.key)}</pre>
          {sent.key && (
            <p class="small">
              Encryption key: <code data-testid="pages-key">{sent.key}</code>
            </p>
          )}
          <button class="btn btn-ghost" onClick={() => void navigator.clipboard?.writeText(agentSnippet(sent.topic, sent.base, sent.key)).catch(() => {})}>
            Copy
          </button>
        </>
      )}
    </div>
  );
}

registerPanel({ id: 'pages', title: 'Pages', order: 62, render: () => <PagesPanel /> });
