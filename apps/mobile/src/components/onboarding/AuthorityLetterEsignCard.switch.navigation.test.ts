/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [FOLLOWUPS-2475 · COMPANY-DOCS Part 2] The REAL letter card, as a business type change's papers place it: it shows
// nothing while the server's AUTHORITY_LETTER_ESIGN switch is off (GET `enabled` false, or an older server), so the paper
// upload is the only path; on, it offers the form, and on a change's papers it names the letter the change asks for
// (`docType`), which the Documents checklist never sends. The API, the kit and the signed-in account are stand-ins.
// Synthetic names and a reserved-looking number only.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
  read: { enabled: false as boolean, accountBasis: 'OWNER', request: null as unknown },
  asked: [] as unknown[],
  inputs: new Map<string, (v: string) => void>(),
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  return { View: ({ children }: any) => R.createElement('div', null, children) };
});
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../kit', async () => {
  const R = await import('react');
  return {
    Card: ({ children }: any) => R.createElement('section', { 'data-card': 'esign' }, children),
    DialCodeChip: () => null,
    LabeledInput: ({ label, onChangeText }: { label: string; onChangeText: (v: string) => void }) => {
      fx.inputs.set(label, onChangeText);
      return R.createElement('label', null, label);
    },
    LinkText: ({ label }: { label: string }) => R.createElement('span', null, label),
    PillButton: ({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress: () => void }) =>
      R.createElement('button', { type: 'button', disabled, onClick: onPress }, label),
    T: ({ children }: any) => R.createElement('span', null, children),
  };
});
vi.mock('../../stores/authStore', () => ({ useAuthStore: (pick: (s: unknown) => unknown) => pick({ user: { phone: '+5926000001' } }) }));
vi.mock('../../services/api', () => ({
  vendorApi: {
    authorityLetter: async () => ({ data: { data: fx.read } }),
    askAuthorityLetter: async (body: unknown) => { fx.asked.push(body); return { data: { data: { request: null } } }; },
    resendAuthorityLetter: async () => ({ data: {} }),
    cancelAuthorityLetter: async () => ({ data: {} }),
  },
}));

import { AuthorityLetterEsignCard } from './AuthorityLetterEsignCard';
import { ESIGN_SEND, esignFieldLabels } from '../../lib/authorityLetterCopy';

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
const mount = async (props: { forChange?: boolean }) => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root!.render(React.createElement(QueryClientProvider, { client },
    React.createElement(AuthorityLetterEsignCard, { role: 'RESTAURANT', docType: 'company_authority_letter', kind: 'director', ...props }))));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const fill = async () => {
  const labels = esignFieldLabels('director');
  const typed: Record<string, string> = {
    [labels.businessName]: 'Sample Foods Ltd.', [labels.registrationNumber]: 'C-0001', [labels.requesterName]: 'Sample Holder',
    [labels.requesterRole]: 'Manager', [labels.signerName]: 'Other Director', [labels.signerPhone]: '6000002',
  };
  for (const [label, value] of Object.entries(typed)) await act(async () => fx.inputs.get(label)!(value));
};
const send = async () => {
  const button = [...host!.querySelectorAll('button')].find((b) => b.textContent === ESIGN_SEND)!;
  expect(button.disabled).toBe(false);
  await act(async () => { button.click(); await new Promise((r) => setTimeout(r, 0)); });
};
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); host = undefined; root = undefined;
  fx.asked.length = 0; fx.inputs.clear(); fx.read = { enabled: false, accountBasis: 'OWNER', request: null };
});

describe('[FOLLOWUPS-2475] the letter card on a change’s papers follows the server’s switch', () => {
  it('switched off: nothing at all (the paper upload above is the only path)', async () => {
    await mount({ forChange: true });
    expect(host!.querySelector('[data-card]')).toBeNull();
    expect(host!.textContent).toBe('');
  });

  it('an older server (no `enabled`): nothing either', async () => {
    fx.read = { accountBasis: 'OWNER', request: null } as typeof fx.read;
    await mount({ forChange: true });
    expect(host!.querySelector('[data-card]')).toBeNull();
  });

  it('switched on, on a change’s papers: the form, and the request names the change’s letter', async () => {
    fx.read = { enabled: true, accountBasis: 'OWNER', request: null };
    await mount({ forChange: true });
    expect(host!.querySelector('[data-card]')).not.toBeNull();
    await fill();
    await send();
    expect(fx.asked).toEqual([{
      businessName: 'Sample Foods Ltd.', registrationNumber: 'C-0001', requesterName: 'Sample Holder', requesterRole: 'Manager',
      signerName: 'Other Director', signerPhone: '+5926000002', docType: 'company_authority_letter',
    }]);
  });

  it('switched on, on the Documents checklist: the request is as before (no docType: the account’s own letter)', async () => {
    fx.read = { enabled: true, accountBasis: 'COMPANY', request: null };
    await mount({});
    await fill();
    await send();
    expect(fx.asked).toHaveLength(1);
    expect(fx.asked[0]).not.toHaveProperty('docType');
  });
});
