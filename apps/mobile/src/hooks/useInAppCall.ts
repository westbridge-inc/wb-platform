import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';
import { toast } from '../kit/toast';
import type { CallTarget } from '../lib/callBridge';
import { INAPP_WORDS, backupRevealText, inAppErrorText, offerInApp, revealsBackup, type BackupKind, type InAppConfig } from '../lib/inAppCalls';
import {
  endInAppCall,
  ensureMicrophone,
  inCallSnapshot,
  inAppCallActive,
  inAppVoiceAvailable,
  placeInAppCall,
  registerForInAppCalls,
  subscribeInCall,
} from '../services/inAppVoice';

// [INAPP-CALLS] One answer per app run for a few minutes (as the bridge's config); a failed read means
// "not on" (the "Call via Swift" control beside it is unaffected), and is asked again next time.
const CONFIG_TTL_MS = 5 * 60_000;
let cached: { at: number; value: InAppConfig } | null = null;
let inflight: Promise<InAppConfig | null> | null = null;
/** Loaded on first use: screens with a Call button do not pull the API client in at import. */
const calls = async () => (await import('../services/api')).callsApi;

export async function loadInAppConfig(now = Date.now()): Promise<InAppConfig | null> {
  if (cached && now - cached.at < CONFIG_TTL_MS) return cached.value;
  inflight ??= calls().then((api) => api.appConfig())
    .then((res) => { const d = res.data?.data; return d && typeof d.enabled === 'boolean' ? { enabled: d.enabled } : null; })
    .catch(() => null)
    .then((value) => { cached = value ? { at: Date.now(), value } : null; inflight = null; return value; });
  return inflight;
}

/**
 * [CALLS-UX review S3] How long the backup control waits for the switch before it shows anyway. The read can take
 * up to the API client's GET timeout (20 s); nobody is left that long with no way to call.
 */
const CONFIG_GRACE_MS = 4_000;
let configGraceMs = CONFIG_GRACE_MS;

/** Tests only. */
export function resetInAppConfigForTests(opts: { graceMs?: number } = {}): void {
  cached = null; inflight = null; backups.clear(); backupKinds.clear();
  configGraceMs = opts.graceMs ?? CONFIG_GRACE_MS;
}

// ---------------------------------------------------------------------------
// [CALLS-UX · owner 8 Nov 2026, "A"] In-app first, the number only as a backup. While "Call in app" is offered
// for a person, the dial / "Call via Swift" control beside it is hidden. It comes back (the backup) for that
// person on that order when the server says the in-app call cannot happen (they cannot be rung in the app, Swift
// cannot tell, the switch went off, or this phone's microphone is refused): see revealsBackup in lib/inAppCalls.
// No extra read: the answer is the one POST /calls/app already gives (party checked first, 404 for anyone else,
// refused before any call row, so no attempt is spent). Kept a few minutes, so the screen does not ask again.
// ---------------------------------------------------------------------------

const BACKUP_TTL_MS = 10 * 60_000;
const backups = new Map<string, number>();
const backupListeners = new Set<() => void>();
const backupKey = (orderId: string, target: CallTarget) => `${orderId}:${target}`;

/** Show the backup call control for this person on this order (the in-app call could not happen). */
export function revealBackupCall(orderId: string, target: CallTarget, now = Date.now()): void {
  backups.set(backupKey(orderId, target), now);
  for (const l of [...backupListeners]) l();
}

/** Has the backup been revealed for this person on this order (in the last few minutes)? */
export function backupRevealed(orderId: string | null | undefined, target: CallTarget, now = Date.now()): boolean {
  if (!orderId) return false;
  const at = backups.get(backupKey(orderId, target));
  if (at === undefined) return false;
  if (now - at >= BACKUP_TTL_MS) { backups.delete(backupKey(orderId, target)); return false; }
  return true;
}

const subscribeBackups = (listener: () => void) => { backupListeners.add(listener); return () => { backupListeners.delete(listener); }; };
let backupVersion = 0;
backupListeners.add(() => { backupVersion += 1; });

/**
 * [CALLS-UX review S2] Which backup control CallParty draws for this person on this order, so the words shown when
 * it comes back name that control. Written by CallParty itself (useBackupCallShown); unknown means none (chat only:
 * the words never promise a button that is not there).
 */
const backupKinds = new Map<string, { kind: BackupKind; owner: object }>();
export function backupKindFor(orderId: string, target: CallTarget): BackupKind {
  return backupKinds.get(backupKey(orderId, target))?.kind ?? 'none';
}

/** The switch as the backup control sees it: still being read, could not be read (null), or the answer. */
type ConfigState = InAppConfig | null | 'loading';

/**
 * For the dial / "Call via Swift" control: should it show beside "Call in app"? `kind` is what that control is.
 * - Yes when "Call in app" can never be offered here (build 12 without the module, the parcel recipient, no order),
 *   or when the backup has been revealed for this person.
 * - [CALLS-UX review S3] While the switch is being read: no (it would flash and be tappable, then vanish); after a
 *   short grace, or when the read fails: yes (never no way to call). A loaded switch decides.
 */
export function useBackupCallShown(orderId: string | null | undefined, target: CallTarget, kind: BackupKind = 'none'): boolean {
  const available = inAppVoiceAvailable();
  const [config, setConfig] = useState<ConfigState>(() => cached?.value ?? 'loading');
  const [owner] = useState(() => ({}));
  useSyncExternalStore(subscribeBackups, () => backupVersion);
  useEffect(() => {
    if (!available) return undefined; // build 12: never read the switch for this
    let live = true;
    const grace = setTimeout(() => { if (live) setConfig((c) => (c === 'loading' ? null : c)); }, configGraceMs);
    void loadInAppConfig().then((c) => { if (live) setConfig(c); });
    return () => { live = false; clearTimeout(grace); };
  }, [available]);
  useEffect(() => {
    if (!orderId) return undefined;
    const key = backupKey(orderId, target);
    backupKinds.set(key, { kind, owner });
    return () => { if (backupKinds.get(key)?.owner === owner) backupKinds.delete(key); };
  }, [orderId, target, kind, owner]);
  if (backupRevealed(orderId, target)) return true;
  if (!available || !orderId || target === 'recipient') return true; // "Call in app" can never show: no wait
  if (config === 'loading') return false;
  return !offerInApp(config, available, orderId, target);
}

/** Swift's own words before Android's bare microphone prompt. Resolves true on "Continue". */
function explainMicrophone(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(INAPP_WORDS.micTitle, INAPP_WORDS.micWhy, [
      { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Continue', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

/** The server's code, else the thrown one (placeInAppCall's own). Only words: an SDK error's number is not a code here. */
const errorCode = (e: unknown): string | null => {
  const c = (e as { response?: { data?: { error?: { code?: unknown } } } })?.response?.data?.error?.code
    ?? (e as { code?: unknown })?.code;
  return typeof c === 'string' ? c : null;
};

/**
 * "Call in app" for one person on one order. Each screen keeps its own look: it shows the control when
 * `visible`, labels it with `label`, and calls `onPress`. While visible it also keeps this phone able to be
 * rung in the app (registration with a short server token; only people on a live order get one).
 * [CALLS-REACH] That is no longer the only way: components/InAppCallReach registers anyone on a live order,
 * whatever screen shows (a customer on a store pickup order never sees a call control).
 */
export function useInAppCall(input: { orderId?: string | null; target: CallTarget }) {
  const [config, setConfig] = useState<InAppConfig | null>(cached?.value ?? null);
  const [busy, setBusy] = useState(false);
  // [CALLS-UX] On a call (placed or answered here): the same call the in-call bar shows.
  const onCall = useSyncExternalStore(subscribeInCall, inCallSnapshot) !== null;
  const busyRef = useRef(false);
  const available = inAppVoiceAvailable();
  const { orderId, target } = input;
  const visible = offerInApp(config, available, orderId, target);

  useEffect(() => {
    if (!available) return undefined; // [CALLS-UX] build 12: "Call in app" can never show, so the switch is not read
    let live = true;
    void loadInAppConfig().then((c) => { if (live) setConfig(c); });
    return () => { live = false; };
  }, [available]);

  useEffect(() => {
    if (!visible) return;
    void registerForInAppCalls(async (platform, purpose) => (await (await calls()).appToken(platform, purpose)).data.data.token);
  }, [visible]);

  const onPress = useCallback(async () => {
    if (!visible || !orderId || busyRef.current) return;
    if (inAppCallActive()) { await endInAppCall(); return; }
    busyRef.current = true;
    setBusy(true);
    // [CALLS-UX] The in-app call cannot happen: the backup control comes back, and the words name that control
    // (review S2: never the server's "message them in chat instead" beside a Call button).
    const fallBack = (title: string, code: string) => {
      revealBackupCall(orderId, target);
      toast.error(title, backupRevealText(code, backupKindFor(orderId, target)));
    };
    try {
      if (!(await ensureMicrophone(explainMicrophone))) {
        fallBack(INAPP_WORDS.micTitle, 'MIC_REFUSED'); // this phone cannot talk in the app
        return;
      }
      const api = await calls();
      await placeInAppCall(orderId, target, {
        start: async (o, t, platform) => (await api.appStart(o, t, platform)).data.data,
        cancel: (callId) => api.appCancel(callId),
        // [CALLS-UX review S3] Accepted by the server, then the SDK reported it never connected.
        onConnectFailure: () => fallBack(INAPP_WORDS.failedTitle, 'INAPP_CONNECT_FAILED'),
      });
      toast.success(INAPP_WORDS.calling, INAPP_WORDS.callingHow);
    } catch (e) {
      const code = errorCode(e);
      if (code && revealsBackup(code)) {
        fallBack(INAPP_WORDS.failedTitle, code);
        return;
      }
      toast.error(INAPP_WORDS.failedTitle, inAppErrorText(code));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [visible, orderId, target]);

  return {
    visible,
    label: onCall ? INAPP_WORDS.endLabel : INAPP_WORDS.label,
    hint: INAPP_WORDS.hint,
    a11y: onCall ? INAPP_WORDS.endLabel : INAPP_WORDS.a11y,
    busy,
    onPress: () => { void onPress(); },
  };
}
