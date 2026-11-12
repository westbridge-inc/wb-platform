import { describe, expect, it } from 'vitest';
import {
  CARD_SALE_WITHIN_MS, SETTLED_CERTAIN_BUSINESS_DAYS, cardSaleLatestAt, isGuyanaBusinessDay, isGuyanaPublicHoliday, reversalKindByAge, settledCertainAt,
} from '../modules/billing/card-settlement';
import { reversalPlanOf } from '../modules/billing/card-rail.service';

// [LEGAL-CARDS 12 Nov 2026 · VOID-REFUND-CHECK §3] PowerTranz: VOID before the bank settles a sale, REFUND after (the bank
// settles, typically in 2-3 business days). Swift's conservative time rule: certainly settled from the start of the
// Guyana day after the 4th business day following the sale's Guyana day.

/** A Guyana wall-clock time (UTC-4, no DST) as an instant. */
const gy = (iso: string) => new Date(`${iso}-04:00`);

describe('[VOID-REFUND-CHECK §3] settledCertainAt: 4 Guyana business days after the sale\'s day, counted in America/Guyana', () => {
  it('is 4 business days, the sale\'s own day not counted', () => {
    expect(SETTLED_CERTAIN_BUSINESS_DAYS).toBe(4);
    // Monday 16 Nov 2026, 10:00 -> Tue, Wed, Thu, Fri -> Saturday 21 Nov 00:00 Guyana time.
    expect(settledCertainAt(gy('2026-11-16T10:00:00')).toISOString()).toBe('2026-11-21T04:00:00.000Z');
  });

  it('skips Saturday and Sunday', () => {
    // Thursday 19 Nov -> Fri 20, (Sat, Sun), Mon 23, Tue 24, Wed 25 -> Thursday 26 Nov 00:00.
    expect(settledCertainAt(gy('2026-11-19T09:00:00')).toISOString()).toBe('2026-11-26T04:00:00.000Z');
  });

  it('counts the sale\'s day in Guyana, not in UTC: 23:30 on a Friday in Guyana is already Saturday in UTC', () => {
    const lateFriday = gy('2026-11-13T23:30:00');
    expect(lateFriday.toISOString()).toBe('2026-11-14T03:30:00.000Z');
    // Friday 13 -> Mon 16, Tue 17, Wed 18, Thu 19 -> Friday 20 Nov 00:00 Guyana time.
    expect(settledCertainAt(lateFriday).toISOString()).toBe('2026-11-20T04:00:00.000Z');
  });

  it('skips Guyana public holidays (Christmas, Boxing Day kept on the Monday; Good Friday and Easter Monday; Phagwah)', () => {
    // Wed 23 Dec 2026 -> Thu 24 (1), Fri 25 Christmas, Sat 26 Boxing Day (kept Mon 28), Tue 29 (2), Wed 30 (3), Thu 31 (4).
    expect(settledCertainAt(gy('2026-12-23T12:00:00')).toISOString()).toBe('2027-01-01T04:00:00.000Z');
    // Thu 25 Mar 2027 -> Fri 26 Good Friday, Mon 29 Easter Monday, Tue 30, Wed 31, Thu 1 Apr, Fri 2 Apr -> Sat 3 Apr.
    expect(settledCertainAt(gy('2027-03-25T12:00:00')).toISOString()).toBe('2027-04-03T04:00:00.000Z');
    for (const day of ['2026-01-01', '2026-02-23', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-05', '2026-05-26', '2026-07-06', '2026-12-25', '2026-12-28', '2026-03-04', '2026-11-09']) {
      expect(isGuyanaPublicHoliday(day), day).toBe(true);
      expect(isGuyanaBusinessDay(day), day).toBe(false);
    }
    expect(isGuyanaBusinessDay('2026-11-12')).toBe(true);
    expect(isGuyanaBusinessDay('2026-11-14')).toBe(false); // Saturday
  });

  it('anchors a hosted Pay now\'s sale at the LATEST it can have been made (its session + 30 minutes): a later anchor only keeps the void', () => {
    expect(CARD_SALE_WITHIN_MS).toBe(30 * 60_000);
    const createdAt = gy('2026-11-16T23:45:00');
    expect(cardSaleLatestAt({ createdAt }).toISOString()).toBe('2026-11-17T04:15:00.000Z'); // Tuesday 00:15 in Guyana
    const certain = settledCertainAt(cardSaleLatestAt({ createdAt }));
    expect(certain.toISOString()).toBe('2026-11-24T04:00:00.000Z'); // Tue 17 -> Wed, Thu, Fri, Mon -> Tuesday 24 Nov
    expect(reversalKindByAge({ createdAt }, new Date(certain.getTime() - 1))).toBe('VOID');
    expect(reversalKindByAge({ createdAt }, certain)).toBe('REFUND');
  });
});

describe('[VOID-REFUND-CHECK F1/F3] reversalPlanOf: what finance\'s REFUND decision sends for a HELD Pay now', () => {
  const createdAt = gy('2026-11-16T10:00:00');
  const young = gy('2026-11-17T10:00:00');
  const old = gy('2026-11-30T10:00:00');
  const base = { createdAt, providerVoidState: null, providerRefundState: null, providerReversalKind: null, reversalCheck: null, reversalRetryAt: null };

  it('none sent yet: a VOID while the sale may be unsettled, a REFUND once certainly settled', () => {
    expect(reversalPlanOf(base, young, true)).toEqual({ kind: 'VOID', retry: false });
    expect(reversalPlanOf(base, old, true)).toEqual({ kind: 'REFUND', retry: false });
    // A provider with no void (the simulator) is only refunded.
    expect(reversalPlanOf(base, young, false)).toEqual({ kind: 'REFUND', retry: false });
    // Swift's own void of it was already refused: never a second void, whatever its age.
    expect(reversalPlanOf({ ...base, providerVoidState: 'FAILED' }, young, true)).toEqual({ kind: 'REFUND', retry: false });
    // [F6] ... or sent with no answer (resolveHeld lets it through only after a check shows the sale standing).
    expect(reversalPlanOf({ ...base, providerVoidState: 'UNKNOWN' }, young, true)).toEqual({ kind: 'REFUND', retry: false });
  });

  it('a REFUSED reversal: nothing until a check shows the sale standing; then ONE more, of the other kind; never a third', () => {
    const refusedVoid = { ...base, providerRefundState: 'FAILED', providerReversalKind: 'VOID' };
    expect(reversalPlanOf(refusedVoid, young, true)).toMatchObject({ refusal: { code: 'REVERSAL_CHECK_REQUIRED' } });
    expect(reversalPlanOf({ ...refusedVoid, reversalCheck: 'NOT_TAKEN' }, young, true)).toMatchObject({ refusal: { code: 'REVERSAL_CHECK_REQUIRED' } });
    expect(reversalPlanOf({ ...refusedVoid, reversalCheck: 'SALE_STANDS' }, young, true)).toEqual({ kind: 'REFUND', retry: true });
    const refusedRefund = { ...base, providerRefundState: 'FAILED', providerReversalKind: 'REFUND', reversalCheck: 'SALE_STANDS' };
    expect(reversalPlanOf(refusedRefund, old, true)).toEqual({ kind: 'VOID', retry: true });
    // A refund sent before kinds were recorded (null) was a refund.
    expect(reversalPlanOf({ ...refusedRefund, providerReversalKind: null }, old, true)).toEqual({ kind: 'VOID', retry: true });
    // Both kinds already refused (Swift's own void, then finance's refund): nothing more.
    expect(reversalPlanOf({ ...refusedRefund, providerVoidState: 'FAILED' }, old, true)).toMatchObject({ refusal: { code: 'REVERSAL_ALREADY_RETRIED' } });
    expect(reversalPlanOf({ ...refusedVoid, reversalCheck: 'SALE_STANDS', reversalRetryAt: young }, old, true)).toMatchObject({ refusal: { code: 'REVERSAL_ALREADY_RETRIED' } });
  });

  it('a reversal sent, pending, unknown or done: nothing more', () => {
    for (const state of ['SENDING', 'PENDING', 'UNKNOWN', 'REFUNDED']) {
      expect(reversalPlanOf({ ...base, providerRefundState: state }, old, true), state).toMatchObject({ refusal: { code: 'REFUND_ALREADY_SENT' } });
    }
  });
});
