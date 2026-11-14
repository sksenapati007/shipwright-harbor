// Backup operations over an open sync client. The panel and the tests both use these.
import { ProtoError, type Client, type Entry } from '../../proto/client';
import { BACKUP_DIR, PATCH_PATH, RESTORE_PATH, dockUrlOk, dockUrlPatch, describeBackupError, newestBackup, validateBackup } from './validate';

/** The subset of the sync client these operations need (Client and test doubles both fit). */
export type SyncLike = Pick<Client, 'list' | 'get' | 'put'>;

export class BackupProblem extends Error {}

const enc = new TextEncoder();

/** Downloads the newest backup the device wrote (Settings > Backup & restore > Back up). */
export async function fetchNewestBackup(c: SyncLike): Promise<{ name: string; bytes: Uint8Array }> {
  let entries: Entry[];
  try {
    entries = await c.list(BACKUP_DIR);
  } catch (e) {
    if (e instanceof ProtoError && e.code !== 'disconnected' && e.code !== 'timeout') entries = []; // no folder yet
    else throw e;
  }
  const name = newestBackup(entries);
  if (!name) throw new BackupProblem('No backup on the device yet. On the device open Settings, Backup & restore, then Back up.');
  const bytes = await c.get(`${BACKUP_DIR}/${name}`);
  const v = validateBackup(bytes);
  if (!v.ok) throw new BackupProblem(`The backup on the device is not usable: ${describeBackupError(v.error)}`);
  return { name, bytes };
}

/** Checks a chosen file, then uploads it as the restore file. The device applies it at its next start. */
export async function uploadRestore(c: SyncLike, bytes: Uint8Array): Promise<void> {
  const v = validateBackup(bytes);
  if (!v.ok) throw new BackupProblem(describeBackupError(v.error));
  await c.put(RESTORE_PATH, bytes);
}

/** Uploads a patch that sets only the Dock catalogue URL. Applied at the device's next start. */
export async function uploadDockUrl(c: SyncLike, url: string): Promise<void> {
  const u = url.trim();
  if (!dockUrlOk(u)) throw new BackupProblem('The Dock address must start with http:// or https:// and contain no spaces.');
  const body = enc.encode(dockUrlPatch(u));
  const v = validateBackup(body);
  if (!v.ok) throw new BackupProblem(describeBackupError(v.error));
  await c.put(PATCH_PATH, body);
}
