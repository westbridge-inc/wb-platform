import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// [AUDIT C2-5 · 13 Nov 2026] billing_events is the weekly fee's money history.
// The database refuses a DELETE of a row whose subscription still exists, and a
// TRUNCATE. The subscription's own deletion still cascades. A disposable test
// database turns the purge on for its sessions (setup/billing-cutover.ts); this
// file turns it off inside each transaction to see the guard as production has it.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasourceUrl: process.env['DATABASE_URL'] });
const STAMP = String(Date.now()).slice(-7);
const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let subscriptionId = '';

async function vendorSub(n: number) {
  const phone = `+5920${n}${STAMP}`;
  const user = await prisma.user.create({ data: { phone, firstName: 'Ledger', lastName: `Guard${n}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true } });
  userIds.push(user.id);
  const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Ledger Guard Kitchen ${n}`, slug: `ledger-guard-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone, addressLine1: '1 Ledger St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    },
  });
  vendorIds.push(vendor.id);
  const now = Date.now();
  const sub = await prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 5000, billingMethod: 'CASH',
      currentPeriodStart: new Date(now - 86_400_000), currentPeriodEnd: new Date(now + 6 * 86_400_000), nextBillingDate: new Date(now + 6 * 86_400_000),
    },
  });
  subIds.push(sub.id);
  return sub;
}

beforeAll(async () => {
  subscriptionId = (await vendorSub(1)).id;
});

afterAll(async () => {
  await prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

const event = () => prisma.billingEvent.create({
  data: { subscriptionId, type: 'PREPAID_TOPUP', amount: 5000, currencyCode: 'GYD', idempotencyKey: `ledger-guard:${nanoid(10)}`, paymentRef: `GUARD-${nanoid(6)}` },
});

describe('[AUDIT C2-5] a billing event is never deleted', () => {
  it('a DELETE of an event whose subscription stands is refused, and the row stays', async () => {
    const row = await event();
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL swift.billing_events_purge = 'off'`;
      await tx.$executeRaw`DELETE FROM "billing_events" WHERE "id" = ${row.id}`;
    })).rejects.toThrow(/append-only/);
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL swift.billing_events_purge = 'off'`;
      await tx.billingEvent.deleteMany({ where: { subscriptionId } });
    })).rejects.toThrow(/append-only/);
    expect(await prisma.billingEvent.count({ where: { id: row.id } })).toBe(1);
  });

  it('a TRUNCATE is refused', async () => {
    // Always rolled back: on a database without the guard the TRUNCATE lands and the sentinel undoes it, so this test
    // can never empty a table, red or green.
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL swift.billing_events_purge = 'off'`;
      await tx.$executeRawUnsafe('TRUNCATE "billing_events" CASCADE');
      throw new Error('ROLLBACK-SENTINEL: the TRUNCATE was not refused');
    })).rejects.toThrow(/append-only/);
  });

  it('the subscription\'s own deletion still takes its events with it', async () => {
    const other = await vendorSub(2);
    await prisma.billingEvent.create({ data: { subscriptionId: other.id, type: 'PREPAID_TOPUP', amount: 1, currencyCode: 'GYD', idempotencyKey: `ledger-guard-cascade:${nanoid(10)}` } });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL swift.billing_events_purge = 'off'`;
      await tx.subscription.delete({ where: { id: other.id } });
    });
    expect(await prisma.billingEvent.count({ where: { subscriptionId: other.id } })).toBe(0);
  });
});
