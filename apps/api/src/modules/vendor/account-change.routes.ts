/**
 * [COMPANY-DOCS Part 3 · owner rulings 10 Nov 2026 ~07:3xZ (c) + (d)] The store's and the named person's doors to an
 * account change (vendor/account-change.ts holds the rules). The person at Swift decides in the console
 * (admin.routes /account-changes).
 *
 * Under /vendor (the account holder only — never a manager or staff, who may not change who the business is):
 *   GET  /account-change                      the business type today, the answers open to it, the change waiting
 *   POST /account-change/business-type        ask to change the business type
 *   POST /account-change/own-name             sign the own-name declaration for a pending change to "own name"
 *   POST /account-change/handover             name the new account holder (fresh "confirm it's you")
 *   POST /account-change/:id/withdraw         take back the change waiting
 * Under /customer (the person named, who holds no store account yet):
 *   GET  /account-handovers                   the handover naming them
 *   POST /account-handovers/:id/accept        say yes (they then file their own papers)
 *   POST /account-handovers/:id/decline       say no (nothing changes)
 * Every refusal is decided before a body is read: an outsider is told 403, never what a body would have said.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from '../../lib/zod';
import { zPhone } from '../../utils/phone';
import { AppError } from '../../utils/errors';
import { bindTenantTransaction } from '../../plugins/prisma';
import type { NotificationService } from '../notification/notification.service';
import { notifyAdmins } from '../notification/notification.service';
import type { VerificationService } from '../verification/verification.service';
import { requireStepUp } from '../auth/step-up';
import { LEGAL_VERSION } from '../legal/legal.routes';
import type { ConsentSurface } from '../legal/consent.service';
import { OWN_NAME_DOC_TYPE } from '../verification/doc-registry';
import {
  BUSINESS_TYPE_OPTIONS, acceptHandover, endAccountChange, handoversNaming, holderAccountChange, loadChange,
  startBusinessTypeChange, startHandover, viewOfChange,
} from './account-change';
import { OWN_NAME_DECLARATION_VERSION, OWN_NAME_VENDOR_TYPES } from './own-name';
import { fileOwnNameDeclaration } from './own-name-filing';

interface Deps { verification: VerificationService; notifications: NotificationService }

/** The account holder, or 403 — decided before anything else is read. */
async function requireHolder(app: FastifyInstance, userId: string) {
  const owner = await app.prisma.vendorOwner.findUnique({
    where: { userId },
    select: { id: true, user: { select: { tenantId: true } }, vendors: { select: { id: true, name: true, vendorType: true }, orderBy: { createdAt: 'asc' } } },
  });
  if (!owner || owner.vendors.length === 0) throw new AppError(403, 'STAFF_FORBIDDEN', 'Only the account holder can do this');
  return owner;
}

function surfaceOf(request: FastifyRequest): ConsentSurface {
  const platform = String(request.headers['x-client-platform'] ?? '').toLowerCase();
  return platform === 'ios' || platform === 'android' ? platform : 'vendor_web';
}

async function publish(deps: Pick<Deps, 'notifications'>, ids: readonly string[]): Promise<void> {
  for (const id of ids) await deps.notifications.publishPersisted(id).catch(() => undefined);
}

export function registerAccountChangeVendorRoutes(app: FastifyInstance, deps: Deps): void {
  const auth = { preHandler: [app.authenticate] };

  app.get('/account-change', auth, async (request) => {
    await requireHolder(app, request.user.userId);
    return { success: true, data: await holderAccountChange(app.prisma, request.user.userId) };
  });

  // [review-2475 F8] An ask pages every reviewer: limited like the handover (and to 3 a day, account-change.ts).
  app.post('/account-change/business-type', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const owner = await requireHolder(app, request.user.userId);
    const { toOption } = z.object({ toOption: z.enum(BUSINESS_TYPE_OPTIONS) }).strict().parse(request.body ?? {});
    const change = await startBusinessTypeChange(app.prisma, request.user.userId, toOption);
    await notifyAdmins(app.prisma, deps.notifications, {
      tenantId: owner.user.tenantId,
      title: 'Business type change to check',
      body: `${owner.vendors[0]?.name ?? 'A store'} asked to change its business type. Check its new papers, then the change, under Account changes.`,
      data: { kind: 'account_change_pending', changeId: change.id },
    }).catch((err: unknown) => request.log.warn({ err }, 'account change: admins not told'));
    reply.code(201);
    return { success: true, data: change };
  });

  app.post('/account-change/own-name', auth, async (request, reply) => {
    const owner = await requireHolder(app, request.user.userId);
    const body = z.object({
      accept: z.literal(true),
      attestationVersion: z.literal(OWN_NAME_DECLARATION_VERSION),
      privacyNoticeVersion: z.string().min(1).max(20).default(LEGAL_VERSION),
    }).parse(request.body ?? {});
    const userId = request.user.userId;
    const pending = await app.prisma.accountChangeRequest.findFirst({ where: { vendorOwnerId: owner.id, status: 'PENDING', kind: 'BUSINESS_TYPE', toOption: 'OWN_NAME' }, select: { id: true } });
    if (!pending) throw new AppError(409, 'NO_OWN_NAME_CHANGE', 'Ask to change your business type to “I trade under my own name” first.');
    const existing = await app.prisma.verificationDocument.findFirst({ where: { userId, docType: OWN_NAME_DOC_TYPE, status: { in: ['PENDING', 'APPROVED'] } }, select: { status: true } });
    if (existing) {
      throw new AppError(409, 'OWN_NAME_DECLARATION_EXISTS', `Your own-name declaration is already ${existing.status === 'APPROVED' ? 'on file' : 'waiting for review'}.`);
    }
    const store = owner.vendors.find((v) => (OWN_NAME_VENDOR_TYPES as readonly string[]).includes(v.vendorType));
    if (!store) throw new AppError(400, 'OWN_NAME_NOT_APPLICABLE', 'A service business is not asked for a business registration.');
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { firstName: true, lastName: true } });
    const doc = await fileOwnNameDeclaration(app.prisma, deps.verification, {
      userId, vendor: store, legalName: `${user.firstName} ${user.lastName}`.trim(), privacyNoticeVersion: body.privacyNoticeVersion,
      surface: surfaceOf(request), ip: request.ip, markStore: false,
    });
    reply.code(201);
    return { success: true, data: { declaration: { id: doc.id, status: doc.status, docType: doc.docType }, change: await viewOfChange(app.prisma, await loadChange(app.prisma, pending.id)) } };
  });

  app.post('/account-change/handover', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const owner = await requireHolder(app, request.user.userId);
    const { phone } = z.object({ phone: zPhone }).strict().parse(request.body ?? {});
    // Handing the whole business to another phone: a fresh "confirm it's you", as adding a team member.
    await requireStepUp(app, request as unknown as Parameters<typeof requireStepUp>[1]);
    const { change, noticeId } = await startHandover(app.prisma, request.user.userId, phone);
    await publish(deps, [noticeId]);
    await notifyAdmins(app.prisma, deps.notifications, {
      tenantId: owner.user.tenantId,
      title: 'Account handover to check',
      body: `${owner.vendors[0]?.name ?? 'A store'} named a new account holder. Check their papers, then the handover, under Account changes.`,
      data: { kind: 'account_change_pending', changeId: change.id },
    }).catch((err: unknown) => request.log.warn({ err }, 'account handover: admins not told'));
    reply.code(201);
    return { success: true, data: change };
  });

  app.post('/account-change/:id/withdraw', auth, async (request) => {
    const owner = await requireHolder(app, request.user.userId);
    const { id } = request.params as { id: string };
    const change = await app.prisma.accountChangeRequest.findFirst({ where: { id, vendorOwnerId: owner.id }, select: { id: true } });
    if (!change) throw new AppError(404, 'NOT_FOUND', 'That change was not found.');
    const notices = await app.prisma.$transaction(async (tx) => { await bindTenantTransaction(tx); return endAccountChange(tx, {
      changeId: id, by: request.user.userId, outcome: 'WITHDRAWN',
      audit: (t, row) => t.auditLog.create({ data: { userId: request.user.userId, action: 'WITHDRAW_ACCOUNT_CHANGE', entity: 'AccountChangeRequest', entityId: row.id, changes: { kind: row.kind } } }).then(() => undefined),
    }); });
    await publish(deps, notices);
    return { success: true, data: await viewOfChange(app.prisma, await loadChange(app.prisma, id)) };
  });
}

/** Registered inside customerRoutes, whose own hook signs every request in before these run. */
export function registerAccountHandoverCustomerRoutes(app: FastifyInstance, deps: Pick<Deps, 'notifications'>): void {
  const auth = {};

  app.get('/account-handovers', auth, async (request) => ({ success: true, data: await handoversNaming(app.prisma, request.user.userId) }));

  app.post('/account-handovers/:id/accept', auth, async (request) => {
    const { id } = request.params as { id: string };
    return { success: true, data: await acceptHandover(app.prisma, request.user.userId, id) };
  });

  app.post('/account-handovers/:id/decline', auth, async (request) => {
    const { id } = request.params as { id: string };
    const named = await app.prisma.accountChangeRequest.findFirst({ where: { id, newHolderId: request.user.userId, kind: 'HOLDER_HANDOVER' }, select: { id: true } });
    if (!named) throw new AppError(404, 'NOT_FOUND', 'That handover was not found.');
    const notices = await app.prisma.$transaction(async (tx) => { await bindTenantTransaction(tx); return endAccountChange(tx, {
      changeId: id, by: request.user.userId, outcome: 'WITHDRAWN',
      audit: (t, row) => t.auditLog.create({ data: { userId: request.user.userId, action: 'DECLINE_ACCOUNT_HANDOVER', entity: 'AccountChangeRequest', entityId: row.id } }).then(() => undefined),
    }); });
    await publish(deps, notices);
    return { success: true, data: { id, status: 'WITHDRAWN' } };
  });
}
