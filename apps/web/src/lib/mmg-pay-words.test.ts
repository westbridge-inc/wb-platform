import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MMG_MONEY_MOVED, MMG_PAY_AFTER_ACCEPT, acceptHeldForPayment, mmgMoneyMoved, paysAfterAccept } from './mmg-pay-words';
import { ATTESTABLE_PAYMENT_STATUSES, canAttestPayment } from './vendor-hub';

// The board decides "paid" and "the store may confirm" with the SERVER's own
// sets, so the two can never drift: money moved = MMG_MONEY_MOVED
// (apps/api/src/modules/order/order.service.ts), confirmable =
// ATTESTABLE_PAYMENT_STATUSES (apps/api/src/modules/vendor/mmg-attestation.ts).
const API = join(__dirname, '..', '..', '..', 'api', 'src', 'modules');
const strings = (src: string, name: string) => {
  const line = src.split('\n').find((l) => l.includes(`const ${name}`));
  if (!line) throw new Error(`${name} not found`);
  return [...line.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
};

describe('the board\'s payment sets are the server\'s', () => {
  it('money moved matches MMG_MONEY_MOVED', () => {
    const server = strings(readFileSync(join(API, 'order', 'order.service.ts'), 'utf8'), 'MMG_MONEY_MOVED');
    expect([...MMG_MONEY_MOVED].sort()).toEqual(server);
    for (const status of server) expect(mmgMoneyMoved(status)).toBe(true);
    expect(mmgMoneyMoved('PENDING')).toBe(false);
  });
  it('confirmable matches ATTESTABLE_PAYMENT_STATUSES', () => {
    const server = strings(readFileSync(join(API, 'vendor', 'mmg-attestation.ts'), 'utf8'), 'ATTESTABLE_PAYMENT_STATUSES');
    expect([...ATTESTABLE_PAYMENT_STATUSES].sort()).toEqual(server);
    for (const status of server) expect(canAttestPayment(status)).toBe(true);
    expect(canAttestPayment('CLAIMED')).toBe(false);
  });
});

// [owner 14 Nov 2026 · option A, PAYMENT-SIMPLIFY Q1] Accept comes BEFORE payment on an MMG order: the customer sees
// the store's MMG number only once the store accepts (the API's customer order read), and nothing moves past Accept
// until "Paid by MMG". So the web offers Accept on an unpaid MMG order whose payment can still happen, exactly where
// the server allows it (order.service.ts assertMmgFulfilmentAllowed: ACCEPTED with an open payment and no rejected
// store claim), and says what happens next.
describe('[owner 14 Nov] an unpaid MMG order is accepted first, then paid', () => {
  const mmg = (paymentStatus: string, extra: Record<string, unknown> = {}) => ({ paymentMethod: 'MOBILE_MONEY', paymentStatus, mmgAttestedRef: null, ...extra });

  it('an open payment (PENDING, AUTHORIZED) is accepted first, with the owner\'s line', () => {
    for (const status of ['PENDING', 'AUTHORIZED']) {
      expect(acceptHeldForPayment(mmg(status)), status).toBe(false);
      expect(paysAfterAccept(mmg(status)), status).toBe(true);
    }
    expect(MMG_PAY_AFTER_ACCEPT).toBe('The customer pays your MMG number after you accept, so tap Paid by MMG when it lands.');
  });

  it('a payment that moved needs no line; cash and card are never held', () => {
    for (const status of ['CAPTURED', 'CLAIMED']) {
      expect(acceptHeldForPayment(mmg(status))).toBe(false);
      expect(paysAfterAccept(mmg(status))).toBe(false);
    }
    for (const paymentMethod of ['CASH', 'CARD']) {
      expect(acceptHeldForPayment({ paymentMethod, paymentStatus: 'PENDING' })).toBe(false);
      expect(paysAfterAccept({ paymentMethod, paymentStatus: 'PENDING' })).toBe(false);
    }
  });

  it('a payment that can no longer happen is still held (the server refuses that Accept)', () => {
    for (const status of ['FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'EXPIRED', 'UNKNOWN', 'CANCELLED']) {
      expect(acceptHeldForPayment(mmg(status)), status).toBe(true);
      expect(paysAfterAccept(mmg(status)), status).toBe(false);
    }
    // A store claim an operator rejected (its reference kept on a reopened order) can never be paid on this order.
    expect(acceptHeldForPayment(mmg('PENDING', { mmgAttestedRef: 'ABC123' }))).toBe(true);
    expect(paysAfterAccept(mmg('PENDING', { mmgAttestedRef: 'ABC123' }))).toBe(false);
  });

  it('the old "the server refuses it otherwise" comment is gone', () => {
    const src = readFileSync(join(__dirname, 'mmg-pay-words.ts'), 'utf8');
    expect(src).not.toMatch(/server refuses it otherwise/);
  });
});
