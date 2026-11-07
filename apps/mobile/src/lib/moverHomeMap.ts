/**
 * [APP-SPEED C · report item 9] The driver Home map and its demand dots, as pure seams (tested without a phone).
 *
 * - The camera: the map used to be a CONTROLLED region rebuilt on every draw, so every location tick, demand poll or
 *   sheet change snapped the map back over the driver's own pan or zoom. Now it opens on `moverCameraRegion`, moves
 *   there once when the first position arrives, and again only when the driver taps Recentre.
 * - The demand dots: a new rounded position (about every 110 m) is a new demand key; with no data under it the dots
 *   vanished and came back. The last answer of the SAME kind of work stays while the new one is read.
 * - The board's Accept: only the row whose accept is out shows it; the others wait (one accept at a time).
 */

/** How far the camera sits SOUTH of the earner, so the location dot floats in the upper map half, clear of GO. */
export const MOVER_CAMERA_SOUTH = 0.008;
export const MOVER_CAMERA_DELTA = 0.04;

export function moverCameraRegion(latitude: number, longitude: number) {
  return {
    latitude: latitude - MOVER_CAMERA_SOUTH,
    longitude,
    latitudeDelta: MOVER_CAMERA_DELTA,
    longitudeDelta: MOVER_CAMERA_DELTA,
  };
}

/** The demand key's kind sits at index 2: ['mover', 'demand', kind, point]. */
export function keepDemandOfKind(kind: string | null) {
  return <T>(previous: T | undefined, previousQuery?: { queryKey: readonly unknown[] } | null): T | undefined =>
    previousQuery?.queryKey?.[2] === kind ? previous : undefined;
}

/**
 * One board row's Accept while an accept may be out: 'mine' (this row's accept is on its way: it shows the wait),
 * 'other' (another row's is: this one waits, disabled), 'idle'. An accept whose row cannot be told (no id) is shown
 * on every row, as before.
 */
export function acceptRowState(pending: boolean, variables: unknown, rowId: string): 'idle' | 'mine' | 'other' {
  if (!pending) return 'idle';
  const id = (variables as { id?: unknown } | null | undefined)?.id;
  if (typeof id !== 'string' || !id) return 'mine';
  return id === rowId ? 'mine' : 'other';
}
