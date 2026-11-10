import { describe, it, expect } from 'vitest';
import type { UserRole } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGAL_VERSION, PRIVACY, TERMS, DRIVER_AGREEMENT, VENDOR_AGREEMENT } from '../modules/legal/legal.routes';
import { MATERIAL_CHANGES, NON_MATERIAL_CHANGES, acceptanceStatus, materialVersion, partnerMaterialVersion } from '../modules/legal/reaccept';
import { POLICY_NAMED_WITHOUT_EGRESS, processorByRef, coverageOfProviderDir } from '../modules/legal/processor-register';

// ---------------------------------------------------------------------------
// [LEGAL-CARDS · 10 Nov 2026 · DRAFT until the owner approves the words and a Guyana attorney reads them] Paying
// Swift's weekly fee by card, in the legal texts, before cards go live:
//   - Privacy section 1 (what Swift keeps of a card payment, never the card number), section 2 (card details are typed
//     on the card processor's page, never into Swift) and section 5 (PowerTranz as a processor, what it receives, and
//     that its page asks ipapi.co for the IP location, as served on staging 10 Nov 2026);
//   - Mover and Business Agreements section 2: a closing refund of a card week goes back to that card, and a refused
//     card refund is never resent: it stays as credit until the partner agrees in writing another way (the owner's
//     switch-on plan, item 6);
//   - the website's refunds page says the same (apps/web, not a versioned text).
// MATERIAL for partners (a new processor flow, as 2026-10-25.1): every partner ticks again; a customer, who pays Swift
// nothing, is not asked.
// ---------------------------------------------------------------------------

const flat = (s: string) => s.replace(/\s+/g, ' ');
const WEB_REFUNDS = readFileSync(join(__dirname, '../../../web/src/app/legal/refunds/page.tsx'), 'utf8');

describe('LEGAL_VERSION 2026-11-10: card payments of the weekly fee, material for partners', () => {
  it('is served, and classed material exactly once, for partners only', () => {
    expect(LEGAL_VERSION).toBe('2026-11-10');
    const entry = MATERIAL_CHANGES.filter((c) => c.version === '2026-11-10');
    expect(entry).toHaveLength(1);
    expect(entry[0]!.audience).toBe('partner');
    expect(NON_MATERIAL_CHANGES.map((c) => c.version)).not.toContain('2026-11-10');
    expect(partnerMaterialVersion(LEGAL_VERSION)).toBe('2026-11-10');
    expect(materialVersion(LEGAL_VERSION)).toBe('2026-11-09');
  });

  it.each([
    ['a rider', ['MOVER', 'CUSTOMER']], ['a store owner', ['VENDOR_OWNER', 'CUSTOMER']],
  ] as const)('%s at 2026-11-09.2 is asked once, with the card summary alone; at 2026-11-10, not', (_who, roles) => {
    const summary = MATERIAL_CHANGES.find((c) => c.version === '2026-11-10')!.summary;
    expect(acceptanceStatus({ tosVersion: '2026-11-09.2', roles: [...roles] as UserRole[] })).toMatchObject({ needsAcceptance: true, summary });
    expect(acceptanceStatus({ tosVersion: '2026-11-10', roles: [...roles] as UserRole[] })).toMatchObject({ needsAcceptance: false, summary: [] });
  });

  it('a customer at 2026-11-09.2 is not asked: nothing in the change concerns a customer', () => {
    expect(acceptanceStatus({ tosVersion: '2026-11-09.2', roles: ['CUSTOMER'] as UserRole[] })).toMatchObject({ needsAcceptance: false, summary: [] });
  });

  it('a partner who skipped 2026-11-09 sees both summaries, oldest first; a customer at the same version sees only the call one', () => {
    const calls = MATERIAL_CHANGES.find((c) => c.version === '2026-11-09')!.summary;
    const cards = MATERIAL_CHANGES.find((c) => c.version === '2026-11-10')!.summary;
    expect(acceptanceStatus({ tosVersion: '2026-11-08', roles: ['MOVER', 'CUSTOMER'] as UserRole[] })).toMatchObject({ needsAcceptance: true, summary: [...calls, ...cards] });
    expect(acceptanceStatus({ tosVersion: '2026-11-08', roles: ['CUSTOMER'] as UserRole[] })).toMatchObject({ needsAcceptance: true, summary: [...calls] });
  });

  it('the summary names the card processor, what it receives, ipapi.co, and the closing refund to the card', () => {
    const words = MATERIAL_CHANGES.find((c) => c.version === '2026-11-10')!.summary.join(' ');
    expect(words).toContain('PowerTranz, our card processor, receives them, never Swift');
    expect(words).toContain('network (IP) address and browser details');
    expect(words).toContain('ipapi.co, an IP-location service');
    expect(words).toContain('never your card number');
    expect(words).toContain('goes back to that card');
    expect(words).toContain('returns it another way only once you agree to that way in writing');
  });
});

describe('the served words', () => {
  it('Privacy section 5 names PowerTranz, what its page receives, what Swift sends and keeps, and ipapi.co', () => {
    const p = flat(PRIVACY);
    expect(p).toContain('PowerTranz, our card processor, outside Guyana (processes a Partner\'s weekly-fee payment by card');
    expect(p).toContain('receives the card details typed there, the cardholder details the page asks for, such as your name and your email address or phone number, and your device\'s network (IP) address and browser details, for the payment and the bank\'s security check (3-D Secure)');
    expect(p).toContain('Swift sends it the amount and Swift\'s reference for the payment and receives back the payment\'s reference and result, never your card number');
    expect(p).toContain('it also asks ipapi.co, an IP-location service, from your browser where your network address is located');
  });

  it('Privacy sections 1 and 2: what Swift keeps of a card payment, and that card details are never typed into Swift', () => {
    const p = flat(PRIVACY);
    expect(p).toContain('if you pay by card, our card processor\'s reference for the payment, the amount and currency, the result of the bank\'s security check, and whether the payment was approved, refused or refunded, never your card number');
    expect(p).toContain('If you are a partner and pay Swift\'s weekly fee by card, you type your card details on our card processor\'s secure payment page, shown inside the Swift app or website; they go to the card processor, never to Swift.');
    expect(p).toContain('we do not collect card numbers or mobile-money credentials');
  });

  it('both partner agreements: a closing refund goes back to the card, and a refused card refund stays as credit until the partner agrees in writing', () => {
    for (const doc of [DRIVER_AGREEMENT, VENDOR_AGREEMENT]) {
      const d = flat(doc);
      expect(d).toContain('to the account you paid from, to the card you paid with, or, if you paid in person, by a way you and Swift agree');
      expect(d).toContain('If a refund to your card is refused, Swift does not send it to the card again: Swift tells you, keeps the money as credit for your weekly fees, and returns it another way only once you agree to that way in writing; your account is deleted once it has been returned.');
    }
  });

  it('the Terms change only by their date', () => {
    expect(TERMS).toContain('10 November 2026');
    expect(flat(TERMS)).not.toContain('PowerTranz');
  });

  it('the website refunds page: the card processor\'s secure page (never "our bank\'s"), and the refused-card-refund fallback', () => {
    const page = flat(WEB_REFUNDS);
    expect(page).toContain('It can also be paid by Visa or Mastercard, on our card processor’s secure payment page, shown inside the Swift app or website; Swift never sees your card number.');
    expect(page).not.toContain('through our bank’s card payment page');
    expect(page).toContain('to the account you paid from, to the card you paid with, or, if you paid in person');
    expect(page).toContain('If a refund to your card is refused, {site.tradeName} does not send it to the card again: it tells you, keeps the money as credit for your weekly fees, and returns it another way only once you agree to that way in writing.');
    expect(page).toContain("const UPDATED = '10 November 2026';");
  });
});

describe('the processor register agrees with the policy', () => {
  it('PowerTranz is the card processor for both card directories, and Swift sends ipapi.co nothing', () => {
    const row = processorByRef('POWERTRANZ')!;
    expect(row.providerDirs).toEqual(['payment', 'card']);
    expect(row.hosts).toEqual(['ptranz.com']);
    expect(row.leavesCountry).toBe(true);
    expect(coverageOfProviderDir('card')).toEqual({ kind: 'PROCESSOR', refs: ['POWERTRANZ'] });
    expect(POLICY_NAMED_WITHOUT_EGRESS['ipapi.co']).toMatch(/Swift's code sends it nothing/);
  });
});
