import type { CardSession, Prisma, PrismaClient } from '@prisma/client';
import { z } from '../../lib/zod';
import type { OnAudit } from '../../lib/audit-writer';
import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { toProviderMinor } from '../../utils/currency-amount';
import { cardTestSubscriptions } from '../../utils/card-rail';
import { bindingOf, rawDigest, sameBinding, type CardRailSource, type CardRefundOutcome } from '../../providers/card/card-provider';
import {
  CARD_REFUND_ACTION, PAID_KEY, REFUND_AMOUNT, REFUND_SET_ASIDE_ID, assertPayoutPairRule, audit, cents, creditRefundState,
  lockCreditRefundAsks, lockPayer, namedOpenSetAside, openCreditRefunds, openSetAsideIds, recordPayoutPartInTx, refuseInboundReference,
  stillToPayCents, type CreditRefundState,
} from './credit-refund';

// ---------------------------------------------------------------------------
// [CARD-READY · REVIEW-2 F1/F2 · REVIEW-1 R1-1] Weekly-fee money a partner paid ahead by card goes back to the SAME
// card ("to the account you paid from", partner agreements s2) through the card provider's DOCUMENTED refund, never a
// refund typed by hand:
//
//   PowerTranz Ecommerce API Guide v2.7: sec. 3 "Refund — Refund a previously authorized transaction — POST
//   <API Root>/api/refund"; sec. 5.2 TransactionIdentifier "of the Original Transaction ... to be captured/refunded or
//   voided", TotalAmount "Required for Capture and Refund", Refund "Mandatory for refunds: Set to true"; sec. 7.5 the
//   request and its answer (TransactionType 5, its own TransactionIdentifier, OriginalTrxnIdentifier).
//
// What the guide does NOT say, so Swift does not do it:
//   - that a refund may be smaller than the payment. Sec. 5.2 says "partial voids are not supported. Only partial
//     captures are supported." So a card payment is refunded WHOLE or not at all: only a card payment whose whole
//     amount sits unused in the refund set aside at closing (fee-receipt allocations say which payment's money it is)
//     can go back to its card. Part of one that already paid a week cannot: the owner decides how that part is paid
//     back (an open question for PowerTranz, CARD-CHECKOUT-API.md section 11);
//   - a refund made by hand in the merchant portal (the guide names the portal only for page names, sec. 5.1, and
//     order references in reports, sec. 9.2): nothing here records one;
//   - a way to look a lost refund answer up. PowerTranz's written answer to Swift (4 Nov 2026) gives a transaction
//     lookup (GET /api/Transactions/{id}) for unknown outcomes, but not yet whether it shows a refund and its own
//     reference (asked of PowerTranz). Until then a refund whose answer is lost is never sent again; it is held for a
//     person.
//
// The law, in order:
//   1. A person asks, with a reason; a second admin approves (C4); the asker of the set-aside never approves it.
//   2. Under the payer lock: the set-aside is open, this card payment's whole amount is in it, nothing is refunded for
//      this payment yet, and it fits what is still to pay back. The claim (SENDING) is written BEFORE the one call.
//   3. ONE refund call, keyed by the claim. Only the provider's approved answer for THIS transaction, type and amount
//      (the driver checks all three) records the money as paid back: a CARD payout part under the refund's own
//      reference (into the reference census), REFUND_PAYABLE -> CLEARING_CARD. A refusal moves nothing (FAILED).
//      Anything else (no answer, pending, an answer without its own reference) is UNKNOWN / PENDING: the money may
//      be on its way, so the set-aside can never be released, and a person settles it with PowerTranz.
// ---------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;

export const CARD_REFUND_BODY = z.object({
  setAsideId: REFUND_SET_ASIDE_ID,
  cardSessionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Name the card payment to refund.'),
  amount: REFUND_AMOUNT,
}).strict();

export type CardRefundState = 'SENDING' | 'REFUNDED' | 'FAILED' | 'UNKNOWN' | 'PENDING';
/** The order reference Swift sent the provider for a card payment (powertranz-provider.ts OrderIdentifier). Guide
 *  sec. 9.2: "one of the values used in the Merchant Portal and reports". */
export const orderReferenceOf = (cardSessionId: string) => `SWIFT-${cardSessionId}`;

/** Where receipts say this money came from. */
export type CreditRail = 'CARD' | 'MMG' | 'IN_PERSON' | 'OTHER';
export function railOfChannel(channel: string | null): CreditRail {
  if (!channel) return 'OTHER';
  if (channel.startsWith('CARD')) return 'CARD';
  if (channel.startsWith('IN_PERSON')) return 'IN_PERSON';
  if (channel.includes('MMG')) return 'MMG';
  return 'OTHER';
}

function refuse(code: string, message: string): never {
  throw new AppError(409, code, message);
}

const NOTHING_SET_ASIDE = 'No refund is set aside for this account. Set the credit aside first; refund the card only after that.';
const CYCLE_CHANGED = 'The refund this names is no longer the one set aside (it was paid or returned since). Nothing was sent.';

/** The card payment, the receipt its money came in on, and how much of it is in this set-aside. */
async function cardPaymentInSetAside(tx: Tx, subscriptionId: string, setAsideId: string, cardSessionId: string) {
  const session = await tx.cardSession.findUnique({ where: { id: cardSessionId } });
  if (!session || session.subscriptionId !== subscriptionId || session.purpose !== 'PAY_NOW') {
    refuse('CARD_PAYMENT_NOT_FOUND', 'That is not a card payment of this account.');
  }
  if (session.status !== 'SUCCEEDED' || !session.paymentId || session.amount === null || !session.currencyCode) {
    refuse('CARD_PAYMENT_NOT_REFUNDABLE', 'Only a card payment the card provider confirmed can be refunded to its card.');
  }
  // The ORIGINAL transaction (guide sec. 5.2) is the one the provider's own answer named when Swift took the money.
  const payment = await tx.subscriptionPayment.findUnique({ where: { id: session.paymentId }, select: { status: true, externalRef: true, paymentMethod: true } });
  const original = payment?.status === 'CAPTURED' && payment.paymentMethod === 'CARD' ? payment.externalRef?.trim() ?? '' : '';
  if (!original || (session.providerTransactionRef && session.providerTransactionRef.trim().toLowerCase() !== original.toLowerCase())) {
    refuse('CARD_PAYMENT_NOT_REFUNDABLE', 'Swift cannot name this card payment\'s original transaction with certainty. Nothing was sent: escalate to the owner.');
  }
  // A TEST card system moved no real money: nothing goes back to a card for it.
  if (session.environment !== 'live' && !cardTestSubscriptions().has(subscriptionId)) {
    refuse('TEST_SYSTEM_NEVER_REFUNDS', 'This payment was on a test card system and moved no real money: nothing is refunded to a card.');
  }
  const kept = await tx.billingEvent.findUnique({ where: { idempotencyKey: `bank:${session.paymentId}` }, select: { id: true } });
  if (!kept) {
    refuse('CARD_PAYMENT_PAID_A_WEEK', 'This card payment paid a week that had started: a week that has started is not refunded.');
  }
  const receipt = await tx.feeReceipt.findUnique({ where: { billingEventId: kept.id }, select: { id: true, weeksTracked: true } });
  const inSetAside = receipt?.weeksTracked
    ? (await tx.feeReceiptAllocation.findMany({ where: { receiptId: receipt.id, kind: 'REFUND_SET_ASIDE', billingEventId: setAsideId }, select: { amount: true } }))
      .reduce((sum, row) => sum + cents(row.amount), 0)
    : 0;
  return { session: session as CardSession & { paymentId: string; currencyCode: string }, original, inSetAside };
}

/** Everything that must hold for this card payment to go back to its card now, read under the payer lock. */
async function eligibleInTx(tx: Tx, subscriptionId: string, setAsideId: string, cardSessionId: string, amount: number) {
  const open = await namedOpenSetAside(tx, subscriptionId, setAsideId, NOTHING_SET_ASIDE, CYCLE_CHANGED);
  const { session, original, inSetAside } = await cardPaymentInSetAside(tx, subscriptionId, open.opened.id, cardSessionId);
  const whole = cents(session.amount);
  if (session.currencyCode !== open.currencyCode) refuse('CARD_REFUND_CURRENCY', 'This card payment is in another currency than the refund set aside.');
  const prior = await tx.cardCreditRefund.findUnique({ where: { cardSessionId }, select: { state: true } });
  if (prior) refuse('CARD_REFUND_EXISTS', `A refund of this card payment was already asked (${prior.state === 'REFUNDED' ? 'refunded' : prior.state === 'FAILED' ? 'the card provider refused it' : 'its answer is not confirmed'}). It is never sent twice.`);
  if (inSetAside !== whole) {
    refuse('CARD_PAYMENT_PARTLY_USED', `Only ${inSetAside / 100} of this ${whole / 100} ${session.currencyCode} card payment is in the refund set aside: the rest already paid weekly fees. The card provider's guide documents no refund smaller than the payment, so Swift refunds a card payment only whole. Ask the owner how to pay this part back. Nothing was sent.`);
  }
  if (cents(amount) !== whole) refuse('CARD_REFUND_WHOLE_PAYMENT', `A card payment is refunded whole: ${whole / 100} ${session.currencyCode}.`);
  if (whole > await stillToPayCents(tx, open)) refuse('REFUND_AMOUNT_MISMATCH', 'This is more than is still to pay back on this refund. Nothing was sent.');
  return { open, session, original };
}

/** [Review S2-1 pattern] Checked when it is ASKED, before the approval gate writes the request, under the refund's
 *  ask lock: an ask that could never be sent never becomes a "refund asked" marker. */
export async function validateCardRefundAsk(tx: Tx, subscriptionId: string, body: unknown): Promise<void> {
  const parsed = CARD_REFUND_BODY.safeParse(body);
  if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'The refund to the card is not complete.');
  await eligibleInTx(tx, subscriptionId, parsed.data.setAsideId, parsed.data.cardSessionId, parsed.data.amount);
}

export interface CardRefundAnswer extends CreditRefundState {
  state: CardRefundState;
  amount: number;
  /** The refund's own transaction reference, once the provider approved it. */
  providerRefundRef: string | null;
  replayed: boolean;
}

/**
 * The approved ask, applied: ONE refund of the whole card payment through the provider, recorded only on its own
 * approved answer. `approvalId` names the step: applying it again answers what happened, and never sends again.
 */
export async function refundCardCreditToCard(prisma: PrismaClient, rail: CardRailSource, input: {
  adminId: string; approvalId: string; subscriptionId: string; setAsideId: string; cardSessionId: string; amount: number;
  onAudit?: OnAudit; now?: Date;
}): Promise<CardRefundAnswer> {
  if (!input.approvalId) throw new AppError(403, 'APPROVAL_REQUIRED', 'A refund to the card needs a second admin.');
  const answer = async (row: { state: string; amount: unknown; providerRefundRef: string | null }, replayed: boolean): Promise<CardRefundAnswer> => ({
    state: row.state as CardRefundState, amount: Number(row.amount), providerRefundRef: row.providerRefundRef, replayed,
    ...(await creditRefundState(prisma, input.subscriptionId)),
  });
  const replay = await prisma.cardCreditRefund.findUnique({ where: { approvalId: input.approvalId } });
  if (replay) return answer(replay, true);
  const provider = rail();

  // 1-2. The claim, under the payer lock, written before the call.
  const claimed = await prisma.$transaction(async (tx) => {
    await lockPayer(tx, input.subscriptionId);
    await lockCreditRefundAsks(tx, input.subscriptionId);
    const again = await tx.cardCreditRefund.findUnique({ where: { approvalId: input.approvalId } });
    if (again) return { replay: again };
    const { open, session, original } = await eligibleInTx(tx, input.subscriptionId, input.setAsideId, input.cardSessionId, input.amount);
    // Swift refunds only through the provider setup that took the money (guide sec. 4: the merchant's own credentials).
    if (!sameBinding(bindingOf(session), provider.binding)) {
      refuse('CARD_PROVIDER_SETUP_CHANGED', 'This card payment was taken through another card provider setup, and Swift refunds only through the setup that took it. Nothing was sent: escalate to the owner.');
    }
    await assertPayoutPairRule(tx, open.opened, input.approvalId);
    const row = await tx.cardCreditRefund.create({ data: {
      tenantId: session.tenantId, subscriptionId: input.subscriptionId, cardSessionId: session.id, setAsideId: open.opened.id,
      amount: session.amount!, currencyCode: session.currencyCode, requestedByUserId: input.adminId, approvalId: input.approvalId,
    } });
    await audit(tx, input, { step: 'CARD_REFUND_SENDING', amount: Number(row.amount), currencyCode: row.currencyCode, cardSessionId: session.id, orderReference: orderReferenceOf(session.id), providerTransactionRef: original, cardRefundId: row.id });
    return { row, session, original };
  });
  if ('replay' in claimed) return answer(claimed.replay!, true);
  const { row, session, original } = claimed;

  // 3. ONE call. Its key is the claim: the driver never sends a second refund for it.
  const outcome: CardRefundOutcome = await provider.refund({
    binding: provider.binding,
    providerRef: original,
    amountMinor: toProviderMinor(Number(row.amount), row.currencyCode, 'card.v2.credit-refund'),
    currencyCode: row.currencyCode,
    idempotencyKey: `card-credit-refund:${row.id}`,
  }).catch((): CardRefundOutcome => ({ status: 'unknown', reason: 'REFUND_CALL_FAILED', rawSha256: rawDigest({ refund: 'threw' }) }));

  const now = input.now ?? new Date();
  const done = await prisma.$transaction(async (tx) => {
    await lockPayer(tx, input.subscriptionId);
    await tx.$queryRaw`SELECT "id" FROM "card_credit_refunds" WHERE "id" = ${row.id} FOR UPDATE`;
    const fresh = await tx.cardCreditRefund.findUniqueOrThrow({ where: { id: row.id } });
    if (fresh.state !== 'SENDING') return fresh;
    const own = outcome.status === 'succeeded' ? outcome.providerRef.trim().toUpperCase() : '';
    if (outcome.status === 'succeeded' && own && own !== original.toUpperCase() && !await refusedReference(tx, own)) {
      const event = await recordPayoutPartInTx(tx, {
        subscriptionId: input.subscriptionId, amount: Number(row.amount), currencyCode: row.currencyCode, method: 'CARD', reference: own,
        eventKey: `${PAID_KEY}${own}`,
        note: `Set-aside fee credit refunded to the card that paid it: the card provider approved refund ${own} of order ${orderReferenceOf(session.id)} (asked by ${input.adminId})`,
      });
      const refunded = await tx.cardCreditRefund.update({ where: { id: row.id }, data: { state: 'REFUNDED', providerRefundRef: own, billingEventId: event.id, answeredAt: now, answerSha256: outcome.rawSha256 } });
      await audit(tx, input, { step: 'CARD_REFUNDED', amount: Number(row.amount), currencyCode: row.currencyCode, cardSessionId: session.id, reference: own, billingEventId: event.id, cardRefundId: row.id });
      return refunded;
    }
    const state: CardRefundState = outcome.status === 'failed' ? 'FAILED' : outcome.status === 'pending' ? 'PENDING' : 'UNKNOWN';
    const reason = outcome.status === 'failed' || outcome.status === 'unknown' ? outcome.reason
      : outcome.status === 'pending' ? 'REFUND_PENDING' : 'REFUND_ANSWER_WITHOUT_ITS_OWN_REFERENCE';
    const closed = await tx.cardCreditRefund.update({ where: { id: row.id }, data: { state, outcomeReason: reason.slice(0, 200), answeredAt: now, answerSha256: outcome.rawSha256 } });
    await audit(tx, input, { step: `CARD_REFUND_${state}`, amount: Number(row.amount), currencyCode: row.currencyCode, cardSessionId: session.id, outcomeReason: reason, cardRefundId: row.id });
    return closed;
  });
  if (done.state !== 'REFUNDED' && done.state !== 'FAILED') {
    log().error({ cardRefundId: row.id, state: done.state }, '[CARD-READY] a refund to the card is not confirmed: held for a person, never sent again');
  }
  return answer(done, false);
}

/** The refund's own reference must be new to Swift: one already on record is never this refund's proof. */
async function refusedReference(tx: Tx, reference: string): Promise<boolean> {
  try {
    await refuseInboundReference(tx, reference);
    return false;
  } catch {
    return true;
  }
}

export interface CreditSourceView {
  /** The open set-aside, or null. */
  setAside: { id: string; amount: number; stillToPay: number; currencyCode: string } | null;
  /** Where the money in the set-aside (or, with none, the unused credit) came from, by how it was paid. */
  byRail: Array<{ rail: CreditRail | 'NOT_RECORDED'; amount: number }>;
  /** The card payments whose money is in the set-aside, and whether each can go back to its card now. */
  cardPayments: Array<{
    cardSessionId: string; orderReference: string; providerTransactionRef: string | null; amount: number; currencyCode: string;
    inSetAside: number; paidAt: Date | null;
    refund: { state: CardRefundState; providerRefundRef: string | null } | null;
    refundable: boolean;
  }>;
}

/** What the console shows beside a refund: how the money was paid, and the card payments that can go back to a card. */
export async function creditRefundSources(db: PrismaClient | Tx, subscriptionId: string): Promise<CreditSourceView> {
  const [openMap, idMap] = await Promise.all([openCreditRefunds(db, [subscriptionId]), openSetAsideIds(db, [subscriptionId])]);
  const setAsideId = idMap.get(subscriptionId) ?? null;
  const openAmount = openMap.get(subscriptionId) ?? 0;
  if (!setAsideId) return { setAside: null, byRail: [], cardPayments: [] };
  const opened = await db.billingEvent.findUniqueOrThrow({ where: { id: setAsideId }, select: { currencyCode: true } });
  const inFlight = await db.cardCreditRefund.findMany({ where: { setAsideId, state: { in: ['SENDING', 'PENDING', 'UNKNOWN'] } }, select: { amount: true } });
  const stillToPay = (cents(openAmount) - inFlight.reduce((sum, r) => sum + cents(r.amount), 0)) / 100;
  const allocations = await db.feeReceiptAllocation.findMany({
    where: { billingEventId: setAsideId, kind: 'REFUND_SET_ASIDE' },
    select: { amount: true, receipt: { select: { channel: true, billingEventId: true } } },
  });
  const setAsideEvent = await db.billingEvent.findUniqueOrThrow({ where: { id: setAsideId }, select: { amount: true } });
  const byRailCents = new Map<CreditRail | 'NOT_RECORDED', number>();
  let tracked = 0;
  for (const a of allocations) {
    const rail = railOfChannel(a.receipt.channel);
    byRailCents.set(rail, (byRailCents.get(rail) ?? 0) + cents(a.amount));
    tracked += cents(a.amount);
  }
  if (cents(setAsideEvent.amount) > tracked) byRailCents.set('NOT_RECORDED', cents(setAsideEvent.amount) - tracked);
  const cardEvents = allocations.filter((a) => railOfChannel(a.receipt.channel) === 'CARD').map((a) => a.receipt.billingEventId);
  const bankKeys = cardEvents.length
    ? (await db.billingEvent.findMany({ where: { id: { in: cardEvents } }, select: { id: true, idempotencyKey: true } }))
    : [];
  const paymentIds = bankKeys.map((e) => e.idempotencyKey).filter((k) => k.startsWith('bank:')).map((k) => k.slice('bank:'.length));
  const sessions = paymentIds.length
    ? await db.cardSession.findMany({ where: { paymentId: { in: paymentIds }, subscriptionId }, orderBy: { createdAt: 'asc' } })
    : [];
  const originals = sessions.length
    ? new Map<string, string | null>((await db.subscriptionPayment.findMany({ where: { id: { in: sessions.map((s) => s.paymentId!).filter(Boolean) } }, select: { id: true, externalRef: true } })).map((r) => [r.id, r.externalRef]))
    : new Map<string, string | null>();
  const refunds = sessions.length
    ? await db.cardCreditRefund.findMany({ where: { cardSessionId: { in: sessions.map((s) => s.id) } }, select: { cardSessionId: true, state: true, providerRefundRef: true } })
    : [];
  const inSetAsideOf = new Map<string, number>();
  for (const a of allocations) {
    const key = bankKeys.find((e) => e.id === a.receipt.billingEventId)?.idempotencyKey;
    if (key?.startsWith('bank:')) inSetAsideOf.set(key.slice(5), (inSetAsideOf.get(key.slice(5)) ?? 0) + cents(a.amount));
  }
  return {
    setAside: { id: setAsideId, amount: openAmount, stillToPay, currencyCode: opened.currencyCode },
    byRail: [...byRailCents.entries()].map(([rail, c]) => ({ rail, amount: c / 100 })),
    cardPayments: sessions.map((s) => {
      const refund = refunds.find((r) => r.cardSessionId === s.id);
      const inSetAside = inSetAsideOf.get(s.paymentId ?? '') ?? 0;
      return {
        cardSessionId: s.id, orderReference: orderReferenceOf(s.id), providerTransactionRef: originals.get(s.paymentId ?? '') ?? s.providerTransactionRef,
        amount: Number(s.amount ?? 0), currencyCode: s.currencyCode ?? opened.currencyCode, inSetAside: inSetAside / 100, paidAt: s.confirmedAt,
        refund: refund ? { state: refund.state as CardRefundState, providerRefundRef: refund.providerRefundRef } : null,
        refundable: !refund && s.status === 'SUCCEEDED' && !!originals.get(s.paymentId ?? '') && inSetAside === cents(s.amount ?? 0) && inSetAside <= cents(stillToPay),
      };
    }),
  };
}

export { CARD_REFUND_ACTION };
