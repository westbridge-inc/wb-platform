import { describe, it, expect } from 'vitest';
import type { UserRole } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGAL_VERSION, PRIVACY, TERMS, DRIVER_AGREEMENT, VENDOR_AGREEMENT } from '../modules/legal/legal.routes';
import { MATERIAL_CHANGES, NON_MATERIAL_CHANGES, acceptanceStatus, materialVersion } from '../modules/legal/reaccept';
import { PROCESSOR_REGISTER } from '../modules/legal/processor-register';
import { callScreenLine } from '../modules/calls/inapp-calls';
import { inAppIdentity } from '../modules/calls/inapp-calls-switch';
import { TwilioVoiceProvider } from '../providers/voice/twilio-voice';

// ---------------------------------------------------------------------------
// [LEGAL-CALLS · owner ruling 9 Nov 2026] In-app calls (INAPP_CALLS) in the
// Privacy Policy: what Twilio receives for a call made inside the Swift app,
// that it is never recorded, the microphone, and what Swift keeps. Each
// sentence is held to the code that makes it true, and the wording ships under
// its own legal version, MATERIAL (a new processor flow, as 2026-10-25.1 and
// 2026-10-27): a fresh tick with the in-app notice for everyone.
// ---------------------------------------------------------------------------

const API = join(__dirname, '..');
const MOBILE = join(__dirname, '../../../mobile');
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('LEGAL_VERSION 2026-11-09 for the in-app call wording: material, so everyone ticks again', () => {
  it('is served, and classed material exactly once, for everyone', () => {
    expect(LEGAL_VERSION).toBe('2026-11-09');
    const entry = MATERIAL_CHANGES.filter((c) => c.version === '2026-11-09');
    expect(entry).toHaveLength(1);
    expect(entry[0]!.audience).toBeUndefined();
    expect(NON_MATERIAL_CHANGES.map((c) => c.version)).not.toContain('2026-11-09');
    expect(materialVersion(LEGAL_VERSION)).toBe('2026-11-09');
  });

  it.each([
    ['a customer', ['CUSTOMER']], ['a rider', ['MOVER', 'CUSTOMER']], ['a store owner', ['VENDOR_OWNER', 'CUSTOMER']],
  ] as const)('%s at 2026-11-08 is asked once, with the in-app call summary alone; at 2026-11-09, not', (_who, roles) => {
    const summary = MATERIAL_CHANGES.find((c) => c.version === '2026-11-09')!.summary;
    expect(acceptanceStatus({ tosVersion: '2026-11-08', roles: [...roles] as UserRole[] })).toMatchObject({ needsAcceptance: true, summary });
    expect(acceptanceStatus({ tosVersion: '2026-11-09', roles: [...roles] as UserRole[] })).toMatchObject({ needsAcceptance: false, summary: [] });
  });

  it('the summary says what Twilio receives, no recording, and the microphone', () => {
    const words = MATERIAL_CHANGES.find((c) => c.version === '2026-11-09')!.summary.join(' ');
    expect(words).toContain('never your name or your number');
    expect(words).toContain('Twilio carries these calls');
    expect(words).toContain('push token for calls');
    expect(words).toContain('a code for your phone that is not your name, number or account');
    expect(words).toContain('Calls are never recorded.');
    expect(words).toContain('the app uses your microphone only during an in-app call you place or answer, once you allow it');
  });

  it('only the Privacy Policy states in-app calls; the other texts change by their date alone', () => {
    for (const doc of [TERMS, DRIVER_AGREEMENT, VENDOR_AGREEMENT]) {
      expect(doc).toContain('9 November 2026');
      expect(doc).not.toMatch(/in-app call/i);
    }
  });
});

describe('every in-app call sentence is what the code does', () => {
  const privacy = flat(PRIVACY);

  it('never recorded: every <Dial> Swift writes for an in-app call says do-not-record', () => {
    const twilio = new TwilioVoiceProvider({ accountSid: `AC${'a'.repeat(32)}`, apiKeySid: `SK${'b'.repeat(32)}`, apiKeySecret: 'unit-secret', authToken: 'unit-token' });
    const body = twilio.render({
      verb: 'dialApp', clients: ['s0123456789abcdef0123456789abcdef01234567'], callerId: 'client:Swift',
      params: { swiftLine: callScreenLine('rider', 'FOOD'), swiftCallId: 'c0123456789abcdefghijk' },
      answered: 'https://api.example/a', done: 'https://api.example/d', ringSeconds: 30, limitSeconds: 1800,
    }).body;
    expect(body).toContain('record="do-not-record"');
    expect(body).not.toMatch(/<Record|record="record/i);
    expect(privacy).toContain('What you say is carried live to the other person and is never recorded, by Swift or by Twilio.');
    expect(privacy).toContain('Calls through Swift, in the app or by phone, are never recorded.');
  });

  it('the other phone sees the role, never a name or a number: the policy quotes the line the code writes', () => {
    expect(callScreenLine('rider', 'FOOD')).toBe('Swift: your rider is calling about your order');
    expect(privacy).toContain('their phone rings with a line such as "Swift: your rider is calling about your order", which names your role on the order, never your name or your number.');
  });

  it('the code Twilio gets for a phone is not the account, a name or a number', () => {
    const userId = 'cuserid00000000000000001';
    const identity = inAppIdentity('x'.repeat(32), userId, 'csession0000000000000001', 'device-1');
    expect(identity).toMatch(/^s[0-9a-f]{40}$/);
    expect(identity).not.toContain(userId);
    expect(privacy).toContain('a code for your signed-in phone that is not your name, phone number or account number');
  });

  it('the push token for calls, the sound live, the times and the SDK\'s connection details are named; Twilio is in the United States', () => {
    expect(privacy).toContain("your phone's push token for calls, which the app gives Twilio when you have a live order (on Android, only once you have allowed the microphone), so that Twilio can ring your phone through Apple's or Google's push service, and asks Twilio to remove when you sign out");
    expect(privacy).toContain('the sound of the call, live, while you talk; the call\'s times;');
    expect(privacy).toContain("such as your phone's network (IP) address, its operating system, the software's version and the call's sound quality");
    expect(privacy).toContain('Twilio, a company in the United States');
    expect(privacy).toContain('Twilio keeps its own records of these calls, in the United States, and the calls themselves are never recorded');
    const twilio = PROCESSOR_REGISTER.find((p) => p.ref === 'TWILIO')!;
    expect(twilio.payload).toEqual(expect.arrayContaining(['CONTACT', 'DEVICE_TOKEN', 'DIAGNOSTIC']));
    expect(twilio.country).toBe('US');
    expect(twilio.leavesCountry).toBe(true);
  });

  it('a phone registers for in-app calls only on a live order, and the app unregisters it at sign-out', () => {
    const calls = readFileSync(join(API, 'modules/calls/inapp-calls.ts'), 'utf8');
    expect(calls).toContain("if (input.purpose === 'register' && !(await onALiveOrder(deps.prisma, input.userId)))");
    const auth = readFileSync(join(MOBILE, 'src/stores/authStore.ts'), 'utf8');
    expect(auth).toMatch(/unregisterInAppCalls\(/);
  });

  it('what Swift keeps: the call row (no number) and the ringable note, 30 days from the last registration', () => {
    const routes = readFileSync(join(API, 'modules/calls/inapp-calls.routes.ts'), 'utf8');
    expect(routes).toContain('const REGISTRY_TTL_MS = 30 * 86_400_000;');
    expect(routes).toContain("'PX', REGISTRY_TTL_MS");
    expect(privacy).toContain('The record of a call made through Swift, by phone or in the app (no phone number, never what was said), is kept with its order\'s record');
    expect(privacy).toContain('it is deleted 30 days after your phone last registered, and the app asks for it to be deleted when you sign out.');
  });

  it('the microphone: the policy and the phone\'s own purpose string agree (only during calls, never recorded)', () => {
    const config = flat(readFileSync(join(MOBILE, 'app.config.ts'), 'utf8'));
    expect(config).toContain("'Swift uses the microphone only during in-app calls with your rider, driver, store or customer. Swift never records calls.'");
    expect(privacy).toContain("the app uses your phone's microphone for that call only, and only once you have allowed it.");
    expect(privacy).toContain("If you do not allow the microphone, you can still call through Swift's phone line where it is on, or message them in the order chat.");
  });

  it('the phone fallback is stated as the code does it: not reached in the app and not declined', () => {
    const calls = readFileSync(join(API, 'modules/calls/inapp-calls.ts'), 'utf8');
    expect(calls).toContain("const FALLBACK_DIAL_STATUSES = new Set(['no-answer', 'failed']);");
    expect(privacy).toContain('If the call cannot reach them in the app and they did not decline it, Swift rings their phone instead, as above, when Swift\'s call service is on.');
  });
});
