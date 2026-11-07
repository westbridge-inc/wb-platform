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
 * Is the job screen still waiting for the first read made after the accept? Only while that read is on its way:
 * an answer older than the accept is not the job's absence. Once a read lands (with the job, or, if the server
 * already took it away, without) or fails, the screen shows what it says.
 */
export function awaitingAcceptedJob(
  params: { acceptedAt?: unknown } | null | undefined,
  read: { isFetching: boolean; dataUpdatedAt: number },
): boolean {
  const at = params?.acceptedAt;
  return typeof at === 'number' && Number.isFinite(at) && read.isFetching && read.dataUpdatedAt < at;
}

/** Does a step's own answer say the job is over (delivered, completed, failed, cancelled, returned...)? */
export function jobAnswerIsOver(answer: unknown): boolean {
  const status = (answer as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'string' && rideIsOver(status);
}
