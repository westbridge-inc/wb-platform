import type { ProviderCheck } from './api';

/** [CARD-REFUND-LOOKUP] What "Check with the card provider" found, in words: on Card payments (solo) and on Approvals
 *  (the person executing the approved check). Only REFUNDED says money is back. */
export const CHECK_WORDS: Record<ProviderCheck, string> = {
  REFUNDED: "PowerTranz's record shows the whole payment back. Recorded as refunded.",
  OWNER_HOLD: "PowerTranz's record shows a refund that is not the whole payment. Nothing was recorded: it is held for the owner, who has been told.",
  NO_REFUND_ON_RECORD: "PowerTranz's record shows no refund on this payment yet. Nothing was recorded, and nothing was sent again.",
  NOT_KNOWN: 'PowerTranz gave no answer Swift could read. Nothing was recorded, and nothing was sent again. Check its portal, or try again later.',
  ASKED_RECENTLY: 'This payment was looked up moments ago. Nothing was recorded. Try again in a few minutes.',
};

/** The words for a check result, or null for anything else. */
export const checkWords = (check: unknown): string | null =>
  typeof check === 'string' && Object.prototype.hasOwnProperty.call(CHECK_WORDS, check) ? CHECK_WORDS[check as ProviderCheck] : null;
