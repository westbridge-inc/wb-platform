import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HomeNoticePanel } from './home-notice-panel';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [HOME-NOTICE · owner 13 Nov 2026] The console's Home notice panel: write the
// words, turn them on (C5: a second admin, so the answer is "queued"), turn
// them off (C3: at once), and see what is live. The switch is only shown
// changed once the server says so. Synthetic words only.
// ---------------------------------------------------------------------------

const REASON = 'Pickup is open while riders come on board';
const TITLE = 'Pickup is open on Swift';
const BODY = 'Choose Pickup at checkout and collect your order straight from the store.';
type Notice = { active: boolean; id: string; title: string | null; body: string; updatedAt: string } | null;
type Write = { method: string; path: string; body: Record<string, unknown>; reason: string | null };

function server(opts: { notice?: Notice; failRead?: boolean; startReply?: { status: number; body: unknown } } = {}) {
  let notice: Notice = opts.notice ?? null;
  const writes: Write[] = [];
  mockApi((r: ApiRequest) => {
    const path = r.url.pathname;
    if (path === '/api/v1/admin/home-notice' && r.method === 'GET') {
      if (opts.failRead) return { status: 500, body: { success: false, error: { code: 'INTERNAL', message: 'down' } } };
      return { body: { success: true, data: { notice, live: notice?.active === true } } };
    }
    if ((path === '/api/v1/admin/home-notice' && r.method === 'PUT') || (path === '/api/v1/admin/home-notice/stop' && r.method === 'POST')) {
      const w = { method: r.method, path, body: JSON.parse(String(r.init?.body ?? '{}')), reason: new Headers(r.init?.headers).get('x-swift-reason') };
      writes.push(w);
      if (r.method === 'PUT') return opts.startReply ?? { status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this before it happens.', details: { approvalId: 'apr_n1' } } } };
      notice = notice ? { ...notice, active: false } : null;
      return { body: { success: true, data: { notice, live: false } } };
    }
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
  return { writes };
}

async function answerPanel(user: ReturnType<typeof renderWithQuery>['user'], confirm: RegExp) {
  const panel = await screen.findByRole('dialog');
  await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), REASON);
  await user.click(within(panel).getByRole('button', { name: confirm }));
  return panel;
}

describe('[HOME-NOTICE] the Home notice panel', () => {
  it('off by default: says no notice shows, and offers no "turn off"', async () => {
    server();
    renderWithQuery(<HomeNoticePanel />);
    expect(await screen.findByText(/Off\. No notice shows on Home\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Turn off/ })).toBeNull();
  });

  it('turning words on sends them with the reason, and reads as waiting for a second admin', async () => {
    const { writes } = server();
    const { user } = renderWithQuery(<HomeNoticePanel />);
    await screen.findByText(/Off\. No notice shows on Home\./);
    const show = screen.getByRole('button', { name: 'Show on Home' }) as HTMLButtonElement;
    expect(show.disabled).toBe(true);
    await user.type(screen.getByLabelText(/^Title/), TITLE);
    await user.type(screen.getByLabelText(/^Notice/), BODY);
    // The preview is what customers will see.
    expect(screen.getByTestId('home-notice-preview').textContent).toContain(BODY);
    await user.click(screen.getByRole('button', { name: 'Show on Home' }));
    await answerPanel(user, /^Show on Home/);
    expect(await screen.findByText(/Sent for a second admin.s approval/)).toBeTruthy();
    expect(writes).toEqual([{ method: 'PUT', path: '/api/v1/admin/home-notice', body: { title: TITLE, body: BODY }, reason: REASON }]);
    // Still off on screen: nothing is shown as changed before the server says so.
    expect(screen.getByText(/Off\. No notice shows on Home\./)).toBeTruthy();
  });

  it('a live notice is shown with its words, its form starts from them, and turning it off is immediate', async () => {
    const { writes } = server({ notice: { active: true, id: 'abcdef0123456789', title: TITLE, body: BODY, updatedAt: '2026-11-14T14:00:00Z' } });
    const { user } = renderWithQuery(<HomeNoticePanel />);
    expect(await screen.findByText(/Live on Home now/)).toBeTruthy();
    expect(screen.getByText(/14 Nov 2026, 10:00/)).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText(/^Notice/) as HTMLTextAreaElement).value).toBe(BODY));
    expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe(TITLE);
    await user.click(screen.getByRole('button', { name: 'Turn off now' }));
    // [ROUND 2 · REVIEW-A S3-2 · REVIEW-B S3-1] The dialog says what really happens on each screen: the website
    // re-reads every minute (an open page too) behind a one-minute cache; the app re-reads when someone comes back to
    // Home or to Swift, and every 5 minutes on a Home left open. Never "within about a minute".
    const ask = await screen.findByRole('dialog');
    expect(ask.textContent).toContain('It goes off at once.');
    expect(ask.textContent).toContain('The website drops it within about 2 minutes, a page left open included.');
    expect(ask.textContent).toContain('The app drops it when someone comes back to Home or to Swift, and within about 6 minutes on a Home left open.');
    expect(ask.textContent).not.toMatch(/within about a minute/);
    await answerPanel(user, /^Turn off now/);
    expect(await screen.findByText(/Off\. No notice shows on Home\./)).toBeTruthy();
    expect(writes).toEqual([{ method: 'POST', path: '/api/v1/admin/home-notice/stop', body: {}, reason: REASON }]);
  });

  it('a refusal stays in the panel with the words kept', async () => {
    server({ startReply: { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'Keep the notice to 280 characters.' } } } });
    const { user } = renderWithQuery(<HomeNoticePanel />);
    await screen.findByText(/Off\. No notice shows on Home\./);
    await user.type(screen.getByLabelText(/^Notice/), BODY);
    await user.click(screen.getByRole('button', { name: 'Show on Home' }));
    const panel = await answerPanel(user, /^Show on Home/);
    expect((await within(panel).findByRole('alert')).textContent).toContain('Keep the notice to 280 characters.');
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    expect((screen.getByLabelText(/^Notice/) as HTMLTextAreaElement).value).toBe(BODY);
  });

  it('a failed read is never "off": no form over it', async () => {
    server({ failRead: true });
    renderWithQuery(<HomeNoticePanel />);
    expect(await screen.findByText(/Couldn.t load the Home notice/)).toBeTruthy();
    expect(screen.queryByText(/No notice shows/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show on Home' })).toBeNull();
  });
});
