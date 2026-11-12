/**
 * [RESTAURANT-TIN · owner ruling 12 Nov 2026] The list rule and the gate's paper, without a database: a restaurant's TIN
 * certificate in the GRA Food Restaurant Licence's required place (the licence optional), over the code's lists AND over
 * a stored copy that still names the licence (production's, until the owner-signed seed of 2026-11-12.1). Every other
 * store kind is unchanged. A live restaurant is excused the TIN certificate only while it holds a valid GRA licence, and never once a person
 * rejected or revoked a TIN certificate of its owner's (owner ruling 12 Nov 2026, #2494 review S2-1).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCUMENT_CHECKLISTS, PLATFORM_CONFIG_VERSION, desiredPlatformConfig } from '../modules/ops/platform-config';
import { withoutRetiredLists } from '../modules/country/country-config.service';
import { ALWAYS_REVIEW_LEGACY_CODES, BUCKET_OF, PERSON_ONLY_DOC_TYPES, RETIRED_DOC_TYPES, withRestaurantTinRule } from '../modules/verification/doc-registry';
import { gateDocFor } from '../modules/verification/category-gate';
import { liveRestaurant, tinCertificateExcused } from '../modules/verification/restaurant-tin';

const TIN = 'tin_certificate';
const GRA = 'gra_restaurant_licence';

/** Production's stored restaurant lists before this change (the 2026-11-10.1 lists). */
const STORED = {
  RESTAURANT: ['owner_national_id', 'business_registration', GRA, 'storefront_photo'],
  RESTAURANT_OPTIONAL: ['food_handler_cert'],
  RESTAURANT_OWN_NAME: ['owner_national_id', 'own_name_declaration', GRA, 'storefront_photo'],
  RESTAURANT_COMPANY: ['certificate_of_incorporation', 'account_holder_id', 'company_authority_letter', GRA, 'storefront_photo'],
  RESTAURANT_MANAGER: ['account_holder_id', 'owner_authority_letter', 'business_registration', GRA, 'storefront_photo'],
  SUPERMARKET: ['owner_national_id', 'business_registration', 'storefront_photo'],
  STORE: ['owner_national_id', 'business_registration', 'storefront_photo'],
  SERVICE: ['owner_national_id'],
  SERVICE_PROVIDER_TRADE_CHEF: ['food_handler_cert'],
};

describe('[RESTAURANT-TIN] the restaurant lists', () => {
  it('the code’s lists: every restaurant tier asks the TIN certificate where the licence was; the licence is optional', () => {
    expect(DEFAULT_DOCUMENT_CHECKLISTS['RESTAURANT']).toEqual(['owner_national_id', 'business_registration', TIN, 'storefront_photo']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['RESTAURANT_OWN_NAME']).toEqual(['owner_national_id', 'own_name_declaration', TIN, 'storefront_photo']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['RESTAURANT_COMPANY']).toEqual(['certificate_of_incorporation', 'account_holder_id', 'company_authority_letter', TIN, 'storefront_photo']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['RESTAURANT_MANAGER']).toEqual(['account_holder_id', 'owner_authority_letter', 'business_registration', TIN, 'storefront_photo']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['RESTAURANT_OPTIONAL']).toEqual(['food_handler_cert', GRA]);
    for (const [key, list] of Object.entries(DEFAULT_DOCUMENT_CHECKLISTS)) {
      if (!key.startsWith('RESTAURANT')) expect(list, key).not.toContain(TIN);
      if (key !== 'RESTAURANT_OPTIONAL') expect(list, key).not.toContain(GRA);
    }
  });

  it('a checklist change is a config change: 2026-11-12.1 carries the lists into the next owner-signed seed', () => {
    expect(PLATFORM_CONFIG_VERSION).toBe('2026-11-12.1');
    for (const c of desiredPlatformConfig().countries) {
      const lists = c.policy['documentChecklists'] as Record<string, string[]>;
      expect(lists['RESTAURANT'], c.code).toContain(TIN);
      expect(lists['RESTAURANT'], c.code).not.toContain(GRA);
    }
  });

  it('a stored copy that still names the licence reads the TIN certificate in its place, and offers the licence', () => {
    const read = withoutRetiredLists(STORED);
    expect(read['RESTAURANT']).toEqual(['owner_national_id', 'business_registration', TIN, 'storefront_photo']);
    expect(read['RESTAURANT_OWN_NAME']).toEqual(['owner_national_id', 'own_name_declaration', TIN, 'storefront_photo']);
    expect(read['RESTAURANT_COMPANY']).toEqual(['certificate_of_incorporation', 'account_holder_id', 'company_authority_letter', TIN, 'storefront_photo']);
    expect(read['RESTAURANT_MANAGER']).toEqual(['account_holder_id', 'owner_authority_letter', 'business_registration', TIN, 'storefront_photo']);
    expect(read['RESTAURANT_OPTIONAL']).toEqual(['food_handler_cert', GRA]);
    // every other kind exactly as stored
    for (const key of ['SUPERMARKET', 'STORE', 'SERVICE', 'SERVICE_PROVIDER_TRADE_CHEF'] as const) expect(read[key], key).toEqual(STORED[key]);
  });

  it('the rule is idempotent, never doubles the TIN certificate, and never mutates its input', () => {
    const input = { RESTAURANT: [TIN, GRA, 'storefront_photo'], RESTAURANT_OPTIONAL: [TIN, GRA] };
    const once = withRestaurantTinRule(input);
    expect(once['RESTAURANT']).toEqual([TIN, 'storefront_photo']);
    expect(once['RESTAURANT_OPTIONAL']).toEqual([GRA]);
    expect(withRestaurantTinRule(once)).toEqual(once);
    expect(input).toEqual({ RESTAURANT: [TIN, GRA, 'storefront_photo'], RESTAURANT_OPTIONAL: [TIN, GRA] });
  });
});

describe('[RESTAURANT-TIN] the TIN certificate in the registry', () => {
  it('is not retired, is a BUSINESS paper, has no expiry, and a person decides it', () => {
    expect(RETIRED_DOC_TYPES).not.toContain(TIN);
    expect(BUCKET_OF[TIN]).toBe('BUSINESS');
    expect(PERSON_ONLY_DOC_TYPES.has(TIN)).toBe(true);
    expect(ALWAYS_REVIEW_LEGACY_CODES.has(TIN)).toBe(true);
  });
});

describe('[RESTAURANT-TIN] the prepared-food gate’s paper, per store', () => {
  it('a restaurant is asked the TIN certificate; every other store, and an unknown one, the GRA licence as before', () => {
    expect(gateDocFor(GRA, 'GRA Food Restaurant Licence', { vendorId: 'v', vendorType: 'RESTAURANT' })).toEqual({ code: TIN, name: 'TIN Certificate' });
    for (const vendorType of ['SUPERMARKET', 'STORE', 'SERVICE']) {
      expect(gateDocFor(GRA, 'GRA Food Restaurant Licence', { vendorId: 'v', vendorType })).toEqual({ code: GRA, name: 'GRA Food Restaurant Licence' });
    }
    expect(gateDocFor(GRA, 'GRA Food Restaurant Licence', undefined)).toEqual({ code: GRA, name: 'GRA Food Restaurant Licence' });
    // every other gate is untouched, for a restaurant too
    expect(gateDocFor('food_handler_cert', 'Food Handler', { vendorId: 'v', vendorType: 'RESTAURANT' })).toEqual({ code: 'food_handler_cert', name: 'Food Handler' });
  });
});

describe('[RESTAURANT-TIN] who is excused the TIN certificate', () => {
  it('a restaurant live now; never one waiting for its first approval, one not verified, or another kind of store', () => {
    expect(liveRestaurant({ vendorType: 'RESTAURANT', isVerified: true, status: 'ACTIVE' })).toBe(true);
    expect(liveRestaurant({ vendorType: 'RESTAURANT', isVerified: true, status: 'PENDING_APPROVAL' })).toBe(false);
    expect(liveRestaurant({ vendorType: 'RESTAURANT', isVerified: false, status: 'ACTIVE' })).toBe(false);
    expect(liveRestaurant({ vendorType: 'SUPERMARKET', isVerified: true, status: 'ACTIVE' })).toBe(false);
  });

  /** The owner's papers as the two reads see them: a valid GRA licence (held on a subject), and a TIN certificate turned down. */
  const db = (stores: Array<{ id: string; isVerified: boolean; status: string }>, refused: boolean, gra = true) => ({
    vendorOwner: { findUnique: async () => ({ vendors: stores.map((s) => ({ ...s, vendorType: 'RESTAURANT' })) }) },
    verificationDocument: {
      findFirst: async (args: { where: { docType: string } }) => (args.where.docType === GRA
        ? (gra ? { subjectId: 'subject', createdAt: new Date() } : null)
        : (refused ? { id: 'refused-tin' } : null)),
    },
  }) as never;
  const live = { id: 'a', isVerified: true, status: 'ACTIVE' };
  const waiting = { id: 'b', isVerified: false, status: 'PENDING_APPROVAL' };

  it('per store, and on the owner’s list only while every restaurant of theirs is live', async () => {
    expect(await tinCertificateExcused(db([live], false), 'u', 'a')).toBe(true);
    expect(await tinCertificateExcused(db([live, waiting], false), 'u', 'a')).toBe(true);
    expect(await tinCertificateExcused(db([live, waiting], false), 'u', 'b')).toBe(false);
    expect(await tinCertificateExcused(db([live, waiting], false), 'u')).toBe(false);
    expect(await tinCertificateExcused(db([live], false), 'u')).toBe(true);
    expect(await tinCertificateExcused(db([], false), 'u')).toBe(false);
  });

  // [#2494 review S2-1 · owner 12 Nov 2026] only WHILE the GRA licence is valid
  it('never without a valid GRA licence (lapsed, revoked, rejected or never held)', async () => {
    expect(await tinCertificateExcused(db([live], false, false), 'u', 'a')).toBe(false);
    expect(await tinCertificateExcused(db([live], false, false), 'u')).toBe(false);
  });

  it('never once a person rejected or revoked a TIN certificate of the owner’s', async () => {
    expect(await tinCertificateExcused(db([live], true), 'u', 'a')).toBe(false);
    expect(await tinCertificateExcused(db([live], true), 'u')).toBe(false);
  });
});
