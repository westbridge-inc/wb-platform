import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [MENU-OPTIONS · review B S2-2 · review A S3-3] Library writes at a real menu's size, through the real routes:
// a 20-choice group attached to 200 and then 500 items (the bound), a shared sold-out toggle, a shared price edit and a
// detach on all 500. Before the fix these ran row by row inside Prisma's default 5 s transaction: 300 items failed
// with "Transaction already closed". Synthetic fixtures only.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const TAG = wordFreeTag();
const phoneBase = 592_670_000_000 + Math.floor(Math.random() * 300_000_000);
let app: FastifyInstance;
let ownerUserId = '';
let token = '';
const shop = { vendorId: '', categoryId: '' };

const ownerCall = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: Record<string, unknown>) => app.inject({
  method, url: `/api/v1/vendor${path}`,
  ...(payload !== undefined ? { payload } : {}),
  headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}`, 'x-vendor-id': shop.vendorId },
});

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
  await app.ready();
  const u = await app.prisma.user.create({ data: {
    phone: `+${phoneBase}`, firstName: 'Scale', lastName: 'Owner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date(),
  } });
  ownerUserId = u.id;
  token = app.jwt.sign({ userId: u.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: 'menuopts-scale', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  const owner = await app.prisma.vendorOwner.create({ data: { userId: u.id } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: `Scale Pizza ${TAG}`, slug: `menuscale-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
    phone: `+${phoneBase + 1}`, addressLine1: '1 Synthetic Lane', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
  } });
  shop.vendorId = vendor.id;
  shop.categoryId = (await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Pizzas', sortOrder: 0 } })).id;
});

afterAll(async () => {
  if (shop.vendorId) {
    await app.prisma.item.deleteMany({ where: { vendorId: shop.vendorId } });
    await app.prisma.modifierGroup.deleteMany({ where: { vendorId: shop.vendorId } });
    await app.prisma.category.deleteMany({ where: { vendorId: shop.vendorId } });
    await app.prisma.vendor.deleteMany({ where: { id: shop.vendorId } });
  }
  if (ownerUserId) {
    await app.prisma.vendorOwner.deleteMany({ where: { userId: ownerUserId } });
    await app.prisma.user.deleteMany({ where: { id: ownerUserId } });
  }
  await app.close();
});

describe('[B S2-2 · A S3-3] the library at a real menu\'s size', () => {
  const TOPPINGS = Array.from({ length: 20 }, (_, i) => ({ name: `Topping ${i + 1}`, price: 100 + i * 25 }));
  let groupId = '';
  let firstChoice = '';
  const items: string[] = [];

  beforeAll(async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ vendorId: shop.vendorId, categoryId: shop.categoryId, name: `Scale Pie ${i} ${TAG}`, basePrice: 1500, isAvailable: true }));
    await app.prisma.item.createMany({ data: rows });
    items.push(...(await app.prisma.item.findMany({ where: { vendorId: shop.vendorId }, select: { id: true }, orderBy: { name: 'asc' } })).map((i) => i.id));
    const lib = await ownerCall('POST', '/modifier-groups', { name: 'Toppings', allowHalves: true, halfPricePercent: 50, maxSelect: 5, options: TOPPINGS });
    expect(lib.statusCode).toBe(200);
    groupId = lib.json().data.id;
    firstChoice = lib.json().data.options[0].id;
  }, 120_000);

  it('attaches to 200 items, then to all 500 (the bound), every copy complete', async () => {
    const first = await ownerCall('POST', `/modifier-groups/${groupId}/attach`, { itemIds: items.slice(0, 200) });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data.attached).toHaveLength(200);
    const all = await ownerCall('POST', `/modifier-groups/${groupId}/attach`, { itemIds: items });
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json().data.attached).toHaveLength(300);
    expect(all.json().data.already).toHaveLength(200);
    expect(await app.prisma.option.count({ where: { optionGroup: { libraryGroupId: groupId } } })).toBe(500 * 20);
  }, 120_000);

  it('a shared sold-out toggle reaches all 500 copies in one step', async () => {
    const res = await ownerCall('PUT', `/modifier-options/${firstChoice}`, { isAvailable: false });
    expect(res.statusCode, res.body).toBe(200);
    expect(await app.prisma.option.count({ where: { libraryOptionId: firstChoice, isAvailable: false } })).toBe(500);
  }, 120_000);

  it('a shared price edit re-prices all 500 copies, copy ids kept', async () => {
    const before = await app.prisma.option.findMany({ where: { libraryOptionId: firstChoice }, select: { id: true } });
    const res = await ownerCall('PUT', `/modifier-options/${firstChoice}`, { price: 150 });
    expect(res.statusCode, res.body).toBe(200);
    const after = await app.prisma.option.findMany({ where: { libraryOptionId: firstChoice }, select: { id: true, additionalPrice: true } });
    expect(after.map((o) => o.id).sort()).toEqual(before.map((o) => o.id).sort());
    expect(after.every((o) => Number(o.additionalPrice) === 150)).toBe(true);
  }, 120_000);

  it('detaching from all 500 at once', async () => {
    const res = await ownerCall('POST', `/modifier-groups/${groupId}/detach`, { itemIds: items });
    expect(res.statusCode, res.body).toBe(200);
    expect(await app.prisma.optionGroup.count({ where: { libraryGroupId: groupId } })).toBe(0);
  }, 120_000);
});
