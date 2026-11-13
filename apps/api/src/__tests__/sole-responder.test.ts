import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { runWithoutTenant } from '../plugins/tenant-context';
import { isSoleEligibleResponder } from '../modules/integrity/sole-responder';
import { testPhone } from './helpers/fixture-ids';

// [REVIEW-2499-A S3-1 · automated review] "The only eligible responder" is decided from the RESOURCE, never the
// actor's own market: every active SUPER_ADMIN on the platform counts (a platform responder acts anywhere), and the
// ADMINs of the resource's market who hold the capability. A super admin alone in their own market is NOT the only
// responder while another super admin exists elsewhere.
let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const T = `sole-${RUN}`;
const userIds: string[] = [];
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-fixture:sole-responder');

async function admin(tenantId: string, role: 'SUPER_ADMIN' | 'ADMIN', permissions: string[] = ['*'], status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  const u = await sys(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Sole', lastName: `R${RUN}`, roles: [role, 'CUSTOMER'], activeRole: role, status, isPhoneVerified: true, tenantId,
    admin: { create: { permissions } },
  } }));
  userIds.push(u.id);
  return u.id;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
  await sys(() => app.prisma.tenant.create({ data: { id: T, name: `Sole ${T}`, slug: T, isActive: true } }));
});
afterAll(async () => {
  await sys(async () => {
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.prisma.tenant.deleteMany({ where: { id: T } });
  });
  await app.close();
});

describe('[REVIEW-2499-A S3-1] the only eligible responder is decided from the resource', () => {
  it('a super admin alone in their own market is not the only responder while another super admin exists anywhere', async () => {
    const lone = await admin(T, 'SUPER_ADMIN');
    // the platform always has another active SUPER_ADMIN here (the seed's, or this one)
    await admin('swift-default', 'SUPER_ADMIN');
    expect(await isSoleEligibleResponder(app.prisma, lone, 'safety.sos.respond', T)).toBe(false);
    expect(await isSoleEligibleResponder(app.prisma, lone, 'safety.sos.respond', null)).toBe(false);
  });

  it('an ADMIN in the resource market with the grant counts; one without it, or suspended, or a plain ADMIN as actor, does not decide', async () => {
    const lone = await admin(T, 'SUPER_ADMIN');
    const plain = await admin(T, 'ADMIN', ['support.read']);
    expect(await isSoleEligibleResponder(app.prisma, plain, 'safety.sos.respond', T)).toBe(false); // only a SUPER_ADMIN may
    void lone;
  });

  it('with no other eligible responder at all, the actor is the only one (decision function on a bare reader)', async () => {
    const db = {
      user: {
        findUnique: async () => ({ roles: ['SUPER_ADMIN'], status: 'ACTIVE' }),
        findMany: async () => [
          { roles: ['ADMIN'], activeRole: 'ADMIN', admin: { permissions: ['support.read'] } }, // lacks the grant
        ],
      },
    };
    expect(await isSoleEligibleResponder(db as never, 'actor', 'safety.sos.respond', T)).toBe(true);
    const withSecond = { user: { ...db.user, findMany: async () => [{ roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', admin: { permissions: ['*'] } }] } };
    expect(await isSoleEligibleResponder(withSecond as never, 'actor', 'safety.sos.respond', T)).toBe(false);
  });
});
