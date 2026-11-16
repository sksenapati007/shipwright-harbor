// Lock screen preferences, written as a settings patch (the Phase 6G path: /data/backup/patch.json, applied at the
// device's next start). Keys are the ones the device reads (firmware sys/quietwake.cpp, apps/lockscreen.cpp):
// lock.mode (one of 11), lock.every (minutes between quiet wakes: -1 = the mode's default, 0 = on wake only, 10, 30, 60),
// lock.quiet (bool, no fetches 22:00-07:00).
import { KIND, PATCH_PATH } from '../backup/validate';

export const LOCK_MODES = [
  { key: 'ship', label: 'Ship art' },
  { key: 'clock', label: 'Clock' },
  { key: 'smart', label: 'Smart' },
  { key: 'timeweather', label: 'Time & weather' },
  { key: 'thought', label: 'Thought of the day' },
  { key: 'shloka', label: 'Shloka of the day' },
  { key: 'todo', label: 'Todo list' },
  { key: 'reminders', label: 'Reminders' },
  { key: 'github', label: 'GitHub issues' },
  { key: 'weather', label: 'Weather' },
  { key: 'news', label: 'News headlines' },
  { key: 'book', label: 'Current book' },
] as const;
export type LockMode = (typeof LOCK_MODES)[number]['key'];

export const LOCK_EVERY = [
  { value: -1, label: 'Default for the mode' },
  { value: 0, label: 'On wake only' },
  { value: 1, label: 'Every 1 min (clock pages; Time & weather default)' },
  { value: 5, label: 'Every 5 min (clock pages)' },
  { value: 15, label: 'Every 15 min (clock pages)' },
  { value: 10, label: 'Every 10 min' },
  { value: 30, label: 'Every 30 min' },
  { value: 60, label: 'Every 60 min' },
] as const;

export interface LockPrefs {
  mode: LockMode;
  every: number;
  quiet: boolean;
}
export const DEFAULT_LOCK: LockPrefs = { mode: 'ship', every: -1, quiet: false };
export { PATCH_PATH };

export const prefsProblem = (p: LockPrefs): string | null =>
  !LOCK_MODES.some((m) => m.key === p.mode)
    ? 'Pick one of the lock screen modes.'
    : !LOCK_EVERY.some((e) => e.value === p.every)
      ? 'Pick one of the refresh intervals.'
      : null;

export function lockPatch(p: LockPrefs): Uint8Array {
  if (prefsProblem(p)) throw new Error('Bad lock screen setting.');
  return new TextEncoder().encode(
    JSON.stringify({ schema: 1, kind: KIND, settings: { 'lock.mode': p.mode, 'lock.every': p.every, 'lock.quiet': p.quiet } }),
  );
}
