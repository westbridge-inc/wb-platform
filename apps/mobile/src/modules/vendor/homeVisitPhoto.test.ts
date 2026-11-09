/**
 * [OWNER-ASKS · owner ruling 9 Nov 2026] The selfie is for riders, drivers and businesses that go to the customer.
 * A store owner, store staff and a business that serves customers only at its own place never take one — the business
 * app opens without it (rootEntryGate). A business that turns on home visits is asked for the photo THEN, inside the
 * app, and the server refuses a home-visit booking until it is taken (fail closed, order.service).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HOME_VISIT_PHOTO_WORDS, homeVisitPhotoNeeded, homeVisitPhotoNeededFromStatus } from './homeVisitPhoto';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('[owner 9 Nov] the profile photo is asked only for home visits', () => {
  it('a listing at the business’s own place never asks for it', () => {
    expect(homeVisitPhotoNeeded({ mode: 'AT_BUSINESS', hasPhoto: false })).toBe(false);
    expect(homeVisitPhotoNeeded({ mode: null, hasPhoto: false })).toBe(false);
    expect(homeVisitPhotoNeeded({ mode: undefined, hasPhoto: false })).toBe(false);
  });

  it('a listing that goes to the customer asks for it while there is no photo', () => {
    expect(homeVisitPhotoNeeded({ mode: 'MOBILE', hasPhoto: false })).toBe(true);
    expect(homeVisitPhotoNeeded({ mode: 'BOTH', hasPhoto: false })).toBe(true);
    expect(homeVisitPhotoNeeded({ mode: 'MOBILE', hasPhoto: true })).toBe(false);
    expect(homeVisitPhotoNeeded({ mode: 'BOTH', hasPhoto: true })).toBe(false);
  });

  it('from the server’s status: offered and no photo asks; anything else does not (an older server: the account’s own photo decides)', () => {
    expect(homeVisitPhotoNeededFromStatus({ homeVisits: { offered: true, cleared: true, photo: false } }, true)).toBe(true);
    expect(homeVisitPhotoNeededFromStatus({ homeVisits: { offered: true, cleared: false, photo: true } }, false)).toBe(false);
    expect(homeVisitPhotoNeededFromStatus({ homeVisits: { offered: false, cleared: false, photo: false } }, false)).toBe(false);
    expect(homeVisitPhotoNeededFromStatus({ homeVisits: { offered: true, cleared: false } }, false)).toBe(true);
    expect(homeVisitPhotoNeededFromStatus({ homeVisits: { offered: true, cleared: false } }, true)).toBe(false);
    expect(homeVisitPhotoNeededFromStatus({}, false)).toBe(false);
    expect(homeVisitPhotoNeededFromStatus(null, false)).toBe(false);
  });

  it('the words say why, what waits, and that bookings at the business’s place are not affected', () => {
    expect(HOME_VISIT_PHOTO_WORDS.title).toMatch(/home visits/i);
    expect(HOME_VISIT_PHOTO_WORDS.body).toMatch(/profile photo/);
    expect(HOME_VISIT_PHOTO_WORDS.body).toMatch(/until/i);
    expect(HOME_VISIT_PHOTO_WORDS.body).toMatch(/at your place/i);
    expect(HOME_VISIT_PHOTO_WORDS.action).toMatch(/photo/i);
  });
});

describe('[owner 9 Nov] where the business app asks', () => {
  it('the business stack can open the camera screen as a pushed screen (“Not now” goes back; no sign-out)', () => {
    const stack = read('./VendorStack.tsx');
    expect(stack).toMatch(/import \{ SelfieCaptureScreen \} from '\.\.\/\.\.\/screens\/auth\/SelfieCaptureScreen';/);
    expect(stack).toMatch(/<Stack\.Screen name="Selfie" component=\{SelfieCaptureScreen\} \/>/);
  });

  it('the service editor asks when “I travel to them” or “Both” is chosen and there is no photo', () => {
    const editor = read('./screens/VendorItemEditorScreen.tsx');
    expect(editor).toMatch(/homeVisitPhotoNeeded\(\{ mode, hasPhoto \}\)/);
    expect(editor).toMatch(/<HomeVisitPhotoCard \/>/);
  });

  it('the account screen asks while a home-visit listing waits for the photo', () => {
    const account = read('./screens/VendorAccountScreen.tsx');
    expect(account).toMatch(/homeVisitPhotoNeededFromStatus\(/);
    expect(account).toMatch(/<HomeVisitPhotoCard \/>/);
  });

  it('the card opens the camera screen', () => {
    const card = read('./HomeVisitPhotoCard.tsx');
    expect(card).toMatch(/navigate\('Selfie'\)/);
    expect(card).toMatch(/HOME_VISIT_PHOTO_WORDS/);
  });
});
