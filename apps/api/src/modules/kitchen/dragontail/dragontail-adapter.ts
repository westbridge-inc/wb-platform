import {
  KitchenPermanentError,
  type KitchenEvent,
  type KitchenInsertResult,
  type KitchenIntegrationProvider,
  type KitchenOrder,
  type KitchenPollResult,
} from '../kitchen-provider';
import type { DragontailSettings } from '../kitchen-switch';
import { DragontailClient, type DragontailClientOptions } from './dragontail-client';
import {
  DRAGONTAIL_ITEMS_ACTION,
  dragontailCancelBody,
  dragontailEvents,
  dragontailInsertBody,
  dragontailUpdateEvents,
} from './dragontail-mapper';

/**
 * [KITCHEN-INTEGRATION] The Dragontail adapter: KitchenIntegrationProvider over the spec's endpoints.
 *
 *   insert / update / cancel → POST /PosInsertOrders ("Can handle inserting new orders, updating existing ones, or
 *                              canceling orders"); 200 with status "ok" is success, anything else is a refusal
 *   pollNotifications        → GET /GetPosNotification?storeNo= (recommended every 15 s) and, when Swift holds a
 *                              cursor, POST /GetOrderUpdatesForPos { storeNo, updateStamp } as the catch-up
 *   parseWebhook             → the PosNotification body ({ time, orders: Notification[] })
 */
export class DragontailAdapter implements KitchenIntegrationProvider {
  readonly name = 'DRAGONTAIL' as const;
  readonly client: DragontailClient;

  constructor(
    clientOptions: DragontailClientOptions,
    private readonly settings: DragontailSettings,
    /** Swift's order number per external order id, for AltOrderId. */
    private readonly orderNumberOf: (order: KitchenOrder) => string,
  ) {
    this.client = new DragontailClient(clientOptions);
  }

  async testConnection(): Promise<void> {
    await this.client.login();
  }

  private async postOrders(body: unknown, what: string): Promise<KitchenInsertResult> {
    const answer = await this.client.call('POST', '/PosInsertOrders', body);
    const json = (answer.json ?? {}) as { status?: unknown; updateStamp?: unknown; orders?: unknown; errDescription?: unknown };
    const status = typeof json.status === 'string' ? json.status : '';
    if (answer.status !== 200 || status.toLowerCase() !== 'ok') {
      // parseError / validationError / dbError / flowError …: the same request would be refused again.
      throw new KitchenPermanentError(`Dragontail refused the ${what} (HTTP ${answer.status}${status ? `, ${status.slice(0, 40)}` : ''})`);
    }
    const stamp = typeof json.updateStamp === 'number' && Number.isSafeInteger(json.updateStamp) && json.updateStamp >= 0
      ? BigInt(json.updateStamp) : null;
    const first = Array.isArray(json.orders) ? json.orders[0] as { promiseTimeSeconds?: unknown } | undefined : undefined;
    const promise = typeof first?.promiseTimeSeconds === 'number' && Number.isInteger(first.promiseTimeSeconds) && first.promiseTimeSeconds > 0
      ? first.promiseTimeSeconds : null;
    return { ok: true, updateStamp: stamp, promiseSeconds: promise };
  }

  insertOrder(order: KitchenOrder): Promise<KitchenInsertResult> {
    return this.postOrders(dragontailInsertBody(order, this.settings, this.orderNumberOf(order), DRAGONTAIL_ITEMS_ACTION.ADD), 'order');
  }

  updateOrder(order: KitchenOrder): Promise<KitchenInsertResult> {
    return this.postOrders(dragontailInsertBody(order, this.settings, this.orderNumberOf(order), DRAGONTAIL_ITEMS_ACTION.CHANGE), 'order update');
  }

  async cancelOrder(order: KitchenOrder): Promise<void> {
    // A refund ticket needs an id of its own in Swift's range: the order's id with the top of the range flipped
    // would collide, so it is the order's id offset by half the range (TODO-CONFIRM with REFUND_TICKET mode).
    const refundTicketId = order.externalOrderId + 100_000_000;
    await this.postOrders(dragontailCancelBody(order, this.settings, this.orderNumberOf(order), refundTicketId), 'cancellation');
  }

  async pollNotifications(storeNo: number, cursor: bigint): Promise<KitchenPollResult> {
    const pending = await this.client.call('GET', `/GetPosNotification?storeNo=${encodeURIComponent(String(storeNo))}`);
    // 404 "wrong storeNo, content not found" and 400 are answers, not outages: no events.
    const events: KitchenEvent[] = pending.status === 200 ? dragontailEvents(pending.json) : [];
    if (pending.status !== 200 && pending.status !== 404) {
      throw new KitchenPermanentError(`Dragontail GetPosNotification answered HTTP ${pending.status}`);
    }
    // The catch-up: everything since the last stamp Swift processed (0 = the current working day).
    const updates = await this.client.call('POST', '/GetOrderUpdatesForPos', { storeNo, updateStamp: Number(cursor) });
    let nextCursor: bigint | null = null;
    if (updates.status === 200) {
      events.push(...dragontailUpdateEvents(updates.json));
      const stamp = (updates.json as { updateStamp?: unknown } | null)?.updateStamp;
      if (typeof stamp === 'number' && Number.isSafeInteger(stamp) && stamp >= 0) nextCursor = BigInt(stamp);
    }
    return { events: events.filter((e) => e.storeNo === storeNo), nextCursor };
  }

  parseWebhook(body: unknown): KitchenEvent[] {
    return dragontailEvents(body);
  }
}
