import { describe, expect, it } from 'vitest';
import { CALL_SCREEN_TEMPLATE, INAPP_WORDS, OUTGOING_HANDLE, backupRevealText, inAppErrorText, offerInApp, revealsBackup } from './inAppCalls';

// [INAPP-CALLS] When "Call in app" shows, and the words people read.
describe('[INAPP-CALLS] offerInApp', () => {
  it('only with the switch on, the calling module in this build, an order, and never for the parcel recipient', () => {
    const on = { enabled: true };
    expect(offerInApp(on, true, 'o1', 'rider')).toBe(true);
    expect(offerInApp(on, true, 'o1', 'store')).toBe(true);
    expect(offerInApp(on, true, 'o1', 'recipient')).toBe(false);
    expect(offerInApp({ enabled: false }, true, 'o1', 'rider')).toBe(false);
    expect(offerInApp(null, true, 'o1', 'rider')).toBe(false);
    expect(offerInApp(on, false, 'o1', 'rider')).toBe(false); // builds 11/12: no module
    expect(offerInApp(on, true, null, 'rider')).toBe(false);
  });
});

describe('[INAPP-CALLS] words', () => {
  it('every refusal is plain words with a way forward, and none shows a number', () => {
    for (const code of ['INAPP_CALLS_OFF', 'CALL_ORDER_NOT_LIVE', 'CALL_IN_PROGRESS', 'CALL_LIMIT_REACHED', 'INAPP_NO_ONE', 'INAPP_NOT_FOR_TARGET', 'INAPP_NOT_REACHABLE', 'INAPP_CALLS_TROUBLE', 'MIC_REFUSED', 'WHATEVER', null]) {
      const text = inAppErrorText(code);
      expect(text.length, String(code)).toBeGreaterThan(20);
      expect(text).not.toMatch(/\d{3}/);
    }
    expect(inAppErrorText('INAPP_NOT_FOR_TARGET')).toContain('Call via Swift');
  });

  it('[CALLS-REACH] nobody for them can take an in-app call: the server\'s own words, never a misleading error', () => {
    expect(inAppErrorText('INAPP_NOT_REACHABLE')).toBe("They can't take calls in the Swift app. Message them in chat instead.");
    expect(INAPP_WORDS.notReachable).not.toMatch(/right now|try again/i); // [review S3-4] they may have refused for good
    // [review S3-4] Swift's own trouble (the registry down) is never told as theirs.
    expect(inAppErrorText('INAPP_CALLS_TROUBLE')).toBe('Swift calls are having trouble right now. Try again in a minute, or message them in chat.');
    // Swift rings their phone only while the phone bridge is on: the "calling" note never promises it.
    expect(INAPP_WORDS.callingHow).not.toMatch(/rings their phone/i);
  });

  it('the bridge\'s daily rules (owner 6 Nov) read exactly as they do for Call via Swift', () => {
    expect(inAppErrorText('CALL_CALLER_BUSY')).toBe('You already have a Swift call ringing. Answer it, or try again in a minute.');
    expect(inAppErrorText('CALL_USER_DAILY_LIMIT_REACHED')).toBe('You have used your Swift calls for today. Message them in chat, or ask support.');
    expect(inAppErrorText('CALL_DAILY_LIMIT_REACHED')).toBe('Swift calls are busy right now. Message them in chat, or ask support.');
  });

  it('the microphone is explained before it is asked for, and says Swift never records', () => {
    expect(INAPP_WORDS.micWhy).toBe('Swift needs the microphone so you can talk on in-app calls. Swift never records calls.');
    expect(INAPP_WORDS.label).toBe('Call in app');
  });

  it('the call screen shows the server\'s role line; recent calls show "Swift"', () => {
    expect(CALL_SCREEN_TEMPLATE).toBe('${swiftLine}');
    expect(OUTGOING_HANDLE).toBe('Swift');
  });
});

describe('[CALLS-UX · owner 8 Nov] which refusals bring the backup call control back', () => {
  it('the in-app call cannot happen: they cannot be rung, no account to ring, Swift cannot tell, the switch went off, no app, no module, no microphone, the connect failed', () => {
    for (const code of ['INAPP_NOT_REACHABLE', 'INAPP_NO_ONE', 'INAPP_CALLS_TROUBLE', 'INAPP_CALLS_OFF', 'INAPP_NOT_FOR_TARGET', 'INAPP_UNAVAILABLE', 'MIC_REFUSED', 'INAPP_CONNECT_FAILED', 'CALL_PROVIDER_FAILED']) {
      expect(revealsBackup(code)).toBe(true);
    }
  });

  it('not the shared caps, a finished order, a call already ringing, or an unknown error (those hold for every call)', () => {
    for (const code of ['CALL_LIMIT_REACHED', 'CALL_ORDER_NOT_LIVE', 'CALL_IN_PROGRESS', 'CALL_CALLER_BUSY', 'CALL_USER_DAILY_LIMIT_REACHED', 'CALL_DAILY_LIMIT_REACHED', 'NOT_FOUND', 'SOMETHING']) {
      expect(revealsBackup(code)).toBe(false);
    }
    expect(revealsBackup(null)).toBe(false);
    expect(revealsBackup(undefined)).toBe(false);
  });
});

describe('[CALLS-UX review S2] the words when the backup comes back name the control that really appears', () => {
  const codes = ['INAPP_NOT_REACHABLE', 'INAPP_NO_ONE', 'INAPP_CALLS_TROUBLE', 'INAPP_CALLS_OFF', 'INAPP_NOT_FOR_TARGET', 'INAPP_UNAVAILABLE', 'MIC_REFUSED', 'INAPP_CONNECT_FAILED', 'CALL_PROVIDER_FAILED', 'SOMETHING', null];

  it('the dialler: "Tap Call to ring their phone", never "Call via Swift" and never "instead"', () => {
    expect(backupRevealText('INAPP_NOT_REACHABLE', 'dial')).toBe("They can't take calls in the Swift app. Tap Call to ring their phone, or message them in chat.");
    for (const code of codes) {
      const text = backupRevealText(code, 'dial');
      expect(text, String(code)).toContain('Tap Call to ring their phone');
      expect(text).not.toMatch(/Call via Swift|instead/);
    }
  });

  it('the bridge: "Call via Swift"', () => {
    expect(backupRevealText('INAPP_NOT_REACHABLE', 'bridge')).toBe("They can't take calls in the Swift app. Tap Call via Swift to reach them by phone, or message them in chat.");
    for (const code of codes) expect(backupRevealText(code, 'bridge'), String(code)).toContain('Tap Call via Swift');
  });

  it('no backup at all (bridge off, no number): chat only, never a button that is not there', () => {
    for (const code of codes) expect(backupRevealText(code, 'none'), String(code)).not.toMatch(/Tap Call|Call via Swift/);
    expect(backupRevealText('INAPP_NOT_REACHABLE', 'none')).toBe("They can't take calls in the Swift app. Message them in chat.");
    expect(backupRevealText('INAPP_CONNECT_FAILED', 'none')).toBe("Swift couldn't connect the call in the app. Try again in a minute, or message them in chat.");
  });

  it('the microphone refused: Settings, then the backup that is there', () => {
    expect(backupRevealText('MIC_REFUSED', 'dial')).toBe('The microphone is off for Swift, so in-app calls cannot work. You can turn it on in Settings. Tap Call to ring their phone, or message them in chat.');
    expect(backupRevealText('MIC_REFUSED', 'bridge')).toBe('The microphone is off for Swift, so in-app calls cannot work. You can turn it on in Settings. Tap Call via Swift to reach them by phone, or message them in chat.');
  });

  it('[review S3-4] never "right now" or "try again" for them (they may have refused for good); no number', () => {
    for (const code of ['INAPP_NOT_REACHABLE', 'INAPP_NO_ONE', 'INAPP_NOT_FOR_TARGET']) {
      for (const kind of ['dial', 'bridge', 'none'] as const) expect(backupRevealText(code, kind)).not.toMatch(/right now|try again/i);
    }
    for (const code of codes) for (const kind of ['dial', 'bridge', 'none'] as const) expect(backupRevealText(code, kind)).not.toMatch(/\d{3}/);
  });
});
