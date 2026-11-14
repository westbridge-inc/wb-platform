import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { buildApp } from '../app';
import { runWithoutTenant } from '../plugins/prisma';
import { fixtureTag, testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [MENU-BULK · parity audit C2, owner 14 Nov 2026] POST /vendor/items/availability/bulk — tick several items on the
// menu list and mark them sold out, or back on, in one go (a busy kitchen out of chicken switches off every chicken
// item at once). The SAME rules as the one-item switch (PUT /items/:id/availability), item by item:
//   - any member of the store may (staff switch items on and off);
//   - only the store's own, live items: one item that is not (another store's, deleted) refuses the whole batch and
//     nothing changes — the batch never reveals which;
//   - an item Swift does not allow is never switched back on: it is left off and named in the answer (the rest go on);
//     switching it off is always fine;
//   - the owner's switch wins: it clears the stock engine's auto-hide and a till file's "not for sale";
//   - every item that changed leaves its own audit row (ITEM_AVAILABILITY_SET, naming who, from, to, and that it was
//     a batch); asking again changes nothing and writes nothing (idempotent).
// Synthetic data only.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-item-availability-bulk');
const userIds: string[] = [];
const ownerIds: string[] = [];
const vendorIds: string[] = [];
const DAY = 86_400_000;
const URL = '/api/v1/vendor/items/availability/bulk';

type Actor = { userId: string; token: string };
async function makeUser(): Promise<Actor> {
  return sys(async () => {
    const user = await app.prisma.user.create({
      data: { phone: testPhone(), firstName: 'Bulk', lastName: `Menu${fixtureTag(4)}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, status: 'ACTIVE', customer: { create: {} } },
      select: { id: true },
    });
    userIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({
      data: { userId: user.id, token, refreshToken: nanoid(64), deviceId: `bulk-${fixtureTag(6)}`, deviceType: 'web', expiresAt: new Date(Date.now() + DAY) },
    });
    return { userId: user.id, token };
  });
}

async function makeStore(ownerUserId: string): Promise<{ vendorId: string; sectionId: string }> {
  return sys(async () => {
    const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
    ownerIds.push(owner.id);
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: owner.id, name: `Bulk Menu ${wordFreeTag(6)}`, slug: `bulk-menu-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
        phone: testPhone(), addressLine1: '1 Test Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE',
      },
      select: { id: true },
    });
    vendorIds.push(vendor.id);
    const section = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Mains' }, select: { id: true } });
    return { vendorId: vendor.id, sectionId: section.id };
  });
}

type ItemFacts = { isAvailable?: boolean; autoHiddenAt?: Date | null; tillOffAt?: Date | null; archivedAt?: Date | null; banned?: boolean };
async function makeItem(store: { vendorId: string; sectionId: string }, facts: ItemFacts = {}): Promise<string> {
  return sys(async () => {
    const row = await app.prisma.item.create({
      data: {
        vendorId: store.vendorId, categoryId: store.sectionId, name: `Plate ${wordFreeTag(6)}`, basePrice: 1500,
        isAvailable: facts.isAvailable ?? true, autoHiddenAt: facts.autoHiddenAt ?? null, tillOffAt: facts.tillOffAt ?? null,
        archivedAt: facts.archivedAt ?? null,
        ...(facts.banned ? { prohibitedAt: new Date(), prohibitedClass: 'MEDICINE', prohibitedReason: 'Sold as a cure' } : {}),
      },
      select: { id: true },
    });
    return row.id;
  });
}

const send = (token: string | undefined, payload: unknown) => app.inject({
  method: 'POST', url: URL, payload: payload as Record<string, unknown>,
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
});
const stateOf = (ids: string[]) => sys(() => app.prisma.item.findMany({
  where: { id: { in: ids } }, select: { id: true, isAvailable: true, autoHiddenAt: true, tillOffAt: true }, orderBy: { id: 'asc' },
}));
const auditFor = (ids: string[]) => sys(() => app.prisma.auditLog.findMany({
  where: { action: 'ITEM_AVAILABILITY_SET', entity: 'Item', entityId: { in: ids } }, orderBy: { createdAt: 'asc' },
}));

let owner: Actor;
let staff: Actor;
let stranger: Actor;
let otherOwner: Actor;
let store: { vendorId: string; sectionId: string };
let otherStore: { vendorId: string; sectionId: string };

beforeAll(async () => {
  vi.stubEnv('RUN_WORKERS', '0');
  app = await buildApp();
  await app.ready();
  owner = await makeUser();
  staff = await makeUser();
  stranger = await makeUser();
  otherOwner = await makeUser();
  store = await makeStore(owner.userId);
  otherStore = await makeStore(otherOwner.userId);
  await sys(() => app.prisma.vendorStaff.create({ data: { vendorId: store.vendorId, userId: staff.userId, role: 'STAFF', invitedBy: owner.userId } }));
}, 60_000);

afterAll(async () => {
  await sys(async () => {
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendorStaff.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await app?.close();
  vi.unstubAllEnvs();
});

describe('[MENU-BULK] several items sold out, or back on, in one go', () => {
  it('the owner marks three items sold out: each changes, each leaves its own audit row naming who and that it was a batch', async () => {
    const ids = [await makeItem(store), await makeItem(store), await makeItem(store)];
    const res = await send(owner.token, { itemIds: ids, isAvailable: false });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.isAvailable).toBe(false);
    expect([...data.changedIds].sort()).toEqual([...ids].sort());
    expect(data.unchangedIds).toEqual([]);
    expect(data.refused).toEqual([]);
    expect((await stateOf(ids)).every((i) => i.isAvailable === false)).toBe(true);
    const audit = await auditFor(ids);
    expect(audit).toHaveLength(3);
    for (const row of audit) {
      expect(row.userId).toBe(owner.userId);
      expect(row.changes).toMatchObject({ vendorId: store.vendorId, from: true, to: false, bulk: true });
    }
  });

  it('asking again changes nothing and writes nothing (idempotent)', async () => {
    const ids = [await makeItem(store), await makeItem(store)];
    expect((await send(owner.token, { itemIds: ids, isAvailable: false })).statusCode).toBe(200);
    const again = await send(owner.token, { itemIds: ids, isAvailable: false });
    expect(again.statusCode).toBe(200);
    expect(again.json().data.changedIds).toEqual([]);
    expect([...again.json().data.unchangedIds].sort()).toEqual([...ids].sort());
    expect(await auditFor(ids)).toHaveLength(2);
  });

  it('back on: the owner\'s switch wins over the stock engine\'s auto-hide and a till file\'s "not for sale"', async () => {
    const hidden = await makeItem(store, { isAvailable: false, autoHiddenAt: new Date() });
    const tillOff = await makeItem(store, { isAvailable: false, tillOffAt: new Date() });
    const res = await send(owner.token, { itemIds: [hidden, tillOff], isAvailable: true });
    expect(res.statusCode, res.body).toBe(200);
    for (const row of await stateOf([hidden, tillOff])) {
      expect(row).toMatchObject({ isAvailable: true, autoHiddenAt: null, tillOffAt: null });
    }
  });

  it('an item already off by the engine\'s auto-hide, marked sold out: it becomes the owner\'s own "off" (marker cleared, audited)', async () => {
    const hidden = await makeItem(store, { isAvailable: false, autoHiddenAt: new Date() });
    const res = await send(owner.token, { itemIds: [hidden], isAvailable: false });
    expect(res.json().data.changedIds).toEqual([hidden]);
    expect((await stateOf([hidden]))[0]).toMatchObject({ isAvailable: false, autoHiddenAt: null });
    const [row] = await auditFor([hidden]);
    expect(row!.changes).toMatchObject({ from: false, to: false, wasAutoHidden: true, bulk: true });
  });

  it('an item Swift does not allow stays off and is named; the rest go back on', async () => {
    const fine = await makeItem(store, { isAvailable: false });
    const banned = await makeItem(store, { isAvailable: false, banned: true });
    const res = await send(owner.token, { itemIds: [fine, banned], isAvailable: true });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.changedIds).toEqual([fine]);
    expect(data.refused).toHaveLength(1);
    expect(data.refused[0]).toMatchObject({ id: banned });
    expect(typeof data.refused[0].name).toBe('string');
    expect(typeof data.refused[0].message).toBe('string');
    expect(Object.fromEntries((await stateOf([fine, banned])).map((r) => [r.id, r.isAvailable]))).toEqual({ [fine]: true, [banned]: false });
    expect(await auditFor([banned])).toHaveLength(0);
  });

  it('switching an item Swift does not allow OFF is always fine', async () => {
    const banned = await makeItem(store, { isAvailable: true, banned: true });
    const res = await send(owner.token, { itemIds: [banned], isAvailable: false });
    expect(res.json().data.changedIds).toEqual([banned]);
  });

  it('another store\'s item in the batch: the whole batch is refused as not found, and nothing changes', async () => {
    const mine = await makeItem(store);
    const theirs = await makeItem(otherStore);
    const res = await send(owner.token, { itemIds: [mine, theirs], isAvailable: false });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(theirs);
    expect((await stateOf([mine, theirs])).every((i) => i.isAvailable)).toBe(true);
    expect(await auditFor([mine, theirs])).toHaveLength(0);
  });

  it('a deleted item in the batch: refused as not found, nothing changes', async () => {
    const live = await makeItem(store);
    // A deleted item is always off (the items_archived_unavailable check).
    const gone = await makeItem(store, { archivedAt: new Date(), isAvailable: false });
    const res = await send(owner.token, { itemIds: [live, gone], isAvailable: false });
    expect(res.statusCode).toBe(404);
    expect((await stateOf([live]))[0]!.isAvailable).toBe(true);
  });

  it('floor staff may (as the one-item switch); the audit names them', async () => {
    const id = await makeItem(store);
    const res = await send(staff.token, { itemIds: [id], isAvailable: false });
    expect(res.statusCode, res.body).toBe(200);
    expect((await auditFor([id]))[0]!.userId).toBe(staff.userId);
  });

  it('someone with no seat at the store cannot touch its items; no token, no entry', async () => {
    const id = await makeItem(store);
    const res = await send(stranger.token, { itemIds: [id], isAvailable: false });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect((await send(undefined, { itemIds: [id], isAvailable: false })).statusCode).toBe(401);
    expect((await stateOf([id]))[0]!.isAvailable).toBe(true);
  });

  it('the batch\'s shape: 1 to 500 items, a yes/no; the same item twice counts once', async () => {
    expect((await send(owner.token, { itemIds: [], isAvailable: false })).statusCode).toBe(400);
    expect((await send(owner.token, { itemIds: Array.from({ length: 501 }, (_, i) => `item-${i}`), isAvailable: false })).statusCode).toBe(400);
    const id = await makeItem(store);
    expect((await send(owner.token, { itemIds: [id] })).statusCode).toBe(400);
    expect((await send(owner.token, { itemIds: [id], isAvailable: 'no' })).statusCode).toBe(400);
    const twice = await send(owner.token, { itemIds: [id, id], isAvailable: false });
    expect(twice.statusCode, twice.body).toBe(200);
    expect(twice.json().data.changedIds).toEqual([id]);
    expect(await auditFor([id])).toHaveLength(1);
  });

  it('a whole menu at once (a store with 328 items)', async () => {
    const ids = await sys(async () => {
      const rows = await app.prisma.item.createManyAndReturn({
        data: Array.from({ length: 328 }, (_, i) => ({ vendorId: store.vendorId, categoryId: store.sectionId, name: `Big ${i} ${wordFreeTag(4)}`, basePrice: 500 })),
        select: { id: true },
      });
      return rows.map((r) => r.id);
    });
    const res = await send(owner.token, { itemIds: ids, isAvailable: false });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.changedIds).toHaveLength(328);
    expect(await auditFor(ids)).toHaveLength(328);
  });
});
