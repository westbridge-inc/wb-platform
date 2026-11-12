/**
 * [COMPANY-DOCS Part 3 · owner rulings 10 Nov 2026 (c) + (d)] "Change business type" and "Hand over the account" (the
 * account holder, under /vendor), and the handover naming this person (under /customer). The rules live on the server
 * (apps/api/src/modules/vendor/account-change.ts); these only read and ask.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { OWN_NAME_DECLARATION_VERSION } from '../lib/ownNameCopy';
import type { AccountChangeView, BusinessTypeOption, HandoverNamingMe, HolderAccountChange } from '../lib/accountChangeCopy';
import type { MutationGuard } from './vendorops';

async function unwrap<T>(p: Promise<{ data?: { data?: unknown } }>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}
const passThrough: MutationGuard = (fn) => fn;

export const ACCOUNT_CHANGE_KEY = ['vendor', 'account-change'] as const;
export const HANDOVERS_NAMING_ME_KEY = ['customer', 'account-handovers'] as const;

/** The business type today, the answers open to it, and the change waiting (or the last one decided this week). */
export function useAccountChange(enabled = true) {
  return useQuery({ queryKey: ACCOUNT_CHANGE_KEY, queryFn: () => unwrap<HolderAccountChange>(api.get('/vendor/account-change')), enabled });
}

export function useStartBusinessTypeChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (toOption: BusinessTypeOption) => unwrap<AccountChangeView>(api.post('/vendor/account-change/business-type', { toOption })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ACCOUNT_CHANGE_KEY }); },
  });
}

/** Sign the own-name declaration FOR a pending change to "own name": held for the change, never a switch on its own. */
export function useSignOwnNameForChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.post('/vendor/account-change/own-name', { accept: true, attestationVersion: OWN_NAME_DECLARATION_VERSION })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ACCOUNT_CHANGE_KEY }); },
  });
}

/** Name the new account holder: a fresh "confirm it's you" (pass useStepUp().withStepUp). */
export function useNameNewHolder(guard: MutationGuard = passThrough) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: guard((phone: string) => unwrap<AccountChangeView>(api.post('/vendor/account-change/handover', { phone }))),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ACCOUNT_CHANGE_KEY }); },
  });
}

export function useWithdrawAccountChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap<AccountChangeView>(api.post(`/vendor/account-change/${encodeURIComponent(id)}/withdraw`)),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ACCOUNT_CHANGE_KEY }); },
  });
}

/** The handover naming this person (they hold no store account yet). */
export function useHandoversNamingMe() {
  return useQuery({ queryKey: HANDOVERS_NAMING_ME_KEY, queryFn: () => unwrap<HandoverNamingMe[]>(api.get('/customer/account-handovers')) });
}

export function useAnswerHandover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) => unwrap(api.post(`/customer/account-handovers/${encodeURIComponent(id)}/${accept ? 'accept' : 'decline'}`)),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: HANDOVERS_NAMING_ME_KEY }); },
  });
}
