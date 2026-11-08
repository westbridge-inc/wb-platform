import { type ComponentProps, type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space, withAlpha } from '@swift/ui';
import { T } from '../kit';
import { INCALL_WORDS, inCallStatus, type InCallSnapshot } from '../lib/inCallBar';
import {
  endInAppCall,
  inAppVoiceAvailable,
  inCallSnapshot,
  mayBeRegistered,
  setInCallMuted,
  setInCallSpeaker,
  subscribeInCall,
  syncInAppCalls,
} from '../services/inAppVoice';

// ---------------------------------------------------------------------------
// [CALLS-UX · owner 8 Nov 2026, "B"] While an in-app call is on (placed here, or answered from the system's call
// screen or notification), a bar across the top of every screen: the call's state and time, Mute, Speaker and
// Hang up. Android has no in-call screen of its own for these calls; iPhone keeps CallKit's, and this bar only
// follows the route the phone reports (see services/inAppVoice setInCallSpeaker), so the two agree.
// Builds without the calling module (11/12): nothing, not even a listener.
// Like the offline banner, it moves the screens down by its own height below the status bar, never over them.
// ---------------------------------------------------------------------------

/** The bar's body below the status bar (it is measured; this is the floor). */
const MIN_BODY = 52;

function useInCall(): InCallSnapshot | null {
  return useSyncExternalStore(subscribeInCall, inCallSnapshot);
}

/** One second ticks only while connected (the timer); nothing runs otherwise. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return now;
}

function BarButton(props: {
  icon: ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  hint: string;
  on?: boolean;
  danger?: boolean;
  onPress: () => void;
  testID: string;
}) {
  const bg = props.danger ? color.error : props.on ? color.white : withAlpha(color.white, 0.14);
  const fg = props.on && !props.danger ? color.text.primary : color.white;
  return (
    <Pressable
      testID={props.testID}
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityHint={props.hint}
      accessibilityState={props.on === undefined ? undefined : { selected: props.on }}
      style={({ pressed }) => ({ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
    >
      <View style={{ width: 40, height: 40, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', backgroundColor: bg }}>
        <MaterialCommunityIcons name={props.icon} size={20} color={fg} />
      </View>
    </Pressable>
  );
}

export function InCallBar({ snap, onBodyHeight }: { snap: InCallSnapshot; onBodyHeight?: (h: number) => void }) {
  const insets = useSafeAreaInsets();
  const now = useNow(snap.phase === 'connected');
  const status = inCallStatus(snap, now);
  return (
    <View
      testID="in-call-bar"
      onLayout={(e) => onBodyHeight?.(Math.max(MIN_BODY, Math.ceil(e.nativeEvent.layout.height - insets.top)))}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        paddingTop: insets.top + 4,
        paddingBottom: 4,
        paddingHorizontal: space.lg,
        backgroundColor: color.text.primary,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        zIndex: 10000,
        elevation: 10000,
      }}
    >
      <View style={{ flex: 1 }} accessible accessibilityLiveRegion="polite" accessibilityLabel={`${INCALL_WORDS.title}, ${status}`}>
        <T variant="caption" weight="semibold" style={{ color: color.white }} numberOfLines={1}>
          {INCALL_WORDS.title}
        </T>
        <T variant="caption" style={{ color: color.white }} numberOfLines={1} testID="in-call-status">
          {status}
        </T>
      </View>
      <BarButton
        testID="in-call-mute"
        icon={snap.muted ? 'microphone-off' : 'microphone'}
        label={snap.muted ? INCALL_WORDS.unmute : INCALL_WORDS.mute}
        hint={INCALL_WORDS.muteHint}
        on={snap.muted}
        onPress={() => { void setInCallMuted(!snap.muted); }}
      />
      <BarButton
        testID="in-call-speaker"
        icon={snap.routePicker ? 'bluetooth-audio' : 'volume-high'}
        label={snap.routePicker ? INCALL_WORDS.audio : INCALL_WORDS.speaker}
        hint={snap.routePicker ? INCALL_WORDS.audioHint : INCALL_WORDS.speakerHint}
        on={snap.routePicker ? undefined : snap.speaker}
        onPress={() => { void setInCallSpeaker(!snap.speaker); }}
      />
      <BarButton
        testID="in-call-hang-up"
        icon="phone-hangup"
        label={INCALL_WORDS.hangUp}
        hint={INCALL_WORDS.hangUpHint}
        danger
        onPress={() => { void endInAppCall(); }}
      />
    </View>
  );
}

/**
 * Wraps the app's screens: while a call is on, the bar sits at the top and the screens move down below it.
 * Also asks the SDK for its calls when the app comes back (a call answered while the app was closed).
 */
export function InCallBoundary({ children }: { children: ReactNode }) {
  const available = inAppVoiceAvailable();
  const snap = useInCall();
  const [body, setBody] = useState(MIN_BODY);
  useEffect(() => {
    if (!available) return undefined;
    // Only a phone that has registered to be rung can hold an answered call; calls placed here are followed already.
    const sync = () => { if (mayBeRegistered()) void syncInAppCalls(); };
    sync();
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') sync(); });
    return () => sub.remove();
  }, [available]);
  const show = available && snap !== null;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1, paddingTop: show ? body : 0 }}>{children}</View>
      {show ? <InCallBar snap={snap} onBodyHeight={(h) => setBody((cur) => (cur === h ? cur : h))} /> : null}
    </View>
  );
}
