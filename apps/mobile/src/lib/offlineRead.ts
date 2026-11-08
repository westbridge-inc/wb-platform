// ---------------------------------------------------------------------------
// [APP-SPEED D · review S3] A first read asked while the phone is offline does
// not fail: React Query PAUSES it (fetchStatus 'paused') until the connection
// is back. It is then neither loading (isLoading needs a read in flight) nor an
// error, so a door that branched on those drew its "nothing here" state
// ("Nothing saved yet", "No activity yet") as if the server had said so, or a
// skeleton that never ended. A paused first read is the offline state, said as
// such, with Try again.
// ---------------------------------------------------------------------------

/** The words every door shows for a first read the phone could not send. */
export const OFFLINE_FIRST_READ_MESSAGE = 'You’re offline. Connect, then try again.';

/** A read with nothing to show yet that is waiting for a connection. */
export function offlineFirstRead(query: { fetchStatus: string; data: unknown }): boolean {
  return query.fetchStatus === 'paused' && query.data === undefined;
}
