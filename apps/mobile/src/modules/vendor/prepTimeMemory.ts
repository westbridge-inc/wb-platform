import { useState } from 'react';
import { isPrepChoice, storePrepChoice, type PrepChoice } from './prepTime';

/**
 * [APP-PREPTIME · ROUND 2] Where the choices start: the STORE'S OWN declared
 * prep time (owner ruling 14 Nov 2026), unless staff changed it for this store
 * on this device. A change is remembered with the store's time it replaced, so
 * it holds while the store's time is the same, and the store's own time wins
 * again when staff tap it, or when the store changes its declared time.
 *
 * Fail-safe: plain MMKV opened lazily and guarded (the InAppCallReach pattern).
 * A store id and a number of minutes are not personal data, so the encrypted
 * auth store is not needed. Storage that cannot open keeps the change for this
 * run only; storage that throws, or holds anything but "<choice>/<choice>",
 * reads as no change; a lost write only costs the next order the change.
 */

const STORE_ID = 'swift-store-prep';
const slot = (storeId: string) => `prep.${storeId}`;
/** "45/30": staff chose 45 where the store's own time was 30. */
const encode = (minutes: PrepChoice, storeChoice: PrepChoice) => `${minutes}/${storeChoice}`;

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

/** The time staff chose for this store on this device, while the store's own time is still `storeChoice`; or null. */
export function rememberedPrepMinutes(storeId: string | null | undefined, storeChoice: PrepChoice): PrepChoice | null {
  if (!storeId) return null;
  try {
    const disk = device();
    const raw = disk ? disk.getString(slot(storeId)) : thisRun.get(slot(storeId));
    const parts = typeof raw === 'string' ? raw.split('/') : [];
    if (parts.length !== 2) return null;
    const [minutes, against] = parts.map(Number);
    return isPrepChoice(minutes) && isPrepChoice(against) && against === storeChoice ? minutes : null;
  } catch {
    return null;
  }
}

/** Remembers a choice for this store. The store's own time forgets the change; only a choice, only with a store. */
export function rememberPrepMinutes(storeId: string | null | undefined, minutes: number, storeChoice: PrepChoice): void {
  if (!storeId || !isPrepChoice(minutes)) return;
  const value = minutes === storeChoice ? '' : encode(minutes, storeChoice);
  try {
    const disk = device();
    if (disk) disk.set(slot(storeId), value);
    else thisRun.set(slot(storeId), value);
  } catch {
    // Best-effort: the next order starts at the store's own time instead.
  }
}

/** Where the choices start for this store: a change staff made here, else the store's own declared time. */
export function startingPrepMinutes(storeId: string | null | undefined, declared: unknown): PrepChoice {
  const storeChoice = storePrepChoice(declared);
  return rememberedPrepMinutes(storeId, storeChoice) ?? storeChoice;
}

/**
 * The time chosen for the order on screen. It starts where `startingPrepMinutes` says (the store's own time, or a
 * change staff made here) and a new order (another `orderKey`) starts there again; a tap is remembered at once.
 * `declared` is the order's own estimatedPrepTime while it waits (the store's declared time, stamped at checkout).
 */
export function usePrepChoice(
  orderKey: string | null | undefined,
  storeId: string | null | undefined,
  declared: unknown,
): [PrepChoice, (minutes: PrepChoice) => void] {
  const [picked, setPicked] = useState<{ key: string | null | undefined; minutes: PrepChoice } | null>(null);
  const minutes = picked && picked.key === orderKey ? picked.minutes : startingPrepMinutes(storeId, declared);
  const choose = (next: PrepChoice) => {
    setPicked({ key: orderKey, minutes: next });
    rememberPrepMinutes(storeId, next, storePrepChoice(declared));
  };
  return [minutes, choose];
}
