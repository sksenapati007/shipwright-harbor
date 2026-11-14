// Pure helpers for the Books panel.
import { crc32 } from '../../proto/codec';
import { pathOk } from '../../proto/client';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Same as firmware sys::fsutil::id8: crc32 of "<path>|<size>", 8 lowercase hex digits. */
export function id8(path: string, size: number): string {
  return crc32(enc.encode(`${path}|${size}`)).toString(16).padStart(8, '0');
}

export function stateFile(path: string, size: number): string {
  return `/data/books/${id8(path, size)}/state.json`;
}

/** The Markdown export the reader writes for one book's highlights and notes (firmware reader/notes). */
export function notesFile(path: string, size: number): string {
  return `/data/books/${id8(path, size)}/notes.md`;
}

export const NO_NOTES_MESSAGE =
  'No exported notes for that book yet. On the device open the reader menu, Highlights & notes, Export.';

/** A download name for the notes of a book: "<title>-notes.md", with device-unsafe and path characters removed. */
export function notesDownloadName(title: string): string {
  let stem = title.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (stem.length > 60) stem = stem.slice(0, 60).trim();
  return `${stem || 'book'}-notes.md`;
}

export interface BookState {
  title?: string;
  pct: number;
  marks: number;
  updated?: number;
}

/** Reads the progress file the reader writes (plan 3.2). Returns null for anything unusable. */
export function parseState(bytes: Uint8Array): BookState | null {
  try {
    const j = JSON.parse(dec.decode(bytes)) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return null;
    const pct = typeof j.pct === 'number' && isFinite(j.pct) ? Math.max(0, Math.min(100, Math.round(j.pct))) : 0;
    return {
      title: typeof j.title === 'string' ? j.title : undefined,
      pct,
      marks: Array.isArray(j.marks) ? j.marks.length : 0,
      updated: typeof j.updated === 'number' ? j.updated : undefined,
    };
  } catch {
    return null;
  }
}

/** Makes a file name the device accepts: no path parts, no FAT-illegal characters, at most 100 bytes. */
export function safeBookName(name: string): string {
  let n = name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
  const dot = n.lastIndexOf('.');
  const ext = dot > 0 ? n.slice(dot) : '';
  let stem = dot > 0 ? n.slice(0, dot) : n;
  while (enc.encode(stem + ext).length > 100 && stem.length > 1) stem = stem.slice(0, -1);
  n = stem + ext;
  return n || 'book';
}

export function bookPath(name: string): string | null {
  const p = `/books/${safeBookName(name)}`;
  return pathOk(p) ? p : null;
}

export const BOOKS_ROOT = '/books';

/** True for /books and anything below it (no "..", no empty parts). */
export function inBooks(dir: string): boolean {
  if (dir === BOOKS_ROOT) return true;
  return dir.startsWith(`${BOOKS_ROOT}/`) && pathOk(dir);
}

/** The folder one level up, never above /books. */
export function parentDir(dir: string): string {
  if (!inBooks(dir) || dir === BOOKS_ROOT) return BOOKS_ROOT;
  return dir.slice(0, dir.lastIndexOf('/'));
}

/** Makes a folder name the device accepts (same character rules as file names, no extension handling). */
export function safeFolderName(name: string): string {
  let n = name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
  while (enc.encode(n).length > 60 && n.length > 1) n = n.slice(0, -1);
  return n;
}

/**
 * Where an uploaded book goes: inside folder `dir` (default /books), optionally in a new sub-folder `sub` (the device
 * creates missing folders on upload). Null when the result would not be a valid device path.
 */
export function bookPathIn(dir: string, name: string, sub = ''): string | null {
  if (!inBooks(dir)) return null;
  const folder = sub.trim() ? `${dir}/${safeFolderName(sub)}` : dir;
  const p = `${folder}/${safeBookName(name)}`;
  return inBooks(folder) && pathOk(p) ? p : null;
}

export interface FolderNode {
  path: string;
  depth: number;
}

/** The sub-folder tree under /books, depth first and sorted, at most `maxDepth` levels and `maxNodes` folders. */
export async function folderTree(
  list: (dir: string) => Promise<{ name: string; dir: boolean }[]>,
  maxDepth = 3,
  maxNodes = 60,
): Promise<FolderNode[]> {
  const out: FolderNode[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || out.length >= maxNodes) return;
    let entries: { name: string; dir: boolean }[];
    try {
      entries = await list(dir);
    } catch {
      return; // an unreadable folder is just not shown
    }
    const names = entries.filter((e) => e.dir).map((e) => e.name).sort((a, b) => a.localeCompare(b));
    for (const n of names) {
      if (out.length >= maxNodes) return;
      const path = `${dir}/${n}`;
      out.push({ path, depth });
      await walk(path, depth + 1);
    }
  };
  await walk(BOOKS_ROOT, 1);
  return out;
}

export function isBookFile(name: string): boolean {
  return /\.(epub|txt)$/i.test(name);
}

export function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
