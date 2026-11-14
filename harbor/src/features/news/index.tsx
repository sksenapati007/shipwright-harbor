// News feeds panel: edit the feed list and send it to the device as /data/feeds.json.
import { useEffect, useState } from 'preact/hooks';
import { ProtoError, describeError } from '../../proto/client';
import { Icon } from '../../lib/icon';
import { registerPanel } from '../../lib/panels';
import { getClient, useConnection } from '../device/connection';
import { FEEDS_PATH, MAX_FEEDS, checkFeed, feedsFile, parseFeeds, type Feed } from './logic';

function NewsPanel() {
  const conn = useConnection();
  const connected = conn.status === 'connected';
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const c = getClient();
    if (!c) {
      setLoaded(false);
      return;
    }
    c.get(FEEDS_PATH)
      .then((b) => setFeeds(parseFeeds(b)))
      .catch((e) => {
        if (!(e instanceof ProtoError && e.code === 'not_found')) setErr(describeError(e));
      })
      .finally(() => {
        setLoaded(true);
        setDirty(false);
      });
  }, [connected]);

  const add = () => {
    const r = checkFeed(feeds, name, url);
    if (!r.ok) return setErr(r.error);
    setErr(null);
    setOk(null);
    setFeeds([...feeds, r.feed]);
    setDirty(true);
    setName('');
    setUrl('');
  };
  const send = async () => {
    const c = getClient();
    if (!c) return;
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      await c.put(FEEDS_PATH, feedsFile(feeds));
      setDirty(false);
      setOk(`Sent ${feeds.length} feed${feeds.length === 1 ? '' : 's'}.`);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="news-panel">
      <h2>
        <Icon name="book-open" size={24} /> News feeds
      </h2>
      <p class="muted">RSS or Atom feeds for the News app on the device. Up to {MAX_FEEDS}. There are no default feeds.</p>
      {err && (
        <p role="alert" class="err" data-testid="news-error">
          {err}
        </p>
      )}
      {ok && (
        <p role="status" data-testid="news-ok">
          {ok}
        </p>
      )}
      <div class="row">
        <input class="field" aria-label="Feed name" placeholder="Name (optional)" data-testid="news-name" value={name} onInput={(e) => setName(e.currentTarget.value)} />
        <input
          class="field"
          aria-label="Feed address"
          placeholder="https://example.com/feed.xml"
          data-testid="news-url"
          value={url}
          onInput={(e) => setUrl(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button class="btn" data-testid="news-add" onClick={add}>
          Add
        </button>
      </div>
      {loaded && feeds.length === 0 && <p class="muted">No feeds yet.</p>}
      {feeds.length > 0 && (
        <ul class="plain list" data-testid="news-list">
          {feeds.map((f, i) => (
            <li key={f.url}>
              <div class="grow">
                <strong>{f.name || f.url}</strong>
                {f.name && <div class="muted small">{f.url}</div>}
              </div>
              <button
                class="btn btn-ghost"
                data-testid="news-remove"
                aria-label={`Remove ${f.name || f.url}`}
                onClick={() => {
                  setFeeds(feeds.filter((_, j) => j !== i));
                  setDirty(true);
                  setOk(null);
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div class="row">
        <button class="btn" data-testid="news-send" disabled={!connected || !loaded || !dirty || busy} onClick={() => void send()}>
          <Icon name="upload" /> Send to device
        </button>
        {!connected && <span class="muted small">Connect to your device first.</span>}
      </div>
    </div>
  );
}

registerPanel({ id: 'news', title: 'News feeds', order: 63, render: () => <NewsPanel /> });
