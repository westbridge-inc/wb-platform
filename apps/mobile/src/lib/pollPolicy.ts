import { adaptivePollInterval, slowNetworkPollInterval } from './adaptivePolling';
import { vendorOrderFeedLive } from './vendorOrderFeed';
import { moverJobFeedLive } from './moverJobFeed';

/** Every fallback poll cadence that adapts to the network, in one place.
 *
 * Socket-pushed (server emit sites in apps/api): chat:message to chat:<room>;
 * order:new / order:status_changed / order:prep_update / order:pick_state to
 * vendor:<id>. Chat may slow while the socket is connected; the vendor order
 * queries only while a store feed the server admits is bound
 * (bindVendorOrderFeed): a held store shows orders with no feed, and the
 * server joins only the store owner to vendor:<id>, so staff and managers
 * keep the full cadence.
 *
 * The mover's active job: pushed only while the live job feed is bound
 * (lib/moverJobFeed joins each live job's order room; a status change or prep
 * signal re-reads it). [APP-SPEED 7] While that feed is bound and its socket
 * connected the poll is 30 s; otherwise (no live job, socket down) 12 s.
 *
 * Not pushed: stacked legs (a newly stacked leg is in no joined room) and
 * demand get no socket event; the job board is refreshed on offer events but
 * not on other board changes. So these keep their cadence while connected and
 * back off only on a slow network. Same for the vendor profile.
 *
 * Not pushed either: the customer's activity list. Order events go to the
 * order's own room, which only the order screen joins, so the live list
 * re-asks while it is on screen with something in progress (row 5). */
export const POLL = {
  chatMessages: () => adaptivePollInterval(4000, 15000),
  vendorOrders: () => (vendorOrderFeedLive() ? adaptivePollInterval : slowNetworkPollInterval)(12000, 30000),
  vendorOrder: () => (vendorOrderFeedLive() ? adaptivePollInterval : slowNetworkPollInterval)(15000, 30000),
  // [PERF partner #6] The store overview: 30 s, or 120 s while the store feed refreshes it on order events.
  vendorAnalytics: () => (vendorOrderFeedLive() ? adaptivePollInterval : slowNetworkPollInterval)(30000, 120000),
  vendorProfile: () => slowNetworkPollInterval(20000, 30000),
  moverDemand: () => slowNetworkPollInterval(20_000, 30000),
  moverAvailable: () => slowNetworkPollInterval(10000, 30000),
  moverActive: () => (moverJobFeedLive() ? 30000 : slowNetworkPollInterval(12000, 30000)),
  moverLegs: () => slowNetworkPollInterval(12000, 30000),
  customerLiveOrders: () => slowNetworkPollInterval(15000, 30000),
};
