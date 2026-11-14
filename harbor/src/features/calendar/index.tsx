// Calendar panel: import an .ics file (no account) or sign in to Google with your own client ID.
import { useEffect, useState } from 'preact/hooks';
import { describeError } from '../../proto/client';
import { Icon } from '../../lib/icon';
import { registerPanel } from '../../lib/panels';
import { appStore } from '../../lib/store';
import { windowAround, MAX_EVENTS } from '../../lib/ics';
import { GoogleGuideLink } from '../../lib/google-guide';
import { clientIdOk, currentToken, fetchEvents, GoogleAuthError, signIn, signOut } from '../../lib/google';
import { getClient, useConnection } from '../device/connection';
import { icsProblem, importIcs, pushCalendar } from './ops';

const CID_KEY = 'google.clientId'; // a client ID is public, so it may be remembered; the token never is

function CalendarPanel() {
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

  const done = (n: number, truncated: boolean, what: string) =>
    setOk(`Sent ${n} event${n === 1 ? '' : 's'} from ${what}.${truncated ? ` Only the first ${MAX_EVENTS} fit.` : ''}`);

  const fromFile = async (f: File) => {
    const c = getClient();
    if (!c) return;
    setErr(null);
    setOk(null);
    const problem = icsProblem(f.name, f.size);
    if (problem) return setErr(problem);
    setBusy('Importing');
    try {
      const r = await importIcs(c, await f.text());
      done(r.events.length, r.truncated, f.name);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const google = async (interactive: boolean) => {
    setErr(null);
    setOk(null);
    setBusy(interactive ? 'Signing in' : 'Syncing');
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
      const r = await fetchEvents({ token: tok, window: windowAround(Math.floor(Date.now() / 1000)) });
      await pushCalendar(c, r, 'google');
      done(r.events.length, r.truncated, 'Google Calendar');
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

  return (
    <div data-testid="calendar-panel">
      <h2>
        <Icon name="clock" size={24} /> Calendar
      </h2>
      <p class="muted">
        Events from 7 days back to 90 days ahead are sent to the device, with repeating events already expanded.
      </p>
      {err && (
        <p role="alert" class="err" data-testid="calendar-error">
          {err}
        </p>
      )}
      {ok && (
        <p role="status" data-testid="calendar-ok">
          {ok}
        </p>
      )}
      {busy && (
        <p role="status" data-testid="calendar-busy">
          {busy}...
        </p>
      )}

      <h3>From a file</h3>
      <div class="row">
        <label class="btn" style="cursor:pointer">
          <Icon name="upload" /> Import .ics
          <input
            type="file"
            accept=".ics,text/calendar"
            data-testid="ics-file"
            disabled={!connected || !!busy}
            style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden"
            onChange={(ev) => {
              const f = ev.currentTarget.files?.[0];
              ev.currentTarget.value = '';
              if (f) void fromFile(f);
            }}
          />
        </label>
        {!connected && <span class="muted small">Connect to your device first.</span>}
      </div>
      <p class="muted small">Works with any calendar app's export. No account needed.</p>

      <h3>From Google Calendar</h3>
      <p class="muted small">
        Google needs an OAuth client ID that you create yourself (Google Cloud console, type Web application, with this
        page's address as an authorized JavaScript origin, and the Calendar API enabled). Harbor ships none. The sign-in
        token stays in this page's memory and is gone when you close it.
      </p>
      <div class="row">
        <input
          class="field"
          type="text"
          aria-label="Google client ID"
          placeholder="1234-abc.apps.googleusercontent.com"
          autocomplete="off"
          spellcheck={false}
          data-testid="google-client-id"
          value={cid}
          onInput={(e) => setCid(e.currentTarget.value)}
        />
      </div>
      <GoogleGuideLink clientId={cid} />
      <div class="row">
        <button
          class="btn"
          data-testid="google-sync"
          disabled={!connected || !!busy || !(signed || clientIdOk(cid))}
          onClick={() => void google(!signed)}
        >
          <Icon name="reload" /> {signed ? 'Sync Google Calendar' : 'Sign in and sync'}
        </button>
        {signed && (
          <button
            class="btn btn-ghost"
            data-testid="google-signout"
            onClick={() => {
              signOut();
              setSigned(false);
            }}
          >
            Sign out
          </button>
        )}
      </div>
    </div>
  );
}

registerPanel({ id: 'calendar', title: 'Calendar', order: 55, render: () => <CalendarPanel /> });
