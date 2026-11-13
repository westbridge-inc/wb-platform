import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { SAFETY_OPS_CAPABILITY } from '../modules/safety/safety-authority';
import { SUPPORT_OPERATOR_CAPABILITIES } from '../modules/admin/admin-authority';
import { registerErrorHandler } from '../middleware/error-handler';
import { beginRequestTenantContext, runWithoutTenant } from '../plugins/tenant-context';
import { EvidenceService } from '../modules/safety/evidence.service';
import { grantSuiteCapability } from '../lib/test-target-lock';

grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// [AUDIT-20261113 F5 · F7 · FABLE-03 S3-3] The safety console honours the admin grant, and nobody works a
// safety matter that names them.
//
//  - A narrowed admin (the SUPPORT preset: counts and tickets) is refused every ops route: SOS reads, case
//    intake (an S0 suspends its subject), lifting a suspension, evidence. An admin on the role default is not.
//  - An admin who is the subject of a case cannot decide it, lift its interim suspension or open its
//    evidence; a case naming a staff account goes to a SUPER_ADMIN who is not part of it.
//  - The capability table is one-to-one with the ops routes, and no ops check bypasses it.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const S = '/api/v1/safety';
const userIds: string[] = []; const alertIds: string[] = []; const bundleIds: string[] = [];
const phoneBase = 592_772_000_000 + Math.floor(Math.random() * 100_000_000);
let seq = 0;
const liveRoutes: string[] = [];
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-fixture:safety-ops-capability');

type Actor = { userId: string; token: string };
async function makeUser(roles: UserRole[], permissions?: string[]): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Ops', lastName: `C${RUN}${seq}`, roles, activeRole: roles[0]!, status: 'ACTIVE', isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...((roles.includes('ADMIN') || roles.includes('SUPER_ADMIN')) && { admin: { create: { permissions: permissions ?? ['*'] } } }),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'ops-cap', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + 86_400_000) } }));
  return { userId: user.id, token };
}

async function makeCase(subjectUserId: string) {
  return sys(() => app.prisma.incidentCase.create({ data: {
    tenantId: 'swift-default', status: 'OPEN', caseNumber: `INC-${nanoid(8).toUpperCase()}`, severity: 'S2', category: 'SAFETY_THREAT', intake: 'OPS_CREATED',
    subjectUserId, summary: 'capability fixture', slaAckBy: new Date(Date.now() + 3_600_000), slaDecideBy: new Date(Date.now() + 86_400_000),
  } }));
}

async function makeBundleFor(actorUserId: string) {
  const alert = await sys(() => app.prisma.sosAlert.create({ data: { actorUserId, actorRole: 'CUSTOMER', status: 'ACTIVE', triggerSource: 'BUTTON', triggeredAt: new Date(), tenantId: 'swift-default' } }));
  alertIds.push(alert.id);
  const bundle = await sys(() => new EvidenceService(app.prisma, app.io).openForSos(alert.id));
  bundleIds.push(bundle!.id);
  return { alert, bundle: bundle! };
}

const fire = (method: 'GET' | 'POST', url: string, actor: Actor, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${actor.token}`, ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { payload } : {}) });

let admin: Actor, support: Actor, superAdmin: Actor, customer: Actor, staffDriver: Actor;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  app.addHook('onRoute', (r) => {
    for (const m of ([] as string[]).concat(r.method as string | string[])) {
      if (r.url.startsWith(`${S}/`) && !['HEAD', 'OPTIONS'].includes(m)) liveRoutes.push(`${m} ${r.url.slice(S.length)}`);
    }
  });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: S });
  await app.ready();
  admin = await makeUser(['ADMIN']);
  support = await makeUser(['ADMIN'], [...SUPPORT_OPERATOR_CAPABILITIES]);
  superAdmin = await makeUser(['SUPER_ADMIN']);
  customer = await makeUser(['CUSTOMER']);
  // an admin who also has a customer account in the app: a staff account that can be the subject of a case
  staffDriver = await makeUser(['ADMIN', 'CUSTOMER']);
}, 120_000);

afterAll(async () => {
  await sys(async () => {
    await app.prisma.$executeRawUnsafe(`ALTER TABLE "EvidenceItem" DISABLE TRIGGER evidence_item_no_mutation`).catch(() => {});
    await app.prisma.$executeRawUnsafe(`ALTER TABLE "EvidenceBundle" DISABLE TRIGGER evidence_bundle_no_delete_sealed`).catch(() => {});
    await app.prisma.evidenceBundle.deleteMany({ where: { id: { in: bundleIds } } }).catch(() => {});
    await app.prisma.$executeRawUnsafe(`ALTER TABLE "EvidenceItem" ENABLE TRIGGER evidence_item_no_mutation`).catch(() => {});
    await app.prisma.$executeRawUnsafe(`ALTER TABLE "EvidenceBundle" ENABLE TRIGGER evidence_bundle_no_delete_sealed`).catch(() => {});
    await app.prisma.safetyAccessLog.deleteMany({ where: { bundleId: { in: bundleIds } } }).catch(() => {});
    await app.prisma.incidentCase.deleteMany({ where: { subjectUserId: { in: userIds } } }).catch(() => {});
    const ops = await app.prisma.opsAlert.findMany({ where: { sosAlertId: { in: alertIds } }, select: { id: true } });
    await app.prisma.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: ops.map((o) => o.id) } } }).catch(() => {});
    await app.prisma.opsAlert.deleteMany({ where: { id: { in: ops.map((o) => o.id) } } }).catch(() => {});
    await app.prisma.sosAlert.deleteMany({ where: { actorUserId: { in: userIds } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  });
  await app.close();
});

describe('[AUDIT-20261113 F5] the capability table covers every ops route', () => {
  it('every classified route is live, and no ops check bypasses the table', () => {
    const live = new Set(liveRoutes);
    for (const key of Object.keys(SAFETY_OPS_CAPABILITY)) expect(live.has(key), key).toBe(true);
    const source = readFileSync(join(__dirname, '../modules/safety/safety.routes.ts'), 'utf8');
    // every ops-only check goes through requireOpsCapability / decideOpsCapability, never the bare role
    expect(source).not.toMatch(/isOps\(opsRoleOf\(request\)\)/);
    // the one remaining role test is the OPS_MANUAL source claim on a person's own SOS (it grants nothing)
    expect(source.match(/isOps\(/g) ?? []).toHaveLength(1);
  });
});

describe('[AUDIT-20261113 F5 · FABLE-03 S3-3] a narrowed admin is refused the safety console', () => {
  it('the SUPPORT preset cannot list SOS, log a case (which would suspend), lift a suspension or open evidence', async () => {
    const list = await fire('GET', `${S}/sos`, support);
    expect(list.statusCode).toBe(403);
    expect(list.json().error.message).toContain('safety.sos.read');

    const before = await sys(() => app.prisma.incidentCase.count({ where: { subjectUserId: customer.userId } }));
    const intake = await fire('POST', `${S}/incidents/ops`, support, { subjectUserId: customer.userId, category: 'SAFETY_THREAT', severity: 'S0', summary: 'narrowed admin intake' });
    expect(intake.statusCode).toBe(403);
    expect(await sys(() => app.prisma.incidentCase.count({ where: { subjectUserId: customer.userId } }))).toBe(before);

    const kase = await makeCase(customer.userId);
    expect((await fire('POST', `${S}/incidents/${kase.id}/lift-interim`, support)).statusCode).toBe(403);
    expect((await fire('GET', `${S}/incidents`, support)).statusCode).toBe(403);

    const { alert, bundle } = await makeBundleFor(customer.userId);
    expect((await fire('POST', `${S}/evidence/${bundle.id}/view`, support, { reason: 'checking the narrowed grant' })).statusCode).toBe(403);
    // reading one alert falls back to the owner path: someone else's alert is not theirs
    expect((await fire('GET', `${S}/sos/${alert.id}`, support)).statusCode).toBe(403);
  });

  it('an admin on the role default keeps the console', async () => {
    expect((await fire('GET', `${S}/sos`, admin)).statusCode).toBe(200);
    expect((await fire('GET', `${S}/incidents`, admin)).statusCode).toBe(200);
  });
});

describe('[AUDIT-20261113 F7] nobody works a safety matter that names them', () => {
  it('an admin who is the subject cannot decide, lift or ack their own case, or open its evidence', async () => {
    const kase = await makeCase(staffDriver.userId);
    const decide = await fire('POST', `${S}/incidents/${kase.id}/decide`, staffDriver, { decisionCode: 'DISMISSED' });
    expect(decide.statusCode).toBe(403);
    expect((await fire('POST', `${S}/incidents/${kase.id}/lift-interim`, staffDriver)).statusCode).toBe(403);
    expect((await fire('POST', `${S}/incidents/${kase.id}/ack`, staffDriver)).statusCode).toBe(403);
    const after = await sys(() => app.prisma.incidentCase.findUniqueOrThrow({ where: { id: kase.id } }));
    expect(after.status).toBe('OPEN');
    expect(after.decidedAt).toBeNull();

    const { bundle } = await makeBundleFor(staffDriver.userId);
    expect((await fire('POST', `${S}/evidence/${bundle.id}/view`, staffDriver, { reason: 'reading my own case evidence' })).statusCode).toBe(403);
    expect((await fire('POST', `${S}/evidence/${bundle.id}/export`, staffDriver, { reason: 'exporting my own case evidence' })).statusCode).toBe(403);
  });

  it('a case naming a staff account goes to a super admin who is not part of it, not a fellow admin', async () => {
    const kase = await makeCase(staffDriver.userId);
    expect((await fire('POST', `${S}/incidents/${kase.id}/ack`, admin)).statusCode).toBe(403);
    expect((await fire('POST', `${S}/incidents/${kase.id}/ack`, superAdmin)).statusCode).toBe(200);
  });

  it('an admin cannot open an ops case against themselves (an S0 intake suspends its subject)', async () => {
    const res = await fire('POST', `${S}/incidents/ops`, staffDriver, { subjectUserId: staffDriver.userId, category: 'SAFETY_THREAT', severity: 'S3', summary: 'self intake attempt' });
    expect(res.statusCode).toBe(403);
  });

  it('an admin still works an ordinary customer case', async () => {
    const kase = await makeCase(customer.userId);
    expect((await fire('POST', `${S}/incidents/${kase.id}/ack`, admin)).statusCode).toBe(200);
  });
});

// [AUDIT-20261113 F7 · review parity] The same rule on the sibling doors: the SOS an admin is part of, the case
// queue and the evidence lookup.
describe('[AUDIT-20261113 F7] parity: SOS, the case queue and the evidence lookup', () => {
  async function alertAgainst(counterpartyUserId: string) {
    const alert = await sys(() => app.prisma.sosAlert.create({ data: { actorUserId: customer.userId, counterpartyUserId, actorRole: 'CUSTOMER', status: 'ACTIVE', triggerSource: 'BUTTON', triggeredAt: new Date(), tenantId: 'swift-default' } }));
    alertIds.push(alert.id);
    return alert;
  }

  it('the admin an SOS was raised against cannot resolve or acknowledge it, read it in full, or see it on the board', async () => {
    const alert = await alertAgainst(staffDriver.userId);
    expect((await fire('POST', `${S}/sos/${alert.id}/resolve`, staffDriver, { resolutionCode: 'FALSE_ALARM' })).statusCode).toBe(403);
    expect((await fire('POST', `${S}/sos/${alert.id}/ack`, staffDriver)).statusCode).toBe(403);
    expect((await sys(() => app.prisma.sosAlert.findUniqueOrThrow({ where: { id: alert.id } }))).status).toBe('ACTIVE');
    // the one-alert read falls back to the owner path: not theirs
    expect((await fire('GET', `${S}/sos/${alert.id}`, staffDriver)).statusCode).toBe(403);
    const board = await fire('GET', `${S}/sos?status=all&limit=200`, staffDriver);
    expect(board.statusCode).toBe(200);
    expect((board.json().data as Array<{ id: string }>).some((a) => a.id === alert.id)).toBe(false);
    // another admin, not part of it, works it as before
    expect((await fire('GET', `${S}/sos/${alert.id}`, admin)).json().data.id).toBe(alert.id);
    expect((await fire('POST', `${S}/sos/${alert.id}/ack`, admin)).statusCode).toBe(200);
  });

  it('the case queue leaves out a case naming the caller, and a staff case for anyone but a super admin', async () => {
    const kase = await makeCase(staffDriver.userId);
    const listed = async (actor: Actor) => ((await fire('GET', `${S}/incidents?status=all&limit=200`, actor)).json().data as Array<{ id: string }>).some((c) => c.id === kase.id);
    expect(await listed(staffDriver)).toBe(false);
    expect(await listed(admin)).toBe(false);
    expect(await listed(superAdmin)).toBe(true);
  });

  it('the evidence lookup refuses a party', async () => {
    const { alert } = await makeBundleFor(staffDriver.userId);
    expect((await fire('GET', `${S}/evidence?sosAlertId=${alert.id}`, staffDriver)).statusCode).toBe(403);
    expect((await fire('GET', `${S}/evidence?sosAlertId=${alert.id}`, superAdmin)).statusCode).toBe(200);
  });
});

