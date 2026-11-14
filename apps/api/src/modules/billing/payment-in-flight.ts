import type { Prisma } from '@prisma/client';
import { ACTIVE_CONFIRMATION_STATES, feeReversalOpenInTx, lateCardApprovalHeldInTx } from './dunning-clock';
import { IN_PERSON_ACTION } from './in-person-channel';

/**
 * A payment of this subscription's weekly fee that is not settled yet — an open or confirming MMG checkout, a
 * confirmation hold, a held late card approval, a reversal: its quote must not change under it. ONE predicate for every
 * path that moves a fee outside a charge: a chain deal (vendor/chain-deal.ts) and a card price cut (card-price-cut.ts).
 */
export async function paymentInFlightInTx(tx: Prisma.TransactionClient, subscriptionId: string): Promise<boolean> {
  const [checkout, chainShare, hold] = await Promise.all([
    tx.mmgCheckoutIntent.findFirst({ where: { subscriptionId, status: { in: ['OPEN', 'CONFIRMING'] } }, select: { id: true } }),
    // [ENTERPRISE E1] This branch's share of an owner's "pay all my branches" checkout.
    tx.mmgCheckoutPart.findFirst({ where: { subscriptionId, checkout: { status: { in: ['OPEN', 'CONFIRMING'] } } }, select: { id: true } }),
    tx.paymentConfirmationHold.findFirst({ where: { subscriptionId, status: { in: [...ACTIVE_CONFIRMATION_STATES] } }, select: { id: true } }),
  ]);
  return !!checkout || !!chainShare || !!hold || await lateCardApprovalHeldInTx(tx, [subscriptionId]) || await feeReversalOpenInTx(tx, [subscriptionId]);
}

/**
 * [TRIAL PAY-AHEAD · REVIEW-A2 #2513 S3-1] Money for this weekly fee that may already have been paid but is not credited
 * yet: everything paymentInFlightInTx sees (an MMG checkout open or being confirmed, an expired one still held for
 * confirmation, a chain share, a held late card approval, a fee reversal), a card Pay now page still open or unclear,
 * and a fee paid in person whose record waits for the second admin. A rate change reads it as a week paid at the rate
 * it was paid at: the money lands at that rate.
 */
export async function feeMoneyInFlightInTx(tx: Prisma.TransactionClient, subscriptionId: string, now: Date): Promise<boolean> {
  if (await paymentInFlightInTx(tx, subscriptionId)) return true;
  const [card, inPerson] = await Promise.all([
    tx.cardSession.findFirst({ where: { subscriptionId, purpose: 'PAY_NOW', status: { in: ['OPEN', 'UNKNOWN', 'HELD'] } }, select: { id: true } }),
    tx.privilegedApproval.findFirst({ where: { action: IN_PERSON_ACTION, entityId: subscriptionId, status: { in: ['PENDING', 'APPROVED'] }, expiresAt: { gt: now } }, select: { id: true } }),
  ]);
  return !!card || !!inPerson;
}
