/**
 * [FABLE-02 F3 · 13 Nov 2026] A reviewer could open every stored document in bulk: the queue lists any status and
 * GET /verification/:id/document-url minted a link for each, limited only by the global 200 a minute. Minting a view
 * link is now capped PER REVIEWER per hour (DOCUMENT_VIEW_LINKS_PER_HOUR), on the same limiter production composes
 * (utils/rate-limit-options), keyed by the verified caller: one reviewer's bulk run never blocks another reviewer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { rateLimitOptions } from '../utils/rate-limit-options';
import { DOCUMENT_VIEW_LINKS_PER_HOUR } from '../modules/verification/document-view-limit';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
let app: FastifyInstance;
const users: string[] = [];
const tokens = new Map<string, string>();

async function reviewer(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59275${NUM}${n}`, firstName: 'View', lastName: `Rate${n}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*', 'documents.review'] } },
  } }));
  users.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `vr-${RUN}-${n}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) } });
  tokens.set(u.id, token);
  return u.id;
}
const view = (adminId: string) => app.inject({ method: 'GET', url: `/api/v1/admin/verification/missing-${nanoid(10)}/document-url`, headers: { authorization: `Bearer ${tokens.get(adminId)}` } });
/** [REVIEW-2498-A S3-1] The admin console's way: the HttpOnly session cookie, no Authorization header, one office IP. */
const CONSOLE = { 'x-swift-client': 'admin-web', origin: 'http://localhost:3001' } as const;
const viewFromConsole = (adminId: string) => app.inject({
  method: 'GET', url: `/api/v1/admin/verification/missing-${nanoid(10)}/document-url`, remoteAddress: '203.0.113.50',
  headers: { ...CONSOLE, cookie: `swift_at=${tokens.get(adminId)}` },
});

const priorCors = process.env['CORS_ORIGIN'];
beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['CORS_ORIGIN'] = 'http://localhost:3001';
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  // The production composition (app.ts): keyed by the verified caller, a high global ceiling so only the route's own cap bites.
  await app.register(rateLimit, rateLimitOptions({ verify: (token) => app.jwt.verify(token), max: 100_000 }));
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    if (users.length) {
      await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
      await app.prisma.admin.deleteMany({ where: { userId: { in: users } } });
      await app.prisma.user.deleteMany({ where: { id: { in: users } } });
    }
  }, 'document-view-rate-test');
  if (priorCors === undefined) delete process.env['CORS_ORIGIN']; else process.env['CORS_ORIGIN'] = priorCors;
  await app.close();
});

describe('[FABLE-02 F3] view links are capped per reviewer per hour', () => {
  it('a reviewer gets the cap\'s worth of answers, then 429; another reviewer is untouched', async () => {
    expect(DOCUMENT_VIEW_LINKS_PER_HOUR).toBeGreaterThanOrEqual(60); // a real review session is never blocked
    expect(DOCUMENT_VIEW_LINKS_PER_HOUR).toBeLessThanOrEqual(200); // ...and it is far below the global 200 a MINUTE
    const bulk = await reviewer(1);
    const other = await reviewer(2);
    for (let i = 0; i < DOCUMENT_VIEW_LINKS_PER_HOUR; i++) {
      const res = await view(bulk);
      expect(res.statusCode, `request ${i + 1}`).toBe(404); // the handler ran: an unknown document
    }
    const over = await view(bulk);
    expect(over.statusCode).toBe(429);
    expect((await view(other)).statusCode).toBe(404);
  });

  it('[REVIEW-2498-A S3-1] console reviewers (cookie sessions) behind ONE office IP each get their own cap', async () => {
    const first = await reviewer(3);
    const colleague = await reviewer(4);
    const signedIn = await viewFromConsole(first);
    expect(signedIn.statusCode, signedIn.body).toBe(404); // authenticated by the cookie: the handler ran
    for (let i = 1; i < DOCUMENT_VIEW_LINKS_PER_HOUR; i++) expect((await viewFromConsole(first)).statusCode, `request ${i + 1}`).toBe(404);
    expect((await viewFromConsole(first)).statusCode).toBe(429);
    // Same IP, another reviewer: untouched.
    expect((await viewFromConsole(colleague)).statusCode).toBe(404);
    // And the cap follows the reviewer, not the network: the same reviewer from another IP is still capped.
    const elsewhere = await app.inject({ method: 'GET', url: `/api/v1/admin/verification/missing-${nanoid(10)}/document-url`, remoteAddress: '198.51.100.7', headers: { ...CONSOLE, cookie: `swift_at=${tokens.get(first)}` } });
    expect(elsewhere.statusCode).toBe(429);
  });
});
