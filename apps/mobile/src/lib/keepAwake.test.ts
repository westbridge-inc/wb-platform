import { describe, expect, it, vi } from 'vitest';
import { BOARD_KEEP_AWAKE_TAG, holdScreenAwake, keepAwakeModule } from './keepAwake';

// [STORE-BOARD · parity audit C4] The board keeps a counter tablet's screen on, through the ExpoKeepAwake native module
// every build already links (no new native module). A binary without it, or a phone that refuses, keeps normal sleep.

describe('[STORE-BOARD] keep the screen awake while the board is open', () => {
  it('finds the linked module by its native name; none when the binary has no such module', () => {
    const native = { activate: vi.fn(), deactivate: vi.fn() };
    const asked: string[] = [];
    expect(keepAwakeModule((name) => { asked.push(name); return native; })).toBe(native);
    expect(asked).toEqual(['ExpoKeepAwake']);
    expect(keepAwakeModule(() => null)).toBeNull();
    expect(keepAwakeModule(() => ({ activate: vi.fn() }))).toBeNull();
    expect(keepAwakeModule(() => { throw new Error('no module'); })).toBeNull();
    expect(keepAwakeModule(null)).toBeNull();
  });

  it('on: holds the screen with the board\'s own tag; the release lets it sleep again', () => {
    const native = { activate: vi.fn(), deactivate: vi.fn() };
    const release = holdScreenAwake(true, native);
    expect(native.activate).toHaveBeenCalledExactlyOnceWith(BOARD_KEEP_AWAKE_TAG);
    expect(native.deactivate).not.toHaveBeenCalled();
    release();
    expect(native.deactivate).toHaveBeenCalledExactlyOnceWith(BOARD_KEEP_AWAKE_TAG);
  });

  it('off, or no module: nothing is held', () => {
    const native = { activate: vi.fn(), deactivate: vi.fn() };
    holdScreenAwake(false, native)();
    expect(native.activate).not.toHaveBeenCalled();
    expect(native.deactivate).not.toHaveBeenCalled();
    expect(() => holdScreenAwake(true, null)()).not.toThrow();
  });

  it('a refusal from the phone never breaks the board', async () => {
    const native = { activate: vi.fn(() => Promise.reject(new Error('refused'))), deactivate: vi.fn(() => { throw new Error('gone'); }) };
    const release = holdScreenAwake(true, native);
    await Promise.resolve();
    expect(() => release()).not.toThrow();
  });
});
