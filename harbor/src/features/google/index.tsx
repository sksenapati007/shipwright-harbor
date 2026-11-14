// Gmail and Drive panel: sign in to Google with your own client ID and send a read-only snapshot to the device.
import { useEffect, useState } from 'preact/hooks';
import { describeError } from '../../proto/client';
import { Icon } from '../../lib/icon';
import { registerPanel } from '../../lib/panels';
import { appStore } from '../../lib/store';
import { GoogleGuideLink } from '../../lib/google-guide';
import { clientIdOk } from '../../lib/google';
import { getClient, useConnection } from '../device/connection';
import { currentToken, fetchDrive, fetchMail, GoogleAuthError, pushDrive, pushMail, signIn, signOut } from './api';

const CID_KEY = 'google.clientId'; // shared with Calendar: a client ID is public, so it may be remembered; the token never is

function GooglePanel() {
  const conn = useConnection();
  const connected = conn.status === 'connected';
  const [cid, setCid] = useState('');
  const [signed, setSigned] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    appStore()
      .get<string>(CID_KEY)
      .then((v) => typeof v === 'string' && setCid(v))
      .catch(() => {});
    setSigned(!!currentToken());
  }, []);

  const run = async (what: 'mail' | 'drive') => {
    setErr(null);
    setOk(null);
    setBusy(signed ? 'Syncing' : 'Signing in');
    try {
      let tok = currentToken();
      if (!tok) {
        tok = await signIn(cid);
        setSigned(true);
        appStore().set(CID_KEY, cid.trim()).catch(() => {});
      }
      const c = getClient();
      if (!c) return;
      setBusy('Syncing');
      if (what === 'mail') {
        const items = await fetchMail(tok);
        await pushMail(c, items);
        setOk(`Sent ${items.length} message header${items.length === 1 ? '' : 's'} to the device.`);
      } else {
        const items = await fetchDrive(tok);
        await pushDrive(c, items);
        setOk(`Sent ${items.length} file${items.length === 1 ? '' : 's'} to the device.`);
      }
    } catch (e) {
      if (e instanceof GoogleAuthError) {
        signOut();
        setSigned(false);
      }
      setErr(e instanceof Error ? e.message : describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const can = connected && !busy && (signed || clientIdOk(cid));
  return (
    <div data-testid="google-panel">
      <h2>
        <Icon name="upload" size={24} /> Gmail and Drive
      </h2>
      <p class="muted">
        Send a read-only snapshot to the device: the newest 30 inbox headers (sender, subject, a snippet, date) and your 50
        most recently changed Drive files (name, type, date, size). Message bodies and file contents are never read. Your
        device never holds a Google token and never contacts Google.
      </p>
      {err && (
        <p role="alert" class="err" data-testid="google-error">
          {err}
        </p>
      )}
      {ok && (
        <p role="status" data-testid="google-ok">
          {ok}
        </p>
      )}
      {busy && (
        <p role="status" data-testid="google-busy">
          {busy}...
        </p>
      )}
      <p class="muted small">
        Google needs an OAuth client ID that you create yourself (Google Cloud console, type Web application, with this
        page's address as an authorized JavaScript origin, and the Gmail API and Drive API enabled). Harbor ships none. The
        sign-in token stays in this page's memory and is gone when you close it.
      </p>
      <div class="row">
        <input
          class="field"
          type="text"
          aria-label="Google client ID"
          placeholder="1234-abc.apps.googleusercontent.com"
          autocomplete="off"
          spellcheck={false}
          data-testid="gsnap-client-id"
          value={cid}
          onInput={(e) => setCid(e.currentTarget.value)}
        />
      </div>
      <GoogleGuideLink clientId={cid} />
      <div class="row">
        <button class="btn" data-testid="gsnap-mail" disabled={!can} onClick={() => void run('mail')}>
          <Icon name="reload" /> Send Gmail
        </button>
        <button class="btn" data-testid="gsnap-drive" disabled={!can} onClick={() => void run('drive')}>
          <Icon name="reload" /> Send Drive
        </button>
        {signed && (
          <button
            class="btn btn-ghost"
            data-testid="gsnap-signout"
            onClick={() => {
              signOut();
              setSigned(false);
            }}
          >
            Sign out
          </button>
        )}
      </div>
      {!connected && <p class="muted small">Connect to your device first.</p>}
    </div>
  );
}

registerPanel({ id: 'google', title: 'Gmail and Drive', order: 56, render: () => <GooglePanel /> });
