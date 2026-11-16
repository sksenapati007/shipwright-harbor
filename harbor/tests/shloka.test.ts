// Shloka of the day lock mode (Phase 9.9 S1): Harbor lists it right after Thought of the day, the patch validates, and the device rules
// (validate.ts mirrors firmware sys/backup.cpp kLockModes; docs/protocol/backup-vectors.json is shared with the firmware test) accept it
// and still reject look-alikes.
import { describe, expect, it } from 'vitest';
import { LOCK_MODES, lockPatch, prefsProblem } from '../src/features/lockscreen/logic';
import { validateBackup } from '../src/features/backup/validate';

describe('lock mode: Shloka of the day', () => {
  it('is listed right after Thought of the day with its label', () => {
    const keys = LOCK_MODES.map((m) => m.key);
    expect(keys[keys.indexOf('thought') + 1]).toBe('shloka');
    expect(keys[keys.indexOf('shloka') + 1]).toBe('todo');
    expect(LOCK_MODES.find((m) => m.key === 'shloka')?.label).toBe('Shloka of the day');
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('makes a valid patch that the shared rules accept', () => {
    for (const every of [-1, 0]) {
      expect(prefsProblem({ mode: 'shloka', every, quiet: false })).toBeNull();
      expect(validateBackup(lockPatch({ mode: 'shloka', every, quiet: true })).ok).toBe(true);
    }
    const j = JSON.parse(new TextDecoder().decode(lockPatch({ mode: 'shloka', every: -1, quiet: false })));
    expect(j.settings).toEqual({ 'lock.mode': 'shloka', 'lock.every': -1, 'lock.quiet': false });
  });
  it('still rejects look-alike modes', () => {
    for (const bad of ['shlokas', 'Shloka', 'shloka-of-the-day', '']) {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ schema: 1, kind: 'shipwright-settings', settings: { 'lock.mode': bad } }),
      );
      expect(validateBackup(bytes).ok).toBe(false);
    }
  });
});
