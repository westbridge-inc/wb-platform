/**
 * [COMPANY-DOCS Part 3 · owner ruling 10 Nov 2026 (c)] "Change business type" on the website: the account holder's own
 * reads and asks (the server: apps/api/src/modules/vendor/account-change.ts). The words are the phone's
 * (apps/mobile lib/accountChangeCopy), one source for both.
 */
import { apiFetch } from '@/lib/auth';
import type { BusinessTypeOption, HolderAccountChange } from '../../../mobile/src/lib/accountChangeCopy';

export {
  ASK_BUTTON, BUSINESS_TYPE_ROW, BUSINESS_TYPE_ROW_SUB, BUSINESS_TYPE_TITLE, KEEPS_SELLING, WITHDRAW_BUTTON, changeStatusLine, optionWords,
  paperStateWords,
} from '../../../mobile/src/lib/accountChangeCopy';
export type { AccountChangeView, BusinessTypeOption, ChangePaper, HolderAccountChange } from '../../../mobile/src/lib/accountChangeCopy';

const V = '/api/v1/vendor/account-change';

export const getAccountChange = (): Promise<HolderAccountChange> => apiFetch(V).then((r: { data: HolderAccountChange }) => r.data);
export const startBusinessTypeChange = (toOption: BusinessTypeOption) =>
  apiFetch(`${V}/business-type`, { method: 'POST', body: JSON.stringify({ toOption }) });
export const withdrawAccountChange = (id: string) => apiFetch(`${V}/${encodeURIComponent(id)}/withdraw`, { method: 'POST' });
/** A change to "I trade under my own name": the declaration is signed here, held for the change (never a switch alone). */
export const signOwnNameForChange = (attestationVersion: string) =>
  apiFetch(`${V}/own-name`, { method: 'POST', body: JSON.stringify({ accept: true, attestationVersion }) });

/** On the website the handover is not offered: the person named answers and files their papers in their own app. */
export const HANDOVER_IN_APP = 'A company’s account is handed over in the Swift app: Account → Change business type → Hand over the account.';
