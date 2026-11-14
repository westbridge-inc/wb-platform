// ---------------------------------------------------------------------------
// [STORE-BOARD · parity audit A2 + A3, owner 14 Nov 2026] On a tablet the store board is lanes side by side, as on
// the website (apps/web lib/order-buckets.ts): New, Preparing, Ready / handoff, Out for delivery. A phone keeps the
// one list. Every open order lands in exactly one lane: a status this build does not know goes to Preparing (still
// the store's work), never nowhere. Pure: no React Native imports.
// ---------------------------------------------------------------------------

export type BoardLane = 'new' | 'kitchen' | 'handoff' | 'moving';

export const BOARD_LANES: ReadonlyArray<{ key: BoardLane; label: string; hint: string }> = [
  { key: 'new', label: 'New', hint: 'Waiting for a decision' },
  { key: 'kitchen', label: 'Preparing', hint: 'In progress' },
  { key: 'handoff', label: 'Ready / handoff', hint: 'Ready, or a rider is on the way' },
  { key: 'moving', label: 'Out for delivery', hint: 'With the rider' },
];

/** The website's lanes, status by status (apps/web lib/order-buckets.ts STATUS_BUCKET, open statuses). */
const LANE_OF: Readonly<Record<string, BoardLane>> = {
  PENDING: 'new',
  PLACED: 'new',
  ACCEPTED: 'kitchen',
  PREPARING: 'kitchen',
  READY_FOR_PICKUP: 'handoff',
  RIDER_ASSIGNED: 'handoff',
  RIDER_EN_ROUTE_PICKUP: 'handoff',
  RIDER_ARRIVED_PICKUP: 'handoff',
  PICKED_UP: 'moving',
  EN_ROUTE_DELIVERY: 'moving',
  ARRIVED: 'moving',
  RETURNING: 'moving',
  DRIVER_ASSIGNED: 'moving',
  DRIVER_EN_ROUTE: 'moving',
  DRIVER_ARRIVED: 'moving',
  RIDE_IN_PROGRESS: 'moving',
};

export function laneOf(status: string | null | undefined): BoardLane {
  return LANE_OF[(status ?? '').toUpperCase()] ?? 'kitchen';
}

/** Every order in exactly one lane, each lane keeping the board's own order. */
export function boardLanes<T extends { status?: string | null }>(orders: readonly T[]): Record<BoardLane, T[]> {
  const lanes: Record<BoardLane, T[]> = { new: [], kitchen: [], handoff: [], moving: [] };
  for (const o of orders) lanes[laneOf(o.status)].push(o);
  return lanes;
}

/** The width from which the board draws lanes side by side (the website's lane width, 760). */
export const LANES_MIN_WIDTH = 760;

/** How many lanes a row: 4 from 1000 wide, 2 from 760 (a tablet in portrait), else 1 (a phone: the one list). */
export function laneColumns(width: number): 1 | 2 | 4 {
  if (!Number.isFinite(width) || width < LANES_MIN_WIDTH) return 1;
  return width >= 1000 ? 4 : 2;
}
