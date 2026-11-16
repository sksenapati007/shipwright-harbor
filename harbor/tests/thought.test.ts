// Thought of the day lock mode (Phase 9.8 Q1): Harbor lists it right after Time & weather, the patch validates, and the device
// rules (validate.ts mirrors firmware sys/backup.cpp kLockModes) accept it and still reject look-alikes.
import { describe, expect, it } from 'vitest';
import { LOCK_MODES, lockPatch, prefsProblem } from '../src/features/lockscreen/logic';
import { validateBackup } from '../src/features/backup/validate';

describe('lock mode: Thought of the day', () => {
  it('is listed right after Time & weather with its label', () => {
    const keys = LOCK_MODES.map((m) => m.key);
    expect(keys[keys.indexOf('timeweather') + 1]).toBe('thought');
    expect(keys[keys.indexOf('thought') + 1]).toBe('todo');
    expect(LOCK_MODES.find((m) => m.key === 'thought')?.label).toBe('Thought of the day');
    expect(keys).toHaveLength(11);
  });
  it('makes a valid patch that the shared rules accept', () => {
    for (const every of [-1, 0]) {
      expect(prefsProblem({ mode: 'thought', every, quiet: false })).toBeNull();
      expect(validateBackup(lockPatch({ mode: 'thought', every, quiet: true })).ok).toBe(true);
    }
    const j = JSON.parse(new TextDecoder().decode(lockPatch({ mode: 'thought', every: -1, quiet: false })));
    expect(j.settings).toEqual({ 'lock.mode': 'thought', 'lock.every': -1, 'lock.quiet': false });
  });
  it('still rejects a mode that does not exist', () => {
    const bad = new TextEncoder().encode(
      JSON.stringify({ schema: 1, kind: 'shipwright-settings', settings: { 'lock.mode': 'thoughts' } }),
    );
    expect(validateBackup(bad).ok).toBe(false);
  });
});
