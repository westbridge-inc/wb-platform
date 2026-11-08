import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { INAPP_WORDS } from '../lib/inAppCalls';
import { reachSignal, reachSignalFromCache, type ReachSignal } from '../lib/inAppReach';
import type { RegisterResult } from './inAppVoice';
import type { CallsMicAnswer } from './notification-priming';
import { MIC_ASK_TIMEOUT_MS, REACH_RETRY_MS, createInAppReach, type MicAnswer, type ReachDeps } from './inAppReach';

// [CALLS-REACH · live test 8 Nov 2026] The store called a customer on a pickup order (no rider); the customer's
// phone had never registered, because it registered only while a "Call in app" control was on screen. Now a
// phone on a live order registers whatever the screen; it is unregistered only when the SERVER says there is no
// live order (review S2-1); Android asks for the microphone once, at a fitting moment, never a nag (review S2-2).

type Fx = {
  available: boolean; enabled: boolean; platform: 'ios' | 'android'; moment: boolean; mic: boolean;
  card: CallsMicAnswer | 'busy' | 'never'; micAnswer: MicAnswer | 'never'; now: number; disk: string | null;
  server: RegisterResult; registered: boolean; log: string[]; sleepers: Array<() => void>;
};
let fx: Fx;

function deps() {
  const d = {
    available: () => fx.available,
    enabled: vi.fn(async () => { fx.log.push('config'); return fx.enabled; }),
    register: vi.fn(async (force: boolean): Promise<RegisterResult> => {
      fx.log.push(force ? 'check' : 'register');
      if (fx.server === 'registered') fx.registered = true;
      return fx.server;
    }),
    unregister: vi.fn(async () => { fx.log.push('unregister'); fx.registered = false; return true; }),
    mayBeRegistered: () => fx.registered,
    platform: () => fx.platform,
    micGranted: async () => fx.mic,
    askMoment: () => fx.moment,
    ask: vi.fn((audience: 'customer' | 'partner'): Promise<CallsMicAnswer> | null => {
      if (fx.card === 'busy') return null;
      fx.log.push(`card:${audience === 'partner' ? INAPP_WORDS.reachWhyPartner : INAPP_WORDS.reachWhyCustomer}`);
      return fx.card === 'never' ? new Promise<CallsMicAnswer>(() => undefined) : Promise.resolve(fx.card);
    }),
    cancelAsk: vi.fn(() => { fx.log.push('card-closed'); }),
    requestMic: async (): Promise<MicAnswer> => {
      fx.log.push('system-prompt');
      if (fx.micAnswer === 'never') return new Promise<MicAnswer>(() => undefined);
      if (fx.micAnswer === 'granted') fx.mic = true;
      return fx.micAnswer;
    },
    memory: { get: () => fx.disk, set: (v: string) => { fx.disk = v; } },
    now: () => fx.now,
    sleep: (ms: number) => new Promise<void>((r) => { if (ms === MIC_ASK_TIMEOUT_MS) fx.sleepers.push(r); }),
  };
  return d satisfies ReachDeps;
}

const live = (...ids: string[]): ReachSignal => reachSignal({ customerLive: { items: ids.map((id) => ({ id, status: 'PREPARING' })) } });
const none = (): ReachSignal => reachSignal({ customerLive: { items: [] } });
const unknown = (): ReachSignal => reachSignal({});
const count = (entry: string) => fx.log.filter((l) => l === entry).length;
const cards = () => fx.log.filter((l) => l.startsWith('card:')).length;
const DAY = 24 * 60 * 60_000;

beforeEach(() => {
  fx = {
    available: true, enabled: true, platform: 'ios', moment: true, mic: false, card: 'allow', micAnswer: 'granted',
    now: 10_000_000, disk: null, server: 'registered', registered: false, log: [], sleepers: [],
  };
});

describe('[CALLS-REACH] a phone on a live order registers, with no call control on screen', () => {
  it('a customer with a store pickup order (no rider): registers from what the app holds, nothing else needed', async () => {
    const client = new QueryClient();
    // What GET /customer/orders?live=true answers for them (the same read the Activity list makes).
    client.setQueryData(['customer', 'orders', 'live'], { items: [{ id: 'o-pickup', status: 'PREPARING', fulfillment: 'PICKUP', riderId: null }], total: 1 });
    const reach = createInAppReach(deps());
    expect(await reach.update(reachSignalFromCache(client))).toBe('registered');
    expect(fx.log).toEqual(['config', 'register']);
  });

  it('a rider with an active job, a store with an open order: the same', async () => {
    for (const signal of [reachSignal({ moverActive: [{ id: 'j1', status: 'PICKED_UP' }] }), reachSignal({ storeOrders: [{ id: 's1', status: 'PENDING' }] })]) {
      fx.log = [];
      expect(await createInAppReach(deps()).update(signal)).toBe('registered');
      expect(count('register')).toBe(1);
    }
  });

  it('the board\'s reads every few seconds never hammer the server: one register a minute at most (the voice service keeps ten)', async () => {
    const reach = createInAppReach(deps());
    await reach.update(live('o1'));
    fx.now += 5_000;
    expect(await reach.update(live('o1'))).toBe('throttled');
    fx.now += REACH_RETRY_MS;
    expect(await reach.update(live('o1'))).toBe('registered');
    expect(count('register')).toBe(2);
  });

  it('signals that arrive while one runs: only the newest is run next', async () => {
    let release!: () => void;
    const d = deps();
    d.register.mockImplementationOnce(() => new Promise<RegisterResult>((r) => { release = () => { fx.registered = true; r('registered'); }; }));
    const reach = createInAppReach(d);
    const first = reach.update(live('o1'));
    await vi.waitFor(() => expect(d.register).toHaveBeenCalledTimes(1));
    void reach.update(live('o2'));
    void reach.update(none());
    release();
    await first;
    await vi.waitFor(() => expect(d.register).toHaveBeenCalledTimes(2));
    expect(d.register).toHaveBeenLastCalledWith(true); // the newest (none) ran: a check with the server, not o2
  });
});

describe('[CALLS-REACH · review S2-1] unregistered only when the SERVER says there is no live order', () => {
  it('live, then none: Swift asks the server; its "no live order" unregisters, once', async () => {
    const reach = createInAppReach(deps());
    await reach.update(live('o1'));
    fx.server = 'not-live';
    fx.now += REACH_RETRY_MS;
    expect(await reach.update(none())).toBe('unregistered');
    expect(fx.log.slice(-3)).toEqual(['config', 'check', 'unregister']);
    expect(await reach.update(none())).toBe('idle');
    expect(count('unregister')).toBe(1);
  });

  it('a multi-branch owner on branch B while branch A has live orders: the server says live, the phone stays registered', async () => {
    const reach = createInAppReach(deps());
    const roles = { store: true };
    const empty = { customerLive: { items: [] } };
    expect(await reach.update(reachSignal({ ...empty, storeOrders: [{ id: 'a1', status: 'PREPARING' }] }, roles))).toBe('registered');
    // the board now shows branch B, with nothing open; the server still finds A's order
    fx.now += REACH_RETRY_MS;
    expect(await reach.update(reachSignal({ ...empty, storeOrders: [] }, roles))).toBe('kept');
    expect(count('unregister')).toBe(0);
    expect(fx.registered).toBe(true);
  });

  it('a store owner who switches to the customer side, the board evicted after 30 minutes: "unknown", the server is asked, nothing removed', async () => {
    const reach = createInAppReach(deps());
    const roles = { store: true };
    await reach.update(reachSignal({ customerLive: { items: [] }, storeOrders: [{ id: 's1', status: 'ACCEPTED' }] }, roles));
    const evicted = reachSignal({ customerLive: { items: [] } }, roles);
    expect(evicted.state).toBe('unknown');
    fx.now += REACH_RETRY_MS;
    expect(await reach.update(evicted)).toBe('kept');
    expect(count('unregister')).toBe(0);
  });

  it('a check the server could not answer (offline, too soon) is asked again with the next reading', async () => {
    const reach = createInAppReach(deps());
    await reach.update(live('o1'));
    fx.server = 'failed';
    fx.now += REACH_RETRY_MS;
    expect(await reach.update(none())).toBe('failed');
    fx.server = 'not-live';
    expect(await reach.update(none())).toBe('throttled');
    fx.now += REACH_RETRY_MS;
    expect(await reach.update(none())).toBe('unregistered');
  });

  it('the reads behind (they still show an order the server finished): the register is refused, and the phone unregisters', async () => {
    fx.server = 'not-live';
    expect(await createInAppReach(deps()).update(live('o-stale'))).toBe('unregistered');
    expect(fx.log).toEqual(['config', 'register', 'unregister']);
  });

  it('[S3-3] a cold start with no live order on a phone that registered before: the server is asked once, and unregisters it', async () => {
    fx.registered = true; fx.server = 'not-live';
    const reach = createInAppReach(deps());
    expect(await reach.update(unknown())).toBe('waiting'); // not read yet: nothing
    expect(await reach.update(none())).toBe('unregistered');
    expect(fx.log).toEqual(['config', 'check', 'unregister']);
  });

  it('a cold start with no live order on a phone that never registered: nothing at all', async () => {
    const reach = createInAppReach(deps());
    expect(await reach.update(none())).toBe('idle');
    expect(await reach.update(unknown())).toBe('waiting');
    expect(fx.log).toEqual([]);
  });

  it('sign-out / account switch: the state is forgotten (the auth teardown unregisters the phone), and work in flight for the old account is dropped', async () => {
    fx.platform = 'android';
    let grant!: (a: MicAnswer) => void;
    const d = deps();
    d.requestMic = () => new Promise<MicAnswer>((r) => { grant = r; });
    const reach = createInAppReach(d);
    const pending = reach.update(live('o1'));
    await vi.waitFor(() => expect(grant).toBeTypeOf('function'));
    reach.reset();
    grant('granted');
    expect(await pending).toBe('stale');
    expect(d.register).not.toHaveBeenCalled();
    // the next account had no live order before: its first "none" asks nothing
    expect(await reach.update(none())).toBe('idle');
    expect(d.unregister).not.toHaveBeenCalled();
  });
});

describe('[CALLS-REACH] calls off, or no calling module: nothing', () => {
  it('the server switch off: never registers, never asks for the microphone', async () => {
    fx.enabled = false; fx.platform = 'android';
    const d = deps();
    expect(await createInAppReach(d).update(live('o1'))).toBe('off');
    expect(d.register).not.toHaveBeenCalled();
    expect(d.ask).not.toHaveBeenCalled();
  });

  it('build 12 (no voice module): a no-op, not even the config read', async () => {
    fx.available = false; fx.platform = 'android'; fx.registered = true;
    const reach = createInAppReach(deps());
    expect(await reach.update(live('o1'))).toBe('unavailable');
    expect(await reach.update(none())).toBe('unavailable');
    expect(fx.log).toEqual([]);
  });
});

describe('[CALLS-REACH · review S2-2] Android without the microphone: once, at a fitting moment, never a nag', () => {
  beforeEach(() => { fx.platform = 'android'; });

  it('Swift\'s card (customer words) through the priming slot, then the system prompt; registers after the grant', async () => {
    const reach = createInAppReach(deps());
    expect(await reach.update(live('o1'))).toBe('registered');
    expect(fx.log).toEqual([
      'config',
      'card:So the store, rider or driver can call you in Swift, allow the microphone. Swift never records calls.',
      'system-prompt',
      'register',
    ]);
    fx.now += REACH_RETRY_MS;
    await reach.update(live('o1', 'o2'));
    expect(cards()).toBe(1); // granted now: never asked again
  });

  it('a partner reads words about the people on their orders', async () => {
    await createInAppReach(deps()).update(reachSignal({ storeOrders: [{ id: 's1', status: 'PENDING' }] }));
    expect(fx.log[1]).toBe(`card:${INAPP_WORDS.reachWhyPartner}`);
  });

  it('not on a fitting screen (launch, sign-in, a gate, Home): waits; asked once a fitting screen opens', async () => {
    fx.moment = false;
    const reach = createInAppReach(deps());
    expect(await reach.update(live('o1'))).toBe('waiting');
    expect(cards()).toBe(0);
    fx.moment = true;
    fx.now += REACH_RETRY_MS;
    expect(await reach.update(live('o1'))).toBe('registered');
    expect(cards()).toBe(1);
  });

  it('another card already showing (the notifications card): waits its turn, never two at once', async () => {
    fx.card = 'busy';
    const reach = createInAppReach(deps());
    expect(await reach.update(live('o1'))).toBe('waiting');
    fx.card = 'allow';
    fx.now += REACH_RETRY_MS;
    expect(await reach.update(live('o1'))).toBe('registered');
  });

  it('"Not now" is remembered: no system prompt, no register, and no nag for that order or for a week', async () => {
    fx.card = 'not-now';
    const reach = createInAppReach(deps());
    expect(await reach.update(live('o1'))).toBe('mic-refused');
    expect(fx.log).not.toContain('system-prompt');
    expect(count('register')).toBe(0);
    fx.now += 3 * DAY;
    expect(await reach.update(live('o1'))).toBe('mic-off');
    expect(await reach.update(live('o2'))).toBe('mic-off');
    expect(await createInAppReach(deps()).update(live('o3'))).toBe('mic-off'); // an app restart reads the same memory
    expect(cards()).toBe(1);
    fx.now += 7 * DAY; // a week on, a NEW order: asked once more
    expect(await createInAppReach(deps()).update(live('o4'))).toBe('mic-refused');
    expect(cards()).toBe(2);
  });

  it('a card closed without an answer (back, outside) is only "not now" for this run: never stored as a refusal', async () => {
    fx.card = 'dismissed';
    const reach = createInAppReach(deps());
    expect(await reach.update(live('o1'))).toBe('mic-later');
    expect(fx.disk).toBeNull();
    fx.now += REACH_RETRY_MS;
    expect(await reach.update(live('o1'))).toBe('mic-off'); // not again this run
    fx.card = 'allow';
    expect(await createInAppReach(deps()).update(live('o1'))).toBe('registered'); // the next start asks again
  });

  it('a "no" at the system prompt is remembered per order and for a week; Android\'s "don\'t ask again" is for good', async () => {
    fx.micAnswer = 'denied';
    expect(await createInAppReach(deps()).update(live('o1'))).toBe('mic-refused');
    expect(await createInAppReach(deps()).update(live('o1'))).toBe('mic-off');
    fx.micAnswer = 'never_ask_again';
    fx.now += 8 * DAY;
    expect(await createInAppReach(deps()).update(live('o2'))).toBe('mic-refused');
    fx.now += 365 * DAY;
    expect(await createInAppReach(deps()).update(live('o9'))).toBe('mic-off');
    expect(cards()).toBe(2);
    expect(count('register')).toBe(0);
  });

  it('[S3-6] a card nobody answers never stalls the runner: closed after the bound, "not now" for this run', async () => {
    fx.card = 'never';
    const reach = createInAppReach(deps());
    const pending = reach.update(live('o1'));
    await vi.waitFor(() => expect(fx.sleepers.length).toBe(1));
    fx.sleepers[0]!();
    expect(await pending).toBe('mic-later');
    expect(fx.log).toContain('card-closed');
    expect(fx.disk).toBeNull();
    // the runner is free: the next reading runs
    fx.platform = 'ios';
    fx.now += REACH_RETRY_MS;
    expect(await reach.update(live('o2'))).toBe('registered');
  });

  it('[S3-6] a system prompt that never answers is bounded the same way', async () => {
    fx.micAnswer = 'never';
    const reach = createInAppReach(deps());
    const pending = reach.update(live('o1'));
    await vi.waitFor(() => expect(fx.sleepers.length).toBe(2));
    fx.sleepers[1]!();
    expect(await pending).toBe('mic-later');
    expect(fx.disk).toBeNull();
  });

  it('[S3-2] a phone that registered and then lost the microphone is unregistered (its calls go to the phone bridge)', async () => {
    fx.mic = true;
    const reach = createInAppReach(deps());
    expect(await reach.update(live('o1'))).toBe('registered');
    fx.mic = false; fx.card = 'not-now';
    fx.now += REACH_RETRY_MS;
    expect(await reach.update(live('o1'))).toBe('mic-refused');
    expect(count('unregister')).toBe(1);
    expect(fx.registered).toBe(false);
  });

  it('the microphone already on: no card at all, straight to register', async () => {
    fx.mic = true;
    expect(await createInAppReach(deps()).update(live('o1'))).toBe('registered');
    expect(cards()).toBe(0);
  });

  it('iPhone: never asks here (the system asks on Answer)', async () => {
    fx.platform = 'ios';
    expect(await createInAppReach(deps()).update(live('o1'))).toBe('registered');
    expect(cards()).toBe(0);
  });
});
