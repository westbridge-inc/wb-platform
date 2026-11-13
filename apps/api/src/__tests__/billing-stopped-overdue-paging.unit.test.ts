import { afterEach, describe, expect, it, vi } from 'vitest';
import { BillingService } from '../modules/billing/billing.service';

// [Review A N-1 on #2500] The stopped-and-overdue suspension pass reads every such row, page by page in id order:
// rows that stay pending (a paused clock, collection under review) never hide the rows after them.

afterEach(() => vi.restoreAllMocks());

describe('the stopped-overdue suspension pass reads every row', () => {
  it('pages through more than one page, in id order, and judges each row once', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ id: `sub-${String(i).padStart(4, '0')}` }));
    const findMany = vi.fn(async (args: { where: { id?: { gt: string } }; take: number; orderBy: unknown }) => {
      const after = args.where.id?.gt;
      return rows.filter((r) => !after || r.id > after).slice(0, args.take);
    });
    const billing = new BillingService({ subscription: { findMany } } as never, {} as never, {} as never);
    const judged: string[] = [];
    vi.spyOn(billing as unknown as { finishExhaustedGrace: (s: { id: string }) => Promise<string> }, 'finishExhaustedGrace')
      .mockImplementation(async (s: { id: string }) => { judged.push(s.id); return 'pending'; });
    expect(await billing.suspendStoppedPastDue(new Date())).toBe(0);
    expect(judged).toEqual(rows.map((r) => r.id));
    expect(findMany.mock.calls.every(([args]) => JSON.stringify(args.orderBy) === JSON.stringify({ id: 'asc' }))).toBe(true);
  });
});
