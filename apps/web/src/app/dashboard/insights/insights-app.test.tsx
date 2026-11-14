import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InsightsPage from './page';
import { guyanaDayKey } from '@/lib/vendor-hub';
import { BROWSER_API_ORIGIN } from '@/lib/browser-api-origin';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [WEB-INSIGHTS · audit B3 B4 B5] The website's Insights copies the phone's VendorInsightsScreen: the
// revenue chart over 7 / 30 / 90 days with the change against the days before, average order,
// acceptance and cancelled, the most-ordered items, operations, busy hours, repeat customers, the
// store's standing, ratings, the customer reviews with the store's reply, and the 30-day sales
// statement. The same server reads; the four number cards and the order export stay.
// ---------------------------------------------------------------------------

const store = { id: 'camp', name: 'Royal Camp', vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: 'Georgetown', isVerified: true, status: 'ACTIVE' };
const overview = { vendor: { totalOrders: 40 }, today: { orders: 2, revenue: 3000 }, week: { orders: 9, revenue: 21000 }, month: { orders: 30, revenue: 70000 }, activeMenuItems: 12 };

/** `days` Guyana days ending today: each earlier day 1000 a day from 1 order, the last 7 days 2000 from 2 orders. */
function revenue(days: number) {
  const daily = Array.from({ length: days }, (_, i) => {
    const offset = i - days + 1;
    const recent = offset > -7;
    return { date: guyanaDayKey(offset), orders: recent ? 2 : 1, revenue: recent ? 2000 : 1000, total: 0 };
  });
  return { days, daily, totals: { orders: daily.reduce((s, d) => s + d.orders, 0) } };
}

const reviews = [
  { id: 'r1', score: 5, comment: 'Lovely pepperpot', response: 'Thank you for coming!', respondedAt: '2026-11-02T04:00:00.000Z', createdAt: '2026-11-02T04:00:00.000Z' },
  { id: 'r2', score: 3, comment: 'A little slow today', response: null, respondedAt: null, createdAt: '2026-11-05T04:00:00.000Z' },
];

type Opts = { role?: string; reviewsFail?: boolean; replyRefused?: boolean };
const asked: Array<{ method: string; url: URL; body: unknown }> = [];
function api(opts: Opts = {}) {
  return mockApi(({ url, method, init }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    asked.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ body: { success: true, data, ...extra } });
    if (path === '/vendor/stores') return ok({ stores: [store], selectedId: 'camp', myRole: opts.role ?? 'OWNER' });
    if (path === '/vendor/analytics/overview') return ok(overview);
    if (path === '/vendor/analytics/revenue') return ok(revenue(Number(url.searchParams.get('days'))));
    if (path === '/vendor/analytics/ops') return ok({ days: Number(url.searchParams.get('days')), placedOrders: 25, acceptanceRate: 92, cancellationRate: 4, vendorCancellations: 1, avgAcceptMinutes: 3.5, avgPrepMinutes: 24, avgQuotedPrepMinutes: 18 });
    if (path === '/vendor/analytics/popular-items') return ok([
      { id: 'i1', name: 'Pepperpot bowl', imageUrl: null, totalOrdered: 120, recentOrders: 14, category: { id: 'c1', name: 'Mains' } },
      { id: 'i2', name: 'Sorrel', imageUrl: null, totalOrdered: 0, recentOrders: 0, category: null },
    ]);
    if (path === '/vendor/analytics/busy-hours') return ok({ days: 30, hours: Array.from({ length: 24 }, (_, hour) => ({ hour, orders: hour === 12 ? 9 : hour === 18 ? 4 : 0 })), peak: { hour: 12, orders: 9 }, total: 13 });
    if (path === '/vendor/analytics/repeat-customers') return ok({ totalCustomers: 20, repeatCustomers: 8, repeatRate: 40, totalOrders: 35 });
    if (path === '/vendor/standing') return ok({ standing: 'GOOD', displayRating: 4.4, ratingBucket: '4.0–4.5', ratingCount: 2, topRated: false, folded: { count: 2, average: 4 }, trend: [{ weekStart: '2026-10-26', average: 4, count: 2 }], topPositive: [{ tag: 'TASTY', label: 'Tasty', count: 3 }], topNegative: [], coaching: [] });
    if (path === '/vendor/analytics/item-feedback') return ok([{ itemId: 'i2', name: 'Sorrel', up: 1, down: 2 }]);
    if (path === '/vendor/reviews' && method === 'GET') {
      if (opts.reviewsFail) return { status: 503, body: { success: false, error: { message: 'Service unavailable' } } };
      return ok(reviews, { meta: { page: 1, limit: 20, total: 2 }, summary: { averageRating: 4, totalReviews: 2, distribution: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 1 } } });
    }
    if (path === '/vendor/reviews/r2/respond' && method === 'POST') {
      if (opts.replyRefused) return { status: 409, body: { success: false, error: { code: 'REVIEW_CHANGED', message: 'This review changed. Open it again.' } } };
      return ok({ ...reviews[1], response: 'Sorry, we are on it' });
    }
    if (path === '/vendor/sales-statement') return ok({ path: '/api/v1/statements/render?v=3&sig=abc', expiresInSeconds: 600 });
    if (path === '/vendor/orders/export/branches') return ok({ scope: 'owner', branches: [{ id: 'camp', name: 'Royal Camp', city: 'Georgetown' }] });
    return { status: 404, body: { success: false } };
  });
}

const reads = (path: string) => asked.filter((a) => a.method === 'GET' && a.url.pathname === `/api/v1${path}`);

beforeEach(async () => {
  asked.length = 0;
  (await import('@/lib/auth')).setSelectedStore('camp');
});

describe('[WEB-INSIGHTS] the website\'s Insights, as the phone\'s', () => {
  it('keeps the four number cards and the order export', async () => {
    api();
    renderWithQuery(<InsightsPage />);
    expect(await screen.findByText('Orders today')).toBeTruthy();
    expect(screen.getByText('Revenue · 30 days')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Export orders (CSV)' })).toBeTruthy();
  });

  it('revenue over the last 7 days, against the 7 before, with its chart and the three figures', async () => {
    api();
    renderWithQuery(<InsightsPage />);
    const card = await screen.findByRole('region', { name: 'Revenue' });
    await waitFor(() => expect(card.textContent).toContain('REVENUE · LAST 7 DAYS'));
    // Six days at 2000, and today from the overview (3000): 15000 over the 7 days; the 7 before: 7000.
    expect(card.textContent).toMatch(/15,000/);
    expect(card.textContent).toContain('14 completed orders in this range.');
    expect(card.textContent).toContain('Change against the previous 7 days.');
    expect(within(card).getByText(/▲ 114%/)).toBeTruthy();
    expect(within(card).getByRole('img', { name: /Revenue trend for 7 days\. Peak .*3,000\. Today .*3,000\./ })).toBeTruthy();
    expect(reads('/vendor/analytics/revenue').some((r) => r.url.searchParams.get('days') === '14')).toBe(true);
    const figures = screen.getByRole('region', { name: 'Order figures' });
    await waitFor(() => expect(figures.textContent).toContain('92%'));
    expect(figures.textContent).toContain('AVG ORDER');
    expect(figures.textContent).toMatch(/1,071/); // 15000 / 14
    expect(figures.textContent).toContain('4%');
    expect(figures.textContent).toContain('25 placed orders');
  });

  it('30 days asks for 60 days of revenue and 30 days of operations; 90 days says no comparison is offered', async () => {
    api();
    const { user } = renderWithQuery(<InsightsPage />);
    await screen.findByRole('region', { name: 'Revenue' });
    // A new range loads, then draws its own card (the card is found again each time).
    const card = () => screen.getByRole('region', { name: 'Revenue' });
    await user.click(within(screen.getByRole('group', { name: 'Revenue range' })).getByRole('button', { name: '30d' }));
    await waitFor(() => expect(card().textContent).toContain('REVENUE · LAST 30 DAYS'));
    expect(reads('/vendor/analytics/revenue').some((r) => r.url.searchParams.get('days') === '60')).toBe(true);
    expect(reads('/vendor/analytics/ops').some((r) => r.url.searchParams.get('days') === '30')).toBe(true);
    await user.click(within(screen.getByRole('group', { name: 'Revenue range' })).getByRole('button', { name: '90d' }));
    await waitFor(() => expect(card().textContent).toContain('Prior-period comparison is available at 7 and 30 days.'));
    expect(reads('/vendor/analytics/revenue').some((r) => r.url.searchParams.get('days') === '90')).toBe(true);
  });

  it('the most-ordered items, operations, busy hours, repeat customers, standing and ratings', async () => {
    api();
    renderWithQuery(<InsightsPage />);
    const top = await screen.findByRole('region', { name: 'Most ordered' });
    await waitFor(() => expect(top.textContent).toContain('Pepperpot bowl'));
    expect(top.textContent).toContain('120 orders');
    expect(top.textContent).toContain('14 ordered in 30d');
    expect(top.textContent).not.toContain('Sorrel'); // never ordered: not ranked
    const ops = await screen.findByRole('region', { name: /Operations · rolling 7d/ });
    expect(ops.textContent).toContain('3.5m');
    expect(ops.textContent).toContain('Prep runs ~24 min against a ~18 min quote — quote a little more time so customers aren’t kept waiting.');
    expect(ops.textContent).toContain('1 cancelled by the store');
    const busy = await screen.findByRole('region', { name: 'Busy hours' });
    expect(busy.textContent).toContain('peak 12pm');
    const repeat = await screen.findByRole('region', { name: 'Repeat customers' });
    expect(repeat.textContent).toContain('40%');
    expect(repeat.textContent).toContain('8 of 20 customers came back — 35 finished orders.');
    const standing = await screen.findByRole('region', { name: 'Store standing' });
    expect(standing.textContent).toContain('4.4');
    expect(standing.textContent).toContain('Good');
    expect(standing.textContent).toContain('Customers mention: Tasty ×3');
    const feedback = await screen.findByRole('region', { name: 'Item feedback — last 30 days' });
    expect(feedback.textContent).toContain('Sorrel');
    expect(within(feedback).getByLabelText('2 thumbs down, 1 thumbs up')).toBeTruthy();
    const ratings = await screen.findByRole('region', { name: 'Ratings' });
    expect(ratings.textContent).toContain('4.0');
    expect(ratings.textContent).toContain('2 ratings');
    expect(ratings.textContent).toContain('40 lifetime orders');
  });

  it('reviews: what customers said and the store\'s reply; "Reply" posts a public reply', async () => {
    api();
    const { user } = renderWithQuery(<InsightsPage />);
    const box = await screen.findByRole('region', { name: 'Recent reviews' });
    await waitFor(() => expect(box.textContent).toContain('Lovely pepperpot'));
    expect(box.textContent).toContain('You replied: Thank you for coming!');
    expect(box.textContent).toContain('A little slow today');
    // Who wrote a review is never shown (the server never sends it).
    expect(box.textContent).toContain('Customer');
    await user.click(within(box).getByRole('button', { name: 'Reply' }));
    const text = within(box).getByPlaceholderText('Write a public reply…');
    expect(text.getAttribute('maxlength')).toBe('1000');
    const post = within(box).getByRole('button', { name: 'Post reply' }) as HTMLButtonElement;
    expect(post.disabled).toBe(true);
    await user.type(text, '  Sorry, we are on it ');
    await user.click(post);
    await waitFor(() => expect(asked.some((a) => a.method === 'POST' && a.url.pathname === '/api/v1/vendor/reviews/r2/respond')).toBe(true));
    const sent = asked.find((a) => a.method === 'POST')!;
    expect(sent.body).toEqual({ response: 'Sorry, we are on it' });
    await waitFor(() => expect(within(box).queryByPlaceholderText('Write a public reply…')).toBeNull());
    await waitFor(() => expect(reads('/vendor/reviews').length).toBeGreaterThan(1));
  });

  it('"Edit reply" opens the store\'s own reply to change it', async () => {
    api();
    const { user } = renderWithQuery(<InsightsPage />);
    const box = await screen.findByRole('region', { name: 'Recent reviews' });
    await user.click(await within(box).findByRole('button', { name: 'Edit reply' }));
    expect((within(box).getByPlaceholderText('Write a public reply…') as HTMLTextAreaElement).value).toBe('Thank you for coming!');
  });

  it('a refused reply keeps the box open and says why', async () => {
    api({ replyRefused: true });
    const { user } = renderWithQuery(<InsightsPage />);
    const box = await screen.findByRole('region', { name: 'Recent reviews' });
    await user.click(await within(box).findByRole('button', { name: 'Reply' }));
    await user.type(within(box).getByPlaceholderText('Write a public reply…'), 'Sorry');
    await user.click(within(box).getByRole('button', { name: 'Post reply' }));
    expect((await within(box).findByRole('alert')).textContent).toContain('This review changed. Open it again.');
    expect(within(box).getByPlaceholderText('Write a public reply…')).toBeTruthy();
  });

  it('reviews that cannot be read say so, never "Reviews land here…"', async () => {
    api({ reviewsFail: true });
    renderWithQuery(<InsightsPage />);
    const box = await screen.findByRole('region', { name: 'Recent reviews' });
    await waitFor(() => expect(box.textContent).toContain('Reviews are unavailable right now.'));
    expect(box.textContent).not.toContain('Reviews land here');
    expect(within(box).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('"Get sales statement" opens the server\'s signed 30-day statement in a new tab', async () => {
    api();
    const tab = { opener: {} as unknown, location: { href: 'about:blank' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const { user } = renderWithQuery(<InsightsPage />);
    await user.click(await screen.findByRole('button', { name: 'Get sales statement' }));
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => expect(tab.location.href).toBe(`${BROWSER_API_ORIGIN}/api/v1/statements/render?v=3&sig=abc`));
    expect(tab.opener).toBeNull();
    expect(reads('/vendor/sales-statement')[0]!.url.searchParams.get('link')).toBe('1');
    open.mockRestore();
  });

  it('a staff member makes none of these reads', async () => {
    api({ role: 'STAFF' });
    renderWithQuery(<InsightsPage />);
    expect(await screen.findByText(/Insights are for the store/)).toBeTruthy();
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    for (const path of ['/vendor/analytics/revenue', '/vendor/analytics/ops', '/vendor/analytics/popular-items', '/vendor/analytics/busy-hours', '/vendor/analytics/repeat-customers', '/vendor/standing', '/vendor/reviews']) {
      expect(reads(path), path).toHaveLength(0);
    }
    expect(screen.queryByRole('button', { name: 'Get sales statement' })).toBeNull();
  });
});
