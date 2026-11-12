/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [FOLLOWUPS-2475 · COMPANY-DOCS Part 2 seam] On a business type change's papers (the account holder's), a letter of
// authority still to give offers "Ask a director (the owner) to sign in Swift" right under its paper upload, which
// stays: exactly as on the Documents checklist, naming the letter for the change. Not once one is on file (waiting or
// approved); again after a person did not accept it. Never on a handover's papers (the person named is not the account
// holder the letter route serves), never for any other paper. The cards are stand-ins (the real card hides itself
// while the server's switch is off: AuthorityLetterEsignCard.switch.navigation.test.ts).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, children);
  const Pressable = ({ children, onPress, accessibilityLabel }: any) =>
    R.createElement('button', { type: 'button', 'aria-label': accessibilityLabel, onClick: onPress }, children);
  return { View, Pressable };
});
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../kit', async () => {
  const R = await import('react');
  return {
    BrandCheckbox: () => null, Card: ({ children }: any) => R.createElement('div', null, children), CheckRow: () => null, PillButton: () => null,
    T: ({ children }: any) => R.createElement('span', null, children),
  };
});
vi.mock('./OwnNameChoiceCard', () => ({ OwnNameDeclarationText: () => null }));
vi.mock('../../hooks/verification', () => ({ useVerificationStatus: () => ({ data: undefined, dataUpdatedAt: 0 }) }));
vi.mock('../../hooks/accountChange', () => ({ useSignOwnNameForChange: () => ({ mutate: () => undefined, isPending: false, isError: false }) }));
vi.mock('../../lib/websiteUrl', () => ({ WEBSITE_URL: 'https://example.invalid' }));
vi.mock('./AuthorityLetterEsignCard', async () => {
  const R = await import('react');
  return { AuthorityLetterEsignCard: ({ role, docType, kind, docRejected, forChange }: { role: string; docType: string; kind: string; docRejected?: boolean; forChange?: boolean }) =>
    R.createElement('div', { 'data-esign': `${role}:${docType}:${kind}${docRejected ? ':again' : ''}${forChange ? ':for-change' : ''}` }) };
});
vi.mock('./DocumentUploadCard', async () => {
  const R = await import('react');
  return { DocumentUploadCard: ({ docType }: { docType: string }) => R.createElement('div', { 'data-doc': docType }) };
});

import { ChangePapersList } from './ChangePapersList';
import type { ChangePaper } from '../../lib/accountChangeCopy';

const paper = (docType: string, state: ChangePaper['state'] = 'MISSING', role = 'RESTAURANT'): ChangePaper =>
  ({ docType, state, note: null, forChange: state !== 'MISSING', documentId: state === 'MISSING' ? null : `d-${docType}`, role } as ChangePaper);
const TO_COMPANY = ['certificate_of_incorporation', 'account_holder_id', 'company_authority_letter', 'storefront_photo'];
const TO_MANAGER = ['account_holder_id', 'owner_authority_letter', 'business_registration', 'storefront_photo'];

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
const mount = async (papers: ChangePaper[], signLetterInSwift?: boolean) => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(React.createElement(ChangePapersList, { papers, onChanged: () => undefined, ...(signLetterInSwift === undefined ? {} : { signLetterInSwift }) })));
};
const esign = () => [...host!.querySelectorAll('[data-esign]')].map((n) => n.getAttribute('data-esign'));
const uploads = () => [...host!.querySelectorAll('[data-doc]')].map((n) => n.getAttribute('data-doc'));
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); host = undefined; root = undefined;
});

describe('[FOLLOWUPS-2475] a business type change offers signing its letter in Swift, beside the paper upload', () => {
  it('to a company: ask a director, right under the letter’s paper upload (which stays), naming the change’s letter', async () => {
    await mount(TO_COMPANY.map((t) => paper(t)), true);
    expect(uploads()).toEqual(TO_COMPANY);
    expect(esign()).toEqual(['RESTAURANT:company_authority_letter:director:for-change']);
    const letterRow = host!.querySelector('[data-doc="company_authority_letter"]')!;
    expect(letterRow.nextElementSibling?.getAttribute('data-esign')).toBe('RESTAURANT:company_authority_letter:director:for-change');
  });

  it('to a manager: ask the business’s owner', async () => {
    await mount(TO_MANAGER.map((t) => paper(t, 'MISSING', 'STORE')), true);
    expect(esign()).toEqual(['STORE:owner_authority_letter:owner:for-change']);
  });

  it('a letter waiting for review or approved: nothing more to sign; one a person did not accept: offered again', async () => {
    await mount([paper('company_authority_letter', 'PENDING')], true);
    expect(esign()).toEqual([]);
    await mount([paper('company_authority_letter', 'APPROVED')], true);
    expect(esign()).toEqual([]);
    await mount([paper('company_authority_letter', 'REJECTED')], true);
    expect(esign()).toEqual(['RESTAURANT:company_authority_letter:director:again:for-change']);
  });

  it('a handover’s papers (the person named) and any list not asked to: the paper upload only', async () => {
    await mount(TO_COMPANY.map((t) => paper(t)));
    expect(esign()).toEqual([]);
    expect(uploads()).toEqual(TO_COMPANY);
    await mount(TO_COMPANY.map((t) => paper(t)), false);
    expect(esign()).toEqual([]);
  });

  it('a change to an owner’s own business has no letter, so nothing is signed in Swift', async () => {
    await mount(['owner_national_id', 'business_registration', 'storefront_photo'].map((t) => paper(t)), true);
    expect(esign()).toEqual([]);
  });
});
