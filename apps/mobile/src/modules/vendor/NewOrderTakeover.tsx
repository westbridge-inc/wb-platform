import React, { useEffect, useState } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { color, motion, radius, space } from '@swift/ui';
import { T, Money, PillButton } from '../../kit';
import { haptic } from '../../lib/haptics';
import { useVendorOrder, useOrderAction, usePickingActions, useVendorProfile } from '../../hooks/vendorops';
import { OUT_OF_STOCK_WORDS, canMarkOutOfStock, lastLineStanding, lineStockWords, nothingToAccept } from './storeOrderRules';
import { rejectReasonsFor } from './rejectReasons';
import { orderLineOptionsParts, orderLineOptionsText } from './orderLineOptions';
import { acceptClockLabel, takeoverSettled } from './acceptClock';
import { useJobRing } from '../../hooks/useJobRing';
import { RING_PERIOD_MS } from '../../services/jobRinger';
import { hasJobRing } from '../../services/jobRingCapability';
import { takeoverRingCopy } from './takeoverRingCopy';
import { ringMoney } from './ringMoney';
import { PrepTimeChips } from './PrepTimeChips';
import { acceptPrepMinutes, asksPrepTime } from './prepTime';
import { usePrepChoice } from './prepTimeMemory';

/** [ROUND 2 · REVIEW-B F1] The least the items list keeps on a short screen: about one line of an item. */
export const TAKEOVER_ITEMS_MIN_HEIGHT = 72;

/**
 * The NEW-ORDER takeover (alerts spec §A1 + design-100× Part 5 moment 2):
 * impossible to sleep through while the app is open, decidable from across a
 * kitchen. FULL-SCREEN on the paper surface — short-code in displayXl, items
 * at heading size, total in numL, one 64dp ACCEPT. The bell tile pulses in
 * time with the ring [RINGER]: Swift's tone (build 12) and a strong buzz,
 * every 2 s until the order is answered, settles or its accept clock runs
 * out. "View later" dismisses honestly — the server's escalation ladder
 * (re-alert → SMS) still stands behind it. Multiple orders stack, worked
 * first-in-first-out.
 */
export function NewOrderTakeover({
  queue,
  onDismiss,
}: {
  queue: Array<{ orderId: string; orderNumber?: string }>;
  onDismiss: (orderId: string) => void;
}) {
  const current = queue[0];
  const orderId = current?.orderId;
  const [rejecting, setRejecting] = useState(false);
  const [lastOut, setLastOut] = useState(false);
  // A fresh order in the queue starts at the decision, never mid-reject.
  useEffect(() => { setRejecting(false); setLastOut(false); }, [orderId]);
  // [Wave 3 vs reference 22 · #941] The draining accept clock. `respondBy`
  // is the SERVER's deadline — the exact arithmetic auto-cancel was enqueued
  // with — and it is null whenever the order is not PENDING, so the clock
  // draws only while the decision is really open. Recomputed from the wall
  // clock every tick (the DispatchOfferCard law): a backgrounded interval
  // that fires late lands on the true remainder, never a stale decrement.
  const [nowTs, setNowTs] = useState(() => Date.now());
  const order = useVendorOrder(orderId);
  // [STORE-WORDS sweep · REVIEW F3] The board's copy of an order (shown until the detail read answers) may not name its
  // store's kind on an older API: the store's own kind words it meanwhile.
  const storeKind = useVendorProfile().store?.vendorType;
  const act = useOrderAction();
  // [STORE-DASH · O-4] "Out of stock" right on the takeover: one tap asks the customer.
  const picking = usePickingActions();
  const insets = useSafeAreaInsets();
  const pulse = useSharedValue(1);

  // The bell pulses on the ring's beat, so the sound has a visual twin. The
  // ring itself (tone + buzz) is useJobRing below.
  useEffect(() => {
    if (!orderId) return;
    const beat = () => {
      // [design-100x Flow-13] The ring stays on its beat — a missed order is
      // money, and a kitchen bell is functional alerting. The VISUAL pulse
      // honours Reduce Motion (the screen stays still; the ring carries).
      pulse.value = withSequence(
        withTiming(1.12, { duration: motion.duration.fast, reduceMotion: ReduceMotion.System }),
        withTiming(1, { duration: motion.duration.base, reduceMotion: ReduceMotion.System }),
        withTiming(1.12, { duration: motion.duration.fast, reduceMotion: ReduceMotion.System }),
        withTiming(1, { duration: motion.duration.base, reduceMotion: ReduceMotion.System }),
      );
    };
    beat();
    const timer = setInterval(beat, RING_PERIOD_MS);
    return () => clearInterval(timer);
  }, [orderId, pulse]);

  const bellStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));

  // Clock arithmetic ahead of the early return — the tick hook below reads
  // it, and React hooks must run in the same order on every render.
  const o: any = order.data;
  const respondByMs = typeof o?.respondBy === 'string' ? Date.parse(o.respondBy) : Number.NaN;
  const createdMs = typeof o?.createdAt === 'string' ? Date.parse(o.createdAt) : Number.NaN;
  const clockActive = Number.isFinite(respondByMs) && respondByMs > nowTs;

  // Tick only while the clock is really open; flipping inactive cleans up.
  useEffect(() => {
    if (!clockActive) return;
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [clockActive]);

  // [Q12] The buzz is for a decision that is still open. An order that
  // stopped waiting — cancelled by the customer, answered on another device,
  // reaped by the no-response timer — leaves the queue by itself; the order
  // query refetches on the board socket's order:status_changed.
  const settled = takeoverSettled(o);
  useEffect(() => {
    if (orderId && settled) onDismiss(orderId);
  }, [orderId, settled, onDismiss]);

  // [RINGER · owner ruling 15 Oct] Ring until the order is answered (Accept,
  // Reject, or "View later" takes it off the takeover), settles elsewhere, or
  // its accept clock runs out; never in the background.
  const expired = Number.isFinite(respondByMs) && respondByMs <= nowTs;
  useJobRing(!!orderId && !settled && !expired);
  const [canRing] = useState(hasJobRing);
  // [APP-PREPTIME · owner 14 Nov 2026] The preparation time, as on the website's takeover: [ROUND 2] the store's own
  // declared time (the order's, stamped at checkout) or the closest choice is pre-selected (or a change staff made for
  // this store on this device), so ONE tap on Accept still accepts; a booking is never asked.
  // (Per store: the order's own store, known once the order is read; until then nothing is asked.)
  const [prepMinutes, choosePrep] = usePrepChoice(orderId, o?.vendorId, o?.estimatedPrepTime);

  if (!current) return null;
  const remainSecs = clockActive ? Math.max(0, Math.ceil((respondByMs - nowTs) / 1000)) : 0;
  // [E20] A booking's deadline can be a day away: past an hour the clock reads hours and minutes.
  const clockLabel = acceptClockLabel(remainSecs);
  const clockFrac = clockActive && Number.isFinite(createdMs) && respondByMs > createdMs
    ? Math.max(0, Math.min(1, (respondByMs - nowTs) / (respondByMs - createdMs)))
    : null;
  const items: any[] = o?.items ?? [];
  // [RING-FOOD] The store's goods money and whose the fee and tip are (ringMoney.ts, shared with the website).
  const ring = o ? ringMoney(o, storeKind) : null;
  const customer = o?.customer ? [o.customer.firstName, o.customer.lastName].filter(Boolean).join(' ') : '';
  const busy = act.isPending || picking.refundLine.isPending;
  // [O-4] Every item came off: nothing to accept, only Reject with a reason.
  const nothingLeft = nothingToAccept(o);

  const askPrep = asksPrepTime(o);
  const decide = (action: 'accept' | 'reject', reason?: string) => {
    const minutes = action === 'accept' ? acceptPrepMinutes(o, prepMinutes) : undefined;
    act.mutate(
      { id: current.orderId, action, ...(reason ? { reason } : {}), ...(minutes ? { prepMinutes: minutes } : {}) },
      { onSuccess: () => onDismiss(current.orderId) },
    );
  };

  return (
    <Modal
      visible
      animationType="fade"
      // Android hardware back is INERT here. Leaving this order is a decision —
      // Accept, Reject, or the explicit "View later" below — and a reflex press
      // must not be indistinguishable from one. The server's escalation ladder
      // still stands behind a dismissal either way; this is about the vendor
      // knowing which of the three they chose.
      onRequestClose={() => {}}
    >
      <View style={{ flex: 1, backgroundColor: color.surface.subtle, padding: space['2xl'], paddingTop: insets.top + space['2xl'], paddingBottom: insets.bottom + space.md }}>
        {/* [reference 22] The maroon bar at the very top edge IS the clock —
            it drains toward the server's deadline. Absent entirely when the
            server sent no respondBy (the honest state before #941 deploys,
            and for any non-PENDING order). */}
        {clockActive && clockFrac != null ? (
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel="Time left to accept this order"
            accessibilityValue={{ min: 0, max: 100, now: Math.round(clockFrac * 100), text: `${clockLabel} left to accept` }}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 4, backgroundColor: color.brand[50] }}
          >
            <View style={{ height: 4, width: `${clockFrac * 100}%`, backgroundColor: color.brand[500] }} />
          </View>
        ) : null}
        <View style={{ alignItems: 'center' }}>
          <Animated.View
            style={[
              {
                width: 72,
                height: 72,
                borderRadius: radius.lg,
                backgroundColor: color.brand[50],
                alignItems: 'center',
                justifyContent: 'center',
              },
              bellStyle,
            ]}
          >
            <Feather name="bell" size={34} color={color.brand[500]} />
          </Animated.View>
          {/* [Wave 3 vs reference 22] The eyebrow tells the vendor what the
              sound will DO, and [RINGER] only what this phone really does:
              the chime is build 12's ring tone; builds 9-11 only buzz. */}
          <T variant="micro" tone="brand" style={{ marginTop: space.lg }}>
            {takeoverRingCopy(queue.length, canRing)}
          </T>
          <T variant="displayXl" center style={{ marginTop: 2 }}>
            #{o?.orderNumber ?? current.orderNumber ?? '…'}
          </T>
          <T variant="heading" tone="muted" center style={{ marginTop: 2 }}>
            {/* [Wave 3 vs reference 22] The fulfillment says what happens
                NEXT, not just which kind it is — "a rider comes to you" is
                the sentence a kitchen acts on. */}
            {[
              customer || null,
              `${items.length} item${items.length === 1 ? '' : 's'}`,
              o?.fulfillment === 'PICKUP' ? 'pickup — the customer comes to you' : 'delivery — a rider comes to you',
            ]
              .filter(Boolean)
              .join(' · ')}
          </T>
        </View>

        {/* Items — glanceable from across a kitchen. [ROUND 2 · REVIEW-B F1] They keep a height of their own (about
            one line), so the decisions below can never squeeze them to nothing. */}
        <ScrollView style={{ flex: 1, minHeight: TAKEOVER_ITEMS_MIN_HEIGHT, marginTop: space.xl }} contentContainerStyle={{ gap: space.sm }}>
          {items.map((i) => (
            <View key={i.id} style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.md }}>
              <T variant="numM">{i.quantity}×</T>
              <View style={{ flex: 1 }}>
                <T variant="heading" numberOfLines={2}>
                  {i.name}
                </T>
                {/* [L09 · M026] What the customer chose, so the right item is made. [MENU-OPTIONS] One line per
                    group, a pizza's size, crust and halves each on its own line (orderLineOptions). */}
                {orderLineOptionsText(i.options) ? (
                  <T variant="label" weight="semibold" numberOfLines={8}>
                    {orderLineOptionsParts(i.options).join('\n')}
                  </T>
                ) : null}
              </View>
              {/* [Wave 3 vs reference 22] "pepper on the side" · "cold" — the
                  customer's own words, right-aligned and muted, exactly where
                  the kitchen's eye lands after the dish. The snapshot column
                  (OrderItem.specialInstructions) already rides the payload. */}
              {i.specialInstructions ? (
                <T variant="label" tone="muted" numberOfLines={2} style={{ maxWidth: '38%', textAlign: 'right' }}>
                  {i.specialInstructions}
                </T>
              ) : null}
              {/* [STORE-DASH · O-4] One tap per item: the customer is asked (continue without it, or cancel). */}
              {lastLineStanding(o, i) ? (
                // [REVIEW-F S3-2 on #2048] The last item: Reject (out of stock), asked once below.
                <PillButton
                  label={OUT_OF_STOCK_WORDS.lastButton}
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onPress={() => setLastOut(true)}
                />
              ) : canMarkOutOfStock(o, i) ? (
                <PillButton
                  label={OUT_OF_STOCK_WORDS.button}
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onPress={() => picking.refundLine.mutate({ orderId: current.orderId, lineId: i.id })}
                />
              ) : lineStockWords(i) ? (
                <T variant="caption" weight="semibold" style={{ maxWidth: '38%', textAlign: 'right', color: color.warning }}>
                  {lineStockWords(i)}
                </T>
              ) : null}
            </View>
          ))}
        </ScrollView>

        {/* [ROUND 2 · REVIEW-B F1] The money, the clock line and every decision scroll as one block when the screen is
            short (a 667dp phone, a landscape tablet, the reject reasons open): it takes its own height while it fits
            and scrolls when it does not, so Back and the reasons are always reachable. "View later" stays pinned. */}
        <ScrollView testID="takeover-decide" style={{ flexGrow: 0, flexShrink: 1 }}>
        {/* [RING-FOOD · owner 11 Nov 2026] The store's money for the goods, never the customer's whole total (that
            carries the rider's delivery fee and tip). One plain line says whose the fee and tip are. */}
        {ring?.food != null ? (
          <View style={{ paddingVertical: space.lg, borderTopWidth: 1, borderTopColor: color.border.subtle }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <T variant="bodyStrong">{ring.label}</T>
              <Money amount={ring.food} size="l" />
            </View>
            {ring.notes.map((line) => (
              <T key={line} variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                {line}
              </T>
            ))}
          </View>
        ) : null}

        {/* [reference 22] The sentence with the number — and the reason the
            number matters. Server clock, rendered verbatim. */}
        {clockActive ? (
          <T variant="caption" tone="muted" center style={{ marginBottom: space.md }}>
            Accept within <T variant="caption" weight="bold">{clockLabel}</T> — the customer is watching this clock too.
          </T>
        ) : null}
        <View style={{ gap: space.md }}>
          {lastOut ? (
            <>
              <T variant="label" weight="semibold" tone="error" center>
                {OUT_OF_STOCK_WORDS.lastAsk}
              </T>
              <PillButton label={OUT_OF_STOCK_WORDS.lastYes} variant="outline" disabled={busy} onPress={() => { setLastOut(false); decide('reject', OUT_OF_STOCK_WORDS.lastReason); }} />
              <PillButton label={OUT_OF_STOCK_WORDS.lastKeep} variant="soft" disabled={busy} onPress={() => setLastOut(false)} />
            </>
          ) : null}
          {nothingLeft ? (
            <T variant="label" weight="semibold" tone="error" center>
              {OUT_OF_STOCK_WORDS.nothing}
            </T>
          ) : rejecting ? null /* [#2511 ROUND 4 · REVIEW-DELTA S4-3] Accept steps aside while a reason is asked. */ : (
          <>
          {/* [ROUND 2 · REVIEW-A S3-1 · REVIEW-B F1] Not while a reason to reject is asked (this whole branch steps aside
              then, ROUND 4), nor while "reject the last item" is asked: no time is quoted then. */}
          {askPrep && !lastOut ? (
            <PrepTimeChips value={prepMinutes} onChange={choosePrep} vendorType={o?.vendor?.vendorType ?? storeKind} disabled={busy} />
          ) : null}
          <PillButton
            // [Wave 3 vs reference 22] "ACCEPT ORDER", sized to be read across
            // a kitchen — the reference sets it in caps and says the thing.
            label="ACCEPT ORDER"
            size="xl"
            loading={busy}
            onPress={() => {
              haptic.commit();
              decide('accept');
            }}
          />
          </>
          )}
          {/* [Wave 3 vs reference 22] "A rejection always collects a reason."
              The route records it and the customer is told why — so the button
              says what it asks, and the choice is presets, never free typing
              in a rush. */}
          {rejecting ? (
            <>
              {rejectReasonsFor(o?.fulfillment, o?.vendor?.vendorType ?? storeKind).map((why) => (
                <PillButton
                  key={why}
                  label={why}
                  variant="outline"
                  disabled={busy}
                  onPress={() => decide('reject', why)}
                />
              ))}
              <PillButton label="Back" variant="soft" disabled={busy} onPress={() => setRejecting(false)} />
            </>
          ) : (
            <PillButton label="Reject — tell us why" variant="soft" disabled={busy} onPress={() => setRejecting(true)} />
          )}
        </View>
        {act.isError ? (
          <T variant="caption" tone="error" center style={{ marginTop: space.sm }}>
            {(act.error as any)?.response?.data?.error?.message ?? 'That didn’t work — try again.'}
          </T>
        ) : null}
        </ScrollView>
        <T
          testID="takeover-view-later"
          variant="caption"
          tone="muted"
          center
          style={{ marginTop: space.md, marginBottom: space.lg, textDecorationLine: 'underline' }}
          onPress={() => onDismiss(current.orderId)}
        >
          View later — the order stays on your board
        </T>
      </View>
    </Modal>
  );
}
