import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { searchRoutes } from '../modules/search/search.routes';
import { runWithoutTenant } from '../plugins/tenant-context';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { base32Decode, base32Encode, hotp, matchTotp, normaliseRecoveryCode, totpAt, stepAt } from '../modules/auth/admin-totp';
import { notifyAdminSignIn, signInPlaceWords, ADMIN_MFA_MAX_FAILURES, ADMIN_MFA_DAY_MAX_FAILURES } from '../modules/auth/admin-mfa';
import { resetBrowserOriginsForTests } from '../modules/auth/browser-session';
import { stepUpKey } from '../modules/auth/step-up';
import { OPS_WAR_ROOM } from '../modules/safety/war-room';
import { devChannelLog } from '../providers/notifications/channels';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { testPhone } from './helpers/fixture-ids';
import { loginWithOtp, requestOtp } from './helpers/otp';

// ---------------------------------------------------------------------------
// [AUDIT-20261113 FABLE-03 #2 · REVIEW-2501-A] The admin console's second factor and the staff session posture.
//  - TOTP is RFC 6238 (the RFC's own test vector), a code is accepted once, within one step of drift.
//  - With ADMIN_TOTP_REQUIRED=1 the admin API AND every other staff surface (the safety console, /search/sync, the
//    war-room socket) refuse a session that has not proved an authenticator code, or is older than 12 hours; the
//    phone may only ACKNOWLEDGE a page without it (COORD ruling), audited, the owner emailed.
//  - No sign-in answer ever carries TOTP material; recovery digests are keyed (S1-1).
//  - ADMIN_API_CONSOLE_ONLY=1 accepts only a session the console's own sign-in issued, on its cookie (S3-1).
//  - Attempts are reserved before they are judged; a day limit; the owner is told (S3-2, S4-2).
//  - An enrolled admin's step-up is the authenticator code (S3-3). Self-service codes and app (S4-6).
//  - An expired admin session is revoked (S4-7). The sign-in email names the place in fixed words (S4-3).
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let url: string;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
const opsAlertIds: string[] = [];
const sockets: Socket[] = [];
type Actor = { userId: string; token: string; sessionId: string; phone: string };
const KEEP_ENV = ['CORS_ORIGIN', 'ADMIN_HOST'] as const;
const savedEnv = Object.fromEntries(KEEP_ENV.map((k) => [k, process.env[k]]));

async function makeAdmin(opts: { createdAt?: Date; email?: string } = {}): Promise<Actor> {
  return runWithoutTenant(async () => {
    const phone = testPhone();
    const user = await app.prisma.user.create({ data: {
      phone, firstName: 'Mfa', lastName: `Admin${RUN}${userIds.length}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN',
      status: 'ACTIVE', isPhoneVerified: true, ...(opts.email ? { email: opts.email } : {}), admin: { create: { permissions: ['*'] } },
    } });
    userIds.push(user.id);
    return { ...(await newSession(user.id, opts.createdAt)), userId: user.id, phone };
  }, 'test-fixture:admin-mfa');
}
async function newSession(userId: string, createdAt?: Date, extra: { mfaVerifiedAt?: Date } = {}): Promise<{ token: string; sessionId: string }> {
  const token = app.jwt.sign({ userId, role: 'SUPER_ADMIN', jti: nanoid(8) });
  const session = await runWithoutTenant(() => app.prisma.session.create({ data: {
    userId, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'admin-mfa', deviceType: 'test',
    expiresAt: new Date(Date.now() + 86_400_000), ...(createdAt ? { createdAt } : {}), ...extra,
  } }), 'test-fixture:admin-mfa');
  return { token, sessionId: session.id };
}
const get = (a: { token: string }, path: string) => app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${a.token}` } });
const post = (a: { token: string }, path: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: path, headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, payload });
const ADMIN_PROBE = '/api/v1/admin/approvals';
const sessionRow = (id: string) => runWithoutTenant(() => app.prisma.session.findUnique({ where: { id } }), 'test-read');

/** Enrolled through the routes; the step the enrolment used is rewound so the current code works again. */
async function enrolledAdmin(opts: { createdAt?: Date; email?: string } = {}) {
  const admin = await makeAdmin(opts);
  const started = await post(admin, '/api/v1/auth/admin-mfa/enrol');
  expect(started.statusCode, started.body).toBe(200);
  const key = base32Decode((started.json().data as { secret: string }).secret);
  const confirmed = await post(admin, '/api/v1/auth/admin-mfa/enrol/confirm', { code: totpAt(key, Date.now()) });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  await rewind(admin.userId);
  // the enrolling session proved the code; the tests sign in again with a texted code alone
  const sms = await newSession(admin.userId);
  return { ...admin, ...sms, key, recoveryCodes: confirmed.json().data.recoveryCodes as string[] };
}
const rewind = (userId: string) => runWithoutTenant(() => app.prisma.admin.update({ where: { userId }, data: { totpLastStep: stepAt(Date.now()) - 2 } }), 'test-fixture:admin-mfa');
/** A 6-digit code that matches no step in the drift window. */
function wrongCode(key: Buffer): string {
  const now = Date.now();
  const live = new Set([-1, 0, 1].map((d) => totpAt(key, now + d * 30_000)));
  for (const c of ['123456', '654321', '111111', '999999']) if (!live.has(c)) return c;
  throw new Error('unreachable');
}
const emailsTo = (email: string, since: number) => devChannelLog.slice(since).filter((n) => n.channel === 'email' && n.to === email);
async function eventually(check: () => boolean, ms = 3000) {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
}
/** Walks every key of a JSON value. */
function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); keysOf(v, out); }
  return out;
}

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
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.register(searchRoutes, { prefix: '/api/v1' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterEach(() => {
  delete process.env['ADMIN_TOTP_REQUIRED']; delete process.env['ADMIN_API_CONSOLE_ONLY'];
  for (const k of KEEP_ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  resetBrowserOriginsForTests();
});
afterAll(async () => {
  for (const s of sockets) s.disconnect();
  vi.unstubAllEnvs();
  resetKeyProviderForTests();
  await runWithoutTenant(async () => {
    if (opsAlertIds.length > 0) {
      await app.prisma.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: opsAlertIds } } });
      await app.prisma.opsAlert.deleteMany({ where: { id: { in: opsAlertIds } } });
    }
    if (userIds.length > 0) {
      await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:admin-mfa').catch(() => 0);
      await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  }, 'test-cleanup:admin-mfa');
  for (const id of userIds) await app.redis.del(`admin_mfa_fail:${id}`, `admin_mfa_fail_day:${id}`);
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

    expect((await post(admin, '/api/v1/auth/admin-mfa/enrol/confirm', { code: wrongCode(key) })).statusCode).toBe(400);
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

  it('five wrong codes rest the enrolment door', async () => {
    process.env['ADMIN_TOTP_REQUIRED'] = '1';
    const admin = await makeAdmin();
    const { secret } = (await post(admin, '/api/v1/auth/admin-mfa/enrol')).json().data as { secret: string };
    const key = base32Decode(secret);
    for (let i = 0; i < 5; i++) expect((await post(admin, '/api/v1/auth/admin-mfa/enrol/confirm', { code: wrongCode(key) })).statusCode).toBe(400);
    expect((await post(admin, '/api/v1/auth/admin-mfa/enrol/confirm', { code: totpAt(key, Date.now()) })).statusCode).toBe(429);
  });
});

describe('[REVIEW-2501-A S1-1] no TOTP material ever leaves; recovery digests are keyed', () => {
  it('a texted-code sign-in of an enrolled admin answers no totp* field anywhere, and the admin row only by its four fields', async () => {
    const admin = await enrolledAdmin();
    const res = await loginWithOtp(app, admin.phone);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(keysOf(body).filter((k) => /totp/i.test(k))).toEqual([]);
    expect(res.body).not.toMatch(/totp/i);
    expect(Object.keys(body.data.user.admin).sort()).toEqual(['createdAt', 'id', 'permissions', 'userId']);
  });

  it('recovery codes are stored as keyed digests: a bare SHA-256 of a code matches none of them', async () => {
    const admin = await enrolledAdmin();
    const row = await runWithoutTenant(() => app.prisma.admin.findUniqueOrThrow({ where: { userId: admin.userId } }), 'test-read');
    expect(row.totpRecoveryHashes).toHaveLength(10);
    for (const h of row.totpRecoveryHashes) expect(h).toMatch(/^h1:[0-9a-f]{64}$/);
    for (const code of admin.recoveryCodes) {
      const bare = createHash('sha256').update(`swift-admin-recovery:${normaliseRecoveryCode(code)}`).digest('hex');
      expect(row.totpRecoveryHashes.some((h) => h.endsWith(bare))).toBe(false);
    }
  });
});

describe('[REVIEW-2501-A S2-1] with ADMIN_TOTP_REQUIRED=1 every staff surface needs the posture', () => {
  const STAFF_DOORS: Array<['GET' | 'POST', string]> = [
    ['GET', '/api/v1/safety/sos'],
    ['GET', '/api/v1/safety/incidents'],
    ['GET', '/api/v1/safety/evidence?caseId=nope'],
    ['POST', '/api/v1/safety/evidence/nope/view'],
    ['GET', '/api/v1/safety/guardian'],
    ['GET', '/api/v1/safety/ops-alerts/failed-drills'],
    ['POST', '/api/v1/safety/sos/nope/ack'],
    ['POST', '/api/v1/safety/incidents/nope/close'],
    ['POST', '/api/v1/search/sync'],
  ];
  const call = (a: { token: string }, [method, path]: ['GET' | 'POST', string]) => (method === 'GET' ? get(a, path) : post(a, path, { reason: 'probe reason' }));

  it('a texted-code session of an enrolled admin is refused on every door; after the code, it passes', async () => {
    process.env['ADMIN_TOTP_REQUIRED'] = '1';
    const admin = await enrolledAdmin();
    for (const door of STAFF_DOORS) {
      const res = await call(admin, door);
      expect(res.statusCode, `${door[1]}: ${res.body}`).toBe(403);
      expect(res.json().error.code, door[1]).toBe('ADMIN_MFA_REQUIRED');
    }
    expect((await post(admin, '/api/v1/auth/admin-mfa/verify', { code: totpAt(admin.key, Date.now()) })).statusCode).toBe(200);
    expect((await get(admin, '/api/v1/safety/sos')).statusCode).toBe(200);
    expect((await get(admin, '/api/v1/safety/incidents')).statusCode).toBe(200);
    expect((await post(admin, '/api/v1/search/sync')).statusCode).not.toBe(403);
  });

  it('switch off: the safety console answers a texted-code session as before', async () => {
    const admin = await makeAdmin();
    expect((await get(admin, '/api/v1/safety/sos')).statusCode).toBe(200);
  });

  it('a person reading an alert by id is not an ops read: no posture refusal, their own alert or 404', async () => {
    process.env['ADMIN_TOTP_REQUIRED'] = '1';
    const admin = await enrolledAdmin();
    expect((await get(admin, '/api/v1/safety/sos/nope')).statusCode).toBe(404);
  });

  it('12 hours from sign-in the safety console refuses and the session is revoked (S4-7)', async () => {
    process.env['ADMIN_TOTP_REQUIRED'] = '1';
    const admin = await enrolledAdmin();
    const old = await newSession(admin.userId, new Date(Date.now() - 13 * 3_600_000), { mfaVerifiedAt: new Date(Date.now() - 13 * 3_600_000) });
    const res = await get(old, '/api/v1/safety/sos');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('ADMIN_SESSION_EXPIRED');
    expect(await sessionRow(old.sessionId)).toBeNull();
  });

  it('the phone may see THAT a page waits and acknowledge it: no case words, audited, the owner emailed', async () => {
    process.env['ADMIN_TOTP_REQUIRED'] = '1';
    const email = `ack-${RUN}@example.test`;
    const admin = await enrolledAdmin({ email });
    const page = await runWithoutTenant(() => app.prisma.opsAlert.create({ data: {
      kind: 'PLATFORM', tenantId: null, title: `PROBE TITLE ${RUN}`, body: `PROBE BODY ${RUN}`, ackDeadlineAt: new Date(Date.now() + 600_000),
      recipients: { create: { tenantId: null, userId: admin.userId } },
    } }), 'test-fixture:admin-mfa');
    opsAlertIds.push(page.id);

    const list = await get(admin, '/api/v1/safety/ops-alerts');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).not.toContain('PROBE');
    const row = (list.json().data as Array<Record<string, unknown>>).find((r) => r['id'] === page.id)!;
    expect(row).toBeTruthy();
    expect(Object.keys(row).sort()).toEqual(['ackDeadlineAt', 'body', 'createdAt', 'escalationLevel', 'id', 'kind', 'title']);

    const before = devChannelLog.length;
    const ack = await post(admin, `/api/v1/safety/ops-alerts/${page.id}/ack`);
    expect(ack.statusCode, ack.body).toBe(200);
    expect(ack.json().data).toEqual({ acknowledged: true });
    const audit = await runWithoutTenant(() => app.prisma.auditLog.findFirst({ where: { userId: admin.userId, action: 'OPS_ALERT_ACK_WITHOUT_MFA' } }), 'test-read');
    expect(audit).toBeTruthy();
    const mails = emailsTo(email, before);
    expect(mails.map((m) => m.title)).toContain('Swift: an ops page was acknowledged from a phone');
    expect(mails.map((m) => m.body).join('\n')).not.toContain('PROBE');
  });

  it('with the posture, the page list shows the page itself (unchanged)', async () => {
    process.env['ADMIN_TOTP_REQUIRED'] = '1';
    const admin = await enrolledAdmin();
    const page = await runWithoutTenant(() => app.prisma.opsAlert.create({ data: {
      kind: 'PLATFORM', tenantId: null, title: `SEEN TITLE ${RUN}`, body: 'seen', ackDeadlineAt: new Date(Date.now() + 600_000),
    } }), 'test-fixture:admin-mfa');
    opsAlertIds.push(page.id);
    expect((await post(admin, '/api/v1/auth/admin-mfa/verify', { code: totpAt(admin.key, Date.now()) })).statusCode).toBe(200);
    const list = await get(admin, '/api/v1/safety/ops-alerts');
    expect(list.body).toContain(`SEEN TITLE ${RUN}`);
  });

  it('the war-room socket is joined only by a session with the posture', async () => {
    process.env['ADMIN_TOTP_REQUIRED'] = '1';
    const admin = await enrolledAdmin();
    const connect = (token: string) => new Promise<Socket>((resolve, reject) => {
      const socket = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 3000 });
      sockets.push(socket);
      const timer = setTimeout(() => reject(new Error('socket did not become ready')), 7_500);
      socket.on('auth:ready', () => { clearTimeout(timer); resolve(socket); });
      socket.on('connect_error', (e) => { clearTimeout(timer); reject(e); });
    });
    const inRoom = async (socket: Socket) => (await app.io.in(OPS_WAR_ROOM).fetchSockets()).some((s) => s.id === socket.id);
    const unverified = await connect(admin.token);
    expect(await inRoom(unverified)).toBe(false);
    expect((await post(admin, '/api/v1/auth/admin-mfa/verify', { code: totpAt(admin.key, Date.now()) })).statusCode).toBe(200);
    const verified = await connect(admin.token);
    expect(await inRoom(verified)).toBe(true);
  });
});

describe('[REVIEW-2501-A S3-1] console-only is bound to the console\'s own sign-in, not to headers', () => {
  const ORIGIN = 'https://admin.example.test';
  const CONSOLE = { 'x-swift-client': 'admin-web', origin: ORIGIN } as const;
  function jarOf(res: { headers: Record<string, unknown> }): Record<string, string> {
    const jar: Record<string, string> = {};
    for (const line of ([] as string[]).concat((res.headers['set-cookie'] as string[] | string | undefined) ?? [])) {
      const pair = line.split(';')[0]!; const at = pair.indexOf('=');
      jar[pair.slice(0, at)] = decodeURIComponent(pair.slice(at + 1));
    }
    return jar;
  }
  const cookie = (jar: Record<string, string>) => Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');

  it('the console\'s cookie session passes; a token issued to another client, re-sent as that cookie with copied headers, is refused', async () => {
    process.env['ADMIN_API_CONSOLE_ONLY'] = '1';
    process.env['CORS_ORIGIN'] = ORIGIN;
    process.env['ADMIN_HOST'] = 'admin.example.test';
    resetBrowserOriginsForTests();
    const admin = await makeAdmin();

    const code = await requestOtp(app, admin.phone);
    const signedIn = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-otp', headers: CONSOLE, payload: { phone: admin.phone, code } });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    const jar = jarOf(signedIn);
    const accessName = Object.keys(jar).find((k) => k.endsWith('swift_at'))!;
    expect(accessName).toBeTruthy();
    const ok = await app.inject({ method: 'GET', url: ADMIN_PROBE, headers: { ...CONSOLE, cookie: cookie(jar) } });
    expect(ok.statusCode, ok.body).toBe(200);
    const consoleSession = await runWithoutTenant(() => app.prisma.session.findFirst({ where: { userId: admin.userId, consoleBoundAt: { not: null } } }), 'test-read');
    expect(consoleSession).toBeTruthy();

    // The same account signed in on the phone: its token, wrapped as the console's cookie with the console's headers.
    const phone = await loginWithOtp(app, admin.phone);
    const phoneToken = (phone.json().data.tokens as { accessToken: string }).accessToken;
    const replay = await app.inject({ method: 'GET', url: ADMIN_PROBE, headers: { ...CONSOLE, cookie: `${accessName}=${encodeURIComponent(phoneToken)}` } });
    expect(replay.statusCode, replay.body).toBe(403);
    expect(replay.json().error.code).toBe('ADMIN_CONSOLE_ONLY');
    // and as a bearer token
    expect((await get({ token: phoneToken }, ADMIN_PROBE)).statusCode).toBe(403);
  });
});

describe('[REVIEW-2501-A S3-2 · S4-2] attempts are reserved before they are judged', () => {
  it('ten concurrent wrong codes: exactly five are judged, five rest', async () => {
    process.env['ADMIN_TOTP_REQUIRED'] = '1';
    const admin = await enrolledAdmin();
    const wrong = wrongCode(admin.key);
    const results = await Promise.all(Array.from({ length: 10 }, () => post(admin, '/api/v1/auth/admin-mfa/verify', { code: wrong })));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 400)).toHaveLength(ADMIN_MFA_MAX_FAILURES);
    expect(codes.filter((c) => c === 429)).toHaveLength(10 - ADMIN_MFA_MAX_FAILURES);
  });

  it('the sign-in door rests after five wrong codes: the right code is then refused too (M4)', async () => {
    process.env['ADMIN_TOTP_REQUIRED'] = '1';
    const admin = await enrolledAdmin();
    for (let i = 0; i < 5; i++) expect((await post(admin, '/api/v1/auth/admin-mfa/verify', { code: wrongCode(admin.key) })).statusCode).toBe(400);
    const rested = await post(admin, '/api/v1/auth/admin-mfa/verify', { code: totpAt(admin.key, Date.now()) });
    expect(rested.statusCode).toBe(429);
    expect(rested.json().error.code).toBe('ADMIN_MFA_RESTING');
  });

  it('the owner is emailed when the door rests', async () => {
    process.env['ADMIN_TOTP_REQUIRED'] = '1';
    const email = `rest-${RUN}@example.test`;
    const admin = await enrolledAdmin({ email });
    const before = devChannelLog.length;
    for (let i = 0; i < 5; i++) await post(admin, '/api/v1/auth/admin-mfa/verify', { code: wrongCode(admin.key) });
    expect(emailsTo(email, before).map((m) => m.title)).toContain('Swift: wrong authenticator codes on an admin account');
  });

  it('a failure counter always has its expiry, even one found without it (S4-2)', async () => {
    const admin = await enrolledAdmin();
    await app.redis.set(`admin_mfa_fail:${admin.userId}`, '1');
    expect(await app.redis.ttl(`admin_mfa_fail:${admin.userId}`)).toBe(-1);
    await post(admin, '/api/v1/auth/admin-mfa/verify', { code: wrongCode(admin.key) });
    expect(await app.redis.ttl(`admin_mfa_fail:${admin.userId}`)).toBeGreaterThan(0);
  });

  it('a day of wrong codes rests the authenticator door; a recovery code still opens (no permanent lockout)', async () => {
    const admin = await enrolledAdmin();
    await app.redis.set(`admin_mfa_fail_day:${admin.userId}`, String(ADMIN_MFA_DAY_MAX_FAILURES), 'EX', 3600);
    const rested = await post(admin, '/api/v1/auth/admin-mfa/verify', { code: totpAt(admin.key, Date.now()) });
    expect(rested.statusCode).toBe(429);
    expect((await post(admin, '/api/v1/auth/admin-mfa/verify', { recoveryCode: admin.recoveryCodes[0] })).statusCode).toBe(200);
  });

  it('a code is accepted once even when two sessions present it at the same moment (M8)', async () => {
    const admin = await enrolledAdmin();
    const other = await newSession(admin.userId);
    const code = totpAt(admin.key, Date.now());
    // Both requests read the factor row before either writes: only the compare-and-set on the step decides.
    const delegate = app.prisma.admin as unknown as { findUnique: (args: { select?: Record<string, unknown> }) => Promise<unknown> };
    const real = delegate.findUnique.bind(delegate);
    let arrived = 0; let release: () => void = () => {};
    const bothRead = new Promise<void>((r) => { release = r; });
    const spy = vi.spyOn(delegate, 'findUnique').mockImplementation(async (args) => {
      const row = await real(args);
      if (args.select?.['totpSecretEnc']) { arrived += 1; if (arrived >= 2) release(); await Promise.race([bothRead, new Promise((r) => setTimeout(r, 2000))]); }
      return row;
    });
    try {
      const [a, b] = await Promise.all([
        post(admin, '/api/v1/auth/admin-mfa/verify', { code }),
        post(other, '/api/v1/auth/admin-mfa/verify', { code }),
      ]);
      expect(arrived).toBe(2);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    } finally {
      spy.mockRestore();
    }
  });

  it('the authenticator door refuses a session older than 12 hours and revokes it', async () => {
    const admin = await enrolledAdmin();
    const old = await newSession(admin.userId, new Date(Date.now() - 13 * 3_600_000));
    const res = await post(old, '/api/v1/auth/admin-mfa/verify', { code: totpAt(admin.key, Date.now()) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('ADMIN_SESSION_EXPIRED');
    expect(await sessionRow(old.sessionId)).toBeNull();
  });
});

describe('[REVIEW-2501-A S3-3] an enrolled admin steps up with the authenticator, never a text', () => {
  it('no text is sent; the authenticator code steps this session up; a wrong one does not', async () => {
    const admin = await enrolledAdmin();
    const before = devChannelLog.length;
    const send = await post(admin, '/api/v1/auth/step-up');
    expect(send.statusCode).toBe(409);
    expect(send.json().error.code).toBe('STEP_UP_USE_AUTHENTICATOR');
    expect(devChannelLog.slice(before).filter((n) => n.channel === 'sms' && n.to === admin.phone)).toHaveLength(0);
    expect((await post(admin, '/api/v1/auth/step-up/verify', { code: wrongCode(admin.key) })).statusCode).toBe(400);
    expect(await app.redis.exists(stepUpKey(admin.sessionId))).toBe(0);
    const ok = await post(admin, '/api/v1/auth/step-up/verify', { code: totpAt(admin.key, Date.now()) });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await app.redis.exists(stepUpKey(admin.sessionId))).toBe(1);
  });
});

describe('[REVIEW-2501-A S4-6] self-service: new recovery codes, a new authenticator app', () => {
  it('new recovery codes need the current factor; the old ones stop working', async () => {
    const admin = await enrolledAdmin();
    expect((await post(admin, '/api/v1/auth/admin-mfa/recovery-codes', {})).statusCode).toBe(400);
    expect((await post(admin, '/api/v1/auth/admin-mfa/recovery-codes', { code: wrongCode(admin.key) })).statusCode).toBe(400);
    const res = await post(admin, '/api/v1/auth/admin-mfa/recovery-codes', { code: totpAt(admin.key, Date.now()) });
    expect(res.statusCode, res.body).toBe(200);
    const fresh = res.json().data.recoveryCodes as string[];
    expect(fresh).toHaveLength(10);
    const s1 = await newSession(admin.userId);
    expect((await post(s1, '/api/v1/auth/admin-mfa/verify', { recoveryCode: admin.recoveryCodes[1] })).statusCode).toBe(400);
    expect((await post(s1, '/api/v1/auth/admin-mfa/verify', { recoveryCode: fresh[0] })).statusCode).toBe(200);
  });

  it('a new app needs the current factor (here a recovery code) and a code from the new app; the old app stops working', async () => {
    const admin = await enrolledAdmin();
    const started = await post(admin, '/api/v1/auth/admin-mfa/replace', { recoveryCode: admin.recoveryCodes[2] });
    expect(started.statusCode, started.body).toBe(200);
    const newKey = base32Decode((started.json().data as { secret: string }).secret);
    expect((await post(admin, '/api/v1/auth/admin-mfa/replace/confirm', { code: wrongCode(newKey) })).statusCode).toBe(400);
    const done = await post(admin, '/api/v1/auth/admin-mfa/replace/confirm', { code: totpAt(newKey, Date.now()) });
    expect(done.statusCode, done.body).toBe(200);
    await rewind(admin.userId);
    const s1 = await newSession(admin.userId);
    expect((await post(s1, '/api/v1/auth/admin-mfa/verify', { code: totpAt(admin.key, Date.now()) })).statusCode).toBe(400);
    expect((await post(s1, '/api/v1/auth/admin-mfa/verify', { recoveryCode: admin.recoveryCodes[3] })).statusCode).toBe(400);
    expect((await post(s1, '/api/v1/auth/admin-mfa/verify', { code: totpAt(newKey, Date.now()) })).statusCode).toBe(200);
  });

  it('without the current factor a new app cannot be started', async () => {
    const admin = await enrolledAdmin();
    expect((await post(admin, '/api/v1/auth/admin-mfa/replace', { code: wrongCode(admin.key) })).statusCode).toBe(400);
  });
});

describe('[FABLE-03 #2] the admin session posture', () => {
  it('an admin session reaches the admin API for 12 hours from sign-in, switch or not; then it is revoked (S4-7)', async () => {
    const old = await makeAdmin({ createdAt: new Date(Date.now() - 13 * 3_600_000) });
    const res = await get(old, ADMIN_PROBE);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('ADMIN_SESSION_EXPIRED');
    expect(await sessionRow(old.sessionId)).toBeNull();
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
    await notifyAdminSignIn(app, { id: admin.userId, roles: ['SUPER_ADMIN', 'CUSTOMER'] }, { browserClient: 'admin-web' });
    await notifyAdminSignIn(app, { id: admin.userId, roles: ['CUSTOMER'] }, { browserClient: 'admin-web' });
    const sent = emailsTo(email, before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toMatch(/new sign-in to your admin account/);
    expect(sent[0]!.body).toContain('Mission Control (web)');
  });

  it('the sign-in route itself sends it (M6), and never repeats text the request chose (S4-3)', async () => {
    const email = `route-${RUN}@example.test`;
    const admin = await makeAdmin({ email });
    const code = await requestOtp(app, admin.phone);
    const before = devChannelLog.length;
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-otp', headers: { 'x-device-type': 'Swift support: call +592 000 0000' }, payload: { phone: admin.phone, code } });
    expect(res.statusCode, res.body).toBe(200);
    await eventually(() => emailsTo(email, before).length > 0);
    const sent = emailsTo(email, before);
    expect(sent.map((m) => m.title)).toContain('Swift: new sign-in to your admin account');
    expect(sent.map((m) => m.body).join('\n')).not.toContain('support');
  });

  it('the place words are a fixed list', () => {
    expect(signInPlaceWords({ browserClient: 'admin-web', deviceType: 'x' })).toBe('Mission Control (web)');
    expect(signInPlaceWords({ browserClient: null, deviceType: 'iOS' })).toBe('the iPhone app');
    expect(signInPlaceWords({ browserClient: null, deviceType: 'android' })).toBe('the Android app');
    expect(signInPlaceWords({ browserClient: null, deviceType: 'call +592 now' })).toBe('a device Swift could not name');
  });
});
