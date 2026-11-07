import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { QueryClient } from '@tanstack/react-query';
import { HOME_FEED_ALL, homeFeedChanged } from './homeFeed';
import { homeFocusRefreshDue } from './homeReliability';

// ---------------------------------------------------------------------------
// [APP-SPEED C · review S2-2] A return to Home re-reads its feed only when it is older than ~30 s, unless something
// marked it out of date. Placing an order did not (only the orders and the cart were invalidated), so for up to 30 s
// Home hid the order just placed. Now every creation Home shows marks the feed out of date: an order placed, an
// order found placed after an unanswered checkout (the 422 "already placed" answer and the restart probe), a parcel
// sent, a pro booked. Comments are stripped before the source pins (a phrase in a comment never satisfies them).
// ---------------------------------------------------------------------------

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (p: string) => strip(readFileSync(new URL(p, import.meta.url), 'utf8'));
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a, from).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b, to).toBeGreaterThan(a);
  return src.slice(a, b);
};

describe('[review S2-2] homeFeedChanged', () => {
  it('a feed read seconds ago is due again once something new was created', async () => {
    const qc = new QueryClient();
    const key = [...HOME_FEED_ALL, 6.8, -58.16, null];
    qc.setQueryData(key, { activeOrder: null });
    const now = Date.now();
    expect(homeFocusRefreshDue(qc.getQueryState(key) as never, now + 5_000), 'fresh: not read again').toBe(false);
    homeFeedChanged(qc);
    expect(homeFocusRefreshDue(qc.getQueryState(key) as never, now + 5_000), 'marked out of date: read again').toBe(true);
  });

  it('is the key Home reads (customerKeys.homeAll)', () => {
    expect(HOME_FEED_ALL).toEqual(['customer', 'home']);
    expect(read('../hooks/customer.ts')).toContain("homeAll: ['customer', 'home'] as const,");
  });
});

describe('[review S2-2] every creation Home shows marks its feed out of date', () => {
  const customer = read('../hooks/customer.ts');

  it('an order placed', () => {
    expect(between(customer, "onSuccess: (data: any, operation) => {", "track('order_placed'")).toContain('homeFeedChanged(qc);');
  });
  it('an order the server says is already placed (422)', () => {
    expect(between(customer, 'if (err instanceof CheckoutAlreadyPlacedError) {', 'onSettled:')).toContain('homeFeedChanged(qc);');
  });
  it('an order the restart probe finds placed', () => {
    expect(between(customer, "if (probe.status === 'placed') {", '} else if')).toContain('homeFeedChanged(qc);');
  });
  it('a parcel sent (whatever the answer: an unanswered send may have landed)', () => {
    expect(between(read('../hooks/courier.ts'), 'export function useSendCourier()', '\n}\n')).toContain('onSettled: () => { homeFeedChanged(qc); },');
  });
  it('a pro booked', () => {
    expect(between(read('../hooks/services.ts'), 'export function useBookPro()', '\n}\n')).toContain('homeFeedChanged(qc);');
  });
});
