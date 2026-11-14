import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { publicRoutes } from '../modules/public/public.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { diffDesired } from '../modules/ops/seed-plan';
import { desiredPlatformConfig } from '../modules/ops/platform-config';
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';
import { isMachineOwnedConfigKey } from '../modules/admin/machine-owned-config';
import {
  HOME_NOTICE_BODY_MAX, HOME_NOTICE_KEY, HOME_NOTICE_TITLE_MAX, homeNoticeWordsOf, noticeIdOf, publicHomeNoticeOf, storedHomeNoticeOf,
} from '../modules/ops/home-notice';
import { cleanupSecondApprovers, injectWithApproval } from './helpers/admin-approval';

// ---------------------------------------------------------------------------
// [HOME-NOTICE · owner 13 Nov 2026] A small notice on the customer Home, for
// everyone (signed in or not), closable with an X, until the owner stops it.
//
// The words are an admin-set value (one PlatformConfig row the signed spine
// never names), read on a public, briefly cacheable route. Turning a notice ON
// is customer-facing platform text — C5, like a broadcast: a reason and a
// second person (solo mode for the owner). Turning it OFF is immediate — C3, a
// reason and no wait — because the safe direction must never sit 12 hours in
// an approvals queue. Off by default: no row, no notice.
// ---------------------------------------------------------------------------

const RUN = nanoid(6).toLowerCase();
const REASON = 'Pickup is open while riders come on board, ref HOME-NOTICE-1';
const STOP_REASON = 'Riders are on board now, the pickup notice is no longer true';
const TITLE = 'Pickup is open on Swift';
const BODY = "We're still bringing riders on board, so delivery isn't available from every store yet. Choose Pickup at checkout and collect your order straight from the store.";
const userIds: string[] = [];
let app: FastifyInstance;
let token = '';
let before: { value: unknown } | null = null;

const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const publicNotice = async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/public/home-notice' });
  expect(res.statusCode, res.body).toBe(200);
  return { body: res.json().data, cache: res.headers['cache-control'] };
};
const setNotice = (payload: Record<string, unknown>) => injectWithApproval(app, {
  method: 'PUT', url: '/api/v1/admin/home-notice', headers: auth(), payload: { ...payload, reason: REASON },
});
const stopNotice = (reason: string | null = STOP_REASON) => app.inject({
  method: 'POST', url: '/api/v1/admin/home-notice/stop', headers: auth(), payload: reason === null ? {} : { reason },
});
const dropKey = () => runWithoutTenant(() => app.prisma.platformConfig.deleteMany({ where: { key: HOME_NOTICE_KEY } }), 'test-cleanup:home-notice');
const auditRows = () => runWithoutTenant(() => app.prisma.auditLog.findMany({
  where: { userId: userIds[0]!, entity: 'home-notice' },
  orderBy: { createdAt: 'asc' },
  select: { action: true, entityId: true, changes: true },
}), 'test-read').then((rows) => rows.map((r) => ({ ...r, changes: r.changes as Record<string, unknown> })));

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(publicRoutes, { prefix: '/api/v1/public' });
  await app.ready();
  // The key is platform-wide: remember whatever this database held and put it back after.
  before = await runWithoutTenant(() => app.prisma.platformConfig.findUnique({ where: { key: HOME_NOTICE_KEY }, select: { value: true } }), 'test-read');
  await dropKey();
  const phone = `+59274${String(Math.floor(Math.random() * 90000) + 10000)}`;
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: 'Notice', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN',
      status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
    },
  });
  userIds.push(user.id);
  token = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: 'home-notice', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
});

afterAll(async () => {
  await dropKey().catch(() => {});
  if (before) {
    await runWithoutTenant(() => app.prisma.platformConfig.create({ data: { key: HOME_NOTICE_KEY, value: before!.value as never } }), 'test-restore').catch(() => {});
  }
  await cleanupSecondApprovers(app);
  await runWithoutTenant(async () => {
    if (!userIds.length) return;
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'test-cleanup:home-notice').catch(() => 0);
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:home-notice').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:home-notice');
  await app.close();
});

describe('what a stored notice is', () => {
  const stored = { active: true, id: noticeIdOf(TITLE, BODY), title: TITLE, body: BODY, updatedAt: '2026-11-14T10:00:00.000Z' };

  it('an active, well-formed row is served without anything but its words, id and time', () => {
    expect(publicHomeNoticeOf(stored)).toEqual({ id: stored.id, title: TITLE, body: BODY, updatedAt: stored.updatedAt });
  });

  it.each([
    ['no row', undefined], ['null', null], ['switched off', { ...stored, active: false }], ['active as a string', { ...stored, active: 'true' }],
    ['no words', { ...stored, body: '' }], ['words too long', { ...stored, body: 'x'.repeat(HOME_NOTICE_BODY_MAX + 1) }],
    ['no id', { ...stored, id: '' }], ['a number', 42], ['an array', [stored]],
  ])('%s is no notice (a malformed row never shows anything)', (_label, value) => {
    expect(publicHomeNoticeOf(value)).toBeNull();
  });

  it('a stopped notice is still read for the console, so it shows what was last live', () => {
    expect(storedHomeNoticeOf({ ...stored, active: false })).toMatchObject({ active: false, body: BODY });
  });

  it('the id follows the words: the same words keep it, any change makes a new one', () => {
    expect(noticeIdOf(TITLE, BODY)).toBe(noticeIdOf(TITLE, BODY));
    expect(noticeIdOf(TITLE, BODY)).not.toBe(noticeIdOf(TITLE, `${BODY}!`));
    expect(noticeIdOf(TITLE, BODY)).not.toBe(noticeIdOf('', BODY));
    expect(noticeIdOf(TITLE, BODY)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('words are plain text: spaces are tidied, and controls, empties and long text are refused', () => {
    expect(homeNoticeWordsOf({ title: `  ${TITLE} `, body: ` Choose\n Pickup  at checkout. ` })).toEqual({ title: TITLE, body: 'Choose Pickup at checkout.' });
    expect(homeNoticeWordsOf({ body: 'Only a body.' })).toEqual({ title: null, body: 'Only a body.' });
    expect(() => homeNoticeWordsOf({ title: TITLE, body: '   ' })).toThrow();
    expect(() => homeNoticeWordsOf({ body: 'x'.repeat(HOME_NOTICE_BODY_MAX + 1) })).toThrow();
    expect(() => homeNoticeWordsOf({ title: 'x'.repeat(HOME_NOTICE_TITLE_MAX + 1), body: 'ok words' })).toThrow();
    expect(() => homeNoticeWordsOf({ body: 'bell \u0007 here' })).toThrow();
    expect(() => homeNoticeWordsOf({ body: 'flip ‮ this' })).toThrow();
  });
});

describe('off by default, and readable with no sign-in', () => {
  it('with nothing set there is no notice, and the answer is briefly cacheable', async () => {
    const { body, cache } = await publicNotice();
    expect(body).toEqual({ notice: null });
    expect(cache).toBe('public, max-age=60');
  });

  it('the signed platform spine never names the key, so a seed neither plans nor reverts it', () => {
    expect(desiredPlatformConfig().platformConfig.map((c) => c.key)).not.toContain(HOME_NOTICE_KEY);
  });

  it('the generic config route cannot write it: the words go through their own checked route', async () => {
    expect(isMachineOwnedConfigKey(HOME_NOTICE_KEY)).toBe(true);
    const res = await app.inject({
      method: 'PUT', url: `/api/v1/admin/config/${HOME_NOTICE_KEY}`, headers: auth(),
      payload: { value: { active: true, id: 'x', body: 'sneaked in' }, reason: REASON },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect((await publicNotice()).body).toEqual({ notice: null });
  });
});

describe('the console turns it on (C5) and off (C3, immediate)', () => {
  it('the classes: reading is C0, turning on is a platform action, turning off is consequential with no second person', () => {
    expect(ADMIN_ROUTE_AUTHORITY['GET /home-notice']?.cls).toBe('C0');
    expect(ADMIN_ROUTE_AUTHORITY['PUT /home-notice']?.cls).toBe('C5');
    expect(ADMIN_ROUTE_AUTHORITY['POST /home-notice/stop']?.cls).toBe('C3');
  });

  it('turning on asks a second admin first: nothing is live until it is approved', async () => {
    const asked = await app.inject({ method: 'PUT', url: '/api/v1/admin/home-notice', headers: auth(), payload: { title: TITLE, body: BODY, reason: REASON } });
    expect(asked.statusCode, asked.body).toBe(202);
    expect(asked.json().error.code).toBe('APPROVAL_REQUIRED');
    expect((await publicNotice()).body).toEqual({ notice: null });
  });

  it('words that could never go live are refused at the ask, not after the wait', async () => {
    const before = await runWithoutTenant(() => app.prisma.privilegedApproval.count({ where: { requestedBy: userIds[0]! } }), 'test-read');
    const res = await app.inject({ method: 'PUT', url: '/api/v1/admin/home-notice', headers: auth(), payload: { title: TITLE, body: ' ', reason: REASON } });
    expect(res.statusCode, res.body).toBe(400);
    const after = await runWithoutTenant(() => app.prisma.privilegedApproval.count({ where: { requestedBy: userIds[0]! } }), 'test-read');
    expect(after).toBe(before);
  });

  it('once approved it is live for everyone, signed in or not, and the console shows it', async () => {
    const res = await setNotice({ title: TITLE, body: BODY });
    expect(res.statusCode, res.body).toBe(200);
    const { body } = await publicNotice();
    expect(body.notice).toMatchObject({ id: noticeIdOf(TITLE, BODY), title: TITLE, body: BODY });
    expect(Object.keys(body.notice).sort()).toEqual(['body', 'id', 'title', 'updatedAt']);

    const console = await app.inject({ method: 'GET', url: '/api/v1/admin/home-notice', headers: auth() });
    expect(console.statusCode, console.body).toBe(200);
    expect(console.json().data).toMatchObject({ live: true, notice: { active: true, title: TITLE, body: BODY } });
  });

  it('with a notice live, the signed seed still plans nothing for it (it never reverts the owner\'s words)', async () => {
    const changes = await runWithoutTenant(() => diffDesired(app.prisma, desiredPlatformConfig()), 'test-seed-plan');
    expect(changes.filter((c) => c.table === 'platformConfig' && c.key === HOME_NOTICE_KEY)).toEqual([]);
    expect((await publicNotice()).body.notice).not.toBeNull();
  });

  it('turning off needs a reason', async () => {
    const res = await stopNotice(null);
    expect(res.statusCode, res.body).toBe(400);
    expect((await publicNotice()).body.notice).not.toBeNull();
  });

  it('turning off is immediate: no approval, and the notice is gone at the next read', async () => {
    const res = await stopNotice();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ live: false, notice: { active: false, body: BODY } });
    expect((await publicNotice()).body).toEqual({ notice: null });
    const pending = await runWithoutTenant(() => app.prisma.privilegedApproval.count({ where: { requestedBy: userIds[0]!, action: 'POST /home-notice/stop' } }), 'test-read');
    expect(pending).toBe(0);
  });

  it('turning off when nothing is live changes nothing and still answers', async () => {
    const res = await stopNotice();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ live: false });
  });

  it('the same words again keep their id (people who closed them stay closed); new words get a new id', async () => {
    expect((await setNotice({ title: TITLE, body: BODY })).statusCode).toBe(200);
    expect((await publicNotice()).body.notice.id).toBe(noticeIdOf(TITLE, BODY));
    const changed = `${BODY} Thank you.`;
    expect((await setNotice({ title: TITLE, body: changed })).statusCode).toBe(200);
    const after = (await publicNotice()).body.notice;
    expect(after.id).toBe(noticeIdOf(TITLE, changed));
    expect(after.id).not.toBe(noticeIdOf(TITLE, BODY));
  });

  it('every change leaves an audit row with its reason, the notice id and both sides of the switch', async () => {
    const rows = await auditRows();
    const ons = rows.filter((r) => r.action === 'ADMIN PUT /api/v1/admin/home-notice');
    const offs = rows.filter((r) => r.action === 'ADMIN POST /api/v1/admin/home-notice/stop');
    expect(rows.every((r) => r.entityId === HOME_NOTICE_KEY)).toBe(true);
    expect(ons.length).toBe(3);
    expect(offs.length).toBe(2);
    expect(ons[0]!.changes['reason']).toBe(REASON);
    expect(offs[0]!.changes['reason']).toBe(STOP_REASON);
    expect(ons[0]!.changes).toMatchObject({ noticeId: noticeIdOf(TITLE, BODY), liveBefore: false, liveAfter: true, title: TITLE, body: BODY });
    expect(offs[0]!.changes).toMatchObject({ noticeId: noticeIdOf(TITLE, BODY), liveBefore: true, liveAfter: false });
    expect(offs[1]!.changes).toMatchObject({ liveBefore: false, liveAfter: false });
  });
});
