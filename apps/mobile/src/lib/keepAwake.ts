import { useEffect } from 'react';

// ---------------------------------------------------------------------------
// [STORE-BOARD · parity audit C4, owner 14 Nov 2026] A counter tablet must not go dark while the order board is open.
//
// The screen-awake switch is expo-keep-awake's native module, ExpoKeepAwake, which every build of this app already
// links: expo itself depends on expo-keep-awake, and expo-modules-autolinking resolves ExpoKeepAwake for iOS and
// Android on the expo 56 the store builds use. No new native module and no new package: the JS reaches the linked
// module through expo's own lookup (as services/jobRingCapability does), so this ships over the air, and a binary
// without it (or a test) simply keeps the screen's normal sleep.
// ---------------------------------------------------------------------------

/** The switch's two calls, as ExpoKeepAwake exports them (activate / deactivate by tag). */
export interface KeepAwakeModule {
  activate?: (tag: string) => Promise<void> | void;
  deactivate?: (tag: string) => Promise<void> | void;
}

export type NativeModuleLookup = (moduleName: string) => unknown;

/** The board's own tag: releasing it never releases anything else's hold. */
export const BOARD_KEEP_AWAKE_TAG = 'swift-store-order-board';

let expoLookup: NativeModuleLookup | null | undefined;

/** expo's requireOptionalNativeModule, loaded on first use (screen tests never load expo). */
function defaultLookup(): NativeModuleLookup | null {
  if (expoLookup === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const expo = require('expo') as { requireOptionalNativeModule?: NativeModuleLookup };
      expoLookup = typeof expo.requireOptionalNativeModule === 'function' ? expo.requireOptionalNativeModule : null;
    } catch {
      expoLookup = null;
    }
  }
  return expoLookup;
}

/** The linked screen-awake module, or null (no such module in this binary, or not on a phone). */
export function keepAwakeModule(lookup: NativeModuleLookup | null = defaultLookup()): KeepAwakeModule | null {
  if (!lookup) return null;
  try {
    const m = lookup('ExpoKeepAwake') as KeepAwakeModule | null | undefined;
    return m && typeof m.activate === 'function' && typeof m.deactivate === 'function' ? m : null;
  } catch {
    return null;
  }
}

/** Hold the screen awake when `on`; returns the release. Never throws: a refusal leaves the normal sleep. */
export function holdScreenAwake(on: boolean, module: KeepAwakeModule | null = keepAwakeModule()): () => void {
  if (!on || !module) return () => {};
  const call = (fn?: (tag: string) => Promise<void> | void) => {
    try { void Promise.resolve(fn?.(BOARD_KEEP_AWAKE_TAG)).catch(() => {}); } catch { /* the phone said no */ }
  };
  call(module.activate);
  return () => call(module.deactivate);
}

/** Keep the screen on while `on` (the board is on screen); let it sleep again when it is not. */
export function useKeepScreenAwake(on: boolean): void {
  useEffect(() => holdScreenAwake(on), [on]);
}
