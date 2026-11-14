import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { generateKeyPair, randomBytes, type KeyObject } from 'node:crypto';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { MmgCheckoutService } from '../modules/billing/mmg-checkout.service';
import { FakeMmgHistory } from './helpers/mmg-history-fake';
import { feePayActions, resetFeeCheckoutSwitchCache } from '../modules/billing/fee-pay-actions';
import { readFeePaymentDecision } from '../modules/billing/fee-payment-authority';
import { readPayAhead } from '../modules/billing/pay-ahead';
import { feeStatusFor } from '../modules/billing/fee-status';
import { payInfo } from '../modules/billing/agent-cash.service';
import { setAsideCreditRefund, startedWeekOwed } from '../modules/billing/credit-refund';
import { readDunningClock } from '../modules/billing/dunning-clock';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { ensureProviderIdentityBackfill, resetProviderIdentityBackfillCacheForTests } from '../modules/billing/provider-identity-backfill';
import { SANDBOX_MERCHANT_ID, SandboxMmgCheckoutProvider, type SandboxCheckoutKeys } from '../providers/mmg/mmg-checkout';
import { lookupDetailFrom, type MmgCheckoutLookupClient, type MmgLookupDetail } from '../providers/mmg/mmg-provider';

// ---------------------------------------------------------------------------
// [TRIAL PAY-AHEAD · owner 14 Nov 2026] A partner still in its free trial may
// pay the weekly fee a week ahead (MMG or card). The paid week starts when the
// trial ends, so nobody pays twice and no trial day is lost.
//
// Before: a trial is born with no billing clock, and the read-only Pay decision
// (fee-payment-authority.ts readFeePaymentDecision) refused every subscription
// without one (BILLING_REVIEW_REQUIRED), so no Pay button was ever drawn for a
// trial partner. These cases pin, against the database: the read accepts ONLY
// an unmapped trial awaiting its first fee (and still sees any payment being
// confirmed); exactly one week can be paid during the trial; MMG's confirmation
// credits it once and leaves the trial untouched; at the trial's end the credit
// pays the first week (no fee due, no failure, no pause); a refund at closing
// still finds every unstarted week.
// Phones: +592647… (checked unused in the monorepo).
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const HOUR = 3_600_000;
const WEEK = 7 * DAY;
const FEE = 2100;
let app: FastifyInstance;
let billing: BillingService;
let service: MmgCheckoutService;
let sandbox: SandboxMmgCheckoutProvider;
let keys: SandboxCheckoutKeys;
let kekBefore: string | undefined;

const lookups = new Map<string, MmgLookupDetail>();
const history = new FakeMmgHistory();
const lookup: MmgCheckoutLookupClient = {
  transactionLookupDetail: async (id) => lookups.get(id) ?? { outcome: 'not_found' },
  transactionHistoryRows: (query) => history.transactionHistoryRows(query),
};
const gyStamp = (at: Date) => new Date(at.getTime() - 4 * HOUR).toISOString();
/** MMG's lookup of `txn`, in the UAT shape (as mmg-checkout-service.test.ts), and its history row. */
function approved(checkout: { merchantTransactionId: string }, txn: string, amountGyd: number) {
  lookups.set(txn, {
    ...lookupDetailFrom({
      transactionStatus: 'successful', amount: String(amountGyd), currency: 'GYD', creationDate: gyStamp(new Date()),
      subType: 'subscriber_mpay', transactionReference: `L${txn}`,
      creditParty: [{ key: 'accountid', value: SANDBOX_MERCHANT_ID }], debitParty: [{ key: 'accountid', value: '6000002' }],
      metadata: [{ key: 'amount', value: String(amountGyd) }, { key: 'merchant', value: 'Swift' }, { key: 'description', value: '' }],
      descriptionText: null,
    }, txn),
    echoedReferences: [checkout.merchantTransactionId],
  });
  history.holds(txn, amountGyd, { external_id: checkout.merchantTransactionId });
}

const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const phoneBase = 592_647_000_000 + Math.floor(Math.random() * 900_000);
const RUN = nanoid(6).toUpperCase().replace(/[^A-Z0-9]/g, 'Q');
const tx = (name: string) => `${name}${RUN}`;
const key = () => `trial-${nanoid(12)}`;

/** A store in its free trial, exactly as activation makes one: the first fee falls due when the trial ends, and no
 *  billing clock exists yet. `trialEnd` defaults to two hours from now (the conversion case moves past it). */
async function makeTrialStore(opts: { trialEnd?: Date; status?: 'TRIAL' | 'ACTIVE'; nextBillingDate?: Date } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Trial', lastName: `P${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Trial Store ${seq}`, slug: `trial-store-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 5000 + seq}`,
      addressLine1: '1 Trial Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const end = opts.trialEnd ?? new Date(Date.now() + 2 * HOUR);
  const status = opts.status ?? 'TRIAL';
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status, isTrialActive: status === 'TRIAL', weeklyRate: FEE, billingMethod: 'CASH',
      currentPeriodStart: new Date(end.getTime() - 14 * DAY), currentPeriodEnd: end, trialEndDate: end,
      nextBillingDate: opts.nextBillingDate ?? end, prepaidBalance: { create: { balance: 0 } },
    },
  });
  subIds.push(sub.id);
  return { userId: user.id, subId: sub.id, trialEnd: end };
}

/** A trial that paid its first week ahead and has just ended, before the daily conversion: still TRIAL, the first
 *  week (from the trial's end) has started, the credit is held, and the door mapped the clock when it took the money. */
async function endedPrepaidTrial() {
  const s = await makeTrialStore({ trialEnd: new Date(Date.now() - 5 * 60_000) });
  await readDunningClock(app.prisma, s.subId);
  await app.prisma.$transaction((tx) => billing.recordTopUpInTransaction(tx, { subscriptionId: s.subId, amount: FEE,
    recordedBy: 'mmg-checkout', channel: 'MMG_CHECKOUT', eventKey: `trial-gap:${RUN}:${s.subId}` }));
  return s;
}

const start = (s: { subId: string; userId: string }, weeks?: number) =>
  service.createCheckout({ subscriptionId: s.subId, userId: s.userId, platform: 'android', clientKey: key(), ...(weeks ? { weeks } : {}) });
const reply = (row: { merchantTransactionId: string }, txn: string) => service.observeReply({
  source: 'RETURN', outcome: 'success',
  params: { token: sandbox.sandboxReplyToken({ merchantTransactionId: row.merchantTransactionId, transactionId: txn, ResultCode: '0', secretKey: 'must-not-be-stored' }) },
});
const subOf = (id: string) => app.prisma.subscription.findUniqueOrThrow({ where: { id } });
const walletOf = async (id: string) => Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: id } })).balance);
const clocks = (id: string) => app.prisma.billingDunningClock.count({ where: { subscriptionId: id } });
const billable = (id: string) => app.prisma.subscription.findUniqueOrThrow({
  where: { id },
  include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { id: true, owner: { select: { userId: true } } } } },
}) as never;
async function mmgAction(id: string) {
  const sub = await subOf(id);
  const [mmg] = await feePayActions(app.prisma, sub, 'android', () => sandbox);
  // The route's own rule on top (mmg-checkout.routes.ts payActionsFor): the shared read-only decision.
  return mmg!.state === 'live' && (await readFeePaymentDecision(app.prisma, id)).allowed ? mmg! : { id: 'MMG_CHECKOUT', state: 'off' };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  delete process.env['MMG_DRIVER'];
  kekBefore = process.env['MASTER_KEK'];
  process.env['MASTER_KEK'] = randomBytes(32).toString('base64');
  resetKeyProviderForTests();
  const pair = await new Promise<{ publicKey: KeyObject; privateKey: KeyObject }>((resolve, reject) => {
    generateKeyPair('rsa', { modulusLength: 4096 }, (err, publicKey, privateKey) => (err ? reject(err) : resolve({ publicKey, privateKey })));
  });
  keys = { request: pair, result: pair };
  sandbox = new SandboxMmgCheckoutProvider(keys, 'GUYANA_WALL_CLOCK');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
  const notifications = new NotificationService(app.prisma, app.io);
  billing = new BillingService(app.prisma, notifications, getPaymentProvider());
  service = new MmgCheckoutService(app.prisma, billing, notifications, { checkout: () => sandbox, lookup: () => lookup });
  resetProviderIdentityBackfillCacheForTests();
  await ensureProviderIdentityBackfill(app.prisma);
}, 120_000);

beforeEach(() => {
  resetFeeCheckoutSwitchCache();
  history.reset();
});

afterAll(async () => {
  await cleanupBillingClocks(app.prisma, subIds);
  const intents = await app.prisma.mmgCheckoutIntent.findMany({ where: { subscriptionId: { in: subIds } }, select: { id: true } });
  await app.prisma.mmgCheckoutKey.deleteMany({ where: { intentId: { in: intents.map((i) => i.id) } } });
  await app.prisma.mmgCheckoutObservation.deleteMany({ where: { intentId: { in: intents.map((i) => i.id) } } });
  await app.prisma.mmgCheckoutIntent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.providerPayment.deleteMany({ where: { OR: [{ subscriptionId: { in: subIds } }, { providerTxnId: { endsWith: RUN } }] } });
  await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.cardSession.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
  if (kekBefore === undefined) delete process.env['MASTER_KEK'];
  else process.env['MASTER_KEK'] = kekBefore;
  resetKeyProviderForTests();
});

describe('the read-only Pay decision: an unmapped trial awaiting its first fee may pay, nothing else without a clock', () => {
  it('a trial with no clock yet: allowed, and reading it maps nothing', async () => {
    const s = await makeTrialStore();
    expect(await clocks(s.subId)).toBe(0);
    expect(await readFeePaymentDecision(app.prisma, s.subId)).toEqual({ allowed: true, reason: null });
    expect(await clocks(s.subId), 'a read never maps a clock').toBe(0);
  });

  it('still fails closed without a clock for everything else: a trial past its end, a trial whose first fee is not at its end, any non-trial', async () => {
    const ended = await makeTrialStore({ trialEnd: new Date(Date.now() - HOUR) });
    expect(await readFeePaymentDecision(app.prisma, ended.subId)).toEqual({ allowed: false, reason: 'BILLING_REVIEW_REQUIRED' });
    const booked = await makeTrialStore({ trialEnd: new Date(Date.now() + DAY), nextBillingDate: new Date(Date.now() + DAY + WEEK) });
    expect(await readFeePaymentDecision(app.prisma, booked.subId)).toEqual({ allowed: false, reason: 'BILLING_REVIEW_REQUIRED' });
    const active = await makeTrialStore({ status: 'ACTIVE', trialEnd: new Date(Date.now() + 3 * DAY) });
    expect(await readFeePaymentDecision(app.prisma, active.subId)).toEqual({ allowed: false, reason: 'BILLING_REVIEW_REQUIRED' });
  });

  it('an unmapped trial with a payment of this fee still unresolved is never offered a second one', async () => {
    const s = await makeTrialStore();
    const sub = await subOf(s.subId);
    await app.prisma.subscriptionPayment.create({ data: { subscriptionId: s.subId, amount: FEE, paymentMethod: 'CARD',
      status: 'UNKNOWN', periodStart: sub.nextBillingDate, periodEnd: new Date(sub.nextBillingDate.getTime() + WEEK),
      failureRaw: { providerEffect: 'AUTHORIZED' } } });
    expect(await readFeePaymentDecision(app.prisma, s.subId)).toEqual({ allowed: false, reason: 'PAYMENT_CONFIRMING' });
    expect(await clocks(s.subId)).toBe(0);
  });
});

describe('[owner 14 Nov] MMG during the free trial: one week, credited once, kept for the week that starts at the trial end', () => {
  it('pays exactly one week ahead, then the trial runs on and the first week after it is the paid one', async () => {
    const s = await makeTrialStore();
    // The Pay button: live, one week (the trial's own limit), at the current fee.
    expect(await mmgAction(s.subId)).toEqual({ id: 'MMG_CHECKOUT', state: 'live', amountGyd: FEE, currencyCode: 'GYD', weekOptions: [{ weeks: 1, amountGyd: FEE }] });
    // Two weeks is refused before any page exists, in words for the trial.
    await expect(start(s, 2)).rejects.toMatchObject({ statusCode: 409, code: 'PAY_AHEAD_LIMIT',
      message: 'During your free trial Swift takes one weekly fee ahead: the first week after your trial ends. You can pay at most GY$2,100 now.' });
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: s.subId } })).toBe(0);

    const { created, checkout } = await start(s);
    expect(created).toBe(true);
    expect(checkout).toMatchObject({ status: 'OPEN', amountGyd: FEE });
    // The door mapped the clock under its locks, and the open page holds it: no second way to pay meanwhile.
    expect(await clocks(s.subId)).toBe(1);
    expect(await readFeePaymentDecision(app.prisma, s.subId)).toEqual({ allowed: false, reason: 'PAYMENT_CONFIRMING' });

    const row = await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: checkout.ref } });
    approved(row, tx('TRIALTX1'), FEE);
    expect(await reply(row, tx('TRIALTX1'))).toBe('CONFIRMED');
    // A second answer for the same payment credits nothing more.
    expect(await reply(row, tx('TRIALTX1'))).toBe('CONFIRMED');
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: s.subId, type: 'PREPAID_TOPUP' } })).toBe(1);
    expect(await walletOf(s.subId)).toBe(FEE);
    // The partner is told which week it pays, never that the trial is over (REVIEW-B #2513 S4-3).
    const told = (await app.prisma.notification.findMany({ where: { userId: s.userId, data: { path: ['kind'], equals: 'billing_mmg_checkout' } } }))
      .filter((n) => (n.data as Record<string, unknown>)['status'] === 'CONFIRMED');
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ title: 'Weekly fee paid' });
    expect(told[0]!.body).toMatch(/^GY\$2,100 received with MMG\. It pays your first week after your free trial, \d{1,2} \w{3} \d{4} to \d{1,2} \w{3} \d{4}\. Thank you\.$/);

    // The trial is untouched: same end, same first fee date, nothing charged, the clock running again.
    const after = await subOf(s.subId);
    expect(after).toMatchObject({ status: 'TRIAL', isTrialActive: true, failedAttempts: 0 });
    expect(after.nextBillingDate.getTime()).toBe(s.trialEnd.getTime());
    expect(after.trialEndDate!.getTime()).toBe(s.trialEnd.getTime());
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: s.subId, type: 'CHARGE_SUCCESS' } })).toBe(0);
    const clock = await app.prisma.billingDunningClock.findUniqueOrThrow({ where: { subscriptionId: s.subId } });
    expect(clock.pausedAt).toBeNull();
    expect(clock.dueAt.getTime()).toBe(s.trialEnd.getTime());
    expect(await app.prisma.paymentConfirmationHold.count({ where: { subscriptionId: s.subId, status: { in: ['ACTIVE', 'SETTLEMENT_APPLY_PENDING'] } } })).toBe(0);

    // One week is all a trial takes: no button, and the door says why.
    expect(await readFeePaymentDecision(app.prisma, s.subId)).toEqual({ allowed: true, reason: null });
    expect(await readPayAhead(app.prisma, s.subId, new Date())).toMatchObject({ trial: true, maxWeeks: 1, room: 0, excess: 0, heldAhead: FEE });
    expect(await mmgAction(s.subId)).toEqual({ id: 'MMG_CHECKOUT', state: 'off' });
    await expect(start(s)).rejects.toMatchObject({ statusCode: 409, code: 'PAY_AHEAD_LIMIT',
      message: 'Your first weekly fee after your free trial is already paid. You can pay again once your trial has ended.' });

    // What the fee screen says.
    const status = await feeStatusFor(app.prisma, after, await payInfo(app.prisma, after));
    expect(status.state).toBe('TRIAL');
    expect(status.detail).toMatch(/^Your first week after the trial, .+ to .+, is already paid\.$/);

    // A refund at closing finds the week: it has not started, so nothing of it is "started and owed".
    expect(await startedWeekOwed(app.prisma, after, new Date())).toBe(false);

    // The trial ends: the conversion makes the fee due, and the billing run pays the first week from the credit.
    const at = new Date(s.trialEnd.getTime() + 60_000);
    await new SubscriptionService(app.prisma).convertExpiredTrials(at);
    expect(await subOf(s.subId)).toMatchObject({ status: 'ACTIVE', isTrialActive: false });
    expect(await billing.billSubscription(await billable(s.subId), new Date(at.getTime() + 60_000))).toBe('succeeded');
    const paid = await subOf(s.subId);
    expect(paid).toMatchObject({ status: 'ACTIVE', failedAttempts: 0, isInGracePeriod: false });
    expect(paid.nextBillingDate.getTime(), 'the paid week is the first after the trial').toBe(s.trialEnd.getTime() + WEEK);
    expect(await walletOf(s.subId)).toBe(0);
    const success = await app.prisma.billingEvent.findMany({ where: { subscriptionId: s.subId, type: 'CHARGE_SUCCESS' } });
    expect(success).toHaveLength(1);
    expect(success[0]!.paymentRef).toBe('prepaid');
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: s.subId, type: 'CHARGE_FAILED' } })).toBe(0);
    const moved = await app.prisma.billingDunningClock.findUniqueOrThrow({ where: { subscriptionId: s.subId } });
    expect(moved.dueAt.getTime()).toBe(s.trialEnd.getTime() + WEEK);
    expect(moved.pausedAt).toBeNull();
    // Nothing is due until that week ends: the fee screen says the week is paid.
    const paidStatus = await feeStatusFor(app.prisma, paid, await payInfo(app.prisma, paid), new Date(at.getTime() + 2 * 60_000));
    expect(paidStatus.state).toBe('PAID');
  });

  // [REVIEW-A #2513 S3-1] Conversion runs once a day: until it does, a trial that has ended is still TRIAL. One that
  // paid its first week reads "already paid" and is offered nothing more (never a live Pay button beside it).
  it('after the trial ends and before the daily conversion: "already paid", no Pay button, every door refuses more', async () => {
    const s = await endedPrepaidTrial();
    expect(await readFeePaymentDecision(app.prisma, s.subId)).toEqual({ allowed: true, reason: null });
    expect(await readPayAhead(app.prisma, s.subId, new Date())).toMatchObject({ trial: true, trialEnded: true, due: true, room: 0, excess: 0 });
    expect(await mmgAction(s.subId)).toEqual({ id: 'MMG_CHECKOUT', state: 'off' });
    await expect(start(s)).rejects.toMatchObject({ statusCode: 409, code: 'PAY_AHEAD_LIMIT',
      message: 'Your first weekly fee after your free trial is already paid. You can pay again once Swift has applied it.' });
    const sub = await subOf(s.subId);
    expect((await feeStatusFor(app.prisma, sub, await payInfo(app.prisma, sub))).state).toBe('COVERED');
  });

  // [REVIEW-A #2513 S3-2] A week that has started is never refunded: a refund asked in the same window first pays the
  // first week from the credit (converting this one trial exactly as the daily job would), then finds nothing left.
  it('a refund asked after the trial ended, before the conversion, pays the started first week from the credit first', async () => {
    const s = await endedPrepaidTrial();
    const before = await subOf(s.subId);
    expect(await startedWeekOwed(app.prisma, before, new Date()), 'the first week has started').toBe(true);
    expect(await billing.settleStartedWeekFromCredit(s.subId)).toBe('paid');
    const paid = await subOf(s.subId);
    expect(paid).toMatchObject({ status: 'ACTIVE', isTrialActive: false, failedAttempts: 0 });
    expect(paid.nextBillingDate.getTime()).toBe(s.trialEnd.getTime() + WEEK);
    expect(await walletOf(s.subId)).toBe(0);
    await expect(setAsideCreditRefund(app.prisma, { adminId: s.userId, approvalId: `trial-gap-${RUN}`, subscriptionId: s.subId, amount: FEE }))
      .rejects.toMatchObject({ code: 'NO_FEE_CREDIT' });
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: s.subId, type: 'PREPAID_REFUND_RESERVED' } })).toBe(0);
  });

  it('a trial that did not pay ahead is due at its end as before: the pay-ahead changes nothing for it', async () => {
    const s = await makeTrialStore();
    expect((await readPayAhead(app.prisma, s.subId, new Date()))).toMatchObject({ trial: true, room: FEE });
    const at = new Date(s.trialEnd.getTime() + 60_000);
    await new SubscriptionService(app.prisma).convertExpiredTrials(at);
    const converted = await subOf(s.subId);
    expect(converted).toMatchObject({ status: 'ACTIVE', isTrialActive: false });
    expect(converted.nextBillingDate.getTime()).toBe(s.trialEnd.getTime());
    // From the trial's end the four-week limit applies, as for everyone: the week now due on top of it.
    expect(await readPayAhead(app.prisma, s.subId, at)).toMatchObject({ trial: false, maxWeeks: 4, due: true, room: 5 * FEE });
  });
});
