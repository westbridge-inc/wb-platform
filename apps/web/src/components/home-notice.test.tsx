import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, screen, waitFor } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeNotice } from './home-notice';
import { CLOSED_NOTICES_KEY, closedNoticeIds, homeNoticeOf, rememberClosedNotice } from '@/lib/home-notice';
import { axeViolations } from '@/test/axe';
import { API_ORIGIN, mockApi, renderWithQuery } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [HOME-NOTICE · owner 13 Nov 2026] The notice at the top of Home: for everyone
// (it is read with no session), closed with an X, remembered per browser per
// notice id — new words show again, a reload keeps a closed notice closed —
// and a browser that cannot store anything still closes it for the visit.
// ---------------------------------------------------------------------------

const NOTICE = { id: 'abcdef0123456789', title: 'Pickup is open on Swift', body: 'Choose Pickup at checkout and collect your order straight from the store.', updatedAt: '2026-11-14T10:00:00.000Z' };

function server(notice: unknown, status = 200) {
  return mockApi((r) => {
    if (r.url.pathname === '/api/v1/public/home-notice') return { status, body: status === 200 ? { success: true, data: { notice } } : { success: false } };
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}

afterEach(() => { try { localStorage.clear(); } catch { /* storage may be stubbed */ } });

describe('what the server answer means', () => {
  it('a notice with an id and words is a notice; anything else is none', () => {
    expect(homeNoticeOf({ notice: NOTICE })).toEqual({ id: NOTICE.id, title: NOTICE.title, body: NOTICE.body });
    expect(homeNoticeOf({ notice: { ...NOTICE, title: null } })).toEqual({ id: NOTICE.id, title: null, body: NOTICE.body });
    for (const bad of [null, undefined, {}, { notice: null }, { notice: { ...NOTICE, id: '' } }, { notice: { ...NOTICE, body: ' ' } }, { notice: { ...NOTICE, body: 7 } }, 'x']) {
      expect(homeNoticeOf(bad)).toBeNull();
    }
  });

  it('closed ids are remembered, newest kept, and a broken store reads as none closed', () => {
    expect(closedNoticeIds()).toEqual([]);
    rememberClosedNotice('a');
    rememberClosedNotice('b');
    rememberClosedNotice('a');
    expect(closedNoticeIds()).toEqual(['b', 'a']);
    for (let i = 0; i < 30; i += 1) rememberClosedNotice(`n${i}`);
    expect(closedNoticeIds()).toHaveLength(20);
    expect(closedNoticeIds().at(-1)).toBe('n29');
    localStorage.setItem(CLOSED_NOTICES_KEY, '{not json');
    expect(closedNoticeIds()).toEqual([]);
  });
});

describe('the notice on Home', () => {
  it('is read with no session: a plain public GET that sends no cookie or token', async () => {
    const fetchMock = server(NOTICE);
    renderWithQuery(<HomeNotice />);
    expect(await screen.findByText(NOTICE.body)).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${API_ORIGIN}/api/v1/public/home-notice`);
    expect(init?.credentials).toBe('omit');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
  });

  it('shows its title and words, small and accessible, with a close button', async () => {
    server(NOTICE);
    renderWithQuery(<HomeNotice />);
    const note = await screen.findByRole('note', { name: 'Notice from Swift' });
    expect(note.textContent).toContain(NOTICE.title);
    expect(note.textContent).toContain(NOTICE.body);
    expect(screen.getByRole('button', { name: 'Close notice' })).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });

  it('nothing shows when there is no notice, or the read fails', async () => {
    const fetchMock = server(null);
    const { unmount } = renderWithQuery(<HomeNotice />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('note')).toBeNull();
    unmount();
    const failing = server(NOTICE, 500);
    renderWithQuery(<HomeNotice />);
    await waitFor(() => expect(failing).toHaveBeenCalled());
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('X closes it and it stays closed after a reload', async () => {
    server(NOTICE);
    const first = renderWithQuery(<HomeNotice />);
    await screen.findByText(NOTICE.body);
    await first.user.click(screen.getByRole('button', { name: 'Close notice' }));
    expect(screen.queryByRole('note')).toBeNull();
    expect(closedNoticeIds()).toEqual([NOTICE.id]);
    first.unmount();

    // A reload: a fresh page with the same browser storage.
    const fetchMock = server(NOTICE);
    renderWithQuery(<HomeNotice />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('new words (a new id) show again even though the old notice was closed', async () => {
    rememberClosedNotice(NOTICE.id);
    server({ ...NOTICE, id: '0123456789abcdef', body: 'Delivery is back in Georgetown.' });
    renderWithQuery(<HomeNotice />);
    expect(await screen.findByText('Delivery is back in Georgetown.')).toBeTruthy();
  });

  it('a browser that cannot store anything still closes it for this visit', async () => {
    server(NOTICE);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { user } = renderWithQuery(<HomeNotice />);
    await screen.findByText(NOTICE.body);
    await user.click(screen.getByRole('button', { name: 'Close notice' }));
    expect(screen.queryByRole('note')).toBeNull();
  });
});

// [ROUND 2 · REVIEW-A S3-2 · REVIEW-B S3-1] A website tab left open on Home drops a notice the owner turned off: it
// re-reads every minute, and again when the tab is looked at after a minute. (The answer may come from the browser's
// cache for up to a minute, max-age 60, so an open tab drops it within about two minutes.)
describe('an open tab re-reads the notice', () => {
  afterEach(() => { vi.useRealTimers(); focusManager.setFocused(undefined); });
  const reads = (fetchMock: ReturnType<typeof server>) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/public/home-notice')).length;

  it('every minute while the tab is open: a notice turned off leaves the page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let live: unknown = NOTICE;
    const fetchMock = mockApi((r) => {
      if (r.url.pathname === '/api/v1/public/home-notice') return { body: { success: true, data: { notice: live } } };
      throw new Error(`Unexpected request: ${r.method} ${r.url}`);
    });
    renderWithQuery(<HomeNotice />);
    expect(await screen.findByText(NOTICE.body)).toBeTruthy();
    expect(reads(fetchMock)).toBe(1);
    live = null; // the owner pressed "Turn off now"
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    await waitFor(() => expect(reads(fetchMock)).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByRole('note')).toBeNull());
  });

  it('when the tab is looked at again after a minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = server(NOTICE);
    renderWithQuery(<HomeNotice />);
    await screen.findByText(NOTICE.body);
    const before = reads(fetchMock);
    act(() => { focusManager.setFocused(false); });
    // Not a full interval, but past the minute the answer is fresh for.
    vi.setSystemTime(Date.now() + 61_000);
    act(() => { focusManager.setFocused(true); });
    await waitFor(() => expect(reads(fetchMock)).toBeGreaterThan(before));
  });
});

describe('Home draws it for everyone', () => {
  it('the customer Home (guests and signed-in alike) renders the notice, not behind a sign-in check', () => {
    const home = readFileSync(join(process.cwd(), 'src/components/customer-home.tsx'), 'utf8');
    expect(home).toMatch(/^import \{ HomeNotice \} from '@\/components\/home-notice';$/m);
    const at = home.indexOf('<HomeNotice />');
    expect(at).toBeGreaterThan(-1);
    expect(home.slice(Math.max(0, at - 80), at)).not.toMatch(/status|signed/);
  });

  it('[ROUND 2 · REVIEW-A S3-1] it comes after the live order in the page, as on the phone', () => {
    const home = readFileSync(join(process.cwd(), 'src/components/customer-home.tsx'), 'utf8');
    expect(home.indexOf('<HomeNotice />')).toBeGreaterThan(home.indexOf('<LiveOrder order={data.activeOrder} />'));
  });
});
