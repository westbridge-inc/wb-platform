import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { earningsFeeDoor, feeKeepLine, feePayHandler, FEE_HELP_PARAMS, FEE_NOT_PAYABLE_IN_APP, FEE_PAY_IN_PERSON_LINK } from './earningsFee';
import type { FeeSubscription } from './weeklyFee';

// [FOLLOWUPS 11 Nov 2026 · the rider weekly-fee check] With MMG checkout off, Earnings' "Pay weekly fee" opened a
// screen with nothing to pay. The button now exists only when that screen has a way to pay (the same server answer:
// payActions); a fee owed with no way to pay in the app says so instead; and the fee card says what a rider keeps
// ("every delivery fee") apart from what a driver keeps ("every fare").

const due = (extra: Partial<FeeSubscription> = {}): FeeSubscription => ({
  status: 'PAST_DUE',
  feeStatus: { state: 'DUE', headline: 'Payment due since 4 Nov 2026', detail: 'GY$6,000 to pay.', date: null },
  ...extra,
});
const mmgLive = [{ id: 'MMG_CHECKOUT' as const, state: 'live' as const, amountGyd: 6000, currencyCode: 'GYD' as const }];
const allOff = [{ id: 'MMG_CHECKOUT' as const, state: 'off' as const }, { id: 'CARD' as const, state: 'off' as const }];

describe('[FOLLOWUPS] Earnings: "Pay weekly fee" only when there is a way to pay', () => {
  it('MMG live: the button', () => {
    expect(earningsFeeDoor(due({ payActions: mmgLive }))).toEqual({ kind: 'pay' });
  });

  it('a live card (MMG off): the button', () => {
    const card = { id: 'CARD', state: 'live', payNow: { amount: 6000, currencyCode: 'GYD' } };
    expect(earningsFeeDoor(due({ payActions: [allOff[0]!, card] as never }))).toEqual({ kind: 'pay' });
  });

  it('MMG and card off, fee owed: no button; it says it cannot be paid here, and whether in person is open', () => {
    expect(earningsFeeDoor(due({ payActions: allOff }))).toEqual({ kind: 'cannot-pay-here', inPerson: false });
    expect(earningsFeeDoor(due({ payActions: allOff, inPerson: { open: true, waitingGyd: null } }))).toEqual({ kind: 'cannot-pay-here', inPerson: true });
    expect(earningsFeeDoor({ status: 'SUSPENDED', feeStatus: { state: 'SUSPENDED', headline: 'Account suspended', detail: null, date: null }, payActions: allOff }))
      .toEqual({ kind: 'cannot-pay-here', inPerson: false });
  });

  it('the fee paused by Swift (checkout off), a trial, a paid week: no button and nothing more (the fee card says why)', () => {
    for (const state of ['FEE_PAUSED', 'TRIAL', 'PAID', 'UPCOMING', 'COVERED', 'STOPPED', 'CHECKING'] as const) {
      expect(earningsFeeDoor({ status: 'ACTIVE', feeStatus: { state, headline: 'x', detail: null, date: null }, payActions: allOff }), state)
        .toEqual({ kind: 'none' });
    }
  });

  it('an older API with no payActions: no button (never a screen with nothing to pay)', () => {
    expect(earningsFeeDoor(due())).toEqual({ kind: 'cannot-pay-here', inPerson: false });
    expect(earningsFeeDoor(null)).toEqual({ kind: 'none' });
  });
});

describe('[FOLLOWUPS] the fee card says what each kind of mover keeps', () => {
  it('a rider keeps every delivery fee; a driver every fare', () => {
    expect(feeKeepLine('RIDER')).toBe('The flat fee is Swift’s only charge — every delivery fee stays yours.');
    expect(feeKeepLine('DRIVER')).toBe('The flat fee is Swift’s only charge — every fare stays yours.');
    expect(feeKeepLine(null)).not.toContain('fare');
  });
});

describe('[FOLLOWUPS] the Earnings screen reads these', () => {
  const screen = readFileSync(new URL('../modules/mover/screens/EarningsScreen.tsx', import.meta.url), 'utf8');
  const tools = screen.slice(screen.indexOf('function EarningsTools('), screen.indexOf('export function EarningsScreen'));

  it('the fee card\'s line is the mover\'s own (no "every fare" for a rider)', () => {
    expect(screen).not.toContain('every fare stays yours.\n');
    expect(screen).toContain('{feeKeepLine(kind)}');
    expect(screen).toContain('<WeeklyFeeCard sub={subQ.data} kind={kind}');
  });

  it('the Pay button is drawn only for a way to pay; otherwise the line (and the in-person door when open)', () => {
    expect(tools).toContain('const door = earningsFeeDoor(sub);');
    expect(tools).toMatch(/\{door\.kind === 'pay' \? \(\s*<PillButton\s+label="Pay weekly fee"/);
    expect(tools).toContain('{FEE_NOT_PAYABLE_IN_APP}');
    expect(tools).toMatch(/door\.kind === 'cannot-pay-here' \? \([\s\S]*\{door\.inPerson \? <LinkText label=\{FEE_PAY_IN_PERSON_LINK\}/);
    expect(tools).toContain('label={FEE_PAY_IN_PERSON_LINK}');
    expect(FEE_NOT_PAYABLE_IN_APP).toBe('Paying the weekly fee in the app is not open right now.');
    expect(FEE_PAY_IN_PERSON_LINK).toBe('Pay Swift in person');
  });
});

describe('[REVIEW-2490 S2-1 / S4-4] the handler a fee surface may draw a pay button with', () => {
  const open = () => undefined;
  it('only for a way to pay, or the in-person door', () => {
    expect(feePayHandler(due({ payActions: mmgLive }), open)).toBe(open);
    expect(feePayHandler(due({ payActions: allOff, inPerson: { open: true, waitingGyd: null } }), open)).toBe(open);
    expect(feePayHandler(due({ payActions: allOff }), open)).toBeUndefined();
    expect(feePayHandler({ status: 'ACTIVE', feeStatus: { state: 'FEE_PAUSED', headline: 'x', detail: null, date: null }, payActions: allOff }, open)).toBeUndefined();
    expect(feePayHandler(null, open)).toBeUndefined();
  });
  it('the help door asks Swift support about a payment', () => {
    expect(FEE_HELP_PARAMS).toEqual({ category: 'PAYMENT', subject: 'I can’t pay my weekly fee in the app' });
  });
  it('the account screen draws its fee button through it too', () => {
    const account = readFileSync(new URL('../modules/mover/screens/MoverAccountScreen.tsx', import.meta.url), 'utf8');
    expect(account).toContain("<BillingStatusBlock sub={sub} onPay={feePayHandler(sub, () => navigation?.navigate?.('WeeklyFee'))} compact />");
  });
});

