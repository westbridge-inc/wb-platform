import { SUPPORT_CANCELLATION_REASONS } from '@swift/types/src/order-words';
import type { ReasonField } from '@/components/mc/ReasonDialog';

// ---------------------------------------------------------------------------
// [COORD ruling 8 Nov 2026 on #2412] Swift support's cancel says two things,
// kept apart:
//  - "What the customer sees": one fixed reason, picked here. The customer's
//    push, notification list, order, ride and parcel screens show only this, in
//    the apps' own words (@swift/types SUPPORT_CANCELLATION_REASONS).
//  - "Internal note (Swift only)": the operator's own words. The console's audit
//    record keeps it; it never reaches the customer or the store. ADM-006 still
//    requires it (a consequential action states why).
// ---------------------------------------------------------------------------

/** The dialog field for "What the customer sees". The operator picks; nothing is pre-chosen. */
export const CUSTOMER_REASON_FIELD: ReasonField = {
  kind: 'choice',
  name: 'customerReason',
  label: 'What the customer sees',
  hint: 'The customer is told only this: "Swift support cancelled this order because …". Your note below is never shown to them or to the store.',
  options: Object.entries(SUPPORT_CANCELLATION_REASONS).map(([value, words]) => ({ value, label: words.label })),
};

/** The wording of the reason box in a support cancel: it is Swift's internal note. */
export const INTERNAL_NOTE_WORDS = {
  label: 'Internal note (Swift only)',
  hint: 'What happened and why, for Swift’s permanent record. Never sent to the customer or the store.',
} as const;

/** The code the operator picked, as the route takes it. */
export const customerReasonOf = (values: Record<string, string | number>): string => String(values['customerReason'] ?? '');
