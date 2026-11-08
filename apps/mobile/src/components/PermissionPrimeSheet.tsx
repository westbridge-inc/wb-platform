/** @jsxImportSource react */
import React from 'react';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { DecorativeIcon, LinkText, PillButton, PopupCard, PopupTitle, T } from '../kit';
import { PRIME_COPY, answerCallsMicrophone, markPrimeAsked, usePrimeStore } from '../services/notification-priming';
import { registerDeviceForPush } from '../services/push';
import { INAPP_WORDS } from '../lib/inAppCalls';

// The one-line priming card [first-open SO-5]: shows once, at an in-context
// moment (order placed / application submitted / store created), BEFORE the
// OS dialog. "Not now" is a real answer — the app keeps working untouched.
export function PermissionPrimeSheet() {
  const moment = usePrimeStore((s) => s.visibleMoment);
  const micAsk = usePrimeStore((s) => s.micAsk);
  const dismiss = usePrimeStore((s) => s.dismiss);

  // [CALLS-REACH] The in-app calls microphone (Android), in the same slot: the notifications card waits behind it.
  // Closing it (back, outside) is not an answer; "Not now" is.
  if (micAsk) {
    return (
      <PopupCard visible onClose={() => answerCallsMicrophone('dismissed')}>
        <DecorativeIcon
          style={{
            width: 44,
            height: 44,
            borderRadius: radius.full,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: color.brand[50],
            marginBottom: space.md,
          }}
        >
          <Feather name="mic" size={20} color={color.brand[600]} />
        </DecorativeIcon>
        <PopupTitle variant="body" weight="bold" center>
          {INAPP_WORDS.reachTitle}
        </PopupTitle>
        <T variant="caption" tone="muted" center style={{ marginTop: space.sm, marginBottom: space.lg }}>
          {micAsk === 'partner' ? INAPP_WORDS.reachWhyPartner : INAPP_WORDS.reachWhyCustomer}
        </T>
        <PillButton label="Continue" onPress={() => answerCallsMicrophone('allow')} style={{ alignSelf: 'stretch', marginBottom: space.md }} />
        <LinkText label="Not now" tone="muted" onPress={() => answerCallsMicrophone('not-now')} />
      </PopupCard>
    );
  }

  const answer = (turnOn: boolean) => {
    markPrimeAsked();
    dismiss();
    if (turnOn) void registerDeviceForPush();
  };

  return (
    <PopupCard visible={moment != null} onClose={() => answer(false)}>
      <DecorativeIcon
        style={{
          width: 44,
          height: 44,
          borderRadius: radius.full,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: color.brand[50],
          marginBottom: space.md,
        }}
      >
        <Feather name="bell" size={20} color={color.brand[600]} />
      </DecorativeIcon>
      <PopupTitle variant="body" weight="bold" center>
        Turn on notifications?
      </PopupTitle>
      <T variant="caption" tone="muted" center style={{ marginTop: space.sm, marginBottom: space.lg }}>
        {moment ? PRIME_COPY[moment] : ''}
      </T>
      <PillButton label="Turn on" onPress={() => answer(true)} style={{ alignSelf: 'stretch', marginBottom: space.md }} />
      <LinkText label="Not now" tone="muted" onPress={() => answer(false)} />
    </PopupCard>
  );
}
