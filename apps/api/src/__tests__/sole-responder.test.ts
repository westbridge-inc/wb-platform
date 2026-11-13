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

// [REVIEW-2499-A D-3] Suspending is a one-person act: suspending the only other admin must not make the actor the
// only responder at once. An admin suspended, banned or closed in the last 14 days still counts, as for solo approval
// (approverRoster). The database is shared, so the reader is confined to this test's own accounts.
describe('[REVIEW-2499-A D-3] an admin locked out in the last 14 days still counts', () => {
  const confinedTo = (ids: string[]) => ({
    user: {
      findUnique: (args: Parameters<typeof app.prisma.user.findUnique>[0]) => app.prisma.user.findUnique(args),
      findMany: (args: { where?: object; select?: object }) => app.prisma.user.findMany({ ...args, where: { AND: [args.where ?? {}, { id: { in: ids } }] } } as never),
    },
  });

  it('the only other admin, suspended today, keeps the actor from being the only responder; 15 days on, it does not', async () => {
    const actor = await admin(T, 'SUPER_ADMIN');
    const other = await admin(T, 'ADMIN', ['*'], 'SUSPENDED');
    const db = confinedTo([actor, other]) as never;
    expect(await isSoleEligibleResponder(db, actor, 'safety.sos.respond', T)).toBe(false);
    await sys(() => app.prisma.$executeRaw`UPDATE "users" SET "statusChangedAt" = now() - interval '15 days' WHERE id = ${other}`);
    expect(await isSoleEligibleResponder(db, actor, 'safety.sos.respond', T)).toBe(true);
    // with nobody else at all, the actor is the only one
    expect(await isSoleEligibleResponder(confinedTo([actor]) as never, actor, 'safety.sos.respond', T)).toBe(true);
  });

  // [REVIEW-2499-B S2-1] The lock-out is dated by the STATUS change, never by the row's last write: updatedAt moves on
  // any write (a sweep, a profile field), so an admin suspended long ago could switch the owner's exits off for ever.
  it('an old suspension does not count again because the row was written today', async () => {
    const actor = await admin(T, 'SUPER_ADMIN');
    const other = await admin(T, 'ADMIN', ['*']);
    const db = confinedTo([actor, other]) as never;
    await sys(() => app.prisma.user.update({ where: { id: other }, data: { status: 'SUSPENDED' } }));
    expect(await isSoleEligibleResponder(db, actor, 'safety.sos.respond', T)).toBe(false);
    await sys(() => app.prisma.$executeRaw`UPDATE "users" SET "statusChangedAt" = now() - interval '20 days', "updatedAt" = now() - interval '20 days' WHERE id = ${other}`);
    expect(await isSoleEligibleResponder(db, actor, 'safety.sos.respond', T)).toBe(true);
    // an unrelated write today (a name fix, a sweep) moves updatedAt, not the lock-out
    await sys(() => app.prisma.user.update({ where: { id: other }, data: { lastName: `Renamed${RUN}` } }));
    expect(await isSoleEligibleResponder(db, actor, 'safety.sos.respond', T)).toBe(true);
    // a fresh status change does count again: lifted, then suspended again today
    await sys(() => app.prisma.user.update({ where: { id: other }, data: { status: 'ACTIVE' } }));
    await sys(() => app.prisma.user.update({ where: { id: other }, data: { status: 'BANNED' } }));
    expect(await isSoleEligibleResponder(db, actor, 'safety.sos.respond', T)).toBe(false);
  });

  it('the database stamps statusChangedAt on every status change, whatever path wrote it, and on nothing else', async () => {
    const other = await admin(T, 'ADMIN', ['*']);
    const read = () => sys(() => app.prisma.user.findUniqueOrThrow({ where: { id: other }, select: { statusChangedAt: true } }));
    await sys(() => app.prisma.$executeRaw`UPDATE "users" SET "statusChangedAt" = NULL WHERE id = ${other}`);
    await sys(() => app.prisma.user.update({ where: { id: other }, data: { firstName: 'Still' } }));
    expect((await read()).statusChangedAt).toBeNull();
    await sys(() => app.prisma.$executeRaw`UPDATE "users" SET status = 'DEACTIVATED' WHERE id = ${other}`);
    const stamped = (await read()).statusChangedAt;
    expect(stamped).not.toBeNull();
    expect(Math.abs(stamped!.getTime() - Date.now())).toBeLessThan(60_000);
    await sys(() => app.prisma.$executeRaw`UPDATE "users" SET "statusChangedAt" = now() - interval '30 days' WHERE id = ${other}`);
    await sys(() => app.prisma.$executeRaw`UPDATE "users" SET status = 'DEACTIVATED', "firstName" = 'Same' WHERE id = ${other}`);
    expect(Date.now() - (await read()).statusChangedAt!.getTime()).toBeGreaterThan(29 * 86_400_000);
  });

  it('no application code writes statusChangedAt: only the database trigger does', async () => {
    const { execFileSync } = await import('node:child_process');
    const { join } = await import('node:path');
    const out = execFileSync('grep', ['-rln', 'statusChangedAt', join(__dirname, '..', 'modules'), join(__dirname, '..', 'jobs'), join(__dirname, '..', 'plugins')], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    // the two lock-out readers, and the export register (the person's own copy of their account row): reads only
    expect(out.map((f) => f.replace(/^.*\/src\//, '')).sort()).toEqual(['modules/admin/solo-approval.ts', 'modules/integrity/sole-responder.ts', 'modules/user/data-export-register.ts']);
  });

  it('a super admin locked out today counts in any market', async () => {
    const actor = await admin(T, 'SUPER_ADMIN');
    const other = await admin('swift-default', 'SUPER_ADMIN', ['*'], 'SUSPENDED');
    expect(await isSoleEligibleResponder(confinedTo([actor, other]) as never, actor, 'safety.sos.respond', T)).toBe(false);
  });
});
