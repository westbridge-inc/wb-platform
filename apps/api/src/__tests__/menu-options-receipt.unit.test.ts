import { describe, expect, it } from 'vitest';
import { renderReceiptHtml } from '../modules/order/receipt';

// [MENU-OPTIONS · owner 11 Nov 2026] The receipt lists what each line was made with, as snapshotted at checkout:
// the size, each half, the follow-up under its opener. A swapped or closed line lists none (it is charged without them).

const order = (items: unknown[]) => ({
  orderNumber: 'SW-TEST-PIZZA', placedAt: new Date('2026-11-11T15:00:00Z'), status: 'DELIVERED', orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP',
  paymentMethod: 'CASH', paymentStatus: 'CAPTURED', currency: 'GYD', subtotalCustomer: 4338, deliveryFee: 0, discount: 0,
  tipAmount: 0, totalAmount: 4338, items,
}) as unknown as Parameters<typeof renderReceiptHtml>[0];

const pizzaOptions = [
  { optionGroupName: 'Size', optionName: 'Large', markedUpPrice: 0 },
  { optionGroupName: 'Cheese (Stuffed crust)', optionName: 'Cheddar', markedUpPrice: 100 },
  { optionGroupName: 'Toppings', optionName: 'Pepperoni (left half)', markedUpPrice: 150 },
  { optionGroupName: 'Toppings', optionName: 'Mushroom (right half)', markedUpPrice: 88 },
];

describe('[MENU-OPTIONS] the receipt shows the choices', () => {
  it('each choice on its own line; a paid one with what it added', () => {
    const html = renderReceiptHtml(order([{ name: 'Supreme', quantity: 1, totalCustomer: 4338, subStatus: 'NONE', selectedOptions: pizzaOptions }]));
    expect(html).toContain('<div class="opt">Size: Large</div>');
    expect(html).toContain('Toppings: Pepperoni (left half) +GY$150 GYD');
    expect(html).toContain('Toppings: Mushroom (right half) +GY$88 GYD');
    expect(html).toContain('Cheese (Stuffed crust): Cheddar +GY$100 GYD');
  });

  it('a swapped line lists none of the original choices', () => {
    const html = renderReceiptHtml(order([{ name: 'Veggie', quantity: 1, totalCustomer: 3000, subStatus: 'APPROVED', selectedOptions: pizzaOptions }]));
    expect(html).not.toContain('Pepperoni');
  });

  it('choice text is escaped', () => {
    const html = renderReceiptHtml(order([{ name: 'X', quantity: 1, totalCustomer: 1, selectedOptions: [{ optionGroupName: '<b>', optionName: '<script>', markedUpPrice: 0 }] }]));
    expect(html).not.toContain('<script>');
  });
});

describe('[MENU-OPTIONS] the kitchen-system hook reads the snapshot parts', () => {
  it('halves map to sides; a legacy row reads as a whole-item modifier', async () => {
    const { kitchenModifiers } = await import('../modules/order/kitchen-modifiers');
    expect(kitchenModifiers([
      { optionId: 'o1', optionGroupName: 'Toppings', optionName: 'Pepperoni (left half)', plainGroupName: 'Toppings', plainOptionName: 'Pepperoni', placement: 'LEFT', setsPrice: false },
      { optionId: 'o2', optionGroupName: 'Toppings', optionName: 'Mushroom (right half)', plainGroupName: 'Toppings', plainOptionName: 'Mushroom', placement: 'RIGHT' },
      { optionGroupName: 'Size', optionName: 'Large' },
    ]).map((r) => [r.name, r.side, r.optionId])).toEqual([['Pepperoni', 1, 'o1'], ['Mushroom', 2, 'o2'], ['Large', 0, null]]);
  });
});
