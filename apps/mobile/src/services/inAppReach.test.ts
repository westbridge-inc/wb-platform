import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { INAPP_WORDS } from '../lib/inAppCalls';
import { reachSignal, reachSignalFromCache, type ReachSignal } from '../lib/inAppReach';
import { REACH_RETRY_MS, createInAppReach, type MicAnswer, type ReachDeps } from './inAppReach';

// [CALLS-REACH · live test 8 Nov 2026] The store called a customer on a pickup order (no rider); the customer's
// phone had never registered, because it registered only while a "Call in app" control was on screen. Now a
// phone on a live order registers whatever the screen, Android asks for the microphone once in Swift's words,
// and a "no" is never a nag.

type Fx = {
  available: boolean; enabled: boolean; platform: 'ios' | 'android'; foreground: boolean; mic: boolean;
  explainAnswer: boolean; micAnswer: MicAnswer; now: number; disk: string | null;
  log: string[];
};
let fx: Fx;

function deps(): ReachDeps & { explain: ReturnType<typeof vi.fn>; register: ReturnType<typeof vi.fn>; unregister: ReturnType<typeof vi.fn>; enabled: ReturnType<typeof vi.fn> } {
  return {
    available: () => fx.available,
    enabled: vi.fn(async () => { fx.log.push('config'); return fx.enabled; }),
    register: vi.fn(async () => { fx.log.push('register'); return true; }),
    unregister: vi.fn(async () => { fx.log.push('unregister'); return true; }),
    platform: () => fx.platform,
    foreground: () => fx.foreground,
    micGranted: async () => fx.mic,
    explain: vi.fn(async (title: string, body: string) => { fx.log.push(`explain:${title}|${body}`); return fx.explainAnswer; }),
    requestMic: async () => { fx.log.push('system-prompt'); if (fx.micAnswer === 'granted') fx.mic = true; return fx.micAnswer; },
    memory: { get: () => fx.disk, set: (v: string) => { fx.disk = v; } },
    now: () => fx.now,
  };
}

const live = (...ids: string[]): ReachSignal => reachSignal({ customerLive: { items: ids.map((id) => ({ id, status: 'PREPARING' })) } });
const none = (): ReachSignal => reachSignal({ customerLive: { items: [] } });
const registers = () => fx.log.filter((l) => l === 'register').length;
const explains = () => fx.log.filter((l) => l.startsWith('explain:')).length;

beforeEach(() => {
  fx = { available: true, enabled: true, platform: 'ios', foreground: true, mic: false, explainAnswer: true, micAnswer: 'granted', now: 10_000_000, disk: null, log: [] };
});

describe('[CALLS-REACH] a phone on a live order registers, with no call control on screen', () => {
  it('a customer with a store pickup order (no rider): registers from what the app holds, nothing else needed', async () => {
    const client = new QueryClient();
    // What GET /customer/orders?live=true answers for them (the same read the Activity list makes).
    client.setQueryData(['customer', 'orders', 'live'], { items: [{ id: 'o-pickup', status: 'PREPARING', fulfillment: 'PICKUP', riderId: null }], total: 1 });
    const d = deps();
    const reach = createInAppReach(d);
    expect(await reach.update(reachSignalFromCache(client))).toBe('registered');
    expect(d.register).toHaveBeenCalledTimes(1);
    expect(fx.log).toEqual(['config', 'register']);
  });

  it('a rider with an active job, a store with an open order: the same', async () => {
    for (const signal of [reachSignal({ moverActive: [{ id: 'j1', status: 'PICKED_UP' }] }), reachSignal({ storeOrders: [{ id: 's1', status: 'PENDING' }] })]) {
      fx.log = [];
      expect(await createInAppReach(deps()).update(signal)).toBe('registered');
      expect(registers()).toBe(1);
    }
  });

  it('the board\'s reads every few seconds never hammer the server: one register a minute at most (the voice service keeps ten)', async () => {
    const reach = createInAppReach(deps());
    await reach.update(live('o1'));
    fx.now += 5_000;
    expect(await reach.update(live('o1'))).toBe('throttled');
    fx.now += REACH_RETRY_MS;
    expect(await reach.update(live('o1'))).toBe('registered');
    expect(registers()).toBe(2);
  });

  it('signals that arrive while one runs: only the newest is run next', async () => {
    let release!: () => void;
    const d = deps();
    d.register.mockImplementationOnce(() => new Promise<boolean>((r) => { release = () => r(true); }));
    const reach = createInAppReach(d);
    const first = reach.update(live('o1'));
    await vi.waitFor(() => expect(d.register).toHaveBeenCalledTimes(1));
    void reach.update(live('o2'));
    void reach.update(none());
    release();
    await first;
    await vi.waitFor(() => expect(d.unregister).toHaveBeenCalledTimes(1));
    expect(d.register).toHaveBeenCalledTimes(1);
  });
});

describe('[CALLS-REACH] no live order, calls off, or no calling module: nothing', () => {
  it('no live order: never registers; nothing read yet is not "none" either', async () => {
    const d = deps();
    const reach = createInAppReach(d);
    expect(await reach.update(none())).toBe('idle');
    expect(await reach.update(reachSignal({}))).toBe('waiting');
    expect(d.register).not.toHaveBeenCalled();
    expect(d.unregister).not.toHaveBeenCalled();
  });

  it('the server switch off: never registers, never asks for the microphone', async () => {
    fx.enabled = false; fx.platform = 'android';
    const d = deps();
    expect(await createInAppReach(d).update(live('o1'))).toBe('off');
    expect(d.register).not.toHaveBeenCalled();
    expect(d.explain).not.toHaveBeenCalled();
  });

  it('build 12 (no voice module): a no-op, not even the config read', async () => {
    fx.available = false; fx.platform = 'android';
    const d = deps();
    const reach = createInAppReach(d);
    expect(await reach.update(live('o1'))).toBe('unavailable');
    expect(await reach.update(none())).toBe('unavailable');
    expect(fx.log).toEqual([]);
  });
});

describe('[CALLS-REACH] the last live order ends, or the person signs out', () => {
  it('live, then none: unregisters once; none from the start never does', async () => {
    const d = deps();
    const reach = createInAppReach(d);
    await reach.update(live('o1'));
    expect(await reach.update(none())).toBe('unregistered');
    expect(await reach.update(none())).toBe('idle');
    expect(d.unregister).toHaveBeenCalledTimes(1);
    // a new order registers again at once (no wait left over from the last one)
    expect(await reach.update(live('o2'))).toBe('registered');
  });

  it('sign-out / account switch: the state is forgotten (the auth teardown unregisters the phone), and a register in flight for the old account is dropped', async () => {
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
    // the next account had no live order before: its first "none" unregisters nothing
    expect(await reach.update(none())).toBe('idle');
    expect(d.unregister).not.toHaveBeenCalled();
  });
});

describe('[CALLS-REACH] Android without the microphone: Swift\'s words once, then the system prompt', () => {
  beforeEach(() => { fx.platform = 'android'; });

  it('explains in Swift\'s words first (customer), then asks; registers after the grant', async () => {
    const reach = createInAppReach(deps());
    expect(await reach.update(live('o1'))).toBe('registered');
    expect(fx.log).toEqual([
      'config',
      `explain:${INAPP_WORDS.reachTitle}|So the store, rider or driver can call you in Swift, allow the microphone. Swift never records calls.`,
      'system-prompt',
      'register',
    ]);
    // granted now: never explained again
    fx.now += REACH_RETRY_MS;
    await reach.update(live('o1', 'o2'));
    expect(explains()).toBe(1);
  });

  it('a partner reads words about the people on their orders', async () => {
    await createInAppReach(deps()).update(reachSignal({ storeOrders: [{ id: 's1', status: 'PENDING' }] }));
    expect(fx.log[1]).toBe(`explain:${INAPP_WORDS.reachTitle}|${INAPP_WORDS.reachWhyPartner}`);
    expect(INAPP_WORDS.reachWhyPartner).toContain('Swift never records calls.');
  });

  it('"Not now" is remembered: no system prompt, no register, and no nag for that order or for a week', async () => {
    fx.explainAnswer = false;
    const reach = createInAppReach(deps());
    expect(await reach.update(live('o1'))).toBe('mic-refused');
    expect(fx.log).not.toContain('system-prompt');
    expect(registers()).toBe(0);
    fx.now += 3 * 24 * 60 * 60_000;
    expect(await reach.update(live('o1'))).toBe('mic-off');
    expect(await reach.update(live('o2'))).toBe('mic-off');
    // an app restart reads the same memory from the phone
    expect(await createInAppReach(deps()).update(live('o3'))).toBe('mic-off');
    expect(explains()).toBe(1);
    // a week on, a NEW order: asked once more
    fx.now += 7 * 24 * 60 * 60_000;
    expect(await createInAppReach(deps()).update(live('o4'))).toBe('mic-refused');
    expect(explains()).toBe(2);
  });

  it('a "no" at the system prompt is remembered the same way; "don\'t ask again" is for good', async () => {
    fx.micAnswer = 'denied';
    expect(await createInAppReach(deps()).update(live('o1'))).toBe('mic-refused');
    expect(await createInAppReach(deps()).update(live('o1'))).toBe('mic-off');
    fx.micAnswer = 'never_ask_again';
    fx.now += 8 * 24 * 60 * 60_000;
    expect(await createInAppReach(deps()).update(live('o2'))).toBe('mic-refused');
    fx.now += 365 * 24 * 60 * 60_000;
    expect(await createInAppReach(deps()).update(live('o9'))).toBe('mic-off');
    expect(explains()).toBe(2);
    expect(registers()).toBe(0);
  });

  it('never explained to a phone that is not on screen (asked when it comes back)', async () => {
    fx.foreground = false;
    const reach = createInAppReach(deps());
    expect(await reach.update(live('o1'))).toBe('waiting');
    expect(explains()).toBe(0);
    fx.foreground = true;
    expect(await reach.update(live('o1'))).toBe('registered');
    expect(explains()).toBe(1);
  });

  it('the microphone already on: no words at all, straight to register', async () => {
    fx.mic = true;
    expect(await createInAppReach(deps()).update(live('o1'))).toBe('registered');
    expect(explains()).toBe(0);
  });

  it('iPhone: never asks here (the system asks on Answer)', async () => {
    fx.platform = 'ios';
    expect(await createInAppReach(deps()).update(live('o1'))).toBe('registered');
    expect(explains()).toBe(0);
  });
});
