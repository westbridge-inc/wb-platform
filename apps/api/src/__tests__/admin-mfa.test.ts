import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
import { authRoutes } from '../modules/auth/auth.routes';
import { runWithoutTenant } from '../plugins/tenant-context';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { base32Decode, base32Encode, hotp, matchTotp, totpAt, stepAt } from '../modules/auth/admin-totp';
import { notifyAdminSignIn } from '../modules/auth/admin-mfa';
import { devChannelLog } from '../providers/notifications/channels';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [AUDIT-20261113 FABLE-03 #2] The admin console's second factor and session posture.
//  - TOTP is RFC 6238 (the RFC's own test vector), a code is accepted once, within one step of drift.
//  - With ADMIN_TOTP_REQUIRED=1 the admin API refuses a session that has not proved an authenticator code:
//    first "enrol", then "enter the code". Enrolment needs a fresh sign-in code; the secret is stored only
//    encrypted; ten recovery codes, each works once.
//  - An admin session reaches the admin API for 12 hours from sign-in, whatever the switch.
//  - With ADMIN_API_CONSOLE_ONLY=1 a bearer token from any other client is refused.
//  - Every admin sign-in is emailed to the account's address.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
type Actor = { userId: string; token: string; sessionId: string };

async function makeAdmin(opts: { createdAt?: Date; email?: string } = {}): Promise<Actor> {
  return runWithoutTenant(async () => {
    const user = await app.prisma.user.create({ data: {
      phone: testPhone(), firstName: 'Mfa', lastName: `Admin${RUN}${userIds.length}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN',
      status: 'ACTIVE', isPhoneVerified: true, ...(opts.email ? { email: opts.email } : {}), admin: { create: { permissions: ['*'] } },
    } });
    userIds.push(user.id);
    return { ...(await newSession(user.id, opts.createdAt)), userId: user.id };
  }, 'test-fixture:admin-mfa');
}
async function newSession(userId: string, createdAt?: Date): Promise<{ token: string; sessionId: string }> {
  const token = app.jwt.sign({ userId, role: 'SUPER_ADMIN', jti: nanoid(8) });
  const session = await runWithoutTenant(() => app.prisma.session.create({ data: {
    userId, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'admin-mfa', deviceType: 'test',
    expiresAt: new Date(Date.now() + 86_400_000), ...(createdAt ? { createdAt } : {}),
  } }), 'test-fixture:admin-mfa');
  return { token, sessionId: session.id };
}
const get = (a: { token: string }, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${a.token}` } });
const post = (a: { token: string }, url: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, payload });
const ADMIN_PROBE = '/api/v1/admin/approvals';

beforeAll(async () => {
  vi.stubEnv('MASTER_KEK', Buffer.alloc(32, 9).toString('base64'));
  resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(rateLimit, { global: false, allowList: () => true });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
});
afterEach(() => { delete process.env['ADMIN_TOTP_REQUIRED']; delete process.env['ADMIN_API_CONSOLE_ONLY']; });
afterAll(async () => {
  vi.unstubAllEnvs();
  resetKeyProviderForTests();
  await runWithoutTenant(async () => {
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:admin-mfa').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }, 'test-cleanup:admin-mfa');
  for (const id of userIds) await app.redis.del(`admin_mfa_fail:${id}`);
  await app.close();
});

describe('[FABLE-03 #2] TOTP is RFC 6238', () => {
  it('matches the RFC test vector and round-trips base32', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(hotp(secret, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(hotp(secret, Math.floor(1111111109 / 30), 8)).toBe('07081804');
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
  });
  it('accepts one step of drift, never a step at or before the last accepted one', () => {
    const secret = Buffer.from('abcdefghijabcdefghij');
    const now = Date.now();
    const s = stepAt(now);
    expect(matchTotp(secret, totpAt(secret, now), now, null)).toBe(s);
    expect(matchTotp(secret, totpAt(secret, now - 30_000), now, null)).toBe(s - 1);
    expect(matchTotp(secret, totpAt(secret, now - 90_000), now, null)).toBeNull();
    expect(matchTotp(secret, totpAt(secret, now), now, s)).toBeNull();
    expect(matchTotp(secret, 'abcdef', now, null)).toBeNull();
  });
});

describe('[FABLE-03 #2] with ADMIN_TOTP_REQUIRED=1 the admin API needs the authenticator', () => {
  it('switch off: an OTP admin session works as today', async () => {
    const admin = await makeAdmin();
    expect((await get(admin, ADMIN_PROBE)).statusCode).toBe(200);
  });

  it('enrol, then every new session must prove a code; codes work once; recovery codes work once', async () => {
    process.env['ADMIN_TOTP_REQUIRED'] = '1';
    const admin = await makeAdmin();
    const refused = await get(admin, ADMIN_PROBE);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('ADMIN_MFA_ENROLMENT_REQUIRED');

    const started = await post(admin, '/api/v1/auth/admin-mfa/enrol');
    expect(started.statusCode, started.body).toBe(200);
    const { secret, otpauthUrl } = started.json().data as { secret: string; otpauthUrl: string };
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\/Swift%3ASwift%20admin\?secret=/);
    const key = base32Decode(secret);
    const stored = await runWithoutTenant(() => app.prisma.admin.findUniqueOrThrow({ where: { userId: admin.userId } }), 'test-read');
    expect(stored.totpPendingSecretEnc).toBeTruthy();
    expect(stored.totpPendingSecretEnc).not.toContain(secret);

    expect((await post(admin, '/api/v1/auth/admin-mfa/enrol/confirm', { code: '000000' === totpAt(key, Date.now()) ? '111111' : '000000' })).statusCode).toBe(400);
    const confirmed = await post(admin, '/api/v1/auth/admin-mfa/enrol/confirm', { code: totpAt(key, Date.now()) });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const recoveryCodes = confirmed.json().data.recoveryCodes as string[];
    expect(recoveryCodes).toHaveLength(10);
    expect((await get(admin, ADMIN_PROBE)).statusCode).toBe(200); // this session proved the code

    // A new sign-in: the code again. The code just used is refused (accepted once); the next one works.
    const second = { ...(await newSession(admin.userId)) };
    const must = await get(second, ADMIN_PROBE);
    expect(must.statusCode).toBe(403);
    expect(must.json().error.code).toBe('ADMIN_MFA_REQUIRED');
    expect((await post(second, '/api/v1/auth/admin-mfa/verify', { code: totpAt(key, Date.now()) })).statusCode).toBe(400);
    const next = await post(second, '/api/v1/auth/admin-mfa/verify', { code: totpAt(key, Date.now() + 30_000) });
    expect(next.statusCode, next.body).toBe(200);
    expect((await get(second, ADMIN_PROBE)).statusCode).toBe(200);

    // A recovery code works once.
    const third = await newSession(admin.userId);
    expect((await post(third, '/api/v1/auth/admin-mfa/verify', { recoveryCode: recoveryCodes[0] })).statusCode).toBe(200);
    expect((await get(third, ADMIN_PROBE)).statusCode).toBe(200);
    const fourth = await newSession(admin.userId);
    expect((await post(fourth, '/api/v1/auth/admin-mfa/verify', { recoveryCode: recoveryCodes[0] })).statusCode).toBe(400);
    expect((await get(fourth, ADMIN_PROBE)).statusCode).toBe(403);

    // Enrolled: cannot enrol again over the existing factor.
    expect((await post(fourth, '/api/v1/auth/admin-mfa/enrol')).statusCode).toBe(409);
    const enrolled = await runWithoutTenant(() => app.prisma.admin.findUniqueOrThrow({ where: { userId: admin.userId } }), 'test-read');
    expect(enrolled.totpSecretEnc).toBeTruthy();
    expect(enrolled.totpSecretEnc).not.toContain(secret);
    expect(enrolled.totpRecoveryHashes).toHaveLength(9);
  });

  it('enrolment needs a fresh proof: a session older than the step-up window without a step-up is refused', async () => {
    const admin = await makeAdmin({ createdAt: new Date(Date.now() - 60 * 60_000) });
    const res = await post(admin, '/api/v1/auth/admin-mfa/enrol');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
  });

  it('five wrong codes rest the door for 15 minutes', async () => {
    process.env['ADMIN_TOTP_REQUIRED'] = '1';
    const admin = await makeAdmin();
    const { secret } = (await post(admin, '/api/v1/auth/admin-mfa/enrol')).json().data as { secret: string };
    const key = base32Decode(secret);
    const wrong = totpAt(key, Date.now()) === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) expect((await post(admin, '/api/v1/auth/admin-mfa/enrol/confirm', { code: wrong })).statusCode).toBe(400);
    expect((await post(admin, '/api/v1/auth/admin-mfa/enrol/confirm', { code: totpAt(key, Date.now()) })).statusCode).toBe(429);
  });
});

describe('[FABLE-03 #2] the admin session posture', () => {
  it('an admin session reaches the admin API for 12 hours from sign-in, switch or not', async () => {
    const old = await makeAdmin({ createdAt: new Date(Date.now() - 13 * 3_600_000) });
    const res = await get(old, ADMIN_PROBE);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('ADMIN_SESSION_EXPIRED');
    const fresh = await makeAdmin({ createdAt: new Date(Date.now() - 11 * 3_600_000) });
    expect((await get(fresh, ADMIN_PROBE)).statusCode).toBe(200);
  });

  it('with ADMIN_API_CONSOLE_ONLY=1 a bearer token from any other client is refused', async () => {
    process.env['ADMIN_API_CONSOLE_ONLY'] = '1';
    const admin = await makeAdmin();
    const res = await get(admin, ADMIN_PROBE);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/Mission Control web console/);
  });

  it('an admin sign-in is emailed to the account; a customer sign-in is not', async () => {
    const email = `mfa-${RUN}@example.test`;
    const admin = await makeAdmin({ email });
    const before = devChannelLog.length;
    await notifyAdminSignIn(app, { id: admin.userId, roles: ['SUPER_ADMIN', 'CUSTOMER'] }, { deviceType: 'web' });
    await notifyAdminSignIn(app, { id: admin.userId, roles: ['CUSTOMER'] }, { deviceType: 'web' });
    const sent = devChannelLog.slice(before).filter((n) => n.channel === 'email' && n.to === email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toMatch(/new sign-in to your admin account/);
  });
});
