import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { MENU_OPTIONS_CAPABILITY, MENU_OPTIONS_APP_UPDATE_MESSAGE } from '../modules/order/options';
import { wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [MENU-OPTIONS · owner 11 Nov 2026] The pizza menu end to end, through the real routes:
//  - the shared library: build once, bulk-attach, edit once -> every item changes (copy option ids kept);
//  - store authz: owner/manager edit; staff read only; another store gets 404;
//  - an item's copy of a shared group is edited only in the library (sold-out toggles go to the library);
//  - rules the server holds (one size group per item, one level of follow-ups) roll a whole write back;
//  - an older app is told to update instead of ordering an item it cannot show;
//  - the order line snapshots everything; later menu edits never change it; the kitchen gets the parts.
// Synthetic fixtures only.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const TAG = wordFreeTag();
const phoneBase = 592_650_000_000 + Math.floor(Math.random() * 300_000_000);
let seq = 0;
let app: FastifyInstance;
const createdUserIds: string[] = [];
const vendorIds: string[] = [];

async function user(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const u = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + seq}`, firstName: 'Pizza', lastName: `U${seq}`, roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
    ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
  } });
  createdUserIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: 'menuopts', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: u.id, token };
}

async function store(ownerUserId: string, label: string) {
  seq += 1;
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: `${label} Pizza ${TAG}`, slug: `menuopts-${label.toLowerCase()}-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
    phone: `+${phoneBase + 500 + seq}`, addressLine1: '1 Synthetic Lane', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
  } });
  vendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Pizzas', sortOrder: 0 } });
  return { vendorId: vendor.id, categoryId: category.id };
}

function inject(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown, vendorId?: string) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
      ...(vendorId ? { 'x-vendor-id': vendorId } : {}),
    },
  });
}

let owner: { userId: string; token: string };
let staff: { userId: string; token: string };
let otherOwner: { userId: string; token: string };
let shop: { vendorId: string; categoryId: string };
let other: { vendorId: string; categoryId: string };
let pizzaA: string;
let pizzaB: string;
let plainItem: string;
let otherItem: string;
const lib = { size: '', crust: '', cheese: '', toppings: '' };

const V = (path: string) => `/api/v1/vendor${path}`;
const ownerCall = (m: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) => inject(m, V(path), owner.token, body, shop.vendorId);

async function itemGroups(itemId: string) {
  return app.prisma.optionGroup.findMany({ where: { itemId }, include: { options: { orderBy: { sortOrder: 'asc' } } }, orderBy: { sortOrder: 'asc' } });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  owner = await user(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  staff = await user(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  otherOwner = await user(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  shop = await store(owner.userId, 'Alpha');
  other = await store(otherOwner.userId, 'Bravo');
  await app.prisma.vendorStaff.create({ data: { vendorId: shop.vendorId, userId: staff.userId, role: 'STAFF', invitedBy: owner.userId } });
  const mk = async (vendorId: string, categoryId: string, name: string, basePrice: number) =>
    (await app.prisma.item.create({ data: { vendorId, categoryId, name, basePrice, isAvailable: true } })).id;
  pizzaA = await mk(shop.vendorId, shop.categoryId, 'Synthetic Supreme', 0);
  pizzaB = await mk(shop.vendorId, shop.categoryId, 'Synthetic Veggie', 0);
  plainItem = await mk(shop.vendorId, shop.categoryId, 'Synthetic Garlic Bread', 600);
  otherItem = await mk(other.vendorId, other.categoryId, 'Synthetic Other Pie', 900);
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.cartMergeReceipt.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.address.deleteMany({ where: { userId: { in: createdUserIds } } });
  if (vendorIds.length) {
    await app.prisma.vendorStaff.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.modifierGroup.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  }
  if (createdUserIds.length) {
    await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('[MENU-OPTIONS] the shared option library', () => {
  it('the owner builds groups once; a size group is made "pick exactly one"', async () => {
    const size = await ownerCall('POST', '/modifier-groups', {
      name: 'Size', setsPrice: true, options: [{ name: 'Personal', price: 1200 }, { name: 'Medium', price: 2500 }, { name: 'Large', price: 3500 }],
    });
    expect(size.statusCode).toBe(200);
    expect(size.json().data).toMatchObject({ setsPrice: true, isRequired: true, minSelect: 1, maxSelect: 1, usedByItemCount: 0 });
    lib.size = size.json().data.id;
    const cheese = await ownerCall('POST', '/modifier-groups', { name: 'Cheese', isRequired: true, minSelect: 1, options: [{ name: 'Mozzarella', price: 0 }, { name: 'Cheddar', price: 100 }] });
    lib.cheese = cheese.json().data.id;
    const crust = await ownerCall('POST', '/modifier-groups', { name: 'Crust', isRequired: true, minSelect: 1, options: [{ name: 'Thin', price: 0 }, { name: 'Stuffed crust', price: 500 }] });
    lib.crust = crust.json().data.id;
    const stuffed = crust.json().data.options.find((o: { name: string }) => o.name === 'Stuffed crust');
    expect((await ownerCall('PUT', `/modifier-options/${stuffed.id}`, { followUpGroupId: lib.cheese })).statusCode).toBe(200);
    const toppings = await ownerCall('POST', '/modifier-groups', {
      name: 'Toppings', allowHalves: true, halfPricePercent: 50, maxSelect: 3,
      options: [{ name: 'Pepperoni', price: 300 }, { name: 'Mushroom', price: 175 }, { name: 'Onion', price: 100 }],
    });
    expect(toppings.json().data).toMatchObject({ allowHalves: true, halfPricePercent: 50 });
    lib.toppings = toppings.json().data.id;
  });

  it('bulk attach writes the group onto each item; the follow-up comes along; the item price becomes the lowest size', async () => {
    for (const id of [lib.size, lib.crust, lib.toppings]) {
      const res = await ownerCall('POST', `/modifier-groups/${id}/attach`, { itemIds: [pizzaA, pizzaB] });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.attached.sort()).toEqual([pizzaA, pizzaB].sort());
    }
    for (const itemId of [pizzaA, pizzaB]) {
      const groups = await itemGroups(itemId);
      expect(groups.map((g) => g.name).sort()).toEqual(['Cheese', 'Crust', 'Size', 'Toppings']);
      expect(groups.every((g) => g.libraryGroupId)).toBe(true);
      const cheese = groups.find((g) => g.name === 'Cheese')!;
      const stuffed = groups.find((g) => g.name === 'Crust')!.options.find((o) => o.name === 'Stuffed crust')!;
      expect(stuffed.followUpGroupId).toBe(cheese.id);
      const item = await app.prisma.item.findUniqueOrThrow({ where: { id: itemId } });
      expect(Number(item.basePrice)).toBe(1200);
    }
    const library = (await ownerCall('GET', '/modifier-groups')).json().data as Array<{ id: string; usedByItemCount: number; isFollowUp: boolean }>;
    expect(library.find((g) => g.id === lib.size)!.usedByItemCount).toBe(2);
    expect(library.find((g) => g.id === lib.cheese)!.isFollowUp).toBe(true);
    // Attaching again is a no-op.
    expect((await ownerCall('POST', `/modifier-groups/${lib.size}/attach`, { itemIds: [pizzaA] })).json().data).toEqual({ attached: [], already: [pizzaA] });
  });

  it('editing the library changes every attached item at once, and keeps each copy option id (carts hold them)', async () => {
    const before = (await itemGroups(pizzaA)).find((g) => g.name === 'Size')!.options.find((o) => o.name === 'Large')!;
    const library = (await ownerCall('GET', '/modifier-groups')).json().data as Array<{ id: string; options: Array<{ id: string; name: string }> }>;
    const large = library.find((g) => g.id === lib.size)!.options.find((o) => o.name === 'Large')!;
    expect((await ownerCall('PUT', `/modifier-options/${large.id}`, { price: 3600 })).statusCode).toBe(200);
    for (const itemId of [pizzaA, pizzaB]) {
      const copy = (await itemGroups(itemId)).find((g) => g.name === 'Size')!.options.find((o) => o.name === 'Large')!;
      expect(Number(copy.additionalPrice)).toBe(3600);
      if (itemId === pizzaA) expect(copy.id).toBe(before.id);
    }
    expect((await ownerCall('PUT', `/modifier-options/${large.id}`, { price: 3500 })).statusCode).toBe(200);
  });

  it('an item copy is edited only in the library; a sold-out toggle on a copy goes to the library and every item', async () => {
    const groups = await itemGroups(pizzaA);
    const toppings = groups.find((g) => g.name === 'Toppings')!;
    const mush = toppings.options.find((o) => o.name === 'Mushroom')!;
    expect((await ownerCall('PUT', `/option-groups/${toppings.id}`, { name: 'Renamed' })).json().error.code).toBe('SHARED_OPTION_GROUP');
    expect((await ownerCall('POST', `/option-groups/${toppings.id}/options`, { name: 'Olive', additionalPrice: 50 })).json().error.code).toBe('SHARED_OPTION_GROUP');
    expect((await ownerCall('PUT', `/options/${mush.id}`, { additionalPrice: 1 })).json().error.code).toBe('SHARED_OPTION_GROUP');
    expect((await ownerCall('DELETE', `/options/${mush.id}`)).json().error.code).toBe('SHARED_OPTION_GROUP');
    expect((await ownerCall('PUT', `/options/${mush.id}`, { isAvailable: false })).statusCode).toBe(200);
    for (const itemId of [pizzaA, pizzaB]) {
      expect((await itemGroups(itemId)).find((g) => g.name === 'Toppings')!.options.find((o) => o.name === 'Mushroom')!.isAvailable).toBe(false);
    }
    expect((await ownerCall('PUT', `/options/${mush.id}`, { isAvailable: true })).statusCode).toBe(200);
  });

  it('the server holds the rules: a second size group, or a follow-up two levels deep, is refused and nothing changes', async () => {
    const second = await ownerCall('POST', '/modifier-groups', { name: 'Slices', setsPrice: true, options: [{ name: 'Eight', price: 999 }] });
    const res = await ownerCall('POST', `/modifier-groups/${second.json().data.id}/attach`, { itemIds: [plainItem, pizzaA] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MENU_OPTIONS_RULE');
    // The whole bulk attach rolled back: the plain item got nothing either.
    expect(await itemGroups(plainItem)).toHaveLength(0);
    const library = (await ownerCall('GET', '/modifier-groups')).json().data as Array<{ id: string; options: Array<{ id: string; name: string }> }>;
    const mozz = library.find((g) => g.id === lib.cheese)!.options[0]!;
    const deep = await ownerCall('PUT', `/modifier-options/${mozz.id}`, { followUpGroupId: lib.toppings });
    expect(deep.statusCode).toBe(400);
    expect(deep.json().error.message).toMatch(/one level only/);
    expect((await ownerCall('DELETE', `/modifier-groups/${second.json().data.id}`)).statusCode).toBe(200);
  });

  it('the library holds the one-level rule itself, even for groups not on any item yet', async () => {
    const mk = async (name: string) => (await ownerCall('POST', '/modifier-groups', { name, options: [{ name: `${name} one`, price: 0 }] })).json().data;
    const x = await mk('Level X');
    const y = await mk('Level Y');
    const z = await mk('Level Z');
    expect((await ownerCall('PUT', `/modifier-options/${x.options[0].id}`, { followUpGroupId: y.id })).statusCode).toBe(200);
    const deep = await ownerCall('PUT', `/modifier-options/${y.options[0].id}`, { followUpGroupId: z.id });
    expect(deep.statusCode).toBe(400);
    expect(deep.json().error.message).toMatch(/one level only/);
    expect((await app.prisma.modifierOption.findUniqueOrThrow({ where: { id: y.options[0].id } })).followUpGroupId).toBeNull();
    for (const g of [x, y, z]) expect((await ownerCall('DELETE', `/modifier-groups/${g.id}`)).statusCode).toBe(200);
  });

  it('staff read the library but never edit it; another store cannot see or touch it', async () => {
    expect((await inject('GET', V('/modifier-groups'), staff.token, undefined, shop.vendorId)).statusCode).toBe(200);
    expect((await inject('POST', V('/modifier-groups'), staff.token, { name: 'Sneaky' }, shop.vendorId)).statusCode).toBe(403);
    expect((await inject('PUT', V(`/modifier-groups/${lib.size}`), staff.token, { name: 'X' }, shop.vendorId)).statusCode).toBe(403);
    expect((await inject('POST', V(`/modifier-groups/${lib.size}/attach`), staff.token, { itemIds: [plainItem] }, shop.vendorId)).statusCode).toBe(403);
    // Another store's owner: our group is not found, and our group cannot be put on their item (or theirs on ours).
    const theirs = (await inject('GET', V('/modifier-groups'), otherOwner.token, undefined, other.vendorId)).json().data;
    expect(theirs).toEqual([]);
    expect((await inject('PUT', V(`/modifier-groups/${lib.size}`), otherOwner.token, { name: 'Stolen' }, other.vendorId)).statusCode).toBe(404);
    expect((await inject('POST', V(`/modifier-groups/${lib.size}/attach`), otherOwner.token, { itemIds: [otherItem] }, other.vendorId)).statusCode).toBe(404);
    expect((await ownerCall('POST', `/modifier-groups/${lib.size}/attach`, { itemIds: [otherItem] })).statusCode).toBe(404);
    expect(await itemGroups(otherItem)).toHaveLength(0);
    const size = await app.prisma.modifierGroup.findUniqueOrThrow({ where: { id: lib.size } });
    expect(size.name).toBe('Size');
  });
});

describe('[MENU-OPTIONS] ordering a pizza', () => {
  let customer: { userId: string; token: string };
  let orderId: string;
  const ids = { size: '', large: '', crust: '', stuffed: '', cheese: '', cheddar: '', toppings: '', pep: '', mush: '' };

  beforeAll(async () => {
    customer = await user(['CUSTOMER'], 'CUSTOMER');
    const groups = await itemGroups(pizzaA);
    const g = (n: string) => groups.find((x) => x.name === n)!;
    const o = (n: string, on: string) => g(n).options.find((x) => x.name === on)!.id;
    Object.assign(ids, {
      size: g('Size').id, large: o('Size', 'Large'), crust: g('Crust').id, stuffed: o('Crust', 'Stuffed crust'),
      cheese: g('Cheese').id, cheddar: o('Cheese', 'Cheddar'), toppings: g('Toppings').id, pep: o('Toppings', 'Pepperoni'), mush: o('Toppings', 'Mushroom'),
    });
  });

  const pizzaChoice = () => ({ [ids.size]: ids.large, [ids.crust]: ids.stuffed, [ids.cheese]: ids.cheddar, [ids.toppings]: [`${ids.pep}:left`, `${ids.mush}:right`] });
  const UNIT = 3500 + 500 + 100 + 150 + 88;

  it('an older app is told to update for the pizza, in plain words; a plain item still adds', async () => {
    const res = await inject('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: shop.vendorId, itemId: pizzaA, selectedOptions: pizzaChoice() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'APP_UPDATE_REQUIRED', message: MENU_OPTIONS_APP_UPDATE_MESSAGE });
    const plain = await inject('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: shop.vendorId, itemId: plainItem });
    expect(plain.statusCode).toBe(201);
    await app.prisma.cart.deleteMany({ where: { customerId: customer.userId } });
  });

  it('a guest basket from an app without the capability never lands the pizza', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/customer/cart/merge',
      headers: { authorization: `Bearer ${customer.token}`, 'idempotency-key': nanoid(24).replace(/[^A-Za-z0-9]/g, 'x') },
      payload: { lines: [{ clientLineId: 'a', vendorId: shop.vendorId, itemId: pizzaA, quantity: 1, expectedUnitPrice: UNIT, selectedOptions: pizzaChoice() }] },
    });
    expect(res.statusCode).toBe(200);
    const result = res.json().data;
    expect(result.applied).toBe(false);
    expect(result.verdicts[0]!.status).toBe('OPTIONS_CHANGED');
  });

  it('the updated app adds it; the quote prices it by the server rules, whatever the client thinks', async () => {
    const res = await inject('POST', '/api/v1/customer/cart/items', customer.token, {
      vendorId: shop.vendorId, itemId: pizzaA, quantity: 2, selectedOptions: pizzaChoice(), capabilities: [MENU_OPTIONS_CAPABILITY],
      specialInstructions: 'Well done',
    });
    expect(res.statusCode).toBe(201);
    const lineRow = res.json().data.cart.items.find((l: { itemId: string }) => l.itemId === pizzaA);
    expect(lineRow).toMatchObject({ basePrice: 3500, customerPrice: UNIT, lineTotal: UNIT * 2, isAvailable: true });
    expect(lineRow.selectedOptionNames).toEqual(['Large', 'Stuffed crust', 'Cheddar', 'Pepperoni (left half)', 'Mushroom (right half)']);
  });

  it('checkout snapshots the size, halves and the follow-up under its opener', async () => {
    const res = await inject('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH', fulfillmentSelections: { [shop.vendorId]: 'PICKUP' } });
    expect(res.statusCode).toBe(200);
    orderId = res.json().data.orders[0].id;
    const line = await app.prisma.orderItem.findFirstOrThrow({ where: { orderId }, include: { selectedOptions: true } });
    expect(Number(line.basePrice)).toBe(3500);
    expect(Number(line.totalCustomer)).toBe(UNIT * 2);
    const rows = line.selectedOptions.map((o) => ({
      group: o.optionGroupName, name: o.optionName, price: Number(o.basePrice), plainGroup: o.plainGroupName, plain: o.plainOptionName,
      placement: o.placement, parent: o.parentOptionName, setsPrice: o.setsPrice, listed: o.listedPrice == null ? null : Number(o.listedPrice),
    }));
    expect(rows).toEqual(expect.arrayContaining([
      { group: 'Size', name: 'Large', price: 0, plainGroup: 'Size', plain: 'Large', placement: null, parent: null, setsPrice: true, listed: 3500 },
      { group: 'Crust', name: 'Stuffed crust', price: 500, plainGroup: 'Crust', plain: 'Stuffed crust', placement: null, parent: null, setsPrice: false, listed: 500 },
      { group: 'Cheese (Stuffed crust)', name: 'Cheddar', price: 100, plainGroup: 'Cheese', plain: 'Cheddar', placement: null, parent: 'Stuffed crust', setsPrice: false, listed: 100 },
      { group: 'Toppings', name: 'Pepperoni (left half)', price: 150, plainGroup: 'Toppings', plain: 'Pepperoni', placement: 'LEFT', parent: null, setsPrice: false, listed: 300 },
      { group: 'Toppings', name: 'Mushroom (right half)', price: 88, plainGroup: 'Toppings', plain: 'Mushroom', placement: 'RIGHT', parent: null, setsPrice: false, listed: 175 },
    ]));
    expect(rows).toHaveLength(5);
    // The line adds up: base + every choice, times quantity.
    expect((3500 + rows.reduce((s, r) => s + r.price, 0)) * 2).toBe(Number(line.totalCustomer));
  });

  it('the store kitchen view gets the parts: Left / Right, the opener, the size', async () => {
    const res = await ownerCall('GET', `/orders/${orderId}`);
    expect(res.statusCode).toBe(200);
    const options = res.json().data.items[0].options as Array<Record<string, unknown>>;
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'Toppings', name: 'Pepperoni (left half)', plainName: 'Pepperoni', placement: 'LEFT' }),
      expect.objectContaining({ group: 'Toppings', name: 'Mushroom (right half)', plainName: 'Mushroom', placement: 'RIGHT' }),
      expect.objectContaining({ group: 'Cheese (Stuffed crust)', plainGroup: 'Cheese', parentOptionName: 'Stuffed crust' }),
      expect.objectContaining({ group: 'Size', name: 'Large', setsPrice: true }),
    ]));
  });

  it('later menu edits never change the past order', async () => {
    const library = (await ownerCall('GET', '/modifier-groups')).json().data as Array<{ id: string; options: Array<{ id: string; name: string }> }>;
    const pep = library.find((g) => g.id === lib.toppings)!.options.find((o) => o.name === 'Pepperoni')!;
    const large = library.find((g) => g.id === lib.size)!.options.find((o) => o.name === 'Large')!;
    expect((await ownerCall('PUT', `/modifier-options/${pep.id}`, { name: 'Spicy Pepperoni', price: 999 })).statusCode).toBe(200);
    expect((await ownerCall('PUT', `/modifier-options/${large.id}`, { price: 5000 })).statusCode).toBe(200);
    expect((await ownerCall('PUT', `/modifier-groups/${lib.toppings}`, { halfPricePercent: 100 })).statusCode).toBe(200);
    const line = await app.prisma.orderItem.findFirstOrThrow({ where: { orderId }, include: { selectedOptions: true } });
    expect(Number(line.basePrice)).toBe(3500);
    expect(Number(line.totalCustomer)).toBe(UNIT * 2);
    const pepRow = line.selectedOptions.find((o) => o.plainOptionName === 'Pepperoni')!;
    expect([pepRow.optionName, Number(pepRow.basePrice), Number(pepRow.listedPrice)]).toEqual(['Pepperoni (left half)', 150, 300]);
  });

  it('detach and delete: the shared group leaves the items, follow-ups only it opened go too', async () => {
    expect((await ownerCall('POST', `/modifier-groups/${lib.crust}/detach`, { itemIds: [pizzaB] })).statusCode).toBe(200);
    expect((await itemGroups(pizzaB)).map((g) => g.name).sort()).toEqual(['Size', 'Toppings']);
    const del = await ownerCall('DELETE', `/modifier-groups/${lib.toppings}`);
    expect(del.json().data).toMatchObject({ deleted: true, removedFromItems: 2 });
    expect((await itemGroups(pizzaB)).map((g) => g.name)).toEqual(['Size']);
  });
});

