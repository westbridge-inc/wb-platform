/**
 * [KITCHEN-INTEGRATION] The provider-agnostic seam between Swift and a store's kitchen system.
 *
 * Swift speaks in KitchenOrder (what to cook and, for a delivery, where it goes) and hears KitchenEvent (what the
 * kitchen did). An adapter translates both ways for one system; Dragontail is the first (dragontail/). Nothing in
 * this file knows a provider's field names, so a second system is a new adapter, not a change here.
 */

/** One line the kitchen makes, or a choice on it (a child line). */
export interface KitchenLine {
  /** The kitchen-catalogue number (Item.externalItemNo / Option.externalItemNo). Required: an unmapped line stops
   *  the send before it starts (the store's tablet rings instead). */
  itemNo: string;
  name: string;
  quantity: number;
  /** Choices on this line (toppings, sizes), in the order the customer picked them. `name` is the order's own words
   *  ("Pepperoni (left half)", a follow-up under its opener), so the half reaches the cook in words whatever Side is
   *  sent. [MENU-OPTIONS · delta review S3-N2] `placement` (WHOLE / LEFT / RIGHT, null = not a topping placement) is
   *  carried for the adapter; the Dragontail mapper still sends every choice as Side 0 until Half1/Half2 is confirmed
   *  with the store's set-up (order/kitchen-modifiers.ts). */
  choices: Array<{ itemNo: string; name: string; placement?: 'WHOLE' | 'LEFT' | 'RIGHT' | null }>;
  /** The customer's note on this line (cook instruction). */
  note: string | null;
}

/** The order as a kitchen system needs it. Customer details only for a delivery (the store's own driver needs
 *  them); a pickup carries a first name at most. Money in major units (GYD), as Swift stores it. */
export interface KitchenOrder {
  /** Swift's order id (never sent; for logs and idempotency). */
  swiftOrderId: string;
  storeNo: number;
  externalOrderId: number;
  dailyNo: number;
  placedAt: Date;
  saleType: 'TAKEAWAY' | 'DELIVERY';
  payment: 'CASH' | 'MMG';
  /** What the customer pays in total. */
  orderTotal: number;
  /** The items (with their choices) before tax. */
  netSales: number;
  /** The customer's tip for the driver, prepaid only. Swift tips are paid with the order (cash at the door), so
   *  they are NOT prepaid: always 0 today. */
  prepaidTips: number;
  /** Cash the driver collects at the door (cash orders), else 0. */
  cashToCollect: number;
  isPaid: boolean;
  /** [review A S2-2 · owner ruling 12 Nov 2026] The first name only (never the last name). A delivery adds the
   *  customer's phone and the address/location for the store's own driver (a deliberate O-1 exception); a pickup
   *  carries none of them. */
  customer: {
    firstName: string | null;
    phone: string | null;
    address: string | null;
    lat: number | null;
    lng: number | null;
  };
  driverNote: string | null;
  cookNote: string | null;
  lines: KitchenLine[];
}

/** What a kitchen system reported, in Swift's words. */
export type KitchenEventKind =
  | 'MAKE_LINE' // the order reached the make line
  | 'PREPARED'
  | 'COOKED'
  | 'PACKED'
  | 'DISPATCHED' // handed to the store's own driver
  | 'ETA' // the driver's route estimate
  | 'DELIVERED'
  | 'UNASSIGNED' // taken off a driver
  | 'UNDELIVERED'
  | 'BACK_TO_STORE' // the driver is back at the store (a delivery not marked delivered is an operations matter)
  | 'SEEN' // the kitchen system knows the order (a GetOrderUpdatesForPos row): confirms an insert whose answer was lost
  | 'IGNORED'; // a print request, back-to-store, or an action Swift does not know

export interface KitchenEvent {
  storeNo: number;
  externalOrderId: number;
  kind: KitchenEventKind;
  /** The provider's own word for it, kept for the sync log. */
  action: string;
  at: Date | null;
  etaSeconds: number | null;
}

export interface KitchenInsertResult {
  ok: true;
  updateStamp: bigint | null;
  promiseSeconds: number | null;
}

/** A refusal the provider gave (validation, parse, a 4xx): retrying the same request will not help. */
export class KitchenPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KitchenPermanentError';
  }
}

/** A failure that might pass (5xx after the retries, a timeout, the network). */
export class KitchenTransientError extends Error {
  /** [review B S3-3] A write that timed out or lost its connection: the kitchen system may HAVE the order. */
  readonly mayHaveLanded: boolean;
  constructor(message: string, mayHaveLanded = false) {
    super(message);
    this.name = 'KitchenTransientError';
    this.mayHaveLanded = mayHaveLanded;
  }
}

export interface KitchenPollResult {
  events: KitchenEvent[];
  /** For providers with a resumable cursor (Dragontail GetOrderUpdatesForPos updateStamp); null = keep the cursor. */
  nextCursor: bigint | null;
}

export interface KitchenIntegrationProvider {
  readonly name: 'DRAGONTAIL';
  /** Log in only: proves the credentials and the address. */
  testConnection(): Promise<void>;
  /** Every request until the next call must finish by `at` (ms since epoch); null clears it. */
  setDeadline(at: number | null): void;
  insertOrder(order: KitchenOrder): Promise<KitchenInsertResult>;
  updateOrder(order: KitchenOrder): Promise<KitchenInsertResult>;
  cancelOrder(order: KitchenOrder): Promise<void>;
  /** Pending notifications, plus a catch-up from the cursor when the provider has one. */
  pollNotifications(storeNo: number, cursor: bigint): Promise<KitchenPollResult>;
  /** A webhook body, already authenticated by the route. Unknown shapes yield no events, never a throw. */
  parseWebhook(body: unknown): KitchenEvent[];
}
