import type { CardSession, Prisma, PrismaClient } from '@prisma/client';
import { z } from '../../lib/zod';
import type { OnAudit } from '../../lib/audit-writer';
import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { toProviderMinor } from '../../utils/currency-amount';
import { cardTestSubscriptions } from '../../utils/card-rail';
import { bindingOf, rawDigest, sameBinding, type CardRailSource, type CardRefundLookupOutcome, type CardRefundOutcome } from '../../providers/card/card-provider';
import { VOID_DATE_SKEW_MS } from '../../providers/card/powertranz-provider';
import { reversalKindByAge, settledCertainWords, type CardReversalKind } from './card-settlement';
import {
  CARD_REFUND_ACTION, CARD_REFUND_HELD_WHERE, LOOKUP_CREDIT_PREFIX, PAID_KEY, VOID_CREDIT_PREFIX, REFUND_AMOUNT, REFUND_SET_ASIDE_ID, assertPayoutPairRule, audit, cents, creditRefundState,
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
// [OWNER 10 Nov 2026 · PARTLY USED CARD PAYMENT] What goes back to the card is exactly that card payment's money in the
// refund set aside at closing (fee-receipt allocations say which payment's money it is): its weeks that have not
// started. All of it: the WHOLE payment. Part of it (the rest already paid a week that started): that PART, as a partial
// refund of the same original transaction — the same documented call with the part as TotalAmount. PowerTranz's docs:
// "Powertranz supports partial capture and refund ... You cannot void a transaction partially", and "Partial capture,
// partial refund and void after capture, are features that should be supported by acquiring banks" (Authorization
// Result, PowerTranz developer docs); PowerTranz also confirmed in writing (9 Nov 2026) that partial refunds work
// through its API and its Merchant Portal (the answer itself is kept with Swift's records). The owner asked PowerTranz to confirm partial refunds on Swift's account. A
// partial refund PowerTranz refuses (or does not offer) moves nothing: FAILED, exactly like any refused refund, and the
// money stays set aside, owed, for a person to pay back the existing way (a payout record, two people) — never dropped.
// None of it (all of it paid weeks that started): nothing goes back (CARD_PAYMENT_ALL_USED).
//
// What the guide does NOT say, so Swift does not do it:
//   - a partial VOID (sec. 5.2: "partial voids are not supported"): a part goes back only by refund;
//   - a refund made by hand in the merchant portal (the guide names the portal only for page names, sec. 5.1, and
//     order references in reports, sec. 9.2): nothing here records one;
//   - the refund's own reference in the transaction lookup. PowerTranz's written answers to Swift (4 and 9 Nov 2026)
//     give a transaction lookup (GET /api/Transactions/{id}) for unknown outcomes, for every transaction type, with
//     OrderSummary.TotalCreditAmount on the original transaction — but not whether it lists
//     each refund with its own TransactionIdentifier (asked). A refund whose answer is lost is never sent again: a
//     person asks Swift to check it with the card provider (checkCardCreditRefund below, two people), and only
//     EXACTLY what Swift asked back (the whole payment, or the part) credited on the provider's own record closes it.
//
// [LEGAL-CARDS 12 Nov 2026 · VOID-REFUND-CHECK F4/F5] PowerTranz's written answer: VOID a sale the bank has not yet
// settled, REFUND it once settled (settled by the acquiring bank, typically 2-3 business days); a declined transaction
// can never be refunded (Response Code 12). Swift has no settlement signal, so (card-settlement.ts):
//   - the WHOLE payment, younger than SETTLED_CERTAIN: one VOID (kind VOID), recorded as the payout part under the
//     void's own transaction, or VOID-<original> when the void's answer names only the original (guide sec. 7.6 sample);
//   - PART of a payment younger than SETTLED_CERTAIN: refused when it is ASKED (CARD_REFUND_NOT_SETTLED_YET, with the
//     date it can be sent from): partial voids do not exist (sec. 5.2) and a refund waits for settlement. Nothing is
//     sent, nothing is claimed; the money stays set aside, owed;
//   - older: a REFUND, as before.
// A reversal the provider REFUSES moved nothing, yet its money is never paid back another way until a person checks
// the payment with the card provider (a refusal could mean it was already reversed, e.g. by hand in the portal): a
// FAILED row holds its amount like one still in flight until a check reads "nothing back" (checkedAt). After a refused
// VOID so checked, ONE refund to the card may still be asked (a new row, two people), never a second void.
//
// The law, in order:
//   1. A person asks, with a reason; a second admin approves (C4); the asker of the set-aside never approves it.
//   2. Under the payer lock: the set-aside is open, the amount asked is exactly this card payment's money in it (the
//      whole payment, or its unused part: cardRefundPart), nothing is refunded for this payment yet, and it fits what is
//      still to pay back. The claim (SENDING, with that amount) is written BEFORE the one call.
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

/** [OWNER 10 Nov 2026 · PARTLY USED CARD PAYMENT] What of a card payment goes back to its card at closing, in cents:
 *  exactly its money in the refund set aside, the weeks it paid for that have not started. All of it: the whole
 *  payment. Part of it (the rest already paid a week that started): that part, a PARTIAL refund of the same
 *  transaction. None of it: nothing. Never more than the payment, and only whole units of the currency (weekly fees and
 *  card payments are whole GYD). [REVIEW-2484-A S4-3] The whole-units rule is SWIFT'S own platform rule (MAJOR_WHOLE),
 *  not PowerTranz's: its TotalAmount is a decimal and GYD cents would be exact. A part that breaks it is refused
 *  safely (nothing is sent; the money stays owed for Record payout). */
export type CardRefundPart = { cents: number; partial: boolean } | { refused: 'ALL_USED' | 'ABOVE_PAYMENT' | 'NOT_WHOLE_UNITS' };
export function cardRefundPart(paymentCents: number, inSetAsideCents: number): CardRefundPart {
  if (!(inSetAsideCents > 0)) return { refused: 'ALL_USED' };
  if (inSetAsideCents > paymentCents) return { refused: 'ABOVE_PAYMENT' };
  if (!Number.isSafeInteger(inSetAsideCents) || inSetAsideCents % 100 !== 0) return { refused: 'NOT_WHOLE_UNITS' };
  return { cents: inSetAsideCents, partial: inSetAsideCents < paymentCents };
}

/** Everything that must hold for this card payment (or its unused part) to go back to its card now, read under the payer lock. */
async function eligibleInTx(tx: Tx, subscriptionId: string, setAsideId: string, cardSessionId: string, amount: number, now: Date) {
  const open = await namedOpenSetAside(tx, subscriptionId, setAsideId, NOTHING_SET_ASIDE, CYCLE_CHANGED);
  const { session, original, inSetAside } = await cardPaymentInSetAside(tx, subscriptionId, open.opened.id, cardSessionId);
  const whole = cents(session.amount);
  const currency = session.currencyCode;
  if (currency !== open.currencyCode) refuse('CARD_REFUND_CURRENCY', 'This card payment is in another currency than the refund set aside.');
  // [VOID-REFUND-CHECK F4] One reversal of each kind per payment, ever: a refund may follow only a VOID the provider
  // refused AND a person's check then found nothing back on the provider's record.
  const priors = await tx.cardCreditRefund.findMany({ where: { cardSessionId }, select: { state: true, kind: true, checkedAt: true }, orderBy: { createdAt: 'asc' } });
  const prior = priors.find((r) => !(r.kind === 'VOID' && r.state === 'FAILED' && r.checkedAt));
  if (prior) {
    refuse('CARD_REFUND_EXISTS', prior.state === 'FAILED' && !prior.checkedAt
      ? `The card provider refused the ${prior.kind === 'VOID' ? 'void' : 'refund'} Swift sent for this card payment. Nothing is sent again: check it with the card provider first (Card payments, two people).`
      : `A ${prior.kind === 'VOID' ? 'void' : 'refund'} of this card payment was already asked (${prior.state === 'REFUNDED' ? 'done' : prior.state === 'FAILED' ? 'the card provider refused it' : 'its answer is not confirmed'}). It is never sent twice.`);
  }
  const afterRefusedVoid = priors.length > 0;
  const part = cardRefundPart(whole, inSetAside);
  if ('refused' in part) {
    if (part.refused === 'ALL_USED') {
      refuse('CARD_PAYMENT_ALL_USED', `None of this ${whole / 100} ${currency} card payment is in the refund set aside: all of it paid weekly fees that started, and a week that has started is not refunded. Nothing was sent.`);
    }
    if (part.refused === 'ABOVE_PAYMENT') {
      refuse('CARD_REFUND_ABOVE_PAYMENT', `More of this card payment is recorded in the refund set aside (${inSetAside / 100}) than the payment itself (${whole / 100} ${currency}). Nothing was sent: escalate to the owner.`);
    }
    refuse('CARD_REFUND_NOT_WHOLE_UNITS', `The unused part of this card payment, ${inSetAside / 100} ${currency}, is not a whole number of ${currency}. Nothing was sent: pay it back another way (Record payout, two people), or escalate to the owner.`);
  }
  if (cents(amount) !== part.cents) {
    if (!part.partial) refuse('CARD_REFUND_WHOLE_PAYMENT', `A card payment is refunded whole: ${whole / 100} ${currency}.`);
    refuse('CARD_REFUND_UNUSED_PART', `Part of this ${whole / 100} ${currency} card payment already paid a week that started. Only its weeks that have not started go back to its card: exactly ${part.cents / 100} ${currency}, a partial refund of the same payment. Nothing was sent.`);
  }
  if (part.cents > await stillToPayCents(tx, open)) refuse('REFUND_AMOUNT_MISMATCH', 'This is more than is still to pay back on this refund. Nothing was sent.');
  // [VOID-REFUND-CHECK F4 · PowerTranz 12 Nov 2026] A sale the bank may not have settled is voided, never refunded — and
  // a void is whole only ("partial voids are not supported", sec. 5.2): a PART of such a payment waits, refused here,
  // before any claim. After a refused void (checked), the refund is what remains, whatever its age.
  const byAge: CardReversalKind = afterRefusedVoid ? 'REFUND' : reversalKindByAge(session, now);
  if (byAge === 'VOID' && part.partial) {
    refuse('CARD_REFUND_NOT_SETTLED_YET', `Part of a card payment goes back only by a refund, and the card provider refunds a payment only once the bank has settled it. This one can be sent from ${settledCertainWords(session)}. Nothing was sent: the money stays set aside, owed.`);
  }
  return { open, session, original, part, byAge };
}

/** [Review S2-1 pattern] Checked when it is ASKED, before the approval gate writes the request, under the refund's
 *  ask lock: an ask that could never be sent never becomes a "refund asked" marker. */
export async function validateCardRefundAsk(tx: Tx, subscriptionId: string, body: unknown, now: Date = new Date()): Promise<void> {
  const parsed = CARD_REFUND_BODY.safeParse(body);
  if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'The refund to the card is not complete.');
  await eligibleInTx(tx, subscriptionId, parsed.data.setAsideId, parsed.data.cardSessionId, parsed.data.amount, now);
}

export interface CardRefundAnswer extends CreditRefundState {
  state: CardRefundState;
  /** [VOID-REFUND-CHECK F4] What was sent: a VOID (whole, not yet certainly settled) or a REFUND. */
  kind: CardReversalKind;
  amount: number;
  /** The refund's own transaction reference, once the provider approved it. */
  providerRefundRef: string | null;
  replayed: boolean;
}

/**
 * The approved ask, applied: ONE refund through the provider of the card payment's money in the set-aside (the whole
 * payment, or its unused part as a partial refund), recorded only on its own approved answer for exactly that amount.
 * `approvalId` names the step: applying it again answers what happened, and never sends again.
 */
export async function refundCardCreditToCard(prisma: PrismaClient, rail: CardRailSource, input: {
  adminId: string; approvalId: string; subscriptionId: string; setAsideId: string; cardSessionId: string; amount: number;
  onAudit?: OnAudit; now?: Date;
  /** [CARDS-FOLLOWUP] Pages the admins when the refund did not go back (refused, pending or not confirmed): never
   *  silent. Called once per refund (its dedupe key names it), never for an approved refund or a replay. */
  alertAdmins?: (message: string, dedupeKey: string, tenantId: string) => Promise<unknown>;
}): Promise<CardRefundAnswer> {
  if (!input.approvalId) throw new AppError(403, 'APPROVAL_REQUIRED', 'A refund to the card needs a second admin.');
  const answer = async (row: { state: string; kind: string; amount: unknown; providerRefundRef: string | null }, replayed: boolean): Promise<CardRefundAnswer> => ({
    state: row.state as CardRefundState, kind: row.kind as CardReversalKind, amount: Number(row.amount), providerRefundRef: row.providerRefundRef, replayed,
    ...(await creditRefundState(prisma, input.subscriptionId)),
  });
  const replay = await prisma.cardCreditRefund.findUnique({ where: { approvalId: input.approvalId } });
  if (replay) return answer(replay, true);
  const provider = rail();
  const now = input.now ?? new Date();

  // 1-2. The claim, under the payer lock, written before the call.
  const claimed = await prisma.$transaction(async (tx) => {
    await lockPayer(tx, input.subscriptionId);
    await lockCreditRefundAsks(tx, input.subscriptionId);
    const again = await tx.cardCreditRefund.findUnique({ where: { approvalId: input.approvalId } });
    if (again) return { replay: again };
    const { open, session, original, part, byAge } = await eligibleInTx(tx, input.subscriptionId, input.setAsideId, input.cardSessionId, input.amount, now);
    // Swift refunds only through the provider setup that took the money (guide sec. 4: the merchant's own credentials).
    if (!sameBinding(bindingOf(session), provider.binding)) {
      refuse('CARD_PROVIDER_SETUP_CHANGED', 'This card payment was taken through another card provider setup, and Swift refunds only through the setup that took it. Nothing was sent: escalate to the owner.');
    }
    await assertPayoutPairRule(tx, open.opened, input.approvalId);
    // [VOID-REFUND-CHECK F4] A whole payment the bank may not have settled is voided (a provider with no void, the
    // simulator, is refunded); the part of one was refused above.
    const kind: CardReversalKind = byAge === 'VOID' && !part.partial && provider.voidPayment ? 'VOID' : 'REFUND';
    // The amount refunded is the part asked (whole cents, divisible by 100: an exact decimal), frozen in the claim.
    const row = await tx.cardCreditRefund.create({ data: {
      tenantId: session.tenantId, subscriptionId: input.subscriptionId, cardSessionId: session.id, setAsideId: open.opened.id,
      amount: part.cents / 100, currencyCode: session.currencyCode, requestedByUserId: input.adminId, approvalId: input.approvalId, kind,
    } });
    await audit(tx, input, { step: 'CARD_REFUND_SENDING', kind, amount: Number(row.amount), paymentAmount: Number(session.amount), partial: part.partial, currencyCode: row.currencyCode, cardSessionId: session.id, orderReference: orderReferenceOf(session.id), providerTransactionRef: original, cardRefundId: row.id });
    return { row, session, original, partial: part.partial, kind };
  });
  if ('replay' in claimed) return answer(claimed.replay!, true);
  const { row, session, original, partial, kind } = claimed;
  const ofPayment = partial ? ` (part of the ${Number(session.amount)} ${row.currencyCode} payment: its weeks that had not started)` : '';

  // 3. ONE call. Its key is the claim: the driver never sends a second refund (or void) for it.
  const outcome: CardRefundOutcome = await (kind === 'VOID'
    ? provider.voidPayment!({ binding: provider.binding, providerRef: original, idempotencyKey: `card-credit-void:${row.id}` })
    : provider.refund({
      binding: provider.binding,
      providerRef: original,
      amountMinor: toProviderMinor(Number(row.amount), row.currencyCode, 'card.v2.credit-refund'),
      currencyCode: row.currencyCode,
      idempotencyKey: `card-credit-refund:${row.id}`,
    })).catch((): CardRefundOutcome => ({ status: 'unknown', reason: `${kind}_CALL_FAILED`, rawSha256: rawDigest({ [kind.toLowerCase()]: 'threw' }) }));

  const done = await prisma.$transaction(async (tx) => {
    await lockPayer(tx, input.subscriptionId);
    await tx.$queryRaw`SELECT "id" FROM "card_credit_refunds" WHERE "id" = ${row.id} FOR UPDATE`;
    const fresh = await tx.cardCreditRefund.findUniqueOrThrow({ where: { id: row.id } });
    if (fresh.state !== 'SENDING') return fresh;
    const named = outcome.status === 'succeeded' ? outcome.providerRef.trim().toUpperCase() : '';
    // [VOID-REFUND-CHECK F4] A void's answer may name only the original as its own TransactionIdentifier (guide sec. 7.6
    // sample): the void is then recorded under Swift's own reference made from the original (one void per payment, ever).
    const own = kind === 'VOID' && outcome.status === 'succeeded' && (!named || named === original.toUpperCase()) ? voidCreditReference(original) : named;
    if (outcome.status === 'succeeded' && own && own !== original.toUpperCase() && !await refusedReference(tx, own)) {
      const event = await recordPayoutPartInTx(tx, {
        subscriptionId: input.subscriptionId, amount: Number(row.amount), currencyCode: row.currencyCode, method: 'CARD', reference: own,
        eventKey: `${PAID_KEY}${own}`,
        note: kind === 'VOID'
          ? `Set-aside fee credit returned to the card that paid it: the card provider approved the void${named && named !== original.toUpperCase() ? ` ${named}` : ''} of order ${orderReferenceOf(session.id)}, not yet settled by the bank (asked by ${input.adminId})`
          : `Set-aside fee credit refunded to the card that paid it${ofPayment}: the card provider approved refund ${own} of order ${orderReferenceOf(session.id)} (asked by ${input.adminId})`,
      });
      const refunded = await tx.cardCreditRefund.update({ where: { id: row.id }, data: { state: 'REFUNDED', providerRefundRef: own, billingEventId: event.id, answeredAt: now, answerSha256: outcome.rawSha256 } });
      await audit(tx, input, { step: 'CARD_REFUNDED', kind, amount: Number(row.amount), paymentAmount: Number(session.amount), partial, currencyCode: row.currencyCode, cardSessionId: session.id, reference: own, billingEventId: event.id, cardRefundId: row.id });
      return refunded;
    }
    const state: CardRefundState = outcome.status === 'failed' ? 'FAILED' : outcome.status === 'pending' ? 'PENDING' : 'UNKNOWN';
    const reason = outcome.status === 'failed' || outcome.status === 'unknown' ? outcome.reason
      : outcome.status === 'pending' ? 'REFUND_PENDING' : 'REFUND_ANSWER_WITHOUT_ITS_OWN_REFERENCE';
    const closed = await tx.cardCreditRefund.update({ where: { id: row.id }, data: { state, outcomeReason: reason.slice(0, 200), answeredAt: now, answerSha256: outcome.rawSha256 } });
    await audit(tx, input, { step: `CARD_REFUND_${state}`, kind, amount: Number(row.amount), paymentAmount: Number(session.amount), partial, currencyCode: row.currencyCode, cardSessionId: session.id, outcomeReason: reason, cardRefundId: row.id });
    return closed;
  });
  if (done.state !== 'REFUNDED' && done.state !== 'FAILED') {
    log().error({ cardRefundId: row.id, state: done.state }, '[CARD-READY] a refund to the card is not confirmed: held for a person, never sent again');
  }
  // [CARDS-FOLLOWUP] A refund that did not go back is never silent: the admins are paged with the order, the amount and
  // what to do next. A refusal moved nothing (the money stays in the refund, owed); an unconfirmed answer may still be
  // money on its way, so nothing else may pay it until it is checked with the card provider.
  if (done.state !== 'REFUNDED' && input.alertAdmins) {
    const what = `The ${kind === 'VOID' ? 'void' : 'refund'} of ${Number(row.amount)} ${row.currencyCode} to the card for order ${orderReferenceOf(session.id)}${ofPayment}`;
    // [REVIEW-2484-B S4-2] The reason is built from the provider's own codes: only [A-Z0-9_] reaches a push.
    const why = pushSafeCode(done.outcomeReason);
    // [VOID-REFUND-CHECK F5] A refusal may mean the payment was ALREADY reversed (e.g. refunded by hand in PowerTranz's
    // portal): it is never paid back another way before the card provider's own record is checked.
    const message = done.state === 'FAILED'
      ? `${what} was refused by the card provider (${why ?? 'no reason given'}). Nothing was sent again. Before paying it back any other way, check it with the card provider (Card payments, two people): a refusal can mean the payment was already reversed. Only if the check finds nothing went back, pay it back with Record payout (two people)${kind === 'VOID' ? ', or refund it to the card once' : ''}, or ask the owner.`
      : `${what} is not confirmed (${done.state.toLowerCase()}: ${why ?? 'no answer'}). It is never sent again, and the money may be on its way back: do not pay it another way or release the refund. Check it with the card provider (Card payments) and escalate to the owner.`;
    // [REVIEW-2484-A S4-5] Paged in the card payment's own tenant, as every other card alert.
    await input.alertAdmins(message, `card-refund-not-done:${row.id}`, session.tenantId).catch((err: unknown) => {
      log().error({ cardRefundId: row.id, err }, '[CARDS-FOLLOWUP] could not page the admins about a refund to the card that did not go back');
    });
  }
  return answer(done, false);
}

/** [VOID-REFUND-CHECK F4] Swift's own reference for a void of a card payment whose approved answer names only the
 *  original transaction (guide sec. 7.6 sample): one void per payment, ever, so it is unique. Reserved like
 *  LOOKUP-CREDIT- (credit-refund.ts refundReferenceOf): a typed payout never carries it. */
export const voidCreditReference = (original: string) => `${VOID_CREDIT_PREFIX}${original.trim().toUpperCase()}`;

/** [REVIEW-2484-B S4-2] A reason code fit for a push: [A-Z0-9_] only (anything else becomes _), at most 80. */
export function pushSafeCode(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return reason.slice(0, 80).replace(/[^A-Z0-9_]/g, '_');
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
    /** [OWNER 10 Nov 2026] What a refund to the card sends: its money in the set-aside (cardRefundPart), 0 when none can go. */
    refundAmount: number;
    /** True when that is part of the payment (the rest paid a week that started): a partial refund of the same payment. */
    partial: boolean;
    refund: { state: CardRefundState; providerRefundRef: string | null; kind: CardReversalKind; checked: boolean } | null;
    /** [VOID-REFUND-CHECK F4] Part of a payment the bank may not have settled: when it can be sent (Guyana time), else null. */
    notBefore: string | null;
    refundable: boolean;
  }>;
}

/** What the console shows beside a refund: how the money was paid, and the card payments that can go back to a card. */
export async function creditRefundSources(db: PrismaClient | Tx, subscriptionId: string, now: Date = new Date()): Promise<CreditSourceView> {
  const [openMap, idMap] = await Promise.all([openCreditRefunds(db, [subscriptionId]), openSetAsideIds(db, [subscriptionId])]);
  const setAsideId = idMap.get(subscriptionId) ?? null;
  const openAmount = openMap.get(subscriptionId) ?? 0;
  if (!setAsideId) return { setAside: null, byRail: [], cardPayments: [] };
  const opened = await db.billingEvent.findUniqueOrThrow({ where: { id: setAsideId }, select: { currencyCode: true } });
  const inFlight = await db.cardCreditRefund.findMany({ where: { setAsideId, ...CARD_REFUND_HELD_WHERE }, select: { amount: true } });
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
    ? await db.cardCreditRefund.findMany({ where: { cardSessionId: { in: sessions.map((s) => s.id) } }, select: { cardSessionId: true, state: true, kind: true, checkedAt: true, providerRefundRef: true }, orderBy: { createdAt: 'desc' } })
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
      // The latest reversal of it; a refund may follow only a refused void that a check found nothing back for.
      const rows = refunds.filter((r) => r.cardSessionId === s.id);
      const refund = rows[0];
      const blocked = rows.some((r) => !(r.kind === 'VOID' && r.state === 'FAILED' && r.checkedAt));
      const inSetAside = inSetAsideOf.get(s.paymentId ?? '') ?? 0;
      // [OWNER 10 Nov 2026] The whole payment, or its unused part (a partial refund): the same rule the refund applies.
      const part = cardRefundPart(cents(s.amount ?? 0), inSetAside);
      // [VOID-REFUND-CHECK F4] Part of a payment the bank may not have settled waits (no partial void exists).
      const waits = !!part && !('refused' in part) && part.partial && rows.length === 0 && reversalKindByAge(s, now) === 'VOID';
      const goes = 'refused' in part ? null : part;
      return {
        cardSessionId: s.id, orderReference: orderReferenceOf(s.id), providerTransactionRef: originals.get(s.paymentId ?? '') ?? s.providerTransactionRef,
        amount: Number(s.amount ?? 0), currencyCode: s.currencyCode ?? opened.currencyCode, inSetAside: inSetAside / 100, paidAt: s.confirmedAt,
        refundAmount: goes ? goes.cents / 100 : 0, partial: goes?.partial ?? false,
        refund: refund ? { state: refund.state as CardRefundState, providerRefundRef: refund.providerRefundRef, kind: refund.kind as CardReversalKind, checked: !!refund.checkedAt } : null,
        notBefore: waits ? settledCertainWords(s) : null,
        refundable: !blocked && !waits && s.status === 'SUCCEEDED' && !!originals.get(s.paymentId ?? '') && goes !== null && goes.cents <= cents(stillToPay),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// [CARD-REFUND-LOOKUP] "Check with the card provider" — a refund Swift sent whose answer is not known
//
// PowerTranz's written answers to Swift: the transaction lookup is for unknown outcomes only, never the normal flow
// (4 Nov 2026), for every transaction type; refunds, partial and Merchant Portal ones included, are supported
// (9 Nov 2026). Swift reads the ORIGINAL transaction's record (lookupRefund) when a person asks and a second
// admin approves (C4). [OWNER 10 Nov 2026] A partial refund (part of the payment: its weeks that had not started) is
// judged against that PART of Swift's whole capture: REFUNDED only when TotalCreditAmount is exactly the part asked;
// the whole payment back, a void, or any other credit is held for the owner. What it may record:
//   - the record shows TotalCreditAmount = TotalCaptureAmount = the whole payment, or a real VoidDateTime: REFUNDED,
//     once, through the closing paths that already exist (a HELD Pay now: closed REFUNDED; a refund of set-aside
//     credit: its CARD payout part, REFUND_PAYABLE -> CLEARING_CARD);
//   - any other credit (part of it): held for the owner, never "refunded";
//   - no credit yet, an unreadable or missing answer, or a read made moments ago (its backoff): nothing is recorded.
// A refund is NEVER sent again here: nothing in this path calls the provider's refund or void.
// ---------------------------------------------------------------------------

/** What a check found, in the console's words. */
export type ProviderCheck = 'REFUNDED' | 'OWNER_HOLD' | 'NO_REFUND_ON_RECORD' | 'NOT_KNOWN' | 'ASKED_RECENTLY'
  /** [VOID-REFUND-CHECK F3] A held payment's refused reversal: the sale approved and unreversed (one more reversal may be
   *  sent); proven not taken ("nothing taken" may be recorded); or a record that fits no decision (the owner). */
  | 'SALE_STANDS' | 'NOT_TAKEN_ON_RECORD' | 'ESCALATE';
export function providerCheckOf(outcome: CardRefundLookupOutcome): ProviderCheck {
  switch (outcome.status) {
    case 'refunded': return 'REFUNDED';
    case 'part_credited': return 'OWNER_HOLD';
    case 'not_refunded': return 'NO_REFUND_ON_RECORD';
    case 'unknown': return outcome.backoff ? 'ASKED_RECENTLY' : 'NOT_KNOWN';
    default: { const never: never = outcome; throw new Error(`card refund lookup outcome ${String(never)}`); }
  }
}

/** [COORD 9 Nov 2026] A refund claim still SENDING (its process stopped mid-call) is checked like a lost answer only
 *  well after the refund call's own deadline (15 s): ten minutes after the send began. It is never sent again. */
export const REFUND_CHECK_GRACE_MS = 10 * 60_000;
const UNANSWERED = ['UNKNOWN', 'PENDING'];
const stuck = (state: string | null, since: Date | null, now: Date) => state === 'SENDING' && !!since && now.getTime() - since.getTime() >= REFUND_CHECK_GRACE_MS;

/** A HELD Pay now whose refund (resolveHeld) has no known answer, and that nothing has closed. */
export function heldRefundCheckable(s: Pick<CardSession, 'purpose' | 'status' | 'resolution' | 'providerRefundState' | 'providerRefundAt' | 'providerTransactionRef' | 'amount' | 'currencyCode'>, now: Date): boolean {
  if (s.purpose !== 'PAY_NOW' || s.status !== 'HELD' || s.resolution || !s.providerTransactionRef || s.amount === null || !s.currencyCode) return false;
  return UNANSWERED.includes(s.providerRefundState ?? '') || stuck(s.providerRefundState, s.providerRefundAt, now);
}

/** A refund of set-aside credit to its card whose answer is not known — or [VOID-REFUND-CHECK F5] one the provider
 *  REFUSED that no check has yet read (its money is held until one does). */
export function creditRefundCheckable(r: { state: string; createdAt: Date; checkedAt?: Date | null }, now: Date): boolean {
  return UNANSWERED.includes(r.state) || stuck(r.state, r.createdAt, now) || (r.state === 'FAILED' && !r.checkedAt);
}

/** [ASSUMED until PowerTranz says the record lists refunds with their own ids] The reference a lookup-confirmed refund
 *  is recorded under: Swift's, made from the ORIGINAL transaction (one refund per card payment, ever), never a
 *  provider id Swift did not read. The portal shows the refund's own id beside the original. */
export const lookupCreditReference = (original: string) => `${LOOKUP_CREDIT_PREFIX}${original.trim().toUpperCase()}`;

export interface CreditRefundCheckAnswer {
  check: ProviderCheck;
  reason: string;
  refund: { state: CardRefundState; providerRefundRef: string | null };
}

/**
 * Check a refund of set-aside credit to its card with the card provider (two people: the route is C4). Reads the
 * original transaction's record once (its backoff permitting); records REFUNDED only when EXACTLY what Swift asked back
 * is credited (the whole payment, or for a partial refund the part: judgeRefundRecord), as the payout part the
 * provider's own approved answer would have recorded. `alertOwner` is told of any other credit.
 */
export async function checkCardCreditRefund(prisma: PrismaClient, rail: CardRailSource, input: {
  adminId: string; tenantId: string; cardSessionId: string; onAudit?: OnAudit; now?: Date;
  alertOwner?: (message: string) => Promise<void>;
}): Promise<CreditRefundCheckAnswer> {
  const now = input.now ?? new Date();
  const rows = await prisma.cardCreditRefund.findMany({ where: { cardSessionId: input.cardSessionId }, orderBy: { createdAt: 'desc' } });
  const row = rows.find((r) => creditRefundCheckable(r, now));
  if (!row || row.tenantId !== input.tenantId) {
    refuse('NOTHING_TO_CHECK', 'There is no refund of this card payment whose answer is unknown. Nothing was read or recorded.');
  }
  const session = await prisma.cardSession.findUnique({ where: { id: row.cardSessionId } });
  const payment = session?.paymentId
    ? await prisma.subscriptionPayment.findUnique({ where: { id: session.paymentId }, select: { status: true, externalRef: true, paymentMethod: true } })
    : null;
  const original = payment?.status === 'CAPTURED' && payment.paymentMethod === 'CARD' ? payment.externalRef?.trim() ?? '' : '';
  if (!session || !original || session.amount === null || (session.providerTransactionRef && session.providerTransactionRef.trim().toLowerCase() !== original.toLowerCase())) {
    refuse('CARD_PAYMENT_NOT_REFUNDABLE', 'Swift cannot name this card payment\'s original transaction with certainty. Nothing was read or recorded: escalate to the owner.');
  }
  const provider = rail();
  if (!sameBinding(bindingOf(session), provider.binding)) {
    refuse('CARD_PROVIDER_SETUP_CHANGED', 'This card payment was taken through another card provider setup. Nothing was read or recorded: escalate to the owner.');
  }
  if (!provider.lookupRefund) refuse('PROVIDER_CANNOT_LOOK_UP', 'This card provider gives Swift no way to look a payment up. Check its portal and escalate to the owner. Nothing was recorded.');
  const orderRef = orderReferenceOf(session.id);
  // [OWNER 10 Nov 2026] The record is judged for the amount Swift asked back (the claim's), of Swift's whole capture (the
  // payment): the same figures for a whole refund; the part and the whole for a partial one.
  const partial = cents(row.amount) < cents(session.amount);
  const asked = partial
    ? `${Number(row.amount)} of the ${Number(session.amount)} ${row.currencyCode} card payment that Swift asked back (its weeks that had not started)`
    : `whole ${Number(row.amount)} ${row.currencyCode} card payment`;
  const looked: CardRefundLookupOutcome = await provider.lookupRefund({
    binding: provider.binding, providerRef: original, orderRef,
    amountMinor: toProviderMinor(Number(session.amount), row.currencyCode, 'card.v2.credit-refund-check'),
    refundMinor: toProviderMinor(Number(row.amount), row.currencyCode, 'card.v2.credit-refund-check'),
    currencyCode: row.currencyCode,
    notBefore: new Date(session.createdAt.getTime() - VOID_DATE_SKEW_MS),
  }).catch((): CardRefundLookupOutcome => ({ status: 'unknown', reason: 'LOOKUP_CALL_FAILED', rawSha256: rawDigest({ lookup: 'threw', ref: original }) }));
  const check = providerCheckOf(looked);
  // [REVIEW-2461-A S4-2] The hash of the record the decision rests on, and how it showed the money back.
  const facts = {
    step: `CARD_REFUND_CHECK_${check}`, cardSessionId: session.id, cardRefundId: row.id, orderReference: orderRef, providerTransactionRef: original,
    lookup: looked.status, lookupReason: looked.reason, lookupSha256: looked.rawSha256, ...(looked.status === 'refunded' ? { how: looked.how } : {}),
    amount: Number(row.amount), paymentAmount: Number(session.amount), partial, currencyCode: row.currencyCode,
  };
  const who = { adminId: input.adminId, subscriptionId: row.subscriptionId, ...(input.onAudit ? { onAudit: input.onAudit } : {}) };
  const answer = (state: CardRefundState, providerRefundRef: string | null, c: ProviderCheck = check): CreditRefundCheckAnswer => ({ check: c, reason: looked.reason, refund: { state, providerRefundRef } });

  if (looked.status !== 'refunded') {
    // [VOID-REFUND-CHECK F5] A REFUSED reversal whose original shows nothing back: checked — its money is free to be
    // paid back another way (Record payout), or, after a refused void, refunded to the card once.
    const freed = row.state === 'FAILED' && looked.status === 'not_refunded'
      ? await prisma.$transaction(async (tx) => {
        await lockPayer(tx, row.subscriptionId);
        await tx.$queryRaw`SELECT "id" FROM "card_credit_refunds" WHERE "id" = ${row.id} FOR UPDATE`;
        const fresh = await tx.cardCreditRefund.findUniqueOrThrow({ where: { id: row.id } });
        if (fresh.state !== 'FAILED' || fresh.checkedAt) return false;
        await tx.cardCreditRefund.update({ where: { id: row.id }, data: { checkedAt: now } });
        await audit(tx, who, { ...facts, checkedAt: now.toISOString() });
        return true;
      })
      : false;
    if (!freed) await prisma.$transaction(async (tx) => { await audit(tx, who, facts); });
    if (looked.status === 'part_credited') {
      log().error({ cardRefundId: row.id, reason: looked.reason, partial }, '[CARD-REFUND-LOOKUP] the provider record shows a credit that is not what Swift asked back — held for the owner');
      await input.alertOwner?.(`The card provider's record of order ${orderRef} (transaction ${original}) shows a refund that is not the ${asked} (${looked.reason}). Nothing was recorded or sent. The owner settles it with PowerTranz.`).catch(() => {});
    }
    return answer(row.state as CardRefundState, row.providerRefundRef);
  }

  const reference = lookupCreditReference(original);
  type Refusal = { code: string; message: string };
  const done = await prisma.$transaction(async (tx): Promise<{ refunded: { providerRefundRef: string | null } } | { refusal: Refusal }> => {
    await lockPayer(tx, row.subscriptionId);
    await lockCreditRefundAsks(tx, row.subscriptionId);
    await tx.$queryRaw`SELECT "id" FROM "card_credit_refunds" WHERE "id" = ${row.id} FOR UPDATE`;
    const fresh = await tx.cardCreditRefund.findUniqueOrThrow({ where: { id: row.id } });
    if (!creditRefundCheckable(fresh, now)) {
      return { refusal: { code: 'NOTHING_TO_CHECK', message: `This refund was answered while it was being checked (${fresh.state}). Nothing more was recorded.` } };
    }
    // The money is recorded against the set-aside it was asked from, and only while that set-aside is still open for
    // at least this payment (an unconfirmed refund holds it: nothing else can pay or release that part).
    const [openMap, idMap] = await Promise.all([openCreditRefunds(tx, [row.subscriptionId]), openSetAsideIds(tx, [row.subscriptionId])]);
    if (idMap.get(row.subscriptionId) !== fresh.setAsideId || cents(openMap.get(row.subscriptionId) ?? 0) < cents(fresh.amount)) {
      return { refusal: { code: 'REFUND_SET_ASIDE_CHANGED', message: 'The refund set aside for this card payment is no longer open for it. Nothing was recorded: escalate to the owner.' } };
    }
    if (await refusedReference(tx, reference)) {
      return { refusal: { code: 'REFUND_REFERENCE_IS_A_PAYMENT', message: 'Swift already has this payment\'s refund reference on record. Nothing was recorded: escalate to the owner.' } };
    }
    const event = await recordPayoutPartInTx(tx, {
      subscriptionId: row.subscriptionId, amount: Number(fresh.amount), currencyCode: fresh.currencyCode, method: 'CARD', reference,
      eventKey: `${PAID_KEY}${reference}`,
      note: `Set-aside fee credit refunded to the card that paid it: the card provider's own record of transaction ${original} (order ${orderRef}) shows ${partial ? `exactly the ${asked} credited back` : `the whole payment ${looked.how === 'void' ? 'voided' : 'credited back'}`} (checked by ${input.adminId}; Swift's own ${fresh.kind === 'VOID' ? 'void' : 'refund'} had been ${fresh.state})`,
    });
    // [REVIEW-2461-B S3-1] The refund's own answer (its time and hash) stays on the row as it was; the record that
    // confirmed it is in the audit trail. A claim that never got an answer (stuck SENDING) is answered now.
    const answered = fresh.state === 'SENDING' ? { answeredAt: now, answerSha256: looked.rawSha256 } : {};
    const refunded = await tx.cardCreditRefund.update({ where: { id: row.id }, data: {
      state: 'REFUNDED', providerRefundRef: reference, billingEventId: event.id, ...answered,
      outcomeReason: `${fresh.outcomeReason ?? fresh.state}+${looked.reason}`.slice(0, 200),
    } });
    await audit(tx, who, { ...facts, reference, billingEventId: event.id, was: fresh.state, wasAnsweredAt: fresh.answeredAt?.toISOString() ?? null, wasAnswerSha256: fresh.answerSha256 });
    return { refunded };
  });
  if ('refusal' in done) {
    // [REVIEW-2461 A S4-1 · B S4-1] The provider's record says the money is back, yet Swift recorded nothing: the
    // verdict is kept (its own audit row) and the owner is told, before the refusal.
    log().error({ cardRefundId: row.id, refusal: done.refusal.code }, '[CARD-REFUND-LOOKUP] the provider record shows the card payment back, but Swift could not record it — owner');
    await prisma.$transaction(async (tx) => { await audit(tx, who, { ...facts, step: 'CARD_REFUND_CHECK_REFUNDED_NOT_RECORDED', refusal: done.refusal.code }); });
    await input.alertOwner?.(`The card provider's record of order ${orderRef} (transaction ${original}) shows the ${asked} back, but Swift could not record it (${done.refusal.code}). Nothing was recorded or sent. The owner settles it.`).catch(() => {});
    refuse(done.refusal.code, done.refusal.message);
  }
  // [VOID-REFUND-CHECK F5] Recorded back although Swift's own reversal was REFUSED: someone else reversed it (the portal?):
  // the owner is told, and the amount can never be paid back another way.
  if (row.state === 'FAILED') {
    await input.alertOwner?.(`The card provider refused the ${row.kind === 'VOID' ? 'void' : 'refund'} Swift sent for order ${orderRef} (transaction ${original}), but its record now shows the ${asked} back (${looked.reason}). Recorded as refunded; nothing was sent. Check in the portal how it went back.`).catch(() => {});
  }
  return answer('REFUNDED', done.refunded.providerRefundRef);
}

export { CARD_REFUND_ACTION };
