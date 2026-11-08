/**
 * [INAPP-CALLS · owner 6 Nov 2026, "B"] Calling inside the Swift app.
 *
 * "Call in app" sits beside "Call via Swift". It goes over the internet: the
 * other person's phone shows a full call screen, "Swift: your rider is calling
 * about your order" (role words, never a number). If they do not answer in the
 * app, Swift rings their phone through the call bridge in the same call.
 *
 * The button shows only when ALL of these hold:
 * - the server's INAPP_CALLS switch is on (GET /calls/app/config);
 * - this phone's app has the calling module (build 13 and later; the module is
 *   loaded with a guarded require, so builds 11/12 simply never show it);
 * - there is an order, and the person is not the parcel recipient (no app).
 *
 * Pure: no React, no network, no native module.
 */
import { bridgeErrorText, type CallTarget } from './callBridge';

export interface InAppConfig {
  enabled: boolean;
}

/** Offer "Call in app" for this person on this order? */
export function offerInApp(config: InAppConfig | null | undefined, available: boolean, orderId: string | null | undefined, target: CallTarget): boolean {
  return !!config?.enabled && available && !!orderId && target !== 'recipient';
}

/** The words people read. Plain, short, no number. */
export const INAPP_WORDS = {
  label: 'Call in app',
  hint: 'Calls them inside the Swift app, over the internet. Your number stays hidden.',
  a11y: 'Call in the Swift app',
  calling: 'Calling in the app',
  // [CALLS-REACH] Never promises a phone call: Swift rings their phone only while the phone bridge is on.
  callingHow: 'Their phone shows a Swift call screen. If they cannot answer, you will hear it on the call.',
  endLabel: 'End call',
  failedTitle: 'Call not started',
  micTitle: 'Microphone needed',
  /** Shown before the system asks (Android), and after a refusal (both). */
  micWhy: 'Swift needs the microphone so you can talk on in-app calls. Swift never records calls.',
  micRefused: 'The microphone is off for Swift, so in-app calls cannot work. You can turn it on in Settings, or use Call via Swift.',
  /** [CALLS-REACH] Android, once a live order exists: so the other side's in-app call can ring this phone. */
  reachTitle: 'Let Swift calls reach you',
  reachWhyCustomer: 'So the store, rider or driver can call you in Swift, allow the microphone. Swift never records calls.',
  reachWhyPartner: 'So the people on your orders can call you in Swift, allow the microphone. Swift never records calls.',
  /** The caller's words when nobody for them can take an in-app call (server code INAPP_NOT_REACHABLE). Not "right
   *  now": they may have turned the microphone off for good. */
  notReachable: "They can't take calls in the Swift app. Message them in chat instead.",
  /** Swift could not tell which phones can ring (server code INAPP_CALLS_TROUBLE): Swift's trouble, never theirs. */
  callsTrouble: 'Swift calls are having trouble right now. Try again in a minute, or message them in chat.',
} as const;

/** The server's refusal, in the person's words. Unknown codes get a safe general line. */
export function inAppErrorText(code: string | null | undefined): string {
  switch (code) {
    case 'INAPP_CALLS_OFF': return 'In-app calls are not on yet. Use Call via Swift, or message them in chat.';
    case 'CALL_ORDER_NOT_LIVE': return 'This order is finished, so Swift can no longer connect a call. Message them in chat or ask support.';
    case 'CALL_IN_PROGRESS': return 'A Swift call on this order is already ringing. Answer it, or try again in a minute.';
    case 'CALL_LIMIT_REACHED': return 'Swift has connected as many calls as it can for this order. Message them in chat, or ask support.';
    case 'INAPP_NO_ONE': return 'There is no one to call in the app for this. Message them in chat, or ask support.';
    case 'INAPP_NOT_FOR_TARGET': return 'They do not have the Swift app. Use Call via Swift instead.';
    case 'INAPP_NOT_REACHABLE': return INAPP_WORDS.notReachable;
    case 'INAPP_CALLS_TROUBLE': return INAPP_WORDS.callsTrouble;
    case 'MIC_REFUSED': return INAPP_WORDS.micRefused;
    // [owner 6 Nov] The bridge's daily rules hold for in-app calls too: the bridge's own words.
    case 'CALL_CALLER_BUSY':
    case 'CALL_USER_DAILY_LIMIT_REACHED':
    case 'CALL_DAILY_LIMIT_REACHED':
      return bridgeErrorText(code);
    default: return 'Swift could not start the in-app call. Try again, use Call via Swift, or message them in chat.';
  }
}

/**
 * [CALLS-UX · owner 8 Nov 2026, "A"] In-app first: the dial / "Call via Swift" control shows only as a backup.
 * These refusals mean the in-app call cannot happen for this person, so the backup control comes back:
 * - INAPP_NOT_REACHABLE: no phone of theirs can be rung in the app (and Swift cannot ring their phone instead);
 * - INAPP_NO_ONE: there is no Swift account to ring for them (a web order's customer, for one);
 * - INAPP_CALLS_TROUBLE: Swift cannot tell which phones can ring right now;
 * - INAPP_CALLS_OFF: the switch went off since this phone last read it;
 * - INAPP_NOT_FOR_TARGET: the person has no Swift app (the parcel recipient);
 * - INAPP_UNAVAILABLE: this phone's app has no calling module;
 * - MIC_REFUSED: this phone cannot use the microphone for Swift;
 * - INAPP_CONNECT_FAILED: the server accepted, but this phone's call never reached Twilio (connect threw, or the
 *   SDK reported connectFailure; services/inAppVoice placeInAppCall);
 * - CALL_PROVIDER_FAILED: Swift could not set the in-app call up (503); the phone's own dialler does not need it.
 * Not the caps, a finished order or a call already ringing: those hold for "Call via Swift" too.
 */
const BACKUP_CODES: ReadonlySet<string> = new Set([
  'INAPP_NOT_REACHABLE',
  'INAPP_NO_ONE',
  'INAPP_CALLS_TROUBLE',
  'INAPP_CALLS_OFF',
  'INAPP_NOT_FOR_TARGET',
  'INAPP_UNAVAILABLE',
  'MIC_REFUSED',
  'INAPP_CONNECT_FAILED',
  'CALL_PROVIDER_FAILED',
]);

export function revealsBackup(code: string | null | undefined): boolean {
  return !!code && BACKUP_CODES.has(code);
}

/**
 * [CALLS-UX review S2] The backup control that comes back, exactly as CallParty draws it for this person: today's
 * dialler ("Call"), the phone bridge ("Call via Swift"), or nothing (bridge off and no number for them: chat only).
 */
export type BackupKind = 'dial' | 'bridge' | 'none';

/** What went wrong, in the person's words. Never "right now" for them: they may have refused for good (S3-4). */
const BACKUP_LEAD: Readonly<Record<string, string>> = {
  INAPP_NOT_REACHABLE: "They can't take calls in the Swift app.",
  INAPP_NO_ONE: "They can't take calls in the Swift app.",
  INAPP_NOT_FOR_TARGET: "They can't take calls in the Swift app.",
  INAPP_CALLS_TROUBLE: 'Swift calls in the app are having trouble right now.',
  INAPP_CALLS_OFF: 'In-app calls are not on right now.',
  INAPP_UNAVAILABLE: "This phone can't make calls in the Swift app.",
  INAPP_CONNECT_FAILED: "Swift couldn't connect the call in the app.",
  CALL_PROVIDER_FAILED: "Swift couldn't connect the call in the app.",
  MIC_REFUSED: 'The microphone is off for Swift, so in-app calls cannot work. You can turn it on in Settings.',
};
/** Swift's own trouble: worth trying again in a minute when there is no backup to tap. */
const PASSING = new Set(['INAPP_CALLS_TROUBLE', 'INAPP_CONNECT_FAILED', 'CALL_PROVIDER_FAILED']);

/**
 * [CALLS-UX review S2] The words when the in-app call cannot happen and the backup comes back: they point at the
 * control that really appears (the server's own sentence says "message them in chat instead", which reads wrong
 * beside a Call button, so it is not shown here).
 */
export function backupRevealText(code: string | null | undefined, kind: BackupKind): string {
  const lead = (code ? BACKUP_LEAD[code] : undefined) ?? "Swift couldn't start the call in the app.";
  const tail = kind === 'dial' ? 'Tap Call to ring their phone, or message them in chat.'
    : kind === 'bridge' ? 'Tap Call via Swift to reach them by phone, or message them in chat.'
    : code && PASSING.has(code) ? 'Try again in a minute, or message them in chat.'
    : 'Message them in chat.';
  return `${lead} ${tail}`;
}

/** The call-screen template the native module fills from the server's `swiftLine` parameter. */
export const CALL_SCREEN_TEMPLATE = '$' + '{swiftLine}';
/** What CallKit shows in the phone's recent calls for a call this person placed (never a number). */
export const OUTGOING_HANDLE = 'Swift';
