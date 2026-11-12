import { timelineRows } from './store-handover-log';

/**
 * [O-2 · REVIEW-F S3-2 on #2055] The position evidence the server appends to a mover's step note
 * (" — gps:…", " — no GPS fix on file", the stale/not-geocoded variants all start with one of the
 * two). It is the rider's position, kept for support and appeals; the customer's timeline never
 * shows it.
 * [REVIEW-G2 S4-1 on #2080] Custody relay handoff notes written before they used gpsEvidence carry
 * " — GPS 6.80000,-58.15000": cut too (a GPS followed by a number, never the word in a sentence).
 */
const POSITION_EVIDENCE_SUFFIX = / — (?:gps:-?\d|GPS -?\d|no GPS fix on file)[\s\S]*$/;

/** [REVIEW-F S4-2 on #2055] A step note as a customer or passenger reads it: the position evidence cut. */
export function withoutPositionEvidence(note: string | null): string | null {
  return note ? note.replace(POSITION_EVIDENCE_SUFFIX, '') : note;
}

/** The customer's view of the order's status log (rows oldest first):
 *  - [FOLLOWUPS 11 Nov 2026 · REVIEW-2490] the timeline rule (store-handover-log timelineRows): the store's
 *    "Handed to rider" row is left out; its kitchen taps made after a rider took the order read as the
 *    kitchen step they were ("Preparing" / "Ready"); any other row at a rider's pre-pickup status that
 *    did not change the status (a substitution, a courier's cash) is not a second step;
 *  - a step's position evidence is cut from its note;
 *  - [owner 8 Nov 2026] `noteOf` decides which notes the customer may read at all
 *    (customer-cancellation.ts customerStepNote: never Swift support's, and the
 *    CANCELLED step says only the customer's words for the close). */
export function customerTimeline<Row extends { status: string; note: string | null; createdAt: Date }>(
  rows: ReadonlyArray<Row>,
  noteOf: (row: Row) => string | null = (row) => row.note,
): Array<{ status: string; note: string | null; timestamp: Date }> {
  return timelineRows(rows)
    .map((row) => ({ status: row.status, note: withoutPositionEvidence(noteOf(row)), timestamp: row.createdAt }));
}
