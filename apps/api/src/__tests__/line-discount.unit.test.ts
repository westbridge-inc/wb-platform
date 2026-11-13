import { describe, expect, it } from 'vitest';
import { lineChangeDiscount } from '../modules/order/line-discount';

// [Review B S3-2 on #2500] A code that reached a multi-store basket is spread greedily across its orders (cart-plans):
// one order may carry more than the code's rate on its own goods. A change gives back at most the code's rate on the
// change itself: never the order's whole surplus on a removed line, nothing on a same-price swap.
const twentyPercent = (goodsDiscount: number) => ({ goodsDiscount, lineAllocations: null, discountType: 'PERCENTAGE', discountValue: 20, maxDiscount: null });

describe('[review B S3-2] the give-back is the code\'s rate on the change, at most', () => {
  const live = [{ id: 'a', amount: 1000 }, { id: 'b', amount: 4000 }];
  it('a 1,000 line comes off an order carrying the whole basket\'s 2,000: 200 comes back, not 1,200', () => {
    expect(lineChangeDiscount({ orderDiscount: 2000, live, change: { lineId: 'a', newLineTotal: 0 }, redemption: twentyPercent(2000) }).amount).toBe(200);
  });
  it('a same-price swap on that order gives nothing back', () => {
    expect(lineChangeDiscount({ orderDiscount: 2000, live, change: { lineId: 'a', newLineTotal: 1000 }, redemption: twentyPercent(2000) }).amount).toBe(0);
  });
  it('on an order carrying exactly its own rate, nothing changes: 20% of the line', () => {
    expect(lineChangeDiscount({ orderDiscount: 1000, live, change: { lineId: 'a', newLineTotal: 0 }, redemption: twentyPercent(1000) }).amount).toBe(200);
  });
});
