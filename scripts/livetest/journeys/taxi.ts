// Taxi journeys [TASK-057]: TAXI-01..06. A ride needs no ID (owner 24 Oct and
// 1 Nov 2026): the passenger C7 is an ordinary signed-in (L1) account, and a
// case that strikes an account books from a fresh one. Drivers are online
// through their real endpoints and keep fresh positions via the suite
// heartbeat. TAXI-06 is the ride with stops (TAXI_MAX_STOPS), and with
// TAXI_WAITING_CHARGE on, the waiting charge over a whole multi-stop trip.

import { OTP, BASE, ORIGIN, type Session } from '../client.js';
import type { Journey, Recorder } from '../journey.js';
import { GET, POST, PUT, req, sleep, brief, pick, waitFor, codeOf, waitForNotification, type Res } from './common.js';
import type { Ctx } from './context.js';
import { mover, onlineOf, setOnline, pollOffer, driverArrives, releaseDrivers, closeRide } from './dispatch.js';
import { registerFresh } from './auth.js';
import { ping } from '../provision.js';
import { twoPerson } from './admin-util.js';

const PICKUP = { lat: 6.8110, lng: -58.1530 };
const DROPOFF = { lat: 6.8250, lng: -58.1400 };
const rideBody = (extra: Record<string, unknown> = {}) => ({
  pickup: PICKUP, dropoff: DROPOFF, pickupAddress: 'TEST pickup, Camp Street', dropoffAddress: 'TEST dropoff, Vlissengen Road', passengerCount: 1, rideClass: 'ECONOMY', ...extra,
});
const drivers = (ctx: Ctx) => onlineOf(ctx, 'driver');

/** C7 (or a fresh passenger) requests a ride; returns its id and PIN. */
async function requestRide(rec: Recorder, ctx: Ctx, passenger: Session, label: string): Promise<{ id: string; pin: string } | null> {
  const r = await POST('/rides/request', rideBody(), passenger.token);
  if (!rec.expect(`${label}: ride request`, r, 201, undefined, `status=${r.json?.data?.ride?.status}`)) return null;
  const ride = r.json?.data?.ride;
  return { id: ride.id, pin: String(ride.ridePin ?? '') };
}

/** A driver takes the ride through its offer. */
async function driverTakes(rec: Recorder, ctx: Ctx, rideId: string, label: string, exclude: string[] = []): Promise<string | null> {
  const got = await pollOffer(ctx, rideId, drivers(ctx).filter((id) => !exclude.includes(id)), 45_000);
  if (!rec.check(`${label}: a driver is offered the ride`, !!got, got ? `${got.moverId}` : 'no offer in 45 s')) return null;
  const d = mover(ctx, got!.moverId);
  const acc = await POST('/driver/offers/accept', { orderId: rideId, offerAttemptId: got!.offer.offerAttemptId }, d.session.token);
  if (!rec.expect(`${label}: ${got!.moverId} accepts`, acc, 200)) return null;
  return got!.moverId;
}

async function cancelRide(passenger: Session, rideId: string) {
  await POST(`/rides/${rideId}/cancel`, { reason: 'journey cleanup' }, passenger.token);
}

async function activeRide(passenger: Session): Promise<any> {
  return (await GET('/rides/active', passenger.token)).json?.data ?? null;
}

/** A fresh passenger for a case that strikes the account (no-show / refusal),
 *  so C7 never collects the strike. [Owner 24 Oct + 1 Nov 2026] An account
 *  books a ride as it signs up: no ID, no identity review (the server keeps no
 *  customer ID and answers 410 CUSTOMER_ID_NOT_NEEDED to one). Null when the
 *  target would not register one. */
async function freshPassenger(rec: Recorder, ctx: Ctx, slot: string): Promise<Session | null> {
  const acct = await registerFresh(ctx, slot);
  rec.check(`${slot}: a fresh passenger signs up (no ID asked)`, !!acct, acct ? 'registered' : 'registration refused');
  return acct?.session ?? null;
}

export const TAXI_01: Journey<Ctx> = {
  id: 'TAXI-01',
  estimateSeconds: 330,
  title: 'Ride request + queue (mobile only)',
  cases: 'passenger request; a second account requests too (no ID asked, owner 24 Oct 2026); no-supply queue; auto-request recovery',
  async run(rec, ctx) {
    const C7 = ctx.roster.customers.C7!.session;
    rec.require('a passenger was provisioned', !ctx.world.notReady.C7, ctx.world.notReady.C7 ?? '');
    // [Owner ruling 24 Oct 2026] A ride needs no ID on file: an L1 account books like any other. Its ride is
    // withdrawn at once so the passenger's cases below meet a clean board.
    const C1 = ctx.roster.customers.C1!.session;
    const l1 = await POST('/rides/request', rideBody(), C1.token);
    rec.expect('an L1 account (no ID on file) requests a ride — no ID asked', l1, 201, undefined, `code=${l1.json?.error?.code ?? ''}`);
    if (l1.json?.data?.ride?.id) await cancelRide(C1, l1.json.data.ride.id);
    const est = await POST('/rides/estimate', { pickup: PICKUP, dropoff: DROPOFF }, C7.token);
    const eco = (est.json?.data?.tiers ?? []).find((t: any) => t.rideClass === 'ECONOMY');
    rec.check('the estimate prices an economy ride', est.ok && Number(eco?.fare) > 0, `→ ${brief(est)} economy=${eco?.fare} ${est.json?.data?.currencyCode ?? ''}`);

    // the passenger's request with drivers online
    const ride = await requestRide(rec, ctx, C7, 'passenger request');
    if (ride) {
      rec.check('the passenger holds a 6-digit ride PIN', /^\d{6}$/.test(ride.pin), `pin ${ride.pin ? 'present' : 'missing'}`);
      rec.deny('a second ride while one is live', await POST('/rides/request', rideBody(), C7.token), [409], ['RIDE_IN_PROGRESS']);
      await cancelRide(C7, ride.id);
    }

    // no supply: every driver offline, the passenger queues
    const online = drivers(ctx);
    for (const id of online) await setOnline(ctx, id, false);
    try {
      const avail = await GET(`/rides/availability?lat=${PICKUP.lat}&lng=${PICKUP.lng}`, C7.token);
      rec.check('availability reads NONE with no driver online', avail.json?.data?.level === 'NONE', `level=${avail.json?.data?.level}`);
      const join = await POST('/rides/queue/join', rideBody(), C7.token);
      rec.expect('the passenger joins the no-supply queue', join, 201, undefined, `position=${join.json?.data?.position}`);
      const q = await GET('/rides/queue', C7.token);
      rec.check('the queue entry is readable', !!q.json?.data?.id, `→ ${brief(q)}`);

      // recovery: a driver comes back near the pickup; the scan (every 2 min) turns the entry into a ride
      const back = online[0]!;
      const d = mover(ctx, back);
      ctx.stash.heartbeatOverrides[back] = PICKUP;
      await setOnline(ctx, back, true);
      await PUT('/driver/location', { latitude: PICKUP.lat, longitude: PICKUP.lng, accuracy: 5 }, d.session.token);
      const matched = await waitFor(async () => {
        const qq = await GET('/rides/queue', C7.token);
        const a = await activeRide(C7);
        return !qq.json?.data && a ? a : null;
      }, 200_000, 5_000);
      rec.check('the queued request becomes a ride once supply returns (auto-request)', !!matched, matched ? `ride ${matched.id} status=${matched.status}` : 'still queued after 200 s');
      const note = await GET('/customer/notifications', C7.token);
      rec.check('the passenger is told the queue matched', JSON.stringify(note.json?.data ?? []).includes('ride_queue_matched'), '');
      if (matched) await cancelRide(C7, matched.id);
    } finally {
      await POST('/rides/queue/leave', {}, C7.token);
      for (const id of online) {
        ctx.stash.heartbeatOverrides[id] = undefined;
        await setOnline(ctx, id, true);
      }
    }
  },
};

export const TAXI_02: Journey<Ctx> = {
  id: 'TAXI-02',
  estimateSeconds: 150,
  title: 'Driver accept → en-route → arrived (H-4)',
  cases: 'accept; en-route; arrived (E19: refused from afar, taken at the pickup, or on the passenger’s word); cancellation/re-dispatch',
  async run(rec, ctx) {
    const C7 = ctx.roster.customers.C7!.session;
    rec.require('two drivers online', drivers(ctx).length >= 2, drivers(ctx).join(','));
    const ride = await requestRide(rec, ctx, C7, 'ride');
    rec.require('a ride to drive', !!ride, '');
    const moved: string[] = [];
    try {
      const d1 = await driverTakes(rec, ctx, ride!.id, 'first driver');
      rec.require('a driver accepted', !!d1, '');
      const D1 = mover(ctx, d1!);
      const a1 = await activeRide(C7);
      rec.check('the passenger sees the assignment and the driver', a1?.status === 'DRIVER_ASSIGNED' && !!a1?.driver, `status=${a1?.status}`);
      const other = drivers(ctx).find((id) => id !== d1)!;
      rec.deny('another driver cannot move this ride', await PUT(`/driver/rides/${ride!.id}/en-route`, {}, mover(ctx, other).session.token), [403, 404, 409]);
      rec.deny('the passenger cannot drive the ride', await PUT(`/driver/rides/${ride!.id}/en-route`, {}, C7.token), [403, 404]);
      rec.expect('en-route', await PUT(`/driver/rides/${ride!.id}/en-route`, {}, D1.session.token), 200);
      // [E19] The heartbeat's fix is fresh but it is the roster home, ~3.4 km out: the claim is refused.
      const far = await PUT(`/driver/rides/${ride!.id}/arrived`, {}, D1.session.token);
      rec.deny('arrived while the car is ~3 km from the pickup (E19)', far, [409], ['ARRIVAL_NOT_VERIFIED'], `verdict=${far.json?.error?.details?.verdict} distanceM=${far.json?.error?.details?.distanceM}`);
      moved.push(d1!);
      rec.expect('arrived at the pickup', await driverArrives(ctx, d1!, ride!.id, PICKUP), 200);
      const a2 = await activeRide(C7);
      rec.check('the passenger sees DRIVER_ARRIVED', a2?.status === 'DRIVER_ARRIVED', `status=${a2?.status}`);

      // cancellation by the driver before pickup: back to PENDING, a new PIN, re-dispatched
      rec.deny('a cancel reason that is too short', await POST(`/driver/rides/${ride!.id}/cancel`, { reason: 'x' }, D1.session.token), [400], ['VALIDATION_ERROR']);
      const cx = await POST(`/driver/rides/${ride!.id}/cancel`, { reason: 'vehicle problem before pickup' }, D1.session.token);
      rec.expect('the driver cancels before pickup', cx, 200, undefined, `status=${cx.json?.data?.status} reDispatched=${cx.json?.data?.reDispatched}`);
      const a3 = await activeRide(C7);
      rec.check('the ride is PENDING again with a new PIN', a3?.status === 'PENDING' && String(a3?.ridePin) !== ride!.pin, `status=${a3?.status} pinChanged=${String(a3?.ridePin) !== ride!.pin}`);
      const d2 = await driverTakes(rec, ctx, ride!.id, 're-dispatch', [d1!]);
      rec.check('a different driver takes the re-dispatched ride', !!d2 && d2 !== d1, `first=${d1} second=${d2}`);

      // [E19] The escape when the GPS will not say so: the passenger, who can see the car, confirms it.
      if (d2) {
        rec.expect('the second driver is en route', await PUT(`/driver/rides/${ride!.id}/en-route`, {}, mover(ctx, d2).session.token), 200);
        rec.deny('another customer cannot confirm this driver’s arrival', await POST(`/rides/${ride!.id}/confirm-driver-arrival`, {}, ctx.roster.customers.C1!.session.token), [409], ['INVALID_STATUS']);
        const own = await POST(`/rides/${ride!.id}/confirm-driver-arrival`, {}, C7.token);
        rec.expect('the passenger confirms “My driver is here” (E19 override)', own, 200, undefined, `status=${own.json?.data?.status}`);
        const a4 = await activeRide(C7);
        rec.check('the ride reads DRIVER_ARRIVED on the passenger’s word', a4?.status === 'DRIVER_ARRIVED', `status=${a4?.status}`);
      }
      await cancelRide(C7, ride!.id);
    } finally {
      const left = await closeRide(ctx, C7, ride!.id, DROPOFF);
      if (left) ctx.log(`    TAXI-02 left live: ${left}`);
      releaseDrivers(ctx, moved);
    }
  },
};

export const TAXI_03: Journey<Ctx> = {
  id: 'TAXI-03',
  estimateSeconds: 150,
  title: 'PIN verify → start → complete',
  cases: 'PIN verify/start/complete; wrong PIN lockout; concurrent completion',
  async run(rec, ctx) {
    const C7 = ctx.roster.customers.C7!.session;
    const ride = await requestRide(rec, ctx, C7, 'ride');
    rec.require('a ride', !!ride, '');
    const made = [ride!.id];
    const moved: string[] = [];
    try {
      const did = await driverTakes(rec, ctx, ride!.id, 'driver');
      rec.require('a driver', !!did, '');
      const D = mover(ctx, did!);
      await PUT(`/driver/rides/${ride!.id}/en-route`, {}, D.session.token);
      rec.deny('PIN before arrival', await PUT(`/driver/rides/${ride!.id}/verify-pin`, { pin: ride!.pin }, D.session.token), [400], ['INVALID_STATUS']);
      moved.push(did!);
      rec.expect('the driver arrives at the pickup', await driverArrives(ctx, did!, ride!.id, PICKUP), 200);
      rec.deny('start before the PIN', await PUT(`/driver/rides/${ride!.id}/start`, {}, D.session.token), [400], ['PIN_REQUIRED']);
      rec.deny('a malformed PIN (not counted)', await PUT(`/driver/rides/${ride!.id}/verify-pin`, { pin: '12ab' }, D.session.token), [400], ['VALIDATION_ERROR']);
      const wrong = String((Number(ride!.pin) + 1) % 1_000_000).padStart(6, '0');
      rec.deny('a wrong PIN', await PUT(`/driver/rides/${ride!.id}/verify-pin`, { pin: wrong }, D.session.token), [400], ['INVALID_PIN']);
      rec.expect('the passenger’s PIN verifies', await PUT(`/driver/rides/${ride!.id}/verify-pin`, { pin: ride!.pin }, D.session.token), 200);
      rec.expect('the ride starts', await PUT(`/driver/rides/${ride!.id}/start`, {}, D.session.token), 200);
      rec.check('the passenger sees RIDE_IN_PROGRESS', (await activeRide(C7))?.status === 'RIDE_IN_PROGRESS', '');
      rec.deny('cash rides cannot use the card completion path', await PUT(`/driver/rides/${ride!.id}/complete`, {}, D.session.token), [409], ['PAYMENT_NOT_CAPTURED']);

      // concurrent completion: two handovers at once, one outcome
      const gps = { lat: DROPOFF.lat, lng: DROPOFF.lng };
      const [h1, h2] = await Promise.all([
        POST(`/driver/rides/${ride!.id}/handover`, { outcome: 'paid', gps }, D.session.token),
        POST(`/driver/rides/${ride!.id}/handover`, { outcome: 'paid', gps }, D.session.token),
      ]);
      const oks = [h1!, h2!].filter((r) => r.ok && !r.json?.replayed).length;
      rec.check('two concurrent completions settle once', oks === 1 && [h1!, h2!].every((r) => r.ok || [409].includes(r.status)),
        `→ ${brief(h1!)}${h1!.json?.replayed ? ' (replayed)' : ''}, ${brief(h2!)}${h2!.json?.replayed ? ' (replayed)' : ''}`);
      const ridden = await GET(`/rides/${ride!.id}`, C7.token);
      rec.check('the ride reads DELIVERED (cash captured)', ridden.json?.data?.status === 'DELIVERED' && ridden.json?.data?.paymentStatus === 'CAPTURED', `status=${ridden.json?.data?.status} payment=${ridden.json?.data?.paymentStatus}`);
      const earn = await GET('/driver/earnings/today', D.session.token);
      rec.check('the fare is in the driver’s earnings', earn.ok, `→ ${brief(earn)}`);

      // lockout: five wrong PINs, then even the right one is refused
      const r2 = await requestRide(rec, ctx, C7, 'lockout ride');
      rec.require('a second ride', !!r2, '');
      made.push(r2!.id);
      const d2 = await driverTakes(rec, ctx, r2!.id, 'lockout driver');
      rec.require('a driver for the lockout ride', !!d2, '');
      const D2 = mover(ctx, d2!);
      await PUT(`/driver/rides/${r2!.id}/en-route`, {}, D2.session.token);
      moved.push(d2!);
      rec.expect('the lockout driver arrives at the pickup', await driverArrives(ctx, d2!, r2!.id, PICKUP), 200);
      const bad = String((Number(r2!.pin) + 3) % 1_000_000).padStart(6, '0');
      const tries: string[] = [];
      for (let i = 0; i < 5; i += 1) tries.push(brief(await PUT(`/driver/rides/${r2!.id}/verify-pin`, { pin: bad }, D2.session.token)));
      rec.check('wrong PINs are each refused', tries.every((t) => t.startsWith('400')), tries.join(', '));
      rec.deny('after the lockout the right PIN is refused', await PUT(`/driver/rides/${r2!.id}/verify-pin`, { pin: r2!.pin }, D2.session.token), [400], ['MAX_ATTEMPTS']);
      rec.deny('the locked ride cannot start', await PUT(`/driver/rides/${r2!.id}/start`, {}, D2.session.token), [400], ['PIN_REQUIRED']);
      await POST(`/driver/rides/${r2!.id}/cancel`, { reason: 'PIN locked, passenger not verified' }, D2.session.token);
      await cancelRide(C7, r2!.id);
      rec.deviceCase('PIN shown on one phone, typed on another', 'the two-phone PIN exchange is the device gate');
    } finally {
      for (const id of made) {
        const left = await closeRide(ctx, C7, id, DROPOFF);
        if (left) ctx.log(`    TAXI-03 left live: ${left}`);
      }
      releaseDrivers(ctx, moved);
    }
  },
};

export const TAXI_04: Journey<Ctx> = {
  id: 'TAXI-04',
  estimateSeconds: 180,
  title: 'Cash outcome / no-show claim',
  cases: 'paid/no-show outcome; missing-GPS denial; admin claim settlement',
  async run(rec, ctx) {
    const passenger = await freshPassenger(rec, ctx, 'taxi04-noshow');
    rec.require('a fresh passenger (a no-show strikes the account)', !!passenger, '');
    const ride = await requestRide(rec, ctx, passenger!, 'ride');
    rec.require('a ride', !!ride, '');
    const moved: string[] = [];
    try {
      const did = await driverTakes(rec, ctx, ride!.id, 'driver');
      rec.require('a driver', !!did, '');
      const D = mover(ctx, did!);
      await PUT(`/driver/rides/${ride!.id}/en-route`, {}, D.session.token);
      moved.push(did!);
      rec.expect('the driver arrives at the pickup', await driverArrives(ctx, did!, ride!.id, PICKUP), 200);
      await PUT(`/driver/rides/${ride!.id}/verify-pin`, { pin: ride!.pin }, D.session.token);
      rec.expect('the ride starts', await PUT(`/driver/rides/${ride!.id}/start`, {}, D.session.token), 200);
      rec.deny('an outcome without GPS proof', await POST(`/driver/rides/${ride!.id}/handover`, { outcome: 'no_show' }, D.session.token), [400], ['VALIDATION_ERROR']);
      rec.deny('an unknown outcome', await POST(`/driver/rides/${ride!.id}/handover`, { outcome: 'vanished', gps: DROPOFF }, D.session.token), [400], ['VALIDATION_ERROR']);
      const ns = await POST(`/driver/rides/${ride!.id}/handover`, { outcome: 'no_show', gps: DROPOFF }, D.session.token);
      const claim = ns.json?.data?.claim;
      rec.expect('the driver records a no-show outcome', ns, 200, undefined, `status=${ns.json?.data?.status} claim=${claim?.id ? `${claim.status} ${claim.amount}` : 'none'}`);
      const r = await GET(`/rides/${ride!.id}`, passenger!.token);
      rec.check('the ride ends FAILED', r.json?.data?.status === 'FAILED', `status=${r.json?.data?.status}`);
      const mine = await GET('/driver/claims', D.session.token);
      rec.check('the driver’s claim is on record', JSON.stringify(mine.json?.data ?? null).includes(ride!.id), `→ ${brief(mine)}`);
      rec.deny('a driver cannot read the admin claim queue', await GET('/admin/cash-rules/claims', D.session.token), [403]);
      // Every case waits for a person in PENDING_REVIEW; a row the old rule approved automatically waits too.
      const wanted = String(claim?.status ?? 'PENDING_REVIEW');
      let queue = await GET(`/admin/cash-rules/claims?status=${encodeURIComponent(wanted)}`, ctx.admin.token);
      let row = (queue.json?.data ?? []).find((c: any) => c.orderId === ride!.id || c.id === claim?.id);
      if (!row) {
        queue = await GET('/admin/cash-rules/claims', ctx.admin.token);
        row = (queue.json?.data ?? []).find((c: any) => c.orderId === ride!.id || c.id === claim?.id);
      }
      const listed: any[] = queue.json?.data ?? [];
      rec.check('the driver’s case is in the operator ledger, waiting for a person', !!row && ['AUTO_APPROVED', 'PENDING_REVIEW', 'APPROVED'].includes(String(row.status)),
        `claim ${claim?.id ?? '?'} status=${claim?.status ?? '?'}; GET /admin/cash-rules/claims${row ? '' : `?status=${wanted} then unfiltered`} → ${brief(queue)} lists ${listed.length} claim(s) (total ${queue.json?.meta?.total ?? '?'}): ${listed.map((c) => `${c.id}${c.driverId ? ' driver' : c.riderId ? ' rider' : ''}`).join(', ') || 'none'}${row ? '' : ' — the driver claim is absent'}`);
      if (row) {
        let settled = String(row.status) === 'APPROVED';
        if (!settled) {
          const settle = await twoPerson(rec, ctx, 'approve the synthetic no-show claim', 'PUT', `/admin/cash-rules/claims/${row.id}/approve`, { reason: 'synthetic no-show verified by the journey runner' });
          settled = settle.done;
        }
        if (settled) {
          // [P31-1] A claim is paid from the funded GY loss-protection reserve
          // or not at all. The journey reads the line, provisions exactly the
          // shortfall the payout will draw (repeated runs never grow it), pays,
          // then asserts the line is back where it found it and both ledger
          // entries are on the statement.
          const payout = Number(row.amount);
          const line = await GET('/admin/cash-rules/rlp/reserve?country=GY', ctx.admin.token);
          if (!rec.expect('the GY loss-protection reserve is readable', line, 200, undefined, `balance=${line.json?.data?.balance}`)) return;
          const before = Number(line.json?.data?.balance);
          const topUp = Math.max(0, Math.round((payout - before) * 100) / 100);
          let provisionedId: string | null = null;
          if (topUp > 0) {
            // The product rule stays observable: with the line unfunded the
            // SAME payout is refused, and that refused attempt spends its
            // approval (a burnt approval is the safe direction), so the real
            // payout below asks again.
            const dry = await twoPerson(rec, ctx, 'try to pay the synthetic claim from the unfunded reserve (refused)', 'PUT', `/admin/cash-rules/claims/${row.id}/paid`,
              { reference: `SYN-T04-DRY-${ctx.runId}`.slice(0, 40), amount: row.amount }, [409]);
            if (dry.final) {
              rec.deny('a payout over an unfunded reserve is refused (RLP_RESERVE_UNFUNDED)', dry.final, [409], ['RLP_RESERVE_UNFUNDED'], `balance=${before} payout=${payout}`);
            }
            const prov = await twoPerson(rec, ctx, 'provision the GY reserve for the synthetic claim payout', 'POST', '/admin/cash-rules/rlp/reserve/adjust',
              { countryCode: 'GY', amount: topUp, note: `livetest TAXI-04 fixture: provision the synthetic claim's payout (${ctx.runId})` }, [200, 201], { leaveFirstToCaller: true });
            // The adjust route is C4 money (admin-authority.ts): held for a second
            // admin. Should that policy ever change, a first answer of 200/201 is
            // the entry itself, never a refusal.
            const appliedAtOnce = !prov.approvalId && (prov.first.status === 200 || prov.first.status === 201);
            if (!prov.done && !appliedAtOnce) {
              // Held but never applied: twoPerson already recorded the target's
              // refusal (e.g. no second admin). Refused at the ask: the journey
              // cannot provision here, and must say so — never pass it over.
              if (!prov.approvalId) {
                rec.skipCase('provision the GY reserve for the synthetic claim payout', `the adjust route refused the ask: ${brief(prov.first)}`);
              }
              return;
            }
            provisionedId = (appliedAtOnce ? prov.first : prov.final)?.json?.data?.id ?? null;
          } else {
            rec.skipCase('a payout over an unfunded reserve is refused', `the GY reserve already holds ${before} against the ${payout} payout, so the unfunded refusal cannot be shown here`);
          }
          const paid = await twoPerson(rec, ctx, 'mark the synthetic claim paid', 'PUT', `/admin/cash-rules/claims/${row.id}/paid`, { reference: `SYN-T04-${ctx.runId}`.slice(0, 40), amount: row.amount });
          if (paid.done) {
            const after = await GET('/admin/cash-rules/claims?status=PAID', ctx.admin.token);
            rec.check('the claim reads PAID', JSON.stringify(after.json?.data ?? []).includes(row.id), '');
            const stmt = await GET('/admin/cash-rules/rlp/reserve?country=GY', ctx.admin.token);
            const balanceAfter = Number(stmt.json?.data?.balance);
            const entries: any[] = stmt.json?.data?.entries ?? [];
            // The exact ledger arithmetic, whatever the line held before: it moved
            // by the provision minus the payout (from 0 on a fresh target, so
            // back to 0; a partly funded line ends at 0 too; a fully funded one
            // falls by exactly the payout).
            rec.check('the reserve moved by exactly the provision minus the payout', Math.abs(balanceAfter - (before + topUp - payout)) < 0.005,
              `balance=${balanceAfter} (was ${before}; provisioned ${topUp}, payout ${payout})`);
            if (topUp > 0) {
              rec.check('the provision entry is on the reserve statement', entries.some((e) => e.id === provisionedId && e.kind === 'ADJUSTMENT'), `entry=${provisionedId}`);
            }
            rec.check('the payout entry is on the reserve statement', entries.some((e) => e.kind === 'PAYOUT' && e.claimId === row.id), '');
          }
        }
      }
    } finally {
      const left = await closeRide(ctx, passenger!, ride!.id, DROPOFF);
      if (left) ctx.log(`    TAXI-04 left live: ${left}`);
      releaseDrivers(ctx, moved);
    }
    void sleep; void pick; void codeOf; void req;
  },
};

export const TAXI_05: Journey<Ctx> = {
  id: 'TAXI-05',
  estimateSeconds: 45,
  title: 'Web taxi booking disabled',
  cases: 'web booking denial; mobile taxi remains reachable',
  async run(rec, ctx) {
    const C7 = ctx.roster.customers.C7!;
    const origin = (process.env.LIVETEST_WEB_ORIGIN ?? '').trim();
    if (origin) {
      // A browser session: cookies from verify-otp with the web client header and an allowed Origin.
      const v = await fetch(`${BASE}/auth/verify-otp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-swift-client': 'web', origin },
        body: JSON.stringify({ phone: C7.phone, code: OTP }),
      });
      const cookies = (v.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
      rec.check('a browser sign-in yields an HttpOnly session cookie', v.ok && /swift_at=/.test(cookies), `→ ${v.status}, cookies: ${cookies.replace(/=[^;]+/g, '=…') || 'none'}`);
      const webReq = await fetch(`${BASE}/rides/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-swift-client': 'web', origin, cookie: cookies },
        body: JSON.stringify(rideBody()),
      });
      const body = await webReq.json().catch(() => null) as any;
      rec.deny('a web (cookie) session cannot book a taxi', { status: webReq.status, ok: webReq.ok, json: body, text: JSON.stringify(body) }, [403], ['TAXI_MOBILE_APP_REQUIRED']);
      const webQ = await fetch(`${BASE}/rides/queue/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-swift-client': 'web', origin, cookie: cookies },
        body: JSON.stringify(rideBody()),
      });
      const qb = await webQ.json().catch(() => null) as any;
      rec.deny('nor join the taxi queue', { status: webQ.status, ok: webQ.ok, json: qb, text: JSON.stringify(qb) }, [403], ['TAXI_MOBILE_APP_REQUIRED']);
    } else {
      rec.skipCase('web booking denial', 'LIVETEST_WEB_ORIGIN is not set: a browser (cookie) session needs an origin the API allows (CORS_ORIGIN), so the server-side web refusal cannot be formed');
    }
    const mobile = await POST('/rides/request', rideBody(), C7.session.token);
    rec.expect('the mobile app (bearer) still books a taxi', mobile, 201);
    if (mobile.ok) await cancelRide(C7.session, mobile.json.data.ride.id);
    rec.deny('an unauthenticated booking', await req('POST', '/rides/request', { body: rideBody() }), [401]);
    void ORIGIN;
  },
};

// ---------------------------------------------------------------------------
// [TAXI multi-stop] TAXI-06: a ride with a stop, over the real endpoints, on
// whatever TAXI_MAX_STOPS the target runs (GET /rides/capabilities says which).
//  - Off (0 or unset, the launch default): a stop is refused at the quote, the
//    request and the queue (409 MULTI_STOP_UNAVAILABLE) and nothing is written;
//    the stop cases are reported SKIP with that reason.
//  - On (1-3; set it on the private journeys instance, never the public API):
//    one driver goes online declaring TAXI_STOPS_V1, as builds 11/12 do once
//    the server offers stops, while a NEARER driver stays an app without it.
//    Ride 1 arrives at the stop (the car is there), waits, leaves, ends paid;
//    ride 2 arrives from far away (not verified, #1908) and skips the stop;
//    ride 3 (at 2-3) drives the most stops the target allows end to end: the
//    route quoted leg by leg, each stop reached, waited at and left in order,
//    the trip link and the safety monitor following the car from stop to stop,
//    and, with TAXI_WAITING_CHARGE=1, the waiting charge the server freezes
//    checked against the owner's rule from the server's own clocks. Its waits
//    are real time (no clock is moved): ~11 minutes in all.
// The capability is cleared again at the end (a plain go-online), so no
// journey after this one meets a driver that runs stops.
// ---------------------------------------------------------------------------

/** About 1.2 km from PICKUP and the other way from DROPOFF: the trip with the
 *  stop (~4.4 km) is longer than the trip without it (~2.1 km), and an arrival
 *  reported from the pickup is far outside the 300 m arrival check. */
const STOP = { lat: 6.8000, lng: -58.1550, address: 'TEST stop, Hadfield Street' };
const TAXI_STOPS_CAPABILITY = 'TAXI_STOPS_V1';
/** The evidence note's suffix for an arrival the GPS check did not accept (#1908). */
const STOP_NOT_VERIFIED = 'not verified, so this wait is not charged';
/** TAXI_STOP_NO_SHOW_GRACE_MINUTES, in seconds. */
const STOP_GRACE_SECONDS = 10 * 60;
/** PUT /driver/location persists one fix per driver per 10 s (dispatch.ts). */
const FIX_DEBOUNCE_MS = 11_000;
const STOPS_OFF = ['MULTI_STOP_UNAVAILABLE'];

/** [TAXI multi-stop · ride 3] The most stops a ride may carry, in the
 *  passenger's order: each well over the 300 m arrival check from the others
 *  and from both ends (the closest pair, stop 3 and the pickup, ~0.95 km), all
 *  in Georgetown. */
const STOP_ROUTE = [
  STOP,
  { lat: 6.8060, lng: -58.1450, address: 'TEST stop 2, Lamaha Street' },
  { lat: 6.8180, lng: -58.1480, address: 'TEST stop 3, Camp Road' },
] as const;
/** [Owner 19 Oct 2026] The waiting terms: 300 GYD per FULL 10 minutes, the
 *  pickup wait and every stop's wait summed (taxi-waiting.ts tallyTaxiWaiting). */
const OWNER_WAITING = { chargePerBlock: 300, blockMinutes: 10 } as const;
/** Ride 3's waits, in seconds: at the pickup, then at each stop. No single
 *  wait comes near a 10-minute block, but the pickup and the first two stops
 *  pass one together before the car leaves stop 2 (3 × 210 s = 630 s), and the
 *  whole ride stays far inside the second block (~700 of 1,200 s). Waited only
 *  while TAXI_WAITING_CHARGE is on. */
const PICKUP_WAIT_S = 210;
const STOP_WAITS_S = [210, 210, 45] as const;
/** The car stands at the destination before "Fare collected" (the safety
 *  monitor sees it there); a wait at the destination is never charged. */
const DESTINATION_DWELL_S = 40;

/** Metres between two points (haversine): where the trip link puts the car. */
function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** Milliseconds from one server timestamp to another (never negative), or null when either is missing. */
function msBetween(from: unknown, to: unknown): number | null {
  const a = Date.parse(String(from ?? ''));
  const b = Date.parse(String(to ?? ''));
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
}

/** An evidence note without its coordinates (they stay on the console). */
const noteShown = (note: unknown) => (typeof note === 'string' ? note.replace(/gps:\S+/g, 'gps:…') : 'none');

const tripWith = (stops: readonly unknown[], expectedFare?: number) =>
  rideBody({ stops, ...(expectedFare === undefined ? {} : { expectedFare }) });

/** The economy fare quoted for A → (stops) → C, or null when none was quoted. */
async function quoteTrip(passenger: Session, stops: readonly unknown[]): Promise<{ res: Res; fare: number | null }> {
  const res = await POST('/rides/estimate', { pickup: PICKUP, dropoff: DROPOFF, ...(stops.length > 0 ? { stops } : {}) }, passenger.token);
  const eco = (res.json?.data?.tiers ?? []).find((t: any) => t.rideClass === 'ECONOMY');
  const fare = Number(eco?.fare);
  return { res, fare: res.ok && Number.isFinite(fare) && fare > 0 ? fare : null };
}

const stopMove = (s: Session, rideId: string, sequence: number, action: 'arrived' | 'depart' | 'skip', body: Record<string, unknown> = {}) =>
  action === 'skip'
    ? POST(`/driver/rides/${rideId}/stops/${sequence}/skip`, body, s.token)
    : PUT(`/driver/rides/${rideId}/stops/${sequence}/${action}`, body, s.token);

/** The ride's stops as the console's order page reads them (with the evidence note). */
async function consoleStops(ctx: Ctx, rideId: string): Promise<any[] | null> {
  const r = await GET(`/admin/orders/${rideId}`, ctx.admin.token);
  return r.ok && Array.isArray(r.json?.data?.stops) ? r.json.data.stops : null;
}

/** The car is at `point`: the heartbeat holds it there, and one fix is
 *  reported past the location debounce, so the persisted position is this one. */
async function driveTo(ctx: Ctx, id: string, point: { lat: number; lng: number }): Promise<void> {
  ctx.stash.heartbeatOverrides[id] = point;
  await sleep(FIX_DEBOUNCE_MS);
  await PUT('/driver/location', { latitude: point.lat, longitude: point.lng, accuracy: 5 }, mover(ctx, id).session.token);
}

/** Online as a driver app that runs stops (what builds 11/12 send at go-online
 *  once GET /rides/capabilities says maxStops > 0). */
async function onlineWithStops(ctx: Ctx, id: string): Promise<Res> {
  const m = mover(ctx, id);
  await setOnline(ctx, id, false);
  const r = await POST('/driver/go-online', { latitude: m.lat, longitude: m.lng, capabilities: [TAXI_STOPS_CAPABILITY] }, m.session.token);
  if (r.ok) {
    await ping(m);
    if (!ctx.world.onlineMovers.includes(id)) ctx.world.onlineMovers.push(id);
  }
  return r;
}

/** A booked ride with a stop: its id and the passenger's PIN. */
async function bookWithStop(rec: Recorder, passenger: Session, fare: number, label: string): Promise<{ id: string; pin: string } | null> {
  const r = await POST('/rides/request', tripWith([STOP], fare), passenger.token);
  if (!rec.expect(`${label}: booked at the quoted fare with its stop`, r, 201, undefined, `status=${r.json?.data?.ride?.status}`)) return null;
  return { id: String(r.json.data.ride.id), pin: String(r.json.data.ride.ridePin ?? '') };
}

/** The capable driver takes the ride from its offer and starts the trip;
 *  `atPickup` runs with the car arrived at the pickup, before the code. */
async function takeAndStart(rec: Recorder, ctx: Ctx, capable: string, ride: { id: string; pin: string }, label: string,
  atPickup?: () => Promise<void>): Promise<Session> {
  const got = await pollOffer(ctx, ride.id, onlineOf(ctx, 'driver'), 60_000);
  rec.require(`${label}: offered to the driver whose app runs stops, never the nearer older app`, got?.moverId === capable,
    got ? `offered to ${got.moverId} (capable: ${capable})` : 'no offer in 60 s');
  const D = mover(ctx, capable).session;
  rec.must(`${label}: ${capable} accepts`, await POST('/driver/offers/accept', { orderId: ride.id, offerAttemptId: got!.offer.offerAttemptId }, D.token), 200);
  if (label === 'ride 1') {
    rec.deny('no stop move before the passenger is aboard', await stopMove(D, ride.id, 1, 'arrived'), [409], ['INVALID_STATUS']);
  }
  await PUT(`/driver/rides/${ride.id}/en-route`, {}, D.token);
  rec.must(`${label}: the driver arrives at the pickup`, await driverArrives(ctx, capable, ride.id, PICKUP), 200);
  if (atPickup) await atPickup();
  rec.must(`${label}: the passenger's PIN verifies`, await PUT(`/driver/rides/${ride.id}/verify-pin`, { pin: ride.pin }, D.token), 200);
  rec.must(`${label}: the trip starts`, await PUT(`/driver/rides/${ride.id}/start`, {}, D.token), 200);
  return D;
}

/** Cleanup for a ride with stops: "Fare collected" waits for every stop (409
 *  STOPS_REMAINING), so the driver leaves an arrived stop and skips a pending
 *  one, then the usual close. Run twice: a PIN-verified ride that never started
 *  is started by closeRide, which the open stop then holds. */
async function closeStopRide(ctx: Ctx, passenger: Session, rideId: string, driverId: string): Promise<string | null> {
  const finishStops = async () => {
    const r = (await GET(`/rides/${rideId}`, passenger.token)).json?.data;
    if (r?.status !== 'RIDE_IN_PROGRESS') return;
    const D = mover(ctx, driverId).session;
    for (const s of (r.stops ?? []) as any[]) {
      if (s.status === 'ARRIVED') await stopMove(D, rideId, s.sequence, 'depart');
      else if (s.status === 'PENDING') await stopMove(D, rideId, s.sequence, 'skip', { reason: 'Couldn’t reach the stop' });
    }
  };
  await finishStops();
  if (!(await closeRide(ctx, passenger, rideId, DROPOFF))) return null;
  await finishStops();
  return closeRide(ctx, passenger, rideId, DROPOFF);
}

/** TAXI_MAX_STOPS is 0: every door to a stop is shut, and nothing is written. */
async function stopsSwitchedOff(rec: Recorder, passenger: Session): Promise<void> {
  rec.deny('a quote with a stop while stops are off', (await quoteTrip(passenger, [STOP])).res, [409], STOPS_OFF);
  const before = (await activeRide(passenger))?.id ?? null;
  rec.deny('a ride request with a stop while stops are off', await POST('/rides/request', tripWith([STOP], 1000), passenger.token), [409], STOPS_OFF);
  const after = (await activeRide(passenger))?.id ?? null;
  rec.check('the refused request booked nothing', after === before, `active ride before=${before ?? 'none'} after=${after ?? 'none'}`);
  rec.deny('joining the queue with a stop while stops are off', await POST('/rides/queue/join', tripWith([STOP], 1000), passenger.token), [409], STOPS_OFF);
  const q = await GET('/rides/queue', passenger.token);
  rec.check('the refused join holds no queue entry', !q.json?.data?.id, `→ ${brief(q)}`);
  rec.skipCase('a ride with a stop, end to end',
    'TAXI_MAX_STOPS is 0 on this target (the launch default): stops are off, and the off state is proven above. Set TAXI_MAX_STOPS=1 on the private journeys instance (never the public API) to run the stop cases.');
}

/** TAXI_MAX_STOPS is 1-3: the whole stop journey, two rides, and a third
 *  through the most stops allowed when that is more than one. `waiting` is
 *  the terms GET /rides/capabilities disclosed (null: TAXI_WAITING_CHARGE off). */
async function stopsSwitchedOn(rec: Recorder, ctx: Ctx, C7: Session, maxStops: number, plainFare: number | null, waiting: any | null): Promise<void> {
  const online = drivers(ctx);
  rec.require('two drivers online (one app runs stops, one does not)', online.length >= 2, online.join(','));
  const capable = online[0]!;
  const older = online[1]!;
  const O = mover(ctx, older).session;
  const made: string[] = [];
  try {
    // The quote: the whole route priced once, the stop included.
    const q = await quoteTrip(C7, [STOP]);
    const est = q.res.json?.data;
    rec.check('a quote with a stop prices the whole route as one trip', q.fare !== null && est?.stopCount === 1 && est?.maxStops === maxStops,
      `→ ${brief(q.res)} economy=${q.fare} stopCount=${est?.stopCount} maxStops=${est?.maxStops} legs=${Array.isArray(est?.legs) ? est.legs.length : 'none'}`);
    rec.check('the stop is priced: the trip with it costs more than the trip without it', q.fare !== null && plainFare !== null && q.fare > plainFare, `with=${q.fare} without=${plainFare}`);
    rec.require('a quoted fare to book at', q.fare !== null, '');
    const fare = q.fare!;
    {
      // Past the configured maximum (at 3, past the database cap too): counted before anything is looked at.
      const tooMany = Array.from({ length: maxStops + 1 }, (_, i) => ({ lat: STOP.lat - 0.002 * i, lng: STOP.lng, address: `TEST stop ${i + 1}, Hadfield Street` }));
      rec.deny(`a quote with ${maxStops + 1} stops, past the configured ${maxStops}`, (await quoteTrip(C7, tooMany)).res, [400], ['TOO_MANY_STOPS']);
    }

    // The booking rules, before anything is written.
    rec.deny('a ride with a stop must carry the fare it was shown', await POST('/rides/request', tripWith([STOP]), C7.token), [400], ['EXPECTED_FARE_REQUIRED']);
    rec.deny('a fare the passenger was not shown is never booked', await POST('/rides/request', tripWith([STOP], fare + 100), C7.token), [409], ['FARE_CHANGED']);
    rec.deny('the queue holds no trip with stops', await POST('/rides/queue/join', tripWith([STOP], fare), C7.token), [409], ['MULTI_STOP_QUEUE_UNSUPPORTED']);
    rec.check('none of the refusals booked a ride', !(await activeRide(C7)), '');

    // One app runs stops; the other, NEARER to the pickup, does not.
    rec.must('a driver app that runs stops goes online saying so (TAXI_STOPS_V1)', await onlineWithStops(ctx, capable), 200);
    await driveTo(ctx, older, PICKUP);

    // Ride 1: arrive at the stop, wait, leave, end paid.
    const ride1 = await bookWithStop(rec, C7, fare, 'ride 1');
    rec.require('ride 1 is booked', !!ride1, '');
    made.push(ride1!.id);
    const r1 = (await GET(`/rides/${ride1!.id}`, C7.token)).json?.data;
    rec.check('the passenger’s ride carries its stop, the stop to reach next, and the quoted fare',
      r1?.stops?.length === 1 && r1.stops[0].status === 'PENDING' && r1.nextStopSequence === 1 && Number(r1.taxiFareTotal ?? r1.totalAmount) === fare,
      `stops=${JSON.stringify((r1?.stops ?? []).map((s: any) => s.status))} next=${r1?.nextStopSequence} fare=${r1?.taxiFareTotal ?? r1?.totalAmount} quoted=${fare}`);
    rec.deny('an app that cannot run stops accepts it (stale or forged)', await POST(`/driver/rides/${ride1!.id}/accept`, {}, O.token), [409], ['APP_UPDATE_REQUIRED']);
    const pending = (await GET(`/rides/${ride1!.id}`, C7.token)).json?.data;
    rec.check('the refused accept wrote nothing', pending?.status === 'PENDING' && !pending?.driverId, `status=${pending?.status}`);
    const board = await GET('/driver/rides/available', O.token);
    rec.check('that app’s board never shows the ride', board.ok && !JSON.stringify(board.json?.data ?? []).includes(ride1!.id), `→ ${brief(board)}`);
    const D = await takeAndStart(rec, ctx, capable, ride1!, 'ride 1');

    rec.deny('another driver moves this ride’s stop', await stopMove(O, ride1!.id, 1, 'arrived'), [403, 404]);
    rec.deny('the passenger moves a stop', await stopMove(C7, ride1!.id, 1, 'arrived'), [403, 404]);
    rec.deny('a stop this ride does not have', await stopMove(D, ride1!.id, 2, 'arrived'), [404], ['STOP_NOT_FOUND']);
    rec.deny('leave the stop before arriving at it', await stopMove(D, ride1!.id, 1, 'depart'), [409], ['STOP_NOT_ARRIVED']);
    rec.deny('“Fare collected” while the stop is still open', await POST(`/driver/rides/${ride1!.id}/handover`, { outcome: 'paid', gps: STOP }, D.token), [409], ['STOPS_REMAINING']);
    rec.deny('“passenger did not come back” on the way to the stop', await POST(`/driver/rides/${ride1!.id}/handover`, { outcome: 'no_show', gps: PICKUP }, D.token), [409], ['STOPS_REMAINING']);

    await driveTo(ctx, capable, STOP);
    const arrive = await stopMove(D, ride1!.id, 1, 'arrived');
    rec.expect('ride 1: arrived at stop 1, the car at the stop', arrive, 200);
    const wait = arrive.json?.data?.stopWait;
    const graceSeconds = wait ? (Date.parse(wait.noShowAvailableAt) - Date.parse(wait.arrivedAt)) / 1000 : NaN;
    rec.check('the grace runs 10 minutes from the arrival, on the server clock', arrive.json?.data?.stop?.status === 'ARRIVED' && graceSeconds === STOP_GRACE_SECONDS,
      `stop=${arrive.json?.data?.stop?.status} grace=${graceSeconds}s`);
    const again = await stopMove(D, ride1!.id, 1, 'arrived');
    rec.check('a repeated tap is answered as it is, nothing new written', again.ok && again.json?.replayed === true, `→ ${brief(again)} replayed=${again.json?.replayed}`);
    const seen = await activeRide(C7);
    rec.check('the passenger sees the car at stop 1', seen?.stops?.[0]?.status === 'ARRIVED' && seen?.nextStopSequence === 1, `stop=${seen?.stops?.[0]?.status} next=${seen?.nextStopSequence}`);
    const early = await POST(`/driver/rides/${ride1!.id}/handover`, { outcome: 'no_show', gps: STOP }, D.token);
    rec.deny('“passenger did not come back” inside the 10-minute grace', early, [409], ['STOP_WAIT_NOT_ELAPSED']);
    rec.check('the refusal says when the grace ends', !!wait && early.json?.error?.details?.retryAt === wait.noShowAvailableAt,
      `retryAt=${early.json?.error?.details?.retryAt} noShowAvailableAt=${wait?.noShowAvailableAt}`);
    rec.check('the refused no-show wrote nothing', (await activeRide(C7))?.status === 'RIDE_IN_PROGRESS', '');
    const note1 = (await consoleStops(ctx, ride1!.id))?.[0]?.evidenceNote;
    rec.check('an arrival made at the stop is not marked unverified', typeof note1 === 'string' && !note1.includes(STOP_NOT_VERIFIED), `note=${note1 ?? 'none'}`);

    const depart = await stopMove(D, ride1!.id, 1, 'depart');
    rec.check('ride 1: done at stop 1, the destination is next', depart.ok && depart.json?.data?.stop?.status === 'DEPARTED' && depart.json?.data?.nextStopSequence === null && depart.json?.data?.stopWait === null,
      `→ ${brief(depart)} stop=${depart.json?.data?.stop?.status} next=${depart.json?.data?.nextStopSequence}`);
    rec.deny('a stop already left cannot be skipped', await stopMove(D, ride1!.id, 1, 'skip', { reason: 'Passenger asked to skip it' }), [409], ['STOP_ALREADY_RESOLVED']);
    rec.expect('ride 1: “Fare collected” at the destination', await POST(`/driver/rides/${ride1!.id}/handover`, { outcome: 'paid', gps: DROPOFF }, D.token), 200);
    const done1 = (await GET(`/rides/${ride1!.id}`, C7.token)).json?.data;
    rec.check('ride 1 reads DELIVERED, cash captured, at the quoted fare', done1?.status === 'DELIVERED' && done1?.paymentStatus === 'CAPTURED' && Number(done1?.taxiFareTotal ?? done1?.totalAmount) === fare,
      `status=${done1?.status} payment=${done1?.paymentStatus} fare=${done1?.taxiFareTotal ?? done1?.totalAmount} quoted=${fare}`);
    const receipt1 = await GET(`/customer/orders/${ride1!.id}/receipt`, C7.token);
    rec.check('the receipt names the stop the fare covered', receipt1.ok && receipt1.text.includes(`Stops: 1. ${STOP.address}`) && !receipt1.text.includes('(skipped)'), `→ ${brief(receipt1)}`);
    const con1 = await consoleStops(ctx, ride1!.id);
    rec.check('the console’s order page shows the stop, reached and left', con1?.length === 1 && con1[0].status === 'DEPARTED' && !!con1[0].arrivedAt && !!con1[0].departedAt,
      `stops=${JSON.stringify((con1 ?? []).map((s: any) => s.status))}`);

    // Ride 2: an arrival far from the stop, then a skip.
    const ride2 = await bookWithStop(rec, C7, fare, 'ride 2');
    rec.require('ride 2 is booked', !!ride2, '');
    made.push(ride2!.id);
    await takeAndStart(rec, ctx, capable, ride2!, 'ride 2');
    rec.expect('ride 2: an arrival reported ~1.2 km from the stop is never refused', await stopMove(D, ride2!.id, 1, 'arrived'), 200);
    const note2 = (await consoleStops(ctx, ride2!.id))?.[0]?.evidenceNote;
    if (typeof note2 === 'string' && note2.includes(STOP_NOT_VERIFIED)) {
      rec.check('#1908: the far arrival is recorded as not verified (its wait is never charged)', true, `note=${note2}`);
    } else {
      rec.skipCase('#1908: an arrival far from the stop is recorded as not verified',
        `this build wrote no verification on the far arrival (note=${note2 ?? 'none'}): #1908 is not in it, so the waiting charge must stay off with stops on`);
    }
    rec.deny('a skip without a reason', await stopMove(D, ride2!.id, 1, 'skip', {}), [400]);
    rec.deny('a skip reason the passenger must never be sent (a phone number)', await stopMove(D, ride2!.id, 1, 'skip', { reason: 'Call me on +592 012 3456 instead' }), [400], ['SKIP_REASON_REFUSED']);
    const skip = await stopMove(D, ride2!.id, 1, 'skip', { reason: 'Road or access blocked' });
    rec.check('ride 2: stop 1 skipped with its reason, the destination next', skip.ok && skip.json?.data?.stop?.status === 'SKIPPED' && skip.json?.data?.stop?.skipReason === 'Road or access blocked' && skip.json?.data?.nextStopSequence === null,
      `→ ${brief(skip)} stop=${skip.json?.data?.stop?.status}`);
    const told = await waitForNotification(C7, (n) => n?.title === 'Stop 1 skipped' && JSON.stringify(n).includes(ride2!.id));
    rec.check('the passenger is told the stop was skipped, and why', !!told && String(told.body ?? '').includes('Road or access blocked'), told ? 'notice found' : 'no notice in 20 s');
    rec.deny('“passenger did not come back” inside the grace of a stop arrived at and then skipped', await POST(`/driver/rides/${ride2!.id}/handover`, { outcome: 'no_show', gps: STOP }, D.token), [409], ['STOP_WAIT_NOT_ELAPSED']);
    rec.expect('ride 2: “Fare collected” at the destination', await POST(`/driver/rides/${ride2!.id}/handover`, { outcome: 'paid', gps: DROPOFF }, D.token), 200);
    const done2 = (await GET(`/rides/${ride2!.id}`, C7.token)).json?.data;
    rec.check('ride 2 reads DELIVERED at the quoted fare (a skip does not change it)', done2?.status === 'DELIVERED' && Number(done2?.taxiFareTotal ?? done2?.totalAmount) === fare,
      `status=${done2?.status} fare=${done2?.taxiFareTotal ?? done2?.totalAmount} quoted=${fare}`);
    const receipt2 = await GET(`/customer/orders/${ride2!.id}/receipt`, C7.token);
    rec.check('the receipt marks the stop skipped', receipt2.ok && receipt2.text.includes(`Stops: 1. ${STOP.address} (skipped)`), `→ ${brief(receipt2)}`);
    const con2 = await consoleStops(ctx, ride2!.id);
    rec.check('the console’s order page shows the stop skipped with its reason', con2?.[0]?.status === 'SKIPPED' && con2[0].skipReason === 'Road or access blocked',
      `stops=${JSON.stringify((con2 ?? []).map((s: any) => s.status))}`);

    // Ride 3: the most stops the target allows, end to end, with the waiting charge.
    if (maxStops >= 2) {
      await rideThroughStops(rec, ctx, C7, capable, maxStops, fare, waiting, made);
    } else {
      rec.skipCase('a ride through more than one stop, end to end (and its waiting charge)',
        'TAXI_MAX_STOPS is 1 on this target: a ride carries one stop, proven by rides 1 and 2. Set TAXI_MAX_STOPS=3 on the private journeys instance to drive a three-stop ride.');
    }
  } finally {
    for (const id of made) {
      const left = await closeStopRide(ctx, C7, id, capable);
      if (left) ctx.log(`    TAXI-06 left live: ${left}`);
    }
    // A plain go-online clears the capability (the server records it at every go-online).
    await setOnline(ctx, capable, false);
    const back = await setOnline(ctx, capable, true);
    rec.cleanup(`${capable} back online as an app without stops`, back.ok, `→ ${brief(back)}`);
    releaseDrivers(ctx, [capable, older]);
  }
}

/** Ride 3: the most stops the target allows (three at TAXI_MAX_STOPS=3), end
 *  to end, on the real endpoints: the whole route quoted leg by leg and booked
 *  at that fare (with the waiting terms it showed), each stop arrived at with
 *  the car there, waited at and left in the passenger's order, the trip link
 *  and the safety monitor following the car from stop to stop, and the fare
 *  collected at the destination. With TAXI_WAITING_CHARGE on, the charge the
 *  server froze is checked against the owner's rule from the server's own
 *  clocks: floor(pickup wait + every stop's wait / 10 min) × 300. */
async function rideThroughStops(rec: Recorder, ctx: Ctx, C7: Session, capable: string, maxStops: number,
  oneStopFare: number, waiting: any | null, made: string[]): Promise<void> {
  const n = Math.min(maxStops, STOP_ROUTE.length);
  const route = STOP_ROUTE.slice(0, n);
  const label = `ride 3 (${n} stops)`;
  const targets = [...route.map((_, i) => `STOP_${i + 1}`), 'DESTINATION'];
  const codes = ['PICKUP', ...targets];
  const blockS = OWNER_WAITING.blockMinutes * 60;

  // The quote: one trip over the whole road, leg by leg.
  const q = await quoteTrip(C7, route);
  const est = q.res.json?.data;
  const legs: any[] = Array.isArray(est?.legs) ? est.legs : [];
  rec.check(`${label}: the quote prices the whole route through ${n} stops as one trip`, q.fare !== null && est?.stopCount === n && est?.maxStops === maxStops,
    `→ ${brief(q.res)} economy=${q.fare} stopCount=${est?.stopCount} maxStops=${est?.maxStops}`);
  rec.check(`${label}: the quote names one leg per pair of points, in the passenger's order`,
    legs.length === n + 1 && legs.every((l, i) => l.from === codes[i] && l.to === codes[i + 1] && Number.isInteger(l.meters) && l.meters > 0),
    `legs=${legs.map((l) => `${l.from}>${l.to} ${l.meters} m/${l.seconds ?? '-'} s`).join(', ') || 'none'}`);
  const legKm = legs.reduce((sum, l) => sum + Number(l.meters), 0) / 1000;
  rec.check(`${label}: the legs add up to the distance the fare is priced on`,
    legs.length === n + 1 && Math.abs(legKm - Number(est?.billableKm)) <= 0.01 && Math.abs(legKm - Number(est?.distanceKm)) <= 0.06,
    `legs sum ${legKm.toFixed(3)} km; billableKm=${est?.billableKm} distanceKm=${est?.distanceKm} durationMin=${est?.durationMin}`);
  rec.check(`${label}: more stops, more road, more fare (${n} stops > 1 stop)`, q.fare !== null && q.fare > oneStopFare, `${n} stops=${q.fare} one stop=${oneStopFare}`);
  if (waiting) {
    const w = est?.waiting;
    rec.check(`${label}: the quote discloses the owner's waiting terms beside the fare (${OWNER_WAITING.chargePerBlock} per ${OWNER_WAITING.blockMinutes} minutes)`,
      w?.chargePerBlock === OWNER_WAITING.chargePerBlock && w?.blockMinutes === OWNER_WAITING.blockMinutes && typeof w?.text === 'string' && w.text.length > 0,
      `waiting=${JSON.stringify(w ?? null)}`);
  }
  rec.require(`${label}: a quoted fare and its legs to book at`, q.fare !== null && legs.length === n + 1, '');
  const fare = q.fare!;
  const echo = waiting ? { waiting: { chargePerBlock: waiting.chargePerBlock, blockMinutes: waiting.blockMinutes } } : {};
  if (waiting) {
    rec.deny(`${label}: a booking that echoes waiting terms the passenger was not shown`,
      await POST('/rides/request', { ...tripWith(route, fare), waiting: { chargePerBlock: Number(waiting.chargePerBlock) + 100, blockMinutes: waiting.blockMinutes } }, C7.token), [409], ['WAITING_TERMS_CHANGED']);
    rec.check(`${label}: the refused booking booked nothing`, !(await activeRide(C7)), '');
  }

  // The booking: the itinerary and the terms frozen with the ride.
  const book = await POST('/rides/request', { ...tripWith(route, fare), ...echo }, C7.token);
  rec.expect(`${label}: booked at the quoted fare with its ${n} stops${waiting ? ' and the waiting terms it showed' : ''}`, book, 201, undefined,
    `status=${book.json?.data?.ride?.status} fare=${book.json?.data?.ride?.fare} stops=${book.json?.data?.ride?.stops?.length} waiting=${JSON.stringify(book.json?.data?.ride?.waiting ?? null)}`);
  rec.require(`${label} is booked`, book.status === 201 && !!book.json?.data?.ride?.id, '');
  const ride = { id: String(book.json.data.ride.id), pin: String(book.json.data.ride.ridePin ?? '') };
  made.push(ride.id);
  const booked = (await GET(`/rides/${ride.id}`, C7.token)).json?.data;
  const bStops: any[] = booked?.stops ?? [];
  rec.check(`${label}: the ride carries its ${n} stops in the passenger's order, all ahead, stop 1 next`,
    bStops.length === n && bStops.every((s, i) => s.sequence === i + 1 && s.status === 'PENDING' && s.address === route[i]!.address) && booked?.nextStopSequence === 1,
    `stops=${JSON.stringify(bStops.map((s) => `${s.sequence}:${s.status}`))} next=${booked?.nextStopSequence}`);
  rec.check(`${label}: each stop keeps the priced leg that ends at it, exactly as quoted`,
    bStops.length === n && bStops.every((s, i) => s.legMeters === legs[i]?.meters && (s.legSeconds ?? null) === (legs[i]?.seconds ?? null)),
    `booked=${bStops.map((s) => `${s.legMeters} m/${s.legSeconds ?? '-'} s`).join(', ')} quoted=${legs.slice(0, n).map((l) => `${l.meters} m/${l.seconds ?? '-'} s`).join(', ')}`);
  rec.check(`${label}: the ride is frozen at the quoted fare and distance`,
    Number(booked?.taxiFareTotal) === fare && Number(booked?.totalAmount) === fare && Number(booked?.taxiDistance) === Number(est?.distanceKm),
    `taxiFareTotal=${booked?.taxiFareTotal} totalAmount=${booked?.totalAmount} taxiDistance=${booked?.taxiDistance}; quoted ${fare} over ${est?.distanceKm} km`);

  // The pickup: the car arrives (GPS at the pickup), and the passenger is slow to come out.
  const D = await takeAndStart(rec, ctx, capable, ride, label, async () => {
    if (!waiting) {
      rec.check(`${label}: waiting is off, so the arrived ride shows no wait`, (await activeRide(C7))?.waiting === undefined, '');
      return;
    }
    await sleep(PICKUP_WAIT_S * 1000);
    const a = await activeRide(C7);
    const w = a?.waiting;
    rec.check(`${label}: at the pickup the passenger sees the wait running from the GPS-placed arrival, nothing charged yet`,
      a?.status === 'DRIVER_ARRIVED' && w?.running === true && Number(w?.pickupWaitMinutes) >= Math.floor(PICKUP_WAIT_S / 60) && w?.waitingCharge === 0 && typeof w?.nextChargeAt === 'string',
      `status=${a?.status} waiting=${JSON.stringify(w ?? null)}`);
  });

  // The passenger shares the trip; the link follows the car.
  const share = await POST(`/safety/trips/${ride.id}/share`, {}, C7.token);
  rec.expect(`${label}: the passenger shares the trip`, share, [200, 201], undefined, `expiresAt=${share.json?.data?.expiresAt}`);
  const token = typeof share.json?.data?.token === 'string' ? share.json.data.token : '';
  const view = async (): Promise<Res | null> => (token ? req('GET', `/safety/public/trip/${token}`, {}) : null);

  for (let i = 0; i < n; i += 1) {
    const seq = i + 1;
    const at = route[i]!;
    const waitS = waiting ? STOP_WAITS_S[i] ?? 0 : 0;
    if (seq === 1 && n > 1) rec.deny(`${label}: stop 2 before stop 1`, await stopMove(D, ride.id, 2, 'arrived'), [409], ['STOP_OUT_OF_ORDER']);
    await driveTo(ctx, capable, at);
    const arrive = await stopMove(D, ride.id, seq, 'arrived');
    const sw = arrive.json?.data?.stopWait;
    const grace = sw ? (Date.parse(sw.noShowAvailableAt) - Date.parse(sw.arrivedAt)) / 1000 : NaN;
    rec.check(`${label}: arrived at stop ${seq} with the car there; its 10-minute grace runs on the server clock`,
      arrive.ok && arrive.json?.data?.stop?.status === 'ARRIVED' && arrive.json?.data?.nextStopSequence === seq && sw?.sequence === seq && grace === STOP_GRACE_SECONDS,
      `→ ${brief(arrive)} stop=${arrive.json?.data?.stop?.status} next=${arrive.json?.data?.nextStopSequence} grace=${grace}s`);
    const note = (await consoleStops(ctx, ride.id))?.[i]?.evidenceNote;
    rec.check(`${label}: stop ${seq}'s arrival is placed by the GPS (its wait counts)`, typeof note === 'string' && !note.includes(STOP_NOT_VERIFIED), `note=${noteShown(note)}`);
    const pub = await view();
    const loc = pub?.json?.data?.location;
    rec.check(`${label}: the shared trip link shows the trip in progress, the car at stop ${seq}`,
      !!pub && pub.ok && pub.json?.data?.status === 'Trip in progress' && pub.json?.data?.ended === false && !!loc && metres(loc, at) <= 100,
      `→ ${pub ? brief(pub) : 'no link'} status=${pub?.json?.data?.status} ${loc ? `car ${Math.round(metres(loc, at))} m from the stop` : 'no car shown'}`);

    if (waitS > 0) await sleep(waitS * 1000);
    const live = await activeRide(C7);
    const liveStop = (live?.stops ?? []).find((s: any) => s.sequence === seq);
    if (waiting) {
      // What has been waited so far (planned; the real clocks run a few seconds longer).
      const soFar = PICKUP_WAIT_S + STOP_WAITS_S.slice(0, seq).reduce((a, b) => a + b, 0);
      const blocks = Math.floor(soFar / blockS);
      const w = live?.waiting;
      rec.check(`${label}: waiting at stop ${seq}, the passenger's live wait runs: ${blocks} block(s) after ~${soFar} s waited in all`,
        w?.running === true && Number(liveStop?.waitMinutes) >= Math.floor(waitS / 60) && w?.waitingCharge === blocks * OWNER_WAITING.chargePerBlock && Number(w?.waitingMinutes) >= Math.floor(soFar / 60),
        `waiting=${JSON.stringify(w ?? null)} stop ${seq} waitMinutes=${liveStop?.waitMinutes}`);
      const dv = (await GET('/driver/rides/active', D.token)).json?.data;
      rec.check(`${label}: the driver's screen shows the same waiting charge, and the grace at stop ${seq}`,
        dv?.waiting?.waitingCharge === w?.waitingCharge && dv?.stopWait?.sequence === seq,
        `driver waiting=${dv?.waiting?.waitingCharge} passenger=${w?.waitingCharge} stopWait=${dv?.stopWait?.sequence}`);
    } else {
      rec.check(`${label}: waiting is off, so stop ${seq} shows no wait`, live?.waiting === undefined && liveStop?.waitMinutes === undefined, '');
    }

    const depart = await stopMove(D, ride.id, seq, 'depart');
    const next = seq < n ? seq + 1 : null;
    rec.check(`${label}: left stop ${seq}; ${next ? `stop ${next}` : 'the destination'} is next`,
      depart.ok && depart.json?.data?.stop?.status === 'DEPARTED' && depart.json?.data?.nextStopSequence === next && depart.json?.data?.stopWait === null,
      `→ ${brief(depart)} stop=${depart.json?.data?.stop?.status} next=${depart.json?.data?.nextStopSequence}`);
    if (seq === 1 && n > 1) {
      rec.deny(`${label}: “Fare collected” with stop${n > 2 ? `s 2-${n}` : ' 2'} still ahead`,
        await POST(`/driver/rides/${ride.id}/handover`, { outcome: 'paid', gps: at }, D.token), [409], ['STOPS_REMAINING']);
    }
  }

  // The destination: the safety monitor has followed the car there.
  await driveTo(ctx, capable, DROPOFF);
  await sleep(DESTINATION_DWELL_S * 1000);
  const board = await GET('/safety/guardian?status=live&limit=200', ctx.admin.token);
  const session = board.ok ? (board.json?.data ?? []).find((x: any) => x.orderId === ride.id) ?? null : null;
  const state = session?.deviationState ?? {};
  const changes: Array<{ from: string; to: string }> = (state.events ?? []).filter((e: any) => e.kind === 'TARGET_CHANGED').map((e: any) => ({ from: String(e.detail?.from), to: String(e.detail?.to) }));
  const seen = changes.length > 0 ? [changes[0]!.from, ...changes.map((c) => c.to)] : [];
  const expected = targets.slice(1).map((to, i) => `${targets[i]}>${to}`);
  const chain = changes.map((c) => `${c.from}>${c.to}`);
  // Every target, in order, once the waits ran; without them a 15-second sweep may step past a short visit.
  const followed = waiting ? JSON.stringify(chain) === JSON.stringify(expected)
    : seen.every((t, i) => targets.includes(t) && (i === 0 || targets.indexOf(t) > targets.indexOf(seen[i - 1]!)));
  rec.check(`${label}: the safety monitor watches the trip and aims at each stop in turn, then the destination`,
    !!session && session.status === 'MONITORING' && state.targetKey === 'DESTINATION' && followed,
    `→ ${brief(board)} session=${session?.status ?? 'none'} target=${state.targetKey ?? '-'} changes=${chain.join(', ') || 'none'} (expected ${expected.join(', ')})`);
  const flags = state.flags ?? {};
  rec.check(`${label}: the waits at the stops raise no safety alarm (no long-stop, deviation or overdue flag, no check-in)`,
    !!session && !flags.longStop && !flags.deviation && !flags.overdue && session.checkinRequestedAt == null,
    `flags=${JSON.stringify(flags)} checkinRequestedAt=${session?.checkinRequestedAt ?? null} riskScore=${session?.riskScore}`);

  // "Fare collected": the quoted fare, plus the waiting charge frozen once.
  const paid = await POST(`/driver/rides/${ride.id}/handover`, { outcome: 'paid', gps: DROPOFF }, D.token);
  rec.expect(`${label}: “Fare collected” at the destination`, paid, 200, undefined, `status=${paid.json?.data?.status}`);
  const done = (await GET(`/rides/${ride.id}`, C7.token)).json?.data;
  const dStops: any[] = done?.stops ?? [];
  rec.check(`${label} reads DELIVERED, cash captured, every stop reached and left`,
    done?.status === 'DELIVERED' && done?.paymentStatus === 'CAPTURED' && dStops.length === n && dStops.every((s) => s.status === 'DEPARTED' && !!s.arrivedAt && !!s.departedAt),
    `status=${done?.status} payment=${done?.paymentStatus} stops=${JSON.stringify(dStops.map((s) => s.status))}`);
  const fb = done?.fareBreakdown;
  if (waiting) {
    // The owner's rule, from the server's own clocks: the pickup (GPS arrival → the code) and each stop (arrival → departure).
    const pickupMs = msBetween(done?.driverArrivedAt, done?.ridePinVerifiedAt ?? done?.pickedUpAt);
    const stopMs = dStops.map((s) => msBetween(s.arrivedAt, s.departedAt ?? s.skippedAt));
    const waits = [pickupMs, ...stopMs];
    const totalS = Math.min(Math.floor(waits.reduce<number>((a, b) => a + (b ?? 0), 0) / 1000), 60 * 60);
    const expectedCharge = Math.floor(totalS / blockS) * OWNER_WAITING.chargePerBlock;
    const sec = (ms: number | null) => (ms === null ? '?' : (ms / 1000).toFixed(1));
    const waitsText = `pickup ${sec(pickupMs)} s + stops ${stopMs.map(sec).join(' + ')} s = ${totalS} s (whole seconds, capped at an hour)`;
    rec.check(`${label}: no single wait reached a block, but summed over the pickup and the stops they make exactly one`,
      waits.every((w) => w !== null && w < blockS * 1000) && expectedCharge === OWNER_WAITING.chargePerBlock, waitsText);
    rec.check(`${label}: the frozen waiting charge is floor(${totalS} s / ${OWNER_WAITING.blockMinutes} min) × ${OWNER_WAITING.chargePerBlock} = ${expectedCharge}, over ${Math.floor(totalS / 60)} min`,
      fb?.waitingCharge === expectedCharge && fb?.waitingMinutes === Math.floor(totalS / 60),
      `fareBreakdown=${JSON.stringify(fb ?? null)}; from the server clocks: ${waitsText}`);
    rec.check(`${label}: the passenger pays the quoted route fare plus the waiting charge, nothing else`,
      fb?.routeFare === fare && fb?.total === fare + expectedCharge && Number(done?.totalAmount) === fare + expectedCharge && Number(done?.taxiFareTotal) === fare,
      `routeFare=${fb?.routeFare} total=${fb?.total} totalAmount=${done?.totalAmount} taxiFareTotal=${done?.taxiFareTotal} quoted=${fare}`);
    const told = await waitForNotification(C7, (x) => x?.title === 'Ride Complete' && JSON.stringify(x).includes(ride.id));
    rec.check(`${label}: the completion notice splits the trip and the waiting`,
      !!told && String(told.body ?? '').includes(`(trip $${fare.toLocaleString()} + waiting $${expectedCharge.toLocaleString()})`), told ? String(told.body ?? '') : 'no notice in 20 s');
  } else {
    rec.check(`${label}: waiting is off, so nothing is added: the quoted fare is the fare`, !fb && Number(done?.totalAmount) === fare, `fareBreakdown=${fb ? 'present' : 'none'} totalAmount=${done?.totalAmount}`);
    rec.skipCase(`${label}: the waiting charge over the pickup and the stops`,
      'TAXI_WAITING_CHARGE is off on this target: no terms are shown, frozen or charged. Set TAXI_WAITING_CHARGE=1 on the private journeys instance to run the waiting cases.');
  }
  const receipt = await GET(`/customer/orders/${ride.id}/receipt`, C7.token);
  const stopsLine = `Stops: ${route.map((s, i) => `${i + 1}. ${s.address}`).join(' · ')}`;
  rec.check(`${label}: the receipt names the ${n} stops in order${waiting ? ' and itemises the waiting' : ''}`,
    receipt.ok && receipt.text.includes(stopsLine) && !receipt.text.includes('(skipped)') && (!waiting || receipt.text.includes(`Waiting (${fb?.waitingMinutes} min)`)),
    `→ ${brief(receipt)}`);
  const con = await GET(`/admin/orders/${ride.id}`, ctx.admin.token);
  const cStops: any[] = con.json?.data?.stops ?? [];
  rec.check(`${label}: the console's order page shows every stop reached and left${waiting ? ', and the same fare breakdown' : ''}`,
    con.ok && cStops.length === n && cStops.every((s) => s.status === 'DEPARTED' && !!s.arrivedAt && !!s.departedAt)
      && (!waiting || JSON.stringify(con.json?.data?.fareBreakdown ?? null) === JSON.stringify(fb ?? null)),
    `stops=${JSON.stringify(cStops.map((s) => s.status))} fareBreakdown=${JSON.stringify(con.json?.data?.fareBreakdown ?? null)}`);

  // After the trip: the link says so and shows no car; the monitor stands down.
  const after = await view();
  rec.check(`${label}: the trip link now says the trip is over and shows no car`,
    !!after && after.ok && after.json?.data?.ended === true && after.json?.data?.status === 'Trip completed' && after.json?.data?.location === null,
    `→ ${after ? brief(after) : 'no link'} status=${after?.json?.data?.status} ended=${after?.json?.data?.ended}`);
  const stood = await waitFor(async () => {
    const r = await GET('/safety/guardian?status=live&limit=200', ctx.admin.token);
    return r.ok && !(r.json?.data ?? []).some((x: any) => x.orderId === ride.id);
  }, 60_000, 5_000);
  rec.check(`${label}: the safety monitor stands down once the ride is delivered`, !!stood, stood ? 'session off the live board' : 'still live after 60 s');
}

export const TAXI_06: Journey<Ctx> = {
  id: 'TAXI-06',
  estimateSeconds: 1_100,
  title: 'Rides with stops (TAXI_MAX_STOPS), and their waiting charge (TAXI_WAITING_CHARGE)',
  cases: 'the stop count the app may offer; off: a stop refused at the quote, the request and the queue, nothing written; on: the whole route quoted, the quoted fare required, no stops in the queue, offered and given only to a driver app that runs stops, stop moves only in the trip by the ride’s driver, arrive/wait/leave and skip, no fare or no-show while a stop is open or inside its grace, the passenger told of a skip, the receipt and the console list the stops, a far arrival not verified (#1908); at 2-3 a ride through every stop allowed: the quote leg by leg, each leg frozen on its stop, stops only in order, each reached, waited at and left, the trip link and the safety monitor following the car stop by stop without an alarm, and with waiting on: the terms disclosed and echoed (a changed echo refused), the live wait on both screens, one block from waits summed over the pickup and the stops, frozen once and added to the quoted fare, on the receipt, the notice and the console',
  async run(rec, ctx) {
    const C7 = ctx.roster.customers.C7!.session;
    rec.require('a passenger was provisioned', !ctx.world.notReady.C7, ctx.world.notReady.C7 ?? '');
    const caps = await GET('/rides/capabilities', C7.token);
    const maxStops = Number(caps.json?.data?.maxStops);
    rec.require('GET /rides/capabilities says how many stops a ride may carry (0 to 3)', caps.ok && Number.isInteger(maxStops) && maxStops >= 0 && maxStops <= 3,
      `→ ${brief(caps)} maxStops=${String(caps.json?.data?.maxStops)}`);
    const plain = await quoteTrip(C7, []);
    rec.check('a ride without stops is quoted as always', plain.fare !== null, `→ ${brief(plain.res)} economy=${plain.fare}`);
    if (maxStops === 0) return stopsSwitchedOff(rec, C7);
    // [TAXI waiting charge] On (TAXI_WAITING_CHARGE=1), the capability read discloses the market's terms.
    const waiting = caps.json?.data?.waiting ?? null;
    rec.check(`the capability read ${waiting ? 'discloses the waiting terms (TAXI_WAITING_CHARGE on)' : 'discloses no waiting terms (TAXI_WAITING_CHARGE off)'}`,
      waiting === null || (Number.isFinite(waiting.chargePerBlock) && Number.isInteger(waiting.blockMinutes) && typeof waiting.text === 'string'),
      `waiting=${JSON.stringify(waiting)}`);
    return stopsSwitchedOn(rec, ctx, C7, maxStops, plain.fare, waiting);
  },
};

export const TAXI_JOURNEYS = [TAXI_01, TAXI_02, TAXI_03, TAXI_04, TAXI_05, TAXI_06];
