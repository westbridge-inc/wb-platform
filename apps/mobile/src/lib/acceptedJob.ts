// ---------------------------------------------------------------------------
// [APP-SPEED 6 · 7 Nov 2026] A driver or rider lands on the right screen at the server's answer.
//
// Accept: the job screen opens at the accept's yes, carrying the accepted order id and the moment of the answer.
// Until a read of the active job made after that moment lands, the screen shows the job loading, never
// "No active job" (the cached read from before the accept still says there is none).
//
// Completion: a step whose own answer says the job is over leaves the job screen at the answer (the driver's
// rating opens at once); hooks/mover takes the job off the active read and re-reads in the background.
// ---------------------------------------------------------------------------
import { rideIsOver } from './rideAfterTrip';

export type AcceptedJobParams = { acceptedOrderId: string; acceptedAt: number };

/** The ActiveJob route params for a job the server just gave this mover. */
export function acceptedJobParams(orderId: string, now: number = Date.now()): AcceptedJobParams {
  return { acceptedOrderId: orderId, acceptedAt: now };
}

/**
 * Where the job screen stands with a just-accepted job, until a read made AFTER the accept lands:
 * - 'waiting': no such read yet (it is on its way, or retrying): the job is loading. An answer older than the accept
 *   is never the job's absence, so a just-accepted job is never "No active job" ([BUG-GUARDS C3]).
 * - 'failed': the read after the accept failed (every retry spent): say so, with Try again; the screen still never
 *   says "No active job". It stays 'failed' while a poll or Try again is on its way (no spinner/error flicker).
 *   An older failure (from before the accept) with a read on its way is 'waiting'.
 * - 'answered': a read made after the accept landed (with the job, or without it if the server already took it
 *   away), or the screen was not opened by an accept: the screen shows what the read says.
 */
export type AcceptedJobState = 'waiting' | 'failed' | 'answered';
export function acceptedJobState(
  params: { acceptedAt?: unknown } | null | undefined,
  read: { isFetching: boolean; isError: boolean; dataUpdatedAt: number; errorUpdatedAt?: number },
): AcceptedJobState {
  const at = params?.acceptedAt;
  if (typeof at !== 'number' || !Number.isFinite(at) || read.dataUpdatedAt >= at) return 'answered';
  if (!read.isError) return 'waiting';
  return !read.isFetching || (read.errorUpdatedAt ?? 0) >= at ? 'failed' : 'waiting';
}

/** Does a step's own answer say the job is over (delivered, completed, failed, cancelled, returned...)? */
export function jobAnswerIsOver(answer: unknown): boolean {
  const status = (answer as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'string' && rideIsOver(status);
}
