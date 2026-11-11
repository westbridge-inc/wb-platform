import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockDragontail } from './helpers/mock-dragontail';
import { DragontailClient, DRAGONTAIL_MAX_RETRIES } from '../modules/kitchen/dragontail/dragontail-client';
import { DragontailAdapter } from '../modules/kitchen/dragontail/dragontail-adapter';
import {
  dragontailCancelBody,
  dragontailEvents,
  dragontailInsertBody,
  dragontailTime,
  dragontailUpdateEvents,
  parseDragontailTime,
} from '../modules/kitchen/dragontail/dragontail-mapper';
import { KitchenPermanentError, KitchenTransientError, type KitchenOrder } from '../modules/kitchen/kitchen-provider';
import { dragontailIntegrationEnabled, dragontailSettings } from '../modules/kitchen/kitchen-switch';
import { kitchenLoginFor, kitchenLoginRef, kitchenSecretStatus, kitchenWebhookRef, kitchenWebhookSecretFor } from '../modules/kitchen/kitchen-credentials';
import { kitchenEligibility } from '../modules/kitchen/kitchen-claim';
import { kitchenWebhookAuthentic, kitchenWebhookSignature } from '../modules/kitchen/kitchen-webhook.routes';

// ---------------------------------------------------------------------------
// [KITCHEN-INTEGRATION · owner 11 Nov 2026] The Dragontail contract, service-free: the HTTP rules (login, token,
// 403 re-login, 5xx retries with backoff, timeouts), the insert mapping field by field against the public spec
// (v1.1.0), the notification mapping, and the webhook proof. A mock Dragontail
// (helpers/mock-dragontail.ts) answers as the spec describes.
// ---------------------------------------------------------------------------

const mock = new MockDragontail();
const LOGIN = { userName: 'pos-42', password: 'pw-42' };
const sleeps: number[] = [];
const client = (over: Partial<ConstructorParameters<typeof DragontailClient>[0]> = {}) => new DragontailClient({
  baseUrl: mock.url, login: LOGIN, userLevel: -1, timeoutMs: 2_000,
  sleep: async (ms) => { sleeps.push(ms); }, ...over,
});

const ORDER: KitchenOrder = {
  swiftOrderId: 'order-1',
  storeNo: 42,
  externalOrderId: 1_900_000_007,
  dailyNo: 7,
  placedAt: new Date('2026-11-11T16:20:09.000Z'),
  saleType: 'DELIVERY',
  payment: 'CASH',
  orderTotal: 4300,
  netSales: 3500,
  prepaidTips: 0,
  cashToCollect: 4300,
  isPaid: false,
  customer: { firstName: 'Ann', lastName: 'Test', phone: '+5926000000', address: '9 Test Street, Georgetown', lat: 6.81, lng: -58.16 },
  driverNote: 'Blue gate',
  cookNote: null,
  lines: [
    { itemNo: '8', name: 'Pan Pizza XL', quantity: 1, choices: [{ itemNo: '121', name: 'green pepper' }, { itemNo: '233', name: 'black olives' }], note: 'well done' },
    { itemNo: '23', name: 'Pan Pizza L', quantity: 2, choices: [], note: null },
  ],
};
const SETTINGS = dragontailSettings({});

beforeAll(async () => {
  await mock.start();
  mock.users.set(LOGIN.userName, LOGIN.password);
});
afterAll(async () => { await mock.stop(); });
beforeEach(() => { mock.reset(); sleeps.length = 0; });

describe('[KITCHEN] the switch and the settings', () => {
  it('is ON only at exactly 1 (blanks ignored); every TODO-CONFIRM setting has a spec-grounded default', () => {
    for (const [value, on] of [[undefined, false], ['', false], ['0', false], ['true', false], ['1', true], [' 1 ', true], ['2', false]] as const) {
      expect([value, dragontailIntegrationEnabled(value === undefined ? {} : { DRAGONTAIL_INTEGRATION: value })]).toEqual([value, on]);
    }
    expect(SETTINGS).toEqual({
      sourceId: 2, mmgPaymentCode: 2, userLevel: -1, timeoutMs: 8_000, orderIdBase: 1_900_000_000,
      webhookCheck: 'shared', webhookHeader: 'x-dragontail-shared', webhookSignatureHeader: 'x-dragontail-signature',
      acceptOn: 'INSERT_OK', ackTimeoutMs: 180_000, cancelMode: 'REMOVE_ITEMS', pollSeconds: 15,
    });
    // A value outside its allowed set falls back, never half-applies.
    expect(dragontailSettings({ DRAGONTAIL_WEBHOOK_CHECK: 'none', DRAGONTAIL_ACCEPT_ON: 'x', DRAGONTAIL_SOURCE_ID: '-3' })).toMatchObject({ webhookCheck: 'shared', acceptOn: 'INSERT_OK', sourceId: 2 });
  });

  it('credentials come only from the secret, under the connection OWN derived keys; a value is never echoed', () => {
    const mine = { id: 'cmine000000000000000000001', provider: 'DRAGONTAIL' };
    const other = { id: 'cother00000000000000000001', provider: 'DRAGONTAIL' };
    expect(kitchenLoginRef(mine)).toBe('kitchen/dragontail/cmine000000000000000000001/login');
    expect(kitchenWebhookRef(mine)).toBe('kitchen/dragontail/cmine000000000000000000001/webhook');
    const env = { DRAGONTAIL_CREDENTIALS: JSON.stringify({
      [kitchenLoginRef(other)]: { userName: 'u', password: 'p' },
      [kitchenWebhookRef(other)]: { webhookSecret: 's'.repeat(32) },
      [kitchenWebhookRef(mine)]: { webhookSecret: 'short' },
    }) };
    // [confused deputy] another store's entries never resolve for this connection, whatever its row says
    expect(kitchenLoginFor(mine, env)).toBeNull();
    expect(kitchenWebhookSecretFor(mine, env), 'a short webhook secret is no secret').toBeNull();
    expect(kitchenLoginFor(other, env)).toEqual({ userName: 'u', password: 'p' });
    expect(kitchenWebhookSecretFor(other, env)).toBe('s'.repeat(32));
    expect(kitchenLoginFor({ id: '../x', provider: 'DRAGONTAIL' }, env), 'an id outside the shape names nothing').toBeNull();
    expect(kitchenLoginFor(other, {})).toBeNull();
    expect(kitchenLoginFor(other, { DRAGONTAIL_CREDENTIALS: 'not json' })).toBeNull();
    expect(JSON.stringify(kitchenSecretStatus(other, env))).not.toContain('"p"');
    expect(kitchenSecretStatus(other, env)).toMatchObject({ credentialsLoaded: true, login: true, webhookSecret: true });
  });

  it('carries only cash food orders, delivery only from a store that delivers itself', () => {
    const base = { orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', paymentMethod: 'CASH', vendorSelfDelivers: true };
    expect(kitchenEligibility(base)).toEqual({ ok: true });
    expect(kitchenEligibility({ ...base, fulfillment: 'PICKUP', vendorSelfDelivers: false })).toEqual({ ok: true });
    expect(kitchenEligibility({ ...base, paymentMethod: 'MOBILE_MONEY' }).ok).toBe(false);
    expect(kitchenEligibility({ ...base, vendorSelfDelivers: false }).ok).toBe(false);
    expect(kitchenEligibility({ ...base, orderType: 'GROCERY_DELIVERY' }).ok).toBe(false);
    expect(kitchenEligibility({ ...base, fulfillment: 'APPOINTMENT' }).ok).toBe(false);
  });
});

describe('[KITCHEN] Dragontail HTTP rules (spec: Authentication + Important notes)', () => {
  it('logs in with userName/password/userLevel and sends the token header on every other call', async () => {
    const c = client();
    await c.call('POST', '/PosInsertOrders', dragontailInsertBody(ORDER, SETTINGS, 'SW-1'));
    expect(mock.requests.map((r) => r.path)).toEqual(['/login', '/PosInsertOrders']);
    expect(mock.requests[0]!.body).toEqual({ userName: 'pos-42', password: 'pw-42', userLevel: -1 });
    expect(mock.requests[0]!.headers['token']).toBeUndefined();
    expect(mock.requests[1]!.headers['token']).toMatch(/^AE\d{10}$/);
    expect(mock.requests[1]!.headers['content-type']).toBe('application/json');
  });

  it('a timed-out token (403) re-logs in once and repeats the request', async () => {
    const c = client();
    await c.login();
    mock.expireTokens();
    const answer = await c.call('POST', '/PosInsertOrders', dragontailInsertBody(ORDER, SETTINGS, 'SW-1'));
    expect(answer.status).toBe(200);
    expect(mock.requests.map((r) => r.path)).toEqual(['/login', '/PosInsertOrders', '/login', '/PosInsertOrders']);
  });

  it('wrong credentials are final (no retry storm)', async () => {
    const c = client({ login: { userName: 'pos-42', password: 'wrong' } });
    await expect(c.login()).rejects.toBeInstanceOf(KitchenPermanentError);
    expect(mock.count('/login')).toBe(1);
  });

  it('retries a 50x up to 3 times with exponential backoff, then succeeds', async () => {
    const c = client();
    await c.login();
    mock.failNext('/PosInsertOrders', [500, 502, 503]);
    const answer = await c.call('POST', '/PosInsertOrders', dragontailInsertBody(ORDER, SETTINGS, 'SW-1'));
    expect(answer.status).toBe(200);
    expect(mock.count('/PosInsertOrders')).toBe(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it('a 4th 50x is a transient failure after exactly 1 + 3 attempts', async () => {
    const c = client();
    await c.login();
    mock.failNext('/PosInsertOrders', [500, 500, 500, 500]);
    await expect(c.call('POST', '/PosInsertOrders', {})).rejects.toBeInstanceOf(KitchenTransientError);
    expect(mock.count('/PosInsertOrders')).toBe(1 + DRAGONTAIL_MAX_RETRIES);
  });

  it('a request that outlives its timeout is retried and then fails as transient', async () => {
    const c = client({ timeoutMs: 100 });
    await c.login();
    mock.delayMs = 400;
    await expect(c.call('POST', '/PosInsertOrders', {})).rejects.toThrow(/timed out/);
  });

  it('the adapter treats a 200 that is not status "ok" as a refusal (the same order would be refused again)', async () => {
    const adapter = new DragontailAdapter({ baseUrl: mock.url, login: LOGIN, userLevel: -1, timeoutMs: 2_000, sleep: async () => {} }, SETTINGS, () => 'SW-1');
    mock.refuse('/PosInsertOrders', 200, { time: 'x', rowCount: 0, status: 'validationError' });
    await expect(adapter.insertOrder(ORDER)).rejects.toThrow(/validationError/);
  });

  it('the adapter reads updateStamp and promiseTimeSeconds from a successful insert', async () => {
    const adapter = new DragontailAdapter({ baseUrl: mock.url, login: LOGIN, userLevel: -1, timeoutMs: 2_000 }, SETTINGS, () => 'SW-1');
    mock.promiseTimeSeconds = 2070;
    const answer = await adapter.insertOrder(ORDER);
    expect(answer).toEqual({ ok: true, updateStamp: BigInt(mock.updateStamp), promiseSeconds: 2070 });
  });
});

describe('[KITCHEN] PosInsertOrders mapping, field by field (spec: Order, OrderItem, PosInsertOrders)', () => {
  it('a delivery: every required field, the customer for the driver, items in the spec position scheme', () => {
    const body = dragontailInsertBody(ORDER, SETTINGS, 'SW-261111-007ABC', 0, new Date('2026-11-11T16:20:19.000Z'));
    expect(body).toEqual({
      time: '2026-11-11 12:20:19',
      storeNo: 42,
      fullLoad: false,
      AltOrderId: 'SW-261111-007ABC',
      orders: [{
        storeNo: 42,
        orderId: 1_900_000_007,
        dailyNo: 7,
        orderTime: '2026-11-11 12:20:09',
        saleType: 2,
        isTimedOrder: 0,
        source: 2,
        paymentMethod: 0,
        cash: 4300,
        orderTotal: 4300,
        netSales: 3500,
        tips: 0,
        isNotPaid: 1,
        firstName: 'Ann',
        lastName: 'Test',
        phone: '+5926000000',
        street: '9 Test Street, Georgetown',
        lat: 6.81,
        lng: -58.16,
        carrierInstructions: 'Blue gate',
        cookInstructions: 'Pan Pizza XL: well done',
      }],
      ordersItems: [
        { StoreNo: 42, OrderId: 1_900_000_007, Position: '001', OrderStatus: 0, ItemsActions: 0, ItemNo: '8', Quantity: 1, Description: 'Pan Pizza XL', Side: 3 },
        { StoreNo: 42, OrderId: 1_900_000_007, Position: '001001', OrderStatus: 0, ItemsActions: 0, ItemNo: '121', Quantity: 1, Description: 'green pepper', Side: 0 },
        { StoreNo: 42, OrderId: 1_900_000_007, Position: '001002', OrderStatus: 0, ItemsActions: 0, ItemNo: '233', Quantity: 1, Description: 'black olives', Side: 0 },
        { StoreNo: 42, OrderId: 1_900_000_007, Position: '002', OrderStatus: 0, ItemsActions: 0, ItemNo: '23', Quantity: 2, Description: 'Pan Pizza L', Side: 3 },
      ],
      translations: [],
    });
  });

  it('every required field the spec names is present (the schema "required" lists of v1.1.0, copied)', () => {
    const body = dragontailInsertBody(ORDER, SETTINGS, 'SW-1') as unknown as Record<string, unknown>;
    const required = {
      request: ['time', 'storeNo', 'fullLoad', 'orders', 'ordersItems', 'translations'],
      order: ['storeNo', 'orderId', 'dailyNo', 'orderTime', 'saleType'],
      item: ['StoreNo', 'OrderId', 'Position', 'OrderStatus', 'ItemsActions', 'ItemNo', 'Quantity', 'Description', 'Side'],
    };
    for (const field of required.request) expect(body, field).toHaveProperty(field);
    for (const field of required.order) expect((body['orders'] as Array<Record<string, unknown>>)[0], field).toHaveProperty(field);
    for (const row of body['ordersItems'] as Array<Record<string, unknown>>) for (const field of required.item) expect(row, field).toHaveProperty(field);
  });

  it('a takeaway carries a first name only: no phone, no address, no location', () => {
    const pickup = dragontailInsertBody({ ...ORDER, saleType: 'TAKEAWAY' }, SETTINGS, 'SW-1');
    const row = pickup.orders[0]!;
    expect(row['saleType']).toBe(1);
    expect(row['firstName']).toBe('Ann');
    for (const personal of ['lastName', 'phone', 'street', 'lat', 'lng', 'carrierInstructions', 'email']) expect(row, personal).not.toHaveProperty(personal);
  });

  it('MMG maps to the configured "other" code; the source is the configured custom source', () => {
    const body = dragontailInsertBody({ ...ORDER, payment: 'MMG', cashToCollect: 0 }, { ...SETTINGS, mmgPaymentCode: 3, sourceId: 77 }, 'SW-1');
    expect(body.orders[0]).toMatchObject({ paymentMethod: 3, source: 77, cash: 0 });
  });

  it('a cancel re-sends every item as removed (ItemsActions 2), or as a refund ticket naming the order', () => {
    const removed = dragontailCancelBody(ORDER, SETTINGS, 'SW-1', 2_000_000_007);
    expect((removed.ordersItems as Array<Record<string, unknown>>).every((r) => r['ItemsActions'] === 2)).toBe(true);
    const refund = dragontailCancelBody(ORDER, { ...SETTINGS, cancelMode: 'REFUND_TICKET' }, 'SW-1', 2_000_000_007);
    expect(refund.orders[0]).toMatchObject({ orderId: 2_000_000_007, refundFor: '1900000007' });
    expect(refund.ordersItems).toEqual([]);
  });

  it('times are Guyana local (UTC-4) both ways', () => {
    expect(dragontailTime(new Date('2026-11-11T04:00:00.000Z'))).toBe('2026-11-11 00:00:00');
    expect(parseDragontailTime('2026-11-11 00:00:00')!.toISOString()).toBe('2026-11-11T04:00:00.000Z');
    expect(parseDragontailTime('0001-01-01 00:00:00')).toBeNull();
    expect(parseDragontailTime('garbage')).toBeNull();
  });
});

describe('[KITCHEN] notifications → Swift events (spec: Notification.action)', () => {
  const n = (action: string, extra: Record<string, unknown> = {}) => ({ storeNo: 42, orderId: 77, action, actionTime: '2016-04-19 13:08:19', deviceId: 'Pizza-KDS', ...extra });

  it('maps every action the spec lists; anything else is IGNORED, never a throw', () => {
    const body = { time: 'x', orders: ['ReachedTheMakeLine', 'Prepared', 'Cook', 'Pack', 'Dispatched', 'ETA', 'Delivered', 'Unassigned', 'Undelivered', 'PrintRequest', 'BackToStore', 'SomethingNew'].map((a) => n(a, a === 'ETA' ? { ETASeconds: 600 } : {})) };
    expect(dragontailEvents(body).map((e) => [e.action, e.kind])).toEqual([
      ['ReachedTheMakeLine', 'MAKE_LINE'], ['Prepared', 'PREPARED'], ['Cook', 'COOKED'], ['Pack', 'PACKED'],
      ['Dispatched', 'DISPATCHED'], ['ETA', 'ETA'], ['Delivered', 'DELIVERED'], ['Unassigned', 'UNASSIGNED'],
      ['Undelivered', 'UNDELIVERED'], ['PrintRequest', 'IGNORED'], ['BackToStore', 'IGNORED'], ['SomethingNew', 'IGNORED'],
    ]);
    expect(dragontailEvents(body)[5]!.etaSeconds).toBe(600);
    expect(dragontailEvents(body)[0]!.at!.toISOString()).toBe('2016-04-19T17:08:19.000Z');
  });

  it('a malformed body yields no events', () => {
    for (const bad of [null, 'x', 42, {}, { orders: 'x' }, { orders: [null, { action: 'Pack' }, { storeNo: 'a', orderId: 1, action: 'Pack' }] }]) {
      expect(dragontailEvents(bad)).toEqual([]);
    }
  });

  it('GetOrderUpdatesForPos timestamps become the kitchen steps they imply, in kitchen order', () => {
    const events = dragontailUpdateEvents({ orders: [{ storeNo: 42, orderId: 77, reachedTheMakeLineTime: '2026-11-11 12:00:00', preparationTime: '2026-11-11 12:05:00', packTime: '2026-11-11 12:15:00', dispatchTime: '', deliveryTime: '0001-01-01 00:00:00' }] });
    expect(events.map((e) => e.kind)).toEqual(['MAKE_LINE', 'PREPARED', 'PACKED']);
  });
});

describe('[KITCHEN] webhook proof (TODO-CONFIRM: the spec defines none, so each mode is a setting)', () => {
  const secret = 'w'.repeat(40);
  const raw = '{"time":"x","orders":[]}';
  const sig = kitchenWebhookSignature(secret, raw);

  it('shared: the header must equal the secret', () => {
    const s = { ...SETTINGS, webhookCheck: 'shared' as const };
    expect(kitchenWebhookAuthentic({ 'x-dragontail-shared': secret }, raw, secret, s)).toBe(true);
    expect(kitchenWebhookAuthentic({ 'x-dragontail-shared': 'nope' }, raw, secret, s)).toBe(false);
    expect(kitchenWebhookAuthentic({}, raw, secret, s)).toBe(false);
  });

  it('signature: HMAC-SHA256 of the exact raw body, hex (optionally "sha256=")', () => {
    const s = { ...SETTINGS, webhookCheck: 'signature' as const };
    expect(kitchenWebhookAuthentic({ 'x-dragontail-signature': sig }, raw, secret, s)).toBe(true);
    expect(kitchenWebhookAuthentic({ 'x-dragontail-signature': `sha256=${sig}` }, raw, secret, s)).toBe(true);
    expect(kitchenWebhookAuthentic({ 'x-dragontail-signature': sig }, `${raw} `, secret, s), 'a changed body fails').toBe(false);
    expect(kitchenWebhookAuthentic({ 'x-dragontail-shared': secret }, raw, secret, s), 'the shared header alone is not a signature').toBe(false);
  });

  it('both: each proof is required', () => {
    const s = { ...SETTINGS, webhookCheck: 'both' as const };
    expect(kitchenWebhookAuthentic({ 'x-dragontail-shared': secret, 'x-dragontail-signature': sig }, raw, secret, s)).toBe(true);
    expect(kitchenWebhookAuthentic({ 'x-dragontail-signature': sig }, raw, secret, s)).toBe(false);
    expect(kitchenWebhookAuthentic({ 'x-dragontail-shared': secret }, raw, secret, s)).toBe(false);
  });
});
