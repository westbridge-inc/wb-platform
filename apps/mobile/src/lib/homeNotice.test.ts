import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CLOSED_NOTICES_SLOT,
  closedNoticeIds,
  homeNoticeOf,
  noticeToShow,
  rememberClosedNotice,
  type NoticeMemory,
} from './homeNotice';

// ---------------------------------------------------------------------------
// [HOME-NOTICE · owner 13 Nov 2026] The owner's notice at the top of Home: for
// everyone, signed in or not; X closes it and this phone remembers the notice
// id it closed (reopening the app keeps it closed); new words (a new id) show
// again; a store that fails never hides a notice and never crashes Home.
// ---------------------------------------------------------------------------

const NOTICE = { id: 'abcdef0123456789', title: 'Pickup is open on Swift', body: 'Choose Pickup at checkout and collect your order straight from the store.', updatedAt: '2026-11-14T10:00:00.000Z' };

/** The phone's storage, as a map that survives an app restart (a new read of the same slots). */
function memory(): NoticeMemory & { slots: Map<string, string> } {
  const slots = new Map<string, string>();
  return { slots, getString: (key) => slots.get(key), set: (key, value) => { slots.set(key, value); } };
}
const broken: NoticeMemory = {
  getString: () => { throw new Error('storage unavailable'); },
  set: () => { throw new Error('storage unavailable'); },
};

describe('what the server answer means', () => {
  it('a notice with an id and words is a notice', () => {
    expect(homeNoticeOf({ success: true, data: { notice: NOTICE } })).toEqual({ id: NOTICE.id, title: NOTICE.title, body: NOTICE.body });
    expect(homeNoticeOf({ success: true, data: { notice: { ...NOTICE, title: null } } })).toEqual({ id: NOTICE.id, title: null, body: NOTICE.body });
  });

  it.each([
    ['nothing', undefined], ['no notice', { success: true, data: { notice: null } }], ['a failure', { success: false, data: { notice: NOTICE } }],
    ['no id', { success: true, data: { notice: { ...NOTICE, id: '' } } }], ['blank words', { success: true, data: { notice: { ...NOTICE, body: '  ' } } }],
    ['words not text', { success: true, data: { notice: { ...NOTICE, body: 5 } } }], ['a string', 'notice'],
  ])('%s is no notice', (_label, raw) => {
    expect(homeNoticeOf(raw)).toBeNull();
  });
});

describe('closing it with the X', () => {
  const notice = { id: NOTICE.id, title: NOTICE.title, body: NOTICE.body };

  it('shows until closed; closed stays closed when the app is opened again', () => {
    const phone = memory();
    expect(noticeToShow(notice, closedNoticeIds(phone))).toEqual(notice);
    rememberClosedNotice(phone, notice.id);
    // Reopening the app: a fresh read of the same storage.
    expect(noticeToShow(notice, closedNoticeIds(phone))).toBeNull();
    expect(JSON.parse(phone.slots.get(CLOSED_NOTICES_SLOT)!)).toEqual([notice.id]);
  });

  it('new words (a new id) show again even after the old notice was closed', () => {
    const phone = memory();
    rememberClosedNotice(phone, notice.id);
    const next = { ...notice, id: '0123456789abcdef', body: 'Delivery is back in Georgetown.' };
    expect(noticeToShow(next, closedNoticeIds(phone))).toEqual(next);
  });

  it('no notice is never shown', () => {
    expect(noticeToShow(null, [])).toBeNull();
  });

  it('remembers the newest twenty, each once', () => {
    const phone = memory();
    rememberClosedNotice(phone, 'a');
    rememberClosedNotice(phone, 'a');
    for (let i = 0; i < 30; i += 1) rememberClosedNotice(phone, `n${i}`);
    const ids = closedNoticeIds(phone);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    expect(ids.at(-1)).toBe('n29');
  });

  it('a broken or garbled store reads as nothing closed and never throws', () => {
    expect(closedNoticeIds(broken)).toEqual([]);
    expect(() => rememberClosedNotice(broken, notice.id)).not.toThrow();
    const phone = memory();
    phone.slots.set(CLOSED_NOTICES_SLOT, '{not json');
    expect(closedNoticeIds(phone)).toEqual([]);
    phone.slots.set(CLOSED_NOTICES_SLOT, JSON.stringify([1, 'x', null]));
    expect(closedNoticeIds(phone)).toEqual(['x']);
  });
});

describe('Home draws it (read as source: the screen pulls in react-native)', () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const HOME = strip(readFileSync(new URL('../modules/shop/screens/HomeScreen.tsx', import.meta.url), 'utf8'));
  const CARD = strip(readFileSync(new URL('../components/HomeNotice.tsx', import.meta.url), 'utf8'));

  it('Home renders the notice for everyone — not behind a sign-in check', () => {
    expect(HOME).toMatch(/<HomeNotice\b[^>]*\/>/);
    const at = HOME.indexOf('<HomeNotice');
    expect(HOME.slice(Math.max(0, at - 60), at)).not.toMatch(/isAuthenticated/);
  });

  it('the notice reads the public answer, and its X is a labelled button with a full touch target', () => {
    expect(CARD).toMatch(/api\.get\('\/public\/home-notice'\)/);
    expect(CARD).toMatch(/accessibilityRole="button"/);
    expect(CARD).toMatch(/accessibilityLabel="Close notice"/);
    expect(CARD).toMatch(/touchTarget\(/);
    expect(CARD).toMatch(/rememberHomeNoticeClosed\(/);
  });
});
