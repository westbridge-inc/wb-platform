/**
 * [COMPANY-DOCS Part 3 · owner rulings 10 Nov 2026 (c) + (d)] The words of "Change business type" and "Hand over the
 * account" (the server: apps/api/src/modules/vendor/account-change.ts). The four answers are sign-up's own words
 * (businessBasisCopy, ownNameCopy). No React Native import: the website reads these words too.
 */
import { COMPANY_CHOICE, MANAGER_TICK, REGISTERED_CHOICE } from './businessBasisCopy';
import { OWN_NAME_CHOICE } from './ownNameCopy';

export type BusinessTypeOption = 'COMPANY' | 'REGISTERED' | 'MANAGER' | 'OWN_NAME';
export type ChangePaperState = 'APPROVED' | 'PENDING' | 'REJECTED' | 'MISSING';
/** `role`: the store kind the paper is filed under (a store of the account whose list asks for it). */
export interface ChangePaper { docType: string; state: ChangePaperState; note: string | null; forChange: boolean; documentId: string | null; role: string }
export interface AccountChangeView {
  id: string;
  kind: 'BUSINESS_TYPE' | 'HOLDER_HANDOVER';
  status: 'PENDING' | 'APPROVED' | 'REFUSED' | 'WITHDRAWN';
  fromOption: BusinessTypeOption | null;
  toOption: BusinessTypeOption | null;
  createdAt: string;
  decidedAt: string | null;
  refusalReason: string | null;
  accepted: boolean | null;
  papers: ChangePaper[];
  papersComplete: boolean;
}
export interface HolderAccountChange { current: BusinessTypeOption; options: BusinessTypeOption[]; handoverOpen: boolean; change: AccountChangeView | null }
export interface HandoverNamingMe extends AccountChangeView { storeNames: string[]; basis: 'OWNER' | 'COMPANY' | 'MANAGER' }

export const BUSINESS_TYPE_TITLE = 'Business type';
export const BUSINESS_TYPE_ROW = 'Change business type';
export const BUSINESS_TYPE_ROW_SUB = 'If you chose the wrong kind of business when you joined';
export const KEEPS_SELLING = 'Your store keeps selling as it does now while Swift checks the new papers. Nothing changes until a person at Swift approves the change.';
export const ASK_BUTTON = 'Ask Swift to change it';
export const WITHDRAW_BUTTON = 'Withdraw this change';

/** Sign-up's words for each answer ("I'm the manager" is sign-up's tick under a registered business). */
export function optionWords(option: BusinessTypeOption): string {
  switch (option) {
    case 'COMPANY': return COMPANY_CHOICE;
    case 'REGISTERED': return REGISTERED_CHOICE;
    case 'MANAGER': return `${REGISTERED_CHOICE}: ${MANAGER_TICK.charAt(0).toLowerCase()}${MANAGER_TICK.slice(1)}`;
    case 'OWN_NAME': return OWN_NAME_CHOICE;
  }
}

/** A short name for an answer, in a sentence ("You asked to change to a registered company"). */
export function optionShort(option: BusinessTypeOption): string {
  switch (option) {
    case 'COMPANY': return 'a registered company';
    case 'REGISTERED': return 'a registered business';
    case 'MANAGER': return 'a registered business, run by its manager';
    case 'OWN_NAME': return 'trading under your own name';
  }
}

export function paperStateWords(state: ChangePaperState): string {
  switch (state) {
    case 'APPROVED': return 'Checked';
    case 'PENDING': return 'Waiting for a person at Swift';
    case 'REJECTED': return 'Not accepted: upload it again';
    case 'MISSING': return 'Upload this';
  }
}

/** Where the change stands, in one sentence. */
export function changeStatusLine(change: AccountChangeView): string {
  const to = change.toOption ? optionShort(change.toOption) : 'the new business type';
  if (change.kind === 'BUSINESS_TYPE') {
    switch (change.status) {
      case 'PENDING': return change.papersComplete
        ? `You asked to change to ${to}. Every paper is checked; a person at Swift now decides the change.`
        : `You asked to change to ${to}. Upload the papers below; a person at Swift checks each one.`;
      case 'APPROVED': return `Your business type is now ${to}.`;
      case 'REFUSED': return `Swift did not change your business type: ${change.refusalReason ?? 'see your notices'}. Your store kept selling as before. You can ask again.`;
      case 'WITHDRAWN': return 'You withdrew the change. Nothing changed.';
    }
  }
  switch (change.status) {
    case 'PENDING': return change.accepted
      ? 'The person you named said yes and is uploading their papers. A person at Swift then decides the handover.'
      : 'Waiting for the person you named to say yes in their own Swift app.';
    case 'APPROVED': return 'The account was handed over.';
    case 'REFUSED': return `Swift did not approve the handover: ${change.refusalReason ?? 'see your notices'}. Nothing changed.`;
    case 'WITHDRAWN': return 'The handover was withdrawn. Nothing changed.';
  }
}

// --- the handover -------------------------------------------------------------------------------------------------------

export const HANDOVER_ROW = 'Hand over the account';
export const HANDOVER_ROW_SUB = 'When someone else will manage the company’s Swift account';
export const HANDOVER_TITLE = 'Hand over the account';
export const HANDOVER_EXPLAIN = 'Name the person who will manage the company’s Swift account from now on. They need their own Swift account. They say yes in their own app and upload their ID, a new letter of authority naming them, and the company’s papers. A person at Swift checks everything. Then the account, with every branch, moves to them and you are signed out of it. Until then nothing changes.';
export const HANDOVER_MMG_NOTE = 'When the account moves, the stores’ MMG numbers are cleared so customers’ money never goes to a person who left. The new account holder adds the business’s MMG number. Customers can pay cash meanwhile; orders already placed keep their number.';
export const HANDOVER_PHONE_LABEL = 'Their phone number on Swift';
export const HANDOVER_BUTTON = 'Name the new account holder';
export const HANDOVER_NOT_APPLICABLE = 'Only a registered company’s (or a manager’s) account is handed over. If your business has a new owner, they sign up with their own papers.';

// --- the person named ---------------------------------------------------------------------------------------------------

export const NAMED_TITLE = 'Account holder';
export function namedLine(h: Pick<HandoverNamingMe, 'storeNames'>): string {
  const [first, ...rest] = h.storeNames;
  const stores = rest.length ? `${first ?? 'A store'} and ${rest.length} more branch${rest.length === 1 ? '' : 'es'}` : first ?? 'A store';
  return `${stores} named you as the new account holder on Swift.`;
}
export const NAMED_EXPLAIN = 'If you say yes, upload your ID, the new letter of authority naming you, and the company’s papers below. A person at Swift checks them. Only then does the account move to you; until then nothing changes.';
export const NAMED_YES = 'Yes, I’ll hold the account';
export const NAMED_NO = 'No';
export const NAMED_WAITING = 'Every paper is checked. A person at Swift now decides the handover.';
