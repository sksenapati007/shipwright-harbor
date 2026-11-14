// Books panel: browse /books and its sub-folders on the device (folder picker tree, Open, Up), reading progress (from each
// book's state.json), add EPUB/TXT files into the folder you are in (or a new sub-folder) with a progress bar, delete.
// ponytail: the picker shows 3 levels and 60 folders, deeper folders are reachable by opening folders.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { describeError, ProtoError, type Client, type Entry } from '../../proto/client';
import { Icon } from '../../lib/icon';
import { registerPanel } from '../../lib/panels';
import { getClient, useConnection } from '../device/connection';
import { BOOKS_ROOT, bookPathIn, fmtSize, folderTree, inBooks, isBookFile, parentDir, safeFolderName, NO_NOTES_MESSAGE, notesDownloadName, notesFile, parseState, stateFile, type BookState, type FolderNode } from './logic';

interface Row {
  entry: Entry;
  path: string;
  state: BookState | null;
}

async function loadRows(c: Client, dir: string): Promise<Row[]> {
  const entries = await c.list(dir);
  const rows: Row[] = [];
  for (const entry of entries) {
    if (entry.dir) {
      rows.push({ entry, path: `${dir}/${entry.name}`, state: null });
      continue;
    }
    if (!isBookFile(entry.name)) continue;
    const path = `${dir}/${entry.name}`;
    let state: BookState | null = null;
    try {
      state = parseState(await c.get(stateFile(path, entry.size)));
    } catch {
      // no progress file yet (not_found) or unreadable: shown as not started
    }
    rows.push({ entry, path, state });
  }
  rows.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
  return rows;
}

/** Hands the Markdown to the browser as a file download. */
function saveMarkdown(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function BooksPanel() {
  const conn = useConnection();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [up, setUp] = useState<{ name: string; sent: number; total: number } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dir, setDir] = useState(BOOKS_ROOT);
  const [tree, setTree] = useState<FolderNode[]>([]);
  const [sub, setSub] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const connected = conn.status === 'connected';

  const refresh = useCallback(async () => {
    const c = getClient();
    if (!c) {
      setRows(null);
      return;
    }
    try {
      setRows(await loadRows(c, dir));
      setErr(null);
    } catch (e) {
      setErr(describeError(e));
      if (dir !== BOOKS_ROOT) setDir(BOOKS_ROOT); // the folder is gone (deleted on the device): back to the top
    }
    try {
      setTree(await folderTree((d) => c.list(d)));
    } catch {
      setTree([]);
    }
  }, [dir]);

  useEffect(() => {
    void refresh();
  }, [connected, refresh]);

  const add = async (f: File) => {
    const c = getClient();
    if (!c) return;
    setErr(null);
    const path = bookPathIn(dir, f.name, sub);
    if (!path) {
      setErr(sub.trim() ? 'That file or folder name cannot be used on the device.' : 'That file name cannot be used on the device.');
      return;
    }
    const free = conn.hello?.free_kb;
    if (free !== undefined && f.size > Math.max(0, free - 4096) * 1024) {
      setErr('The device does not have room for that book.');
      return;
    }
    setBusy(true);
    setUp({ name: f.name, sent: 0, total: f.size });
    try {
      const data = new Uint8Array(await f.arrayBuffer());
      await c.put(path, data, { onProgress: (sent, total) => setUp({ name: f.name, sent, total }) });
      setSub('');
      await refresh();
    } catch (e) {
      setErr(`${describeError(e)} If the link dropped, connect again and send the same file: it resumes.`);
    } finally {
      setUp(null);
      setBusy(false);
    }
  };

  const remove = async (r: Row) => {
    const c = getClient();
    if (!c) return;
    setArmed(null);
    try {
      await c.del(r.path);
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    }
  };

  // Export notes: the device writes notes.md (reader menu, Highlights & notes, Export); this fetches it.
  const exportNotes = async (r: Row) => {
    const c = getClient();
    if (!c) return;
    setErr(null);
    setNotice(null);
    try {
      const bytes = await c.get(notesFile(r.path, r.entry.size));
      saveMarkdown(notesDownloadName(r.state?.title || r.entry.name.replace(/\.[^.]*$/, '')), bytes);
      setNotice('Notes downloaded.');
    } catch (e) {
      setErr(e instanceof ProtoError && e.code === 'not_found' ? NO_NOTES_MESSAGE : describeError(e));
    }
  };

  return (
    <div data-testid="books-panel">
      <h2>
        <Icon name="book-open" size={24} /> Books
      </h2>
      {!connected && <p class="muted">Connect to your device to see and add books.</p>}
      {connected && (
        <>
          <div class="row">
            <button class="btn btn-ghost" data-testid="books-up" disabled={busy || dir === BOOKS_ROOT} onClick={() => setDir(parentDir(dir))}>
              Up
            </button>
            <label class="grow">
              <span class="muted small">Folder</span>
              <select
                class="field"
                data-testid="books-folder"
                aria-label="Books folder"
                value={dir}
                disabled={busy}
                onChange={(e) => setDir(e.currentTarget.value)}
              >
                <option value={BOOKS_ROOT}>/books</option>
                {!tree.some((n) => n.path === dir) && dir !== BOOKS_ROOT && <option value={dir}>{dir}</option>}
                {tree.map((n) => (
                  <option key={n.path} value={n.path}>
                    {'\u00a0\u00a0'.repeat(n.depth)}
                    {n.path.slice(n.path.lastIndexOf('/') + 1)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div class="row">
            <input
              class="field"
              type="text"
              aria-label="New sub-folder for the next upload"
              placeholder="New sub-folder (optional)"
              maxlength={60}
              data-testid="book-newfolder"
              value={sub}
              disabled={busy}
              onInput={(e) => setSub(safeFolderName(e.currentTarget.value))}
            />
          </div>
          <div class="row">
            <button class="btn" data-testid="book-add" disabled={busy} onClick={() => file.current?.click()}>
              <Icon name="upload" /> Add book
            </button>
            <button class="btn btn-ghost" data-testid="books-refresh" disabled={busy} onClick={() => void refresh()}>
              <Icon name="reload" /> Refresh
            </button>
            <input
              ref={file}
              type="file"
              accept=".epub,.txt,application/epub+zip,text/plain"
              data-testid="book-file"
              hidden
              onChange={(ev) => {
                const f = ev.currentTarget.files?.[0];
                ev.currentTarget.value = '';
                if (f) void add(f);
              }}
            />
          </div>
          {up && (
            <div data-testid="book-progress" role="status">
              <p>
                Sending {up.name}: {up.total ? Math.floor((up.sent * 100) / up.total) : 100}% ({fmtSize(up.sent)} of{' '}
                {fmtSize(up.total)})
              </p>
              <progress max={up.total || 1} value={up.sent} style="width:100%" />
            </div>
          )}
          {err && (
            <p role="alert" class="err" data-testid="books-error">
              {err}
            </p>
          )}
          {notice && (
            <p role="status" data-testid="books-notice">
              {notice}
            </p>
          )}
          {rows && rows.length === 0 && !up && <p class="muted" data-testid="books-empty">{dir === BOOKS_ROOT ? 'No books on the device yet.' : 'This folder is empty.'}</p>}
          {rows && rows.length > 0 && (
            <ul class="plain list" data-testid="books-list">
              {rows.map((r) => (
                <li key={r.path} data-testid="book-row">
                  <div class="grow">
                    <strong>{r.state?.title || r.entry.name}</strong>
                    <div class="muted small">
                      {r.entry.dir ? (
                        'Folder'
                      ) : (
                        <>
                          {r.entry.name} · {fmtSize(r.entry.size)} ·{' '}
                          <span data-testid="book-pct">{r.state ? `${r.state.pct}% read` : 'Not started'}</span>
                          {r.state && r.state.marks > 0 ? ` · ${r.state.marks} bookmark${r.state.marks === 1 ? '' : 's'}` : ''}
                        </>
                      )}
                    </div>
                  </div>
                  {r.entry.dir && inBooks(r.path) && (
                    <button class="btn btn-ghost" data-testid="book-folder-open" aria-label={`Open folder ${r.entry.name}`} onClick={() => setDir(r.path)}>
                      <Icon name="book-open" /> Open
                    </button>
                  )}
                  {!r.entry.dir && (
                    <button class="btn btn-ghost" data-testid="book-export-notes" aria-label={`Export notes for ${r.entry.name}`} onClick={() => void exportNotes(r)}>
                      <Icon name="download" /> Export notes
                    </button>
                  )}
                  {!r.entry.dir &&
                    (armed === r.path ? (
                      <span class="row">
                        <button class="btn" data-testid="book-delete-confirm" onClick={() => void remove(r)}>
                          Delete for sure
                        </button>
                        <button class="btn btn-ghost" onClick={() => setArmed(null)}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button class="btn btn-ghost" data-testid="book-delete" aria-label={`Delete ${r.entry.name}`} onClick={() => setArmed(r.path)}>
                        Delete
                      </button>
                    ))}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

registerPanel({ id: 'books', title: 'Books', order: 20, render: () => <BooksPanel /> });
