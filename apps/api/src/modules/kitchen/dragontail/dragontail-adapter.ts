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
  dragontailFreeVehicles,
  dragontailInsertBody,
  dragontailUpdateEvents,
} from './dragontail-mapper';

/**
 * [KITCHEN-INTEGRATION] The Dragontail adapter: KitchenIntegrationProvider over the spec's endpoints.
 *
 *   insert / update / cancel → POST /PosInsertOrders ("Can handle inserting new orders, updating existing ones, or
 *                              canceling orders"); 200 with status "ok" is success, anything else is a refusal.
 *                              The login happens first, so a write that times out is known to be the write.
 *   pollNotifications        → POST /GetOrderUpdatesForPos { storeNo, updateStamp } (read-only catch-up), and
 *                              GET /GetPosNotification?storeNo=&id=<consumer> only when DRAGONTAIL_POLL_QUEUE=1
 *                              (it may be consume-on-read; the consumer id keeps Swift off the store POS's queue).
 *   parseWebhook             → the PosNotification body ({ time, orders: Notification[] })
 *   freeDriverCount          → GET /PosGetVehicles/{StoreNo} ("(Optional) Retrieve unassigned vehicles"), the
 *                              delivery overflow's driver check (kitchen-overflow.ts); read-only.
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

  setDeadline(at: number | null): void {
    this.client.setDeadline(at);
  }

  async testConnection(): Promise<void> {
    await this.client.login();
  }

  private async postOrders(body: unknown, what: string): Promise<KitchenInsertResult> {
    await this.client.ensureToken();
    const answer = await this.client.call('POST', '/PosInsertOrders', body, false);
    const json = (answer.json ?? {}) as { status?: unknown; updateStamp?: unknown; orders?: unknown };
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
    // REFUND_TICKET mode: the refund ticket needs an id of its own; the order's id + 100,000,000 (TODO-CONFIRM the
    // range with Dragontail before using that mode).
    const refundTicketId = order.externalOrderId + 100_000_000;
    await this.postOrders(dragontailCancelBody(order, this.settings, this.orderNumberOf(order), refundTicketId), 'cancellation');
  }

  async pollNotifications(storeNo: number, cursor: bigint): Promise<KitchenPollResult> {
    const events: KitchenEvent[] = [];
    if (this.settings.pollQueue) {
      const query = `storeNo=${encodeURIComponent(String(storeNo))}&id=${encodeURIComponent(this.settings.consumerId)}`;
      const pending = await this.client.call('GET', `/GetPosNotification?${query}`);
      // 404 "wrong storeNo, content not found" is an answer, not an outage: no events.
      if (pending.status === 200) events.push(...dragontailEvents(pending.json));
      else if (pending.status !== 404) throw new KitchenPermanentError(`Dragontail GetPosNotification answered HTTP ${pending.status}`);
    }
    // The catch-up: everything since the last stamp Swift processed (0 = the current working day).
    const updates = await this.client.call('POST', '/GetOrderUpdatesForPos', { storeNo, updateStamp: Number(cursor) }, true);
    let nextCursor: bigint | null = null;
    if (updates.status === 200) {
      const answer = (updates.json ?? {}) as { updateStamp?: unknown; loggedOut?: unknown };
      // The spec's answer can say the session is gone: the next call logs in afresh.
      if (answer.loggedOut === true) this.client.forgetToken();
      events.push(...dragontailUpdateEvents(updates.json));
      const stamp = answer.updateStamp;
      if (typeof stamp === 'number' && Number.isSafeInteger(stamp) && stamp >= 0) {
        // The answer carries everything since the cursor, so the cursor moves past all of it. A stamp BELOW the
        // cursor is a new working day ("within the current working day", TODO-CONFIRM 19): start over from it.
        nextCursor = BigInt(stamp);
      }
    }
    return { events: events.filter((e) => e.storeNo === storeNo), nextCursor };
  }

  parseWebhook(body: unknown): KitchenEvent[] {
    return dragontailEvents(body);
  }

  /** [DT-OVERFLOW] How many unassigned vehicles the store has, or null for an answer Swift cannot read. A non-200 (the
   *  endpoint is optional: a 404/405 means the store does not have it) is a refusal, which the caller treats as a
   *  failed check. */
  async freeDriverCount(storeNo: number): Promise<number | null> {
    const answer = await this.client.call('GET', `/PosGetVehicles/${encodeURIComponent(String(storeNo))}`);
    if (answer.status !== 200) throw new KitchenPermanentError(`Dragontail PosGetVehicles answered HTTP ${answer.status}`);
    return dragontailFreeVehicles(answer.json);
  }
}
