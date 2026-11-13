import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { MENU_OPTIONS_CAPABILITY } from '../modules/order/options';
import { wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [MENU-OPTIONS · reviews A + B, 12 Nov 2026] The fixes, through the real routes:
//  - B S2-1: turning "Sets the price" on or off never moves a live item's price by itself: the switch carries every
//    choice's new price (the tools convert and confirm), a size is never $0, a size group is never empty;
//  - B S3-5: an older store app cannot write into a size / half / follow-up group (it would read a size as "+$");
//  - A S3-1: the promo check counts a sized line at its size's price;
//  - S4s: reorder asks an older app to update; library prices are whole dollars and audited; attach answers 404 for
//    another store's item before anything else; the "from" price ignores sold-out sizes.
//  - A S3-2: the rollback refuses while menus use the rules (a revert would overcharge every sized item).
// Synthetic fixtures only.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const TAG = wordFreeTag();
const phoneBase = 592_660_000_000 + Math.floor(Math.random() * 300_000_000);
let seq = 0;
let app: FastifyInstance;
const createdUserIds: string[] = [];
const vendorIds: string[] = [];
const promoIds: string[] = [];
const CAP = { capabilities: [MENU_OPTIONS_CAPABILITY] };

async function user(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const u = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + seq}`, firstName: 'Review', lastName: `U${seq}`, roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
    ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
  } });
  createdUserIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: 'menuopts-review', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: u.id, token };
}

async function store(ownerUserId: string, label: string) {
  seq += 1;
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: `${label} Review ${TAG}`, slug: `menurev-${label.toLowerCase()}-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
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
let otherOwner: { userId: string; token: string };
let customer: { userId: string; token: string };
let shop: { vendorId: string; categoryId: string };
let other: { vendorId: string; categoryId: string };

const V = (path: string) => `/api/v1/vendor${path}`;
const ownerCall = (m: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) => inject(m, V(path), owner.token, body, shop.vendorId);
const item = async (name: string, basePrice: number, vendor = shop) =>
  (await app.prisma.item.create({ data: { vendorId: vendor.vendorId, categoryId: vendor.categoryId, name: `${name} ${TAG}`, basePrice, isAvailable: true } })).id;
const price = async (itemId: string) => Number((await app.prisma.item.findUniqueOrThrow({ where: { id: itemId } })).basePrice);
const choices = async (groupId: string) =>
  (await app.prisma.option.findMany({ where: { optionGroupId: groupId }, orderBy: { sortOrder: 'asc' } })).map((o) => ({ id: o.id, name: o.name, price: Number(o.additionalPrice) }));

/** A per-item group the store built before menu options existed: "Size" as add-ons. */
async function addOnSizes(itemId: string) {
  const res = await ownerCall('POST', `/items/${itemId}/option-groups`, {
    name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1, options: [{ name: 'Small', additionalPrice: 0 }, { name: 'Large', additionalPrice: 500 }],
  });
  expect(res.statusCode).toBe(200);
  return res.json().data as { id: string; options: Array<{ id: string; name: string }> };
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
  otherOwner = await user(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  customer = await user(['CUSTOMER'], 'CUSTOMER');
  shop = await store(owner.userId, 'Alpha');
  other = await store(otherOwner.userId, 'Bravo');
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
  if (promoIds.length) await app.prisma.promoCode.deleteMany({ where: { id: { in: promoIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  if (vendorIds.length) {
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

describe('[B S2-1] "Sets the price" on a live group carries every choice\'s new price', () => {
  it('turning it on without the converted prices is refused, and the item keeps its price', async () => {
    const pizza = await item('Flip On', 2000);
    const size = await addOnSizes(pizza);
    const res = await ownerCall('PUT', `/option-groups/${size.id}`, { setsPrice: true, ...CAP });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MENU_OPTIONS_RULE');
    expect(await price(pizza)).toBe(2000);
    expect((await app.prisma.optionGroup.findUniqueOrThrow({ where: { id: size.id } })).setsPrice).toBe(false);
  });

  it('with the converted prices (item price + add-on) the switch lands in one step and the item price is unchanged', async () => {
    const pizza = await item('Flip On Priced', 2000);
    const size = await addOnSizes(pizza);
    const [small, large] = size.options;
    const res = await ownerCall('PUT', `/option-groups/${size.id}`, { setsPrice: true, prices: [{ id: small!.id, price: 2000 }, { id: large!.id, price: 2500 }], ...CAP });
    expect(res.statusCode).toBe(200);
    expect(await price(pizza)).toBe(2000);
    expect(await choices(size.id)).toEqual([{ id: small!.id, name: 'Small', price: 2000 }, { id: large!.id, name: 'Large', price: 2500 }]);
  });

  it('turning it off needs the add-ons back (price minus the lowest); the item keeps the lowest size as its price', async () => {
    const pizza = await item('Flip Off', 0);
    const created = await ownerCall('POST', `/items/${pizza}/option-groups`, {
      name: 'Size', setsPrice: true, options: [{ name: 'Small', additionalPrice: 1800 }, { name: 'Large', additionalPrice: 2600 }], ...CAP,
    });
    expect(created.statusCode).toBe(200);
    const size = created.json().data as { id: string; options: Array<{ id: string }> };
    expect(await price(pizza)).toBe(1800);
    const bare = await ownerCall('PUT', `/option-groups/${size.id}`, { setsPrice: false, ...CAP });
    expect(bare.statusCode).toBe(400);
    const res = await ownerCall('PUT', `/option-groups/${size.id}`, { setsPrice: false, prices: [{ id: size.options[0]!.id, price: 0 }, { id: size.options[1]!.id, price: 800 }], ...CAP });
    expect(res.statusCode).toBe(200);
    expect(await price(pizza)).toBe(1800);
    expect((await choices(size.id)).map((c) => c.price)).toEqual([0, 800]);
  });

  // [DELTA REVIEW S2-N1] The tools convert OFF against the LOWEST of all sizes and the confirm says "the item keeps its
  // smallest size as its price". The "from" price skips a sold-out size, so the item had to be set to that lowest size
  // on the switch, or every add-on cost the gap on top (Large 2400 + 1200 = 3600).
  it('off while the cheapest size is sold out: the item keeps the LOWEST size (sold out included), and a Large still costs 2400', async () => {
    const pizza = await item('Flip Off Sold Out', 0);
    const created = await ownerCall('POST', `/items/${pizza}/option-groups`, {
      name: 'Size', setsPrice: true, options: [{ name: 'Small', additionalPrice: 1200 }, { name: 'Large', additionalPrice: 2400 }], ...CAP,
    });
    expect(created.statusCode).toBe(200);
    const size = created.json().data as { id: string; options: Array<{ id: string; name: string }> };
    const [small, large] = size.options;
    expect((await ownerCall('PUT', `/options/${small!.id}`, { isAvailable: false, ...CAP })).statusCode).toBe(200);
    expect(await price(pizza), 'the "from" price skips the sold-out Small').toBe(2400);
    const res = await ownerCall('PUT', `/option-groups/${size.id}`, { setsPrice: false, prices: [{ id: small!.id, price: 0 }, { id: large!.id, price: 1200 }], ...CAP });
    expect(res.statusCode).toBe(200);
    expect(await price(pizza), 'the smallest size, as the confirm said').toBe(1200);
    const add = await inject('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: shop.vendorId, itemId: pizza, selectedOptions: { [size.id]: large!.id }, ...CAP });
    expect(add.statusCode, JSON.stringify(add.json())).toBe(201);
    const line = add.json().data.cart.items.find((l: { itemId: string }) => l.itemId === pizza);
    expect(line.customerPrice, 'a Large costs what it cost before the switch').toBe(2400);
    await app.prisma.cart.deleteMany({ where: { customerId: customer.userId } });
  });

  it('a shared size group off while its cheapest size is sold out: every item that uses it keeps the lowest size', async () => {
    const a = await item('Shared Off A', 0);
    const b = await item('Shared Off B', 0);
    const lib = await ownerCall('POST', '/modifier-groups', { name: 'Size', setsPrice: true, options: [{ name: 'Small', price: 1200 }, { name: 'Large', price: 2400 }], ...CAP });
    expect(lib.statusCode).toBe(200);
    const group = lib.json().data as { id: string; options: Array<{ id: string }> };
    expect((await ownerCall('POST', `/modifier-groups/${group.id}/attach`, { itemIds: [a, b], ...CAP })).statusCode).toBe(200);
    expect((await ownerCall('PUT', `/modifier-options/${group.options[0]!.id}`, { isAvailable: false, ...CAP })).statusCode).toBe(200);
    expect([await price(a), await price(b)]).toEqual([2400, 2400]);
    const res = await ownerCall('PUT', `/modifier-groups/${group.id}`, { setsPrice: false, prices: [{ id: group.options[0]!.id, price: 0 }, { id: group.options[1]!.id, price: 1200 }], ...CAP });
    expect(res.statusCode).toBe(200);
    expect([await price(a), await price(b)]).toEqual([1200, 1200]);
  });

  it('prices that miss a choice, or name another group\'s choice, are refused', async () => {
    const pizza = await item('Flip Partial', 2000);
    const size = await addOnSizes(pizza);
    const elsewhere = await addOnSizes(await item('Flip Elsewhere', 1000));
    const partial = await ownerCall('PUT', `/option-groups/${size.id}`, { setsPrice: true, prices: [{ id: size.options[1]!.id, price: 2500 }], ...CAP });
    expect(partial.statusCode).toBe(400);
    const foreign = await ownerCall('PUT', `/option-groups/${size.id}`, {
      setsPrice: true, prices: [{ id: size.options[0]!.id, price: 2000 }, { id: elsewhere.options[1]!.id, price: 2500 }], ...CAP,
    });
    expect(foreign.statusCode).toBe(400);
    expect(await price(pizza)).toBe(2000);
  });

  it('a size is never $0: on the switch, on create, on a new choice and on an edit', async () => {
    const pizza = await item('Zero Size', 2000);
    const size = await addOnSizes(pizza);
    const zero = await ownerCall('PUT', `/option-groups/${size.id}`, { setsPrice: true, prices: [{ id: size.options[0]!.id, price: 0 }, { id: size.options[1]!.id, price: 2500 }], ...CAP });
    expect(zero.statusCode).toBe(400);
    expect(await price(pizza)).toBe(2000);
    const fresh = await item('Zero Size Fresh', 0);
    const created = await ownerCall('POST', `/items/${fresh}/option-groups`, { name: 'Size', setsPrice: true, options: [{ name: 'Small', additionalPrice: 0 }], ...CAP });
    expect(created.statusCode).toBe(400);
    const ok = await ownerCall('POST', `/items/${fresh}/option-groups`, { name: 'Size', setsPrice: true, options: [{ name: 'Small', additionalPrice: 1500 }], ...CAP });
    expect(ok.statusCode).toBe(200);
    const groupId = ok.json().data.id as string;
    expect((await ownerCall('POST', `/option-groups/${groupId}/options`, { name: 'Free', additionalPrice: 0, ...CAP })).statusCode).toBe(400);
    const small = ok.json().data.options[0].id as string;
    expect((await ownerCall('PUT', `/options/${small}`, { additionalPrice: 0, ...CAP })).statusCode).toBe(400);
    expect(await price(fresh)).toBe(1500);
  });

  it('a size group is never empty: created without sizes, or its last size deleted, is refused', async () => {
    const pizza = await item('Empty Size', 1000);
    const empty = await ownerCall('POST', `/items/${pizza}/option-groups`, { name: 'Size', setsPrice: true, ...CAP });
    expect(empty.statusCode).toBe(400);
    const one = await ownerCall('POST', `/items/${pizza}/option-groups`, { name: 'Size', setsPrice: true, options: [{ name: 'Only', additionalPrice: 1200 }], ...CAP });
    expect(one.statusCode).toBe(200);
    expect((await ownerCall('DELETE', `/options/${one.json().data.options[0].id}`)).statusCode).toBe(400);
  });

  it('a shared group: the switch carries the full prices; every item that uses it then costs its sizes', async () => {
    const a = await item('Shared Flip A', 2000);
    const b = await item('Shared Flip B', 2000);
    const lib = await ownerCall('POST', '/modifier-groups', { name: 'Size', isRequired: true, minSelect: 1, options: [{ name: 'Small', price: 0 }, { name: 'Large', price: 500 }] });
    expect(lib.statusCode).toBe(200);
    const group = lib.json().data as { id: string; options: Array<{ id: string }> };
    expect((await ownerCall('POST', `/modifier-groups/${group.id}/attach`, { itemIds: [a, b] })).statusCode).toBe(200);
    const bare = await ownerCall('PUT', `/modifier-groups/${group.id}`, { setsPrice: true });
    expect(bare.statusCode).toBe(400);
    expect([await price(a), await price(b)]).toEqual([2000, 2000]);
    const zero = await ownerCall('PUT', `/modifier-groups/${group.id}`, { setsPrice: true, prices: [{ id: group.options[0]!.id, price: 0 }, { id: group.options[1]!.id, price: 2500 }] });
    expect(zero.statusCode).toBe(400);
    const res = await ownerCall('PUT', `/modifier-groups/${group.id}`, { setsPrice: true, prices: [{ id: group.options[0]!.id, price: 2000 }, { id: group.options[1]!.id, price: 2500 }] });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.options.map((o: { price: number }) => o.price)).toEqual([2000, 2500]);
    expect([await price(a), await price(b)]).toEqual([2000, 2000]);
  });

  it('a shared size group: a $0 size is refused, and attaching it while it has no sizes is refused', async () => {
    expect((await ownerCall('POST', '/modifier-groups', { name: 'Size', setsPrice: true, options: [{ name: 'Free', price: 0 }] })).statusCode).toBe(400);
    const empty = await ownerCall('POST', '/modifier-groups', { name: 'Size', setsPrice: true });
    expect(empty.statusCode).toBe(200);
    const id = empty.json().data.id as string;
    expect((await ownerCall('POST', `/modifier-groups/${id}/options`, { name: 'Free', price: 0 })).statusCode).toBe(400);
    expect((await ownerCall('POST', `/modifier-groups/${id}/attach`, { itemIds: [await item('Empty Shared', 900)] })).statusCode).toBe(400);
  });
});

describe('[B S3-5] an older store app cannot write into a size, half or follow-up group', () => {
  it('without the capability: 409 update-the-app on the group, a new choice and a price edit; a sold-out toggle still works', async () => {
    const pizza = await item('Old Store App', 0);
    const created = await ownerCall('POST', `/items/${pizza}/option-groups`, { name: 'Size', setsPrice: true, options: [{ name: 'Small', additionalPrice: 1500 }, { name: 'Large', additionalPrice: 2500 }], ...CAP });
    const size = created.json().data as { id: string; options: Array<{ id: string }> };
    for (const res of [
      await ownerCall('PUT', `/option-groups/${size.id}`, { name: 'Sizes' }),
      await ownerCall('POST', `/option-groups/${size.id}/options`, { name: 'Extra large', additionalPrice: 200 }),
      await ownerCall('PUT', `/options/${size.options[1]!.id}`, { additionalPrice: 200 }),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('APP_UPDATE_REQUIRED');
      expect(res.json().error.message).toMatch(/Update the Swift app/);
    }
    expect((await choices(size.id)).map((c) => c.price)).toEqual([1500, 2500]);
    expect((await ownerCall('PUT', `/options/${size.options[1]!.id}`, { isAvailable: false })).statusCode).toBe(200);
    // The updated tools say they can: the same writes land.
    expect((await ownerCall('POST', `/option-groups/${size.id}/options`, { name: 'Extra large', additionalPrice: 3200, ...CAP })).statusCode).toBe(200);
  });

  it('a plain group is edited by an older app as before', async () => {
    const plain = await item('Old Store Plain', 900);
    const group = await addOnSizes(plain);
    expect((await ownerCall('POST', `/option-groups/${group.id}/options`, { name: 'Medium', additionalPrice: 200 })).statusCode).toBe(200);
    expect((await ownerCall('PUT', `/option-groups/${group.id}`, { name: 'Portion' })).statusCode).toBe(200);
  });
});

describe('[A S3-1] the promo check counts a sized line at its size\'s price', () => {
  it('a Large (3500) on a "from 1200" pizza meets a 3000 minimum', async () => {
    const pizza = await item('Promo Pizza', 0);
    const created = await ownerCall('POST', `/items/${pizza}/option-groups`, { name: 'Size', setsPrice: true, options: [{ name: 'Personal', additionalPrice: 1200 }, { name: 'Large', additionalPrice: 3500 }], ...CAP });
    const size = created.json().data as { id: string; options: Array<{ id: string; name: string }> };
    const large = size.options.find((o) => o.name === 'Large')!.id;
    const add = await inject('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: shop.vendorId, itemId: pizza, selectedOptions: { [size.id]: large }, ...CAP });
    expect(add.statusCode).toBe(201);
    const promo = await app.prisma.promoCode.create({ data: {
      code: `REV${nanoid(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, description: 'review minimum', discountType: 'FIXED_AMOUNT', discountValue: 100,
      minOrderAmount: 3000, applicableTo: [], validFrom: new Date(Date.now() - DAY), validUntil: new Date(Date.now() + DAY), maxUsesPerUser: 5,
      vendorId: shop.vendorId, funder: 'VENDOR',
    } });
    promoIds.push(promo.id);
    const res = await inject('POST', '/api/v1/customer/promo/validate', customer.token, { code: promo.code });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    await app.prisma.cart.deleteMany({ where: { customerId: customer.userId } });
  });
});

describe('[S4] the smaller fixes', () => {
  it('library prices are whole dollars', async () => {
    expect((await ownerCall('POST', '/modifier-groups', { name: 'Dips', options: [{ name: 'Garlic', price: 99.99 }] })).statusCode).toBe(400);
    const ok = await ownerCall('POST', '/modifier-groups', { name: 'Dips', options: [{ name: 'Garlic', price: 100 }] });
    expect(ok.statusCode).toBe(200);
    expect((await ownerCall('PUT', `/modifier-options/${ok.json().data.options[0].id}`, { price: 12.5 })).statusCode).toBe(400);
  });

  it('a library price edit leaves an audit row: who, the choice, old and new price, how many items', async () => {
    const a = await item('Audit A', 800);
    const lib = await ownerCall('POST', '/modifier-groups', { name: 'Sauce', options: [{ name: 'Hot', price: 50 }] });
    const group = lib.json().data as { id: string; options: Array<{ id: string }> };
    await ownerCall('POST', `/modifier-groups/${group.id}/attach`, { itemIds: [a] });
    expect((await ownerCall('PUT', `/modifier-options/${group.options[0]!.id}`, { price: 75 })).statusCode).toBe(200);
    const row = await app.prisma.auditLog.findFirst({ where: { entity: 'ModifierOption', entityId: group.options[0]!.id }, orderBy: { createdAt: 'desc' } });
    expect(row).toMatchObject({ userId: owner.userId, action: 'MODIFIER_OPTION_PRICE_SET' });
    expect(row!.changes).toMatchObject({ vendorId: shop.vendorId, from: 50, to: 75, items: 1 });
  });

  it('attach answers 404 for another store\'s item, even one Swift does not allow, before anything else', async () => {
    const banned = await item('Other Banned', 900, other);
    await app.prisma.item.update({ where: { id: banned }, data: { prohibitedAt: new Date(), prohibitedClass: 'ALCOHOL', prohibitedReason: 'synthetic' } });
    const lib = await ownerCall('POST', '/modifier-groups', { name: 'Extras', options: [{ name: 'Cheese', price: 100 }] });
    const res = await ownerCall('POST', `/modifier-groups/${lib.json().data.id}/attach`, { itemIds: [banned] });
    expect(res.statusCode).toBe(404);
  });

  it('the "from" price ignores a sold-out size, and comes back when it is on sale again', async () => {
    const pizza = await item('From Sold Out', 0);
    const created = await ownerCall('POST', `/items/${pizza}/option-groups`, { name: 'Size', setsPrice: true, options: [{ name: 'Small', additionalPrice: 1200 }, { name: 'Large', additionalPrice: 2400 }], ...CAP });
    const small = created.json().data.options[0].id as string;
    expect(await price(pizza)).toBe(1200);
    expect((await ownerCall('PUT', `/options/${small}`, { isAvailable: false })).statusCode).toBe(200);
    expect(await price(pizza)).toBe(2400);
    expect((await ownerCall('PUT', `/options/${small}`, { isAvailable: true })).statusCode).toBe(200);
    expect(await price(pizza)).toBe(1200);
  });

  it('reorder asks an older app to update for a sized line; the updated app gets it back', async () => {
    const pizza = await item('Reorder Pizza', 0);
    const created = await ownerCall('POST', `/items/${pizza}/option-groups`, { name: 'Size', setsPrice: true, options: [{ name: 'Small', additionalPrice: 1300 }, { name: 'Large', additionalPrice: 2300 }], ...CAP });
    const size = created.json().data as { id: string; options: Array<{ id: string }> };
    const add = await inject('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: shop.vendorId, itemId: pizza, selectedOptions: { [size.id]: size.options[1]!.id }, ...CAP });
    expect(add.statusCode).toBe(201);
    const checkout = await inject('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH', fulfillmentSelections: { [shop.vendorId]: 'PICKUP' } });
    expect(checkout.statusCode, JSON.stringify(checkout.json())).toBe(200);
    const orderId = checkout.json().data.orders[0].id as string;
    const old = await inject('POST', `/api/v1/customer/orders/${orderId}/reorder`, customer.token);
    expect(old.statusCode).toBe(409);
    expect(old.json().error.code).toBe('APP_UPDATE_REQUIRED');
    const updated = await inject('POST', `/api/v1/customer/orders/${orderId}/reorder`, customer.token, CAP);
    expect(updated.statusCode, JSON.stringify(updated.json())).toBe(200);
    await app.prisma.cart.deleteMany({ where: { customerId: customer.userId } });
  });

  it('the order-line placement check is added NOT VALID and validated after, like the other checks on big tables', () => {
    const sql = readFileSync(join(process.cwd(), 'prisma/migrations/20261111150000_menu_options_pizza/migration.sql'), 'utf8');
    expect(sql).toMatch(/ADD CONSTRAINT "order_item_options_placement_check"\s+CHECK \("placement" IS NULL OR "placement" IN \('WHOLE', 'LEFT', 'RIGHT'\)\) NOT VALID;/);
    expect(sql).toMatch(/ALTER TABLE "order_item_options" VALIDATE CONSTRAINT "order_item_options_placement_check";/);
  });
});

describe('[A S3-2] the rollback refuses while menus use the rules', () => {
  it('a size group on any item stops rollback.sql before it drops anything', async () => {
    const pizza = await item('Rollback Guard', 0);
    const created = await ownerCall('POST', `/items/${pizza}/option-groups`, { name: 'Size', setsPrice: true, options: [{ name: 'Small', additionalPrice: 1000 }], ...CAP });
    expect(created.statusCode).toBe(200);
    const sql = readFileSync(join(process.cwd(), 'prisma/migrations/20261111150000_menu_options_pizza/rollback.sql'), 'utf8');
    // Only the guards run (never the DROPs on a shared test database): each DO block before the first DROP, one at a time,
    // each inside a transaction that is always undone.
    const guards = sql.slice(0, sql.indexOf('DROP ')).match(/DO \$\$[\s\S]*?END \$\$;/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
    const refusals: string[] = [];
    for (const guard of guards) {
      await app.prisma.$transaction(async (tx) => {
        try { await tx.$executeRawUnsafe(guard); } catch (e) { refusals.push(String(e)); }
        throw new Error('undo');
      }).catch(() => undefined);
    }
    expect(refusals.join('\n')).toMatch(/menu options rollback refused: menus use sizes, halves or follow-up choices; neutralise them first/);
  });

  // [DELTA REVIEW S3-N1] Without a transaction a plain `psql -f` reports the refusal and goes on to the DROPs.
  it('the whole file is one transaction: BEGIN before the first guard, COMMIT after the last DROP (a refusal stops every DROP)', () => {
    const sql = readFileSync(join(process.cwd(), 'prisma/migrations/20261111150000_menu_options_pizza/rollback.sql'), 'utf8');
    const statements = sql.split('\n').filter((l) => l.trim() !== '' && !l.trimStart().startsWith('--'));
    expect(statements[0]).toBe('BEGIN;');
    expect(statements[1]).toBe("SET LOCAL lock_timeout = '10s';");
    expect(statements.at(-1)).toBe('COMMIT;');
    expect(sql.indexOf('BEGIN;')).toBeLessThan(sql.indexOf('DO $$'));
    expect(sql.lastIndexOf('DROP ')).toBeLessThan(sql.lastIndexOf('COMMIT;'));
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
});
