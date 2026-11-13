import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';
import { stepUpKey } from '../modules/auth/step-up';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [OWNER RULING 13 Nov 2026 · Review A S4-1 on #2502] The owner's late MMG credit and its second review, through the
// real admin guard: the route's class, the reason, the strict body, the owner-only rule before anything is spent, the
// fresh sign-in code it spends, and the tenant it reads. (The credit itself, on MMG's records, is proven at the
// service: mmg-checkout-service.test.ts.)
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const REASON = 'Paid on MMG after the checkout closed; seen on the statement';
const userIds: string[] = [];
interface Actor { token: string; userId: string; sessionId: string }

async function makeAdmin(role: 'SUPER_ADMIN' | 'ADMIN'): Promise<Actor> {
  return runWithoutTenant(async () => {
    const user = await app.prisma.user.create({ data: {
      phone: testPhone(), firstName: 'Late', lastName: `Route${RUN}${userIds.length}`, roles: [role, 'CUSTOMER'], activeRole: role,
      status: 'ACTIVE', isPhoneVerified: true, email: `late-${RUN}-${userIds.length}@example.test`, admin: { create: { permissions: ['*'] } },
    } });
    userIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role, jti: nanoid(8) });
    const session = await app.prisma.session.create({ data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'late-credit', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
    } });
    return { token, userId: user.id, sessionId: session.id };
  }, 'test-fixture:late-credit');
}

const call = (actor: Actor, method: string, url: string, payload?: unknown, reason: string | null = REASON) => app.inject({
  method: method as never, url,
  headers: { authorization: `Bearer ${actor.token}`, 'content-type': 'application/json', ...(reason ? { 'x-swift-reason': reason } : {}) },
  ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
});
const CREDIT = (id: string) => `/api/v1/admin/billing/mmg-checkouts/${id}/credit-late`;
const REVIEW = (id: string) => `/api/v1/admin/billing/mmg-checkouts/${id}/late-credit-review`;

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
}, 120_000);

afterAll(async () => {
  try {
    await runWithoutTenant(async () => {
      await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.user.updateMany({ where: { id: { in: userIds } }, data: { roles: ['CUSTOMER'], activeRole: 'CUSTOMER' } });
    }, 'test-fixture:late-credit');
  } finally {
    await app.close();
  }
});

describe('[owner ruling 13 Nov] the late MMG credit routes, through the real admin guard', () => {
  it('are registered with their classes: the credit and the review C3, the pending list C1', () => {
    expect(ADMIN_ROUTE_AUTHORITY['POST /billing/mmg-checkouts/:id/credit-late']).toMatchObject({ cls: 'C3', capability: 'billing.mmg.credit.late' });
    expect(ADMIN_ROUTE_AUTHORITY['POST /billing/mmg-checkouts/:id/late-credit-review']).toMatchObject({ cls: 'C3', capability: 'billing.mmg.late.review' });
    expect(ADMIN_ROUTE_AUTHORITY['GET /billing/mmg-checkouts/late-credit-reviews']).toMatchObject({ cls: 'C1' });
  });

  it('the credit: a reason, a strict body, the owner alone (refused before any code is spent), then a fresh sign-in code it spends', async () => {
    const owner = await makeAdmin('SUPER_ADMIN');
    const admin = await makeAdmin('ADMIN');
    const id = `mco_none_${RUN}`;
    expect((await call(owner, 'POST', CREDIT(id), { mmgReference: 'MMG123456' }, null)).statusCode).toBe(400);
    expect((await call(owner, 'POST', CREDIT(id), { mmgReference: 'MMG123456', amount: 2100 })).statusCode).toBe(400);
    await app.redis.set(stepUpKey(admin.sessionId), '1', 'EX', 600);
    const notOwner = await call(admin, 'POST', CREDIT(id), { mmgReference: 'MMG123456' });
    expect(notOwner.statusCode, notOwner.body).toBe(403);
    expect(notOwner.json().error.code).toBe('OWNER_ONLY');
    expect(await app.redis.exists(stepUpKey(admin.sessionId)), 'nothing spent for a refused caller').toBe(1);
    const noCode = await call(owner, 'POST', CREDIT(id), { mmgReference: 'MMG123456' });
    expect(noCode.statusCode, noCode.body).toBe(403);
    expect(noCode.json().error.code).toBe('STEP_UP_REQUIRED');
    await app.redis.set(stepUpKey(owner.sessionId), '1', 'EX', 600);
    const missing = await call(owner, 'POST', CREDIT(id), { mmgReference: 'MMG123456' });
    expect(missing.statusCode, missing.body).toBe(404);
    expect(await app.redis.exists(stepUpKey(owner.sessionId)), 'one code, one decision').toBe(0);
  });

  it('the review: a reason, a strict body, an outcome; nothing to review is a 409 or a 404, never a success; the pending list answers', async () => {
    const admin = await makeAdmin('ADMIN');
    const id = `mco_none_${RUN}`;
    expect((await call(admin, 'POST', REVIEW(id), { outcome: 'AGREED', note: 'matches the statement' }, null)).statusCode).toBe(400);
    expect((await call(admin, 'POST', REVIEW(id), { outcome: 'MAYBE', note: 'matches the statement' })).statusCode).toBe(400);
    expect((await call(admin, 'POST', REVIEW(id), { outcome: 'AGREED', note: 'matches the statement', extra: 1 })).statusCode).toBe(400);
    expect((await call(admin, 'POST', REVIEW(id), { outcome: 'AGREED', note: 'matches the statement' })).statusCode).toBe(404);
    const list = await call(admin, 'GET', '/api/v1/admin/billing/mmg-checkouts/late-credit-reviews', undefined, null);
    expect(list.statusCode, list.body).toBe(200);
    expect(Array.isArray(list.json().data)).toBe(true);
  });
});
