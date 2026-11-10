/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [COMPANY-DOCS PART 2 · owner 10 Nov 2026 ~07:5xZ] On the REAL store checklist, a company's (or a manager's) letter of
// authority still to give offers "Ask a director (the owner) to sign in Swift" right under its paper upload, which
// stays: the in-app letter is the main path, the paper the fallback. Not once a letter is on file (waiting or approved);
// again after a person did not accept it. No other paper is ever signed in Swift. The cards are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, children);
  const Pressable = ({ children, onPress, accessibilityLabel, testID }: any) =>
    R.createElement('button', { type: 'button', 'aria-label': accessibilityLabel, 'data-testid': testID, onClick: onPress },
      typeof children === 'function' ? children({ pressed: false }) : children);
  return { View, Pressable };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../kit', async () => {
  const R = await import('react');
  return {
    BrandCheckbox: () => null,
    EmptyState: ({ title }: { title: string }) => R.createElement('p', null, title),
    Spinner: () => R.createElement('p', null, 'loading'),
    T: ({ children }: any) => R.createElement('span', null, children),
  };
});
vi.mock('./OwnNameCard', async () => {
  const R = await import('react');
  return { OwnNameCard: ({ mode }: { mode: string }) => R.createElement('div', { 'data-own-name': mode }) };
});
vi.mock('./FoodHandlersCard', () => ({ FoodHandlersCard: () => null }));
vi.mock('./StoreWeeklyFeeCard', () => ({ StoreWeeklyFeeCard: () => null }));
vi.mock('./AuthorityLetterEsignCard', async () => {
  const R = await import('react');
  return { AuthorityLetterEsignCard: ({ docType, kind, docRejected }: { docType: string; kind: string; docRejected?: boolean }) =>
    R.createElement('div', { 'data-esign': `${docType}:${kind}${docRejected ? ':again' : ''}` }) };
});
vi.mock('./DocumentUploadCard', async () => {
  const R = await import('react');
  return { DocumentUploadCard: ({ docType }: { docType: string }) => R.createElement('div', { 'data-doc': docType }) };
});

import { DocumentChecklist } from './DocumentChecklist';

const COMPANY = ['certificate_of_incorporation', 'account_holder_id', 'company_authority_letter', 'storefront_photo'];
const MANAGER = ['account_holder_id', 'owner_authority_letter', 'business_registration', 'storefront_photo'];
const doc = (docType: string, status: string) => ({ id: `d-${docType}`, docType, status, expiresAt: null, createdAt: '2026-11-10T00:00:00.000Z' });

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
const mount = async (checklist: string[], documents: unknown[] = []) => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(React.createElement(DocumentChecklist, { role: 'STORE', status: { checklist, optional: [], documents, accountBasis: 'COMPANY' }, storeName: 'Kariba Ltd.', storeId: 'store-1' })));
};
const esign = () => [...host!.querySelectorAll('[data-esign]')].map((n) => n.getAttribute('data-esign'));
const uploads = () => [...host!.querySelectorAll('[data-doc]')].map((n) => n.getAttribute('data-doc'));
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); host = undefined; root = undefined;
});

describe('[COMPANY-DOCS PART 2] the phone offers signing the letter in Swift, beside the paper upload', () => {
  it('a company: ask a director, under the letter’s paper upload (which stays)', async () => {
    await mount(COMPANY);
    expect(esign()).toEqual(['company_authority_letter:director']);
    expect(uploads()).toEqual(COMPANY);
    const letterRow = host!.querySelector('[data-doc="company_authority_letter"]')!;
    expect(letterRow.nextElementSibling?.getAttribute('data-esign')).toBe('company_authority_letter:director');
  });

  it('a manager: ask the owner', async () => {
    await mount(MANAGER);
    expect(esign()).toEqual(['owner_authority_letter:owner']);
  });

  it('a letter waiting for review or approved: nothing more to sign; one a person did not accept: offered again', async () => {
    await mount(COMPANY, [doc('company_authority_letter', 'PENDING')]);
    expect(esign()).toEqual([]);
    await act(async () => root!.unmount()); host!.remove();
    await mount(COMPANY, [doc('company_authority_letter', 'APPROVED')]);
    expect(esign()).toEqual([]);
    await act(async () => root!.unmount()); host!.remove();
    await mount(COMPANY, [doc('company_authority_letter', 'REJECTED')]);
    expect(esign()).toEqual(['company_authority_letter:director:again']);
  });

  it('an owner’s own checklist has no letter, so nothing is signed in Swift', async () => {
    await mount(['owner_national_id', 'business_registration', 'storefront_photo']);
    expect(esign()).toEqual([]);
  });
});
