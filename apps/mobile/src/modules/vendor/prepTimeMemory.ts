import { useState } from 'react';
import { DEFAULT_PREP_MINUTES, isPrepChoice, type PrepChoice } from './prepTime';

/**
 * [APP-PREPTIME] The last preparation time a store's staff chose, remembered per
 * store on this device, so a kitchen that always says 30 taps Accept once.
 *
 * Fail-safe: plain MMKV opened lazily and guarded (the InAppCallReach pattern).
 * A store id and a number of minutes are not personal data, so the encrypted
 * auth store is not needed. Storage that cannot open keeps the choice for this
 * run only; storage that throws, or holds anything but one of the six choices,
 * reads as the website's default, 20; a lost write only costs the next order
 * its pre-selection.
 */

const STORE_ID = 'swift-store-prep';
const slot = (storeId: string) => `prep.${storeId}`;

export type PrepStore = { getString(key: string): string | undefined; set(key: string, value: string): void };

/** Kept for this run when the device storage cannot be opened, so a choice still holds until the app restarts. */
const thisRun = new Map<string, string>();
let store: PrepStore | null | undefined;

/** Wires the storage: the device's by default (opened on first use); a test's double, or null for "this run only". */
export function bindPrepTimeStorage(next: PrepStore | null | undefined): void {
  store = next;
  thisRun.clear();
}

/** Opened on first use, never at import: the board and order screens load this module, and a storage that cannot
 *  open (or a test runner without the native module) must not take them down with it. */
function device(): PrepStore | null {
  if (store !== undefined) return store;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MMKV } = require('react-native-mmkv') as { MMKV: new (o: { id: string }) => PrepStore };
    store = new MMKV({ id: STORE_ID });
  } catch {
    store = null;
  }
  return store;
}

/** The time last chosen for this store on this device, or null. */
export function rememberedPrepMinutes(storeId: string | null | undefined): PrepChoice | null {
  if (!storeId) return null;
  try {
    const disk = device();
    const raw = disk ? disk.getString(slot(storeId)) : thisRun.get(slot(storeId));
    const minutes = raw ? Number(raw) : Number.NaN;
    return isPrepChoice(minutes) ? minutes : null;
  } catch {
    return null;
  }
}

/** Remembers a choice for this store. Only one of the six choices, only with a store. */
export function rememberPrepMinutes(storeId: string | null | undefined, minutes: number): void {
  if (!storeId || !isPrepChoice(minutes)) return;
  try {
    const disk = device();
    if (disk) disk.set(slot(storeId), String(minutes));
    else thisRun.set(slot(storeId), String(minutes));
  } catch {
    // Best-effort: the next order starts at 20 instead.
  }
}

/** Where the choices start for this store: the last choice here, else 20. */
export function startingPrepMinutes(storeId: string | null | undefined): PrepChoice {
  return rememberedPrepMinutes(storeId) ?? DEFAULT_PREP_MINUTES;
}

/**
 * The time chosen for the order on screen. It starts at the store's last choice
 * (else 20) and a new order (another `orderKey`) starts there again; a tap is
 * remembered for the store at once.
 */
export function usePrepChoice(orderKey: string | null | undefined, storeId: string | null | undefined): [PrepChoice, (minutes: PrepChoice) => void] {
  const [picked, setPicked] = useState<{ key: string | null | undefined; minutes: PrepChoice } | null>(null);
  const minutes = picked && picked.key === orderKey ? picked.minutes : startingPrepMinutes(storeId);
  const choose = (next: PrepChoice) => {
    setPicked({ key: orderKey, minutes: next });
    rememberPrepMinutes(storeId, next);
  };
  return [minutes, choose];
}
