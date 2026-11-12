import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { buildKitchenOrder, kitchenOptionFor } from '../modules/kitchen/kitchen-sync';

// ---------------------------------------------------------------------------
// [MENU-OPTIONS · delta review S3-N2] The kitchen sync finds each order choice's kitchen item number by the snapshot's
// stable keys (the menu option id, then the plain words), never by the display words alone: those now carry
// "(left half)" and a follow-up's opener ("Cheese (Stuffed crust)"), which name no menu option, so a fully mapped
// half-and-half or follow-up order used to be refused as "unmapped" (and the tablet rang). The half reaches the cook in
// the order's words and its placement rides on the line. Synthetic rows only; the database is a stand-in.
// ---------------------------------------------------------------------------

const ORDER_ID = 'order-kitchen-1';

/** A pizza: Size (sets the price), Crust whose "Stuffed crust" opens Cheese, half-and-half Toppings. Each mapped. */
const CATALOGUE = [{
  id: 'item-pizza', externalItemNo: '8',
  optionGroups: [
    { name: 'Size', options: [{ id: 'o-large', name: 'Large', externalItemNo: '30' }] },
    { name: 'Crust', options: [{ id: 'o-stuffed', name: 'Stuffed crust', externalItemNo: '41' }] },
    { name: 'Cheese', options: [{ id: 'o-cheddar', name: 'Cheddar', externalItemNo: '52' }] },
    { name: 'Toppings', options: [{ id: 'o-pep', name: 'Pepperoni', externalItemNo: '121' }, { id: 'o-mush', name: 'Mushroom', externalItemNo: '233' }] },
  ],
}];

/** What checkout writes for that pizza (OrderItemOption): display words + the plain parts + the option id. */
const SNAPSHOT = [
  { optionId: 'o-large', optionGroupName: 'Size', optionName: 'Large', plainGroupName: 'Size', plainOptionName: 'Large', placement: null, parentOptionName: null, setsPrice: true },
  { optionId: 'o-stuffed', optionGroupName: 'Crust', optionName: 'Stuffed crust', plainGroupName: 'Crust', plainOptionName: 'Stuffed crust', placement: null, parentOptionName: null, setsPrice: false },
  { optionId: 'o-cheddar', optionGroupName: 'Cheese (Stuffed crust)', optionName: 'Cheddar', plainGroupName: 'Cheese', plainOptionName: 'Cheddar', placement: null, parentOptionName: 'Stuffed crust', setsPrice: false },
  { optionId: 'o-pep', optionGroupName: 'Toppings', optionName: 'Pepperoni (left half)', plainGroupName: 'Toppings', plainOptionName: 'Pepperoni', placement: 'LEFT', parentOptionName: null, setsPrice: false },
  { optionId: 'o-mush', optionGroupName: 'Toppings', optionName: 'Mushroom (right half)', plainGroupName: 'Toppings', plainOptionName: 'Mushroom', placement: 'RIGHT', parentOptionName: null, setsPrice: false },
];

function stubPrisma(selectedOptions: unknown[], catalogue = CATALOGUE): PrismaClient {
  return {
    order: {
      findUnique: async () => ({
        orderNumber: 'SW-1001', placedAt: new Date('2026-11-12T15:00:00Z'), fulfillment: 'PICKUP', paymentMethod: 'CASH',
        totalAmount: 4239, subtotalCustomer: 4239, deliveryAddress: null, deliveryLat: null, deliveryLng: null, deliveryInstructions: null,
        customer: { firstName: 'Test', phone: null },
        items: [{ itemId: 'item-pizza', name: 'Pizza', quantity: 1, specialInstructions: null, subStatus: null, selectedOptions }],
      }),
    },
    item: { findMany: async () => catalogue },
  } as unknown as PrismaClient;
}

describe('[MENU-OPTIONS] a half-and-half + follow-up order reaches the kitchen with its item numbers', () => {
  it('every choice maps by its option id: the size, the crust, the cheese under its opener and both halves', async () => {
    const built = await buildKitchenOrder(stubPrisma(SNAPSHOT), { orderId: ORDER_ID, externalOrderId: 7, dailyNo: 1 }, 101);
    expect(built.ok, JSON.stringify(built)).toBe(true);
    if (!built.ok) return;
    expect(built.order.lines).toHaveLength(1);
    expect(built.order.lines[0]!.itemNo).toBe('8');
    expect(built.order.lines[0]!.choices).toEqual([
      { itemNo: '30', name: 'Large', placement: null },
      { itemNo: '41', name: 'Stuffed crust', placement: null },
      { itemNo: '52', name: 'Cheddar', placement: null },
      { itemNo: '121', name: 'Pepperoni (left half)', placement: 'LEFT' },
      { itemNo: '233', name: 'Mushroom (right half)', placement: 'RIGHT' },
    ]);
  });

  it('a renamed menu option still maps (the id is stable); an unmapped one is still refused, never guessed', async () => {
    const renamed = CATALOGUE.map((c) => ({ ...c, optionGroups: c.optionGroups.map((g) => ({ ...g, options: g.options.map((o) => (o.id === 'o-pep' ? { ...o, name: 'Pepperoni (spicy)' } : o)) })) }));
    expect((await buildKitchenOrder(stubPrisma(SNAPSHOT, renamed), { orderId: ORDER_ID, externalOrderId: 7, dailyNo: 1 }, 101)).ok).toBe(true);
    const unmapped = CATALOGUE.map((c) => ({ ...c, optionGroups: c.optionGroups.map((g) => ({ ...g, options: g.options.map((o) => (o.id === 'o-mush' ? { ...o, externalItemNo: null } : o)) })) }));
    const built = await buildKitchenOrder(stubPrisma(SNAPSHOT, unmapped as typeof CATALOGUE), { orderId: ORDER_ID, externalOrderId: 7, dailyNo: 1 }, 101);
    expect(built).toEqual({ ok: false, reason: '1 line(s) or choice(s) have no kitchen item number' });
  });

  it('an order written before the snapshot kept ids maps by its words, as before', () => {
    const groups = CATALOGUE[0]!.optionGroups;
    expect(kitchenOptionFor(groups, { optionGroupName: 'Toppings', optionName: 'Pepperoni' })?.externalItemNo).toBe('121');
    expect(kitchenOptionFor(groups, { optionId: null, optionGroupName: 'Cheese (Stuffed crust)', optionName: 'Cheddar', plainGroupName: 'Cheese', plainOptionName: 'Cheddar' })?.externalItemNo).toBe('52');
    expect(kitchenOptionFor(groups, { optionId: 'gone', optionGroupName: 'Toppings', optionName: 'Olives' })).toBeUndefined();
  });
});
