/**
 * [#2412 security review, 8 Nov 2026] A reason a PERSON gives for closing an order
 * (a store's decline, a customer's or a parcel sender's cancel), as it may be
 * recorded. The order's `cancellationReason` also carries the codes the system and
 * Swift support write (NO_DRIVERS_AVAILABLE, SUPPORT_STORE_CLOSED…), and the apps
 * put words on known codes. So a person's reason may never look like one: a
 * code-shaped value (capitals, digits, underscores) or anything starting
 * "SUPPORT_" is not a person's reason, and is refused or dropped by the caller.
 * Otherwise a store, a customer or a sender could type a code and be read out as
 * Swift support (attribution forgery).
 */
export const CODE_SHAPED_REASON = /^[A-Z0-9_]+$/;

/** The reason trimmed, or null when there is none or it looks like a system or Swift support code. */
export function personTypedReason(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  if (CODE_SHAPED_REASON.test(text) || /^support_/i.test(text)) return null;
  return text;
}
