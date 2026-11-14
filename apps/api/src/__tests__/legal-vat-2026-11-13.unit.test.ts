import { describe, it, expect } from 'vitest';
import type { UserRole } from '@prisma/client';
import { LEGAL_VERSION, PRIVACY, TERMS, DRIVER_AGREEMENT, VENDOR_AGREEMENT } from '../modules/legal/legal.routes';
import { MATERIAL_CHANGES, NON_MATERIAL_CHANGES, acceptanceStatus, materialVersion } from '../modules/legal/reaccept';

// ---------------------------------------------------------------------------
// [STORE-VAT-EXCLUSIVE · 13 Nov 2026 · owner approved the words 13 Nov 2026 01:07Z, verbatim from
// evidence/STORE-VAT-EXCLUSIVE-20261113/TERMS-DRAFT.md] A VAT-registered store may list its prices BEFORE VAT:
//   - Terms section 5: the price a customer sees no longer always includes the store's VAT; such prices are marked
//     "+ VAT", the VAT is added at checkout as a separate line, and the full Total is always shown before confirming;
//   - Business Agreement, the listings paragraph: the listed price is what customers pay for the goods; the before-VAT
//     basis; the VAT is the business's to account for to the GRA, on items not marked zero-rated or exempt.
// MATERIAL for everyone (GUARDRAILS standing rule 1): the in-app notice and a fresh tick for customers and businesses.
// ---------------------------------------------------------------------------

const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('LEGAL_VERSION 2026-11-13: prices before VAT, material for everyone', () => {
  it('is served, and classed material exactly once, for everyone', () => {
    expect(LEGAL_VERSION).toBe('2026-11-13');
    const entry = MATERIAL_CHANGES.filter((c) => c.version === '2026-11-13');
    expect(entry).toHaveLength(1);
    expect(entry[0]!.audience).toBeUndefined();
    expect(NON_MATERIAL_CHANGES.map((c) => c.version)).not.toContain('2026-11-13');
    expect(materialVersion(LEGAL_VERSION)).toBe('2026-11-13');
  });

  it.each([
    ['a customer', ['CUSTOMER']], ['a store owner', ['VENDOR_OWNER', 'CUSTOMER']], ['a rider', ['MOVER', 'CUSTOMER']],
  ] as const)('%s at 2026-11-10 is asked once, with this summary alone (the in-app notice), and not after the tick', (_who, roles) => {
    const summary = MATERIAL_CHANGES.find((c) => c.version === '2026-11-13')!.summary;
    expect(acceptanceStatus({ tosVersion: '2026-11-10', roles: [...roles] as UserRole[] })).toMatchObject({ needsAcceptance: true, summary });
    expect(acceptanceStatus({ tosVersion: '2026-11-13', roles: [...roles] as UserRole[] })).toMatchObject({ needsAcceptance: false, summary: [] });
  });

  it('a store owner re-accepts the Business Agreement with the Terms', () => {
    expect(acceptanceStatus({ tosVersion: '2026-11-10', roles: ['VENDOR_OWNER', 'CUSTOMER'] as UserRole[] }).agreements).toContain('vendor_agreement');
  });

  it('the summary says what changed, in plain words', () => {
    const words = MATERIAL_CHANGES.find((c) => c.version === '2026-11-13')!.summary.join(' ');
    expect(words).toContain('marked “+ VAT”');
    expect(words).toContain('added at checkout as a separate “VAT” line before the Total');
    expect(words).toContain('you see the full Total, VAT included, before you confirm your order');
  });

  it('Terms section 5 and the Business Agreement carry the approved words, verbatim; the old sentences are gone', () => {
    expect(TERMS).toContain('Prices are the Business\'s own prices. Where a Business is registered for VAT and Swift has approved its details, that Business\'s VAT is either included in the prices you see, or, where the Business shows its prices before VAT (marked "+ VAT"), added at checkout as a separate "VAT" line before the Total. Either way, you see the full Total, VAT included, before you confirm the Order.');
    expect(TERMS).not.toContain('the price you see includes that Business\'s VAT');
    expect(VENDOR_AGREEMENT).toContain('Prices you list are the prices customers pay for your goods — the platform adds no markup, and you may not use the platform to mislead. If Swift has approved your VAT details: where your prices include VAT, or you chose to have VAT added to your prices, customers see and pay your price with VAT included; where you chose to list your prices before VAT, customers see your prices as you list them, marked "+ VAT", and your VAT is added at checkout as a separate line before the Total. In every case that VAT is yours to account for to the GRA, and only items you have not marked zero-rated or exempt carry it.');
    expect(VENDOR_AGREEMENT).not.toContain('If Swift has approved your VAT details and you chose to add VAT to your prices');
  });

  it('Privacy and the Mover Agreement change only by their date', () => {
    for (const doc of [PRIVACY, DRIVER_AGREEMENT]) {
      expect(doc).toContain('13 November 2026');
      expect(flat(doc)).not.toMatch(/\+ VAT/);
    }
  });
});
