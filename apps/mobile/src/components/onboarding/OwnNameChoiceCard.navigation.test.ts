/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [OWNER-ASKS 9 Nov 2026] "Sell on Swift": the card "What name does your store use?" showed two boxes with no words
// and the declaration ended in a third box with no words. The card is drawn with the REAL kit control (only native
// drawing is mocked): each choice says what it is, the choices are radio buttons (one or the other), the declaration
// has a plain title and its version, and its tick reads "I have read and agree to this declaration."
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, children);
  const Pressable = ({ children, onPress, accessibilityLabel, accessibilityRole, accessibilityState }: any) =>
    R.createElement('button', {
      type: 'button', 'aria-label': accessibilityLabel, 'data-role': accessibilityRole, 'data-checked': String(!!accessibilityState?.checked), onClick: onPress,
    }, typeof children === 'function' ? children({ pressed: false }) : children);
  return { View, Pressable, Switch: () => null, StyleSheet: { flatten: (s: unknown) => s, create: (s: unknown) => s } };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../kit/card', () => ({ cardShadow: {} }));
vi.mock('../../kit/glyphs', () => ({ HeartGlyph: () => null, StarGlyph: () => null }));
vi.mock('../../lib/haptics', () => ({ haptic: { select: () => {}, light: () => {} } }));
vi.mock('../../kit/text', async () => {
  const R = await import('react');
  return { T: ({ children }: any) => R.createElement('span', null, children) };
});
vi.mock('../../kit', async () => {
  const R = await import('react');
  const controls = await vi.importActual<Record<string, unknown>>('../../kit/controls');
  return {
    ...controls,
    Card: ({ children }: any) => R.createElement('section', null, children),
    T: ({ children }: any) => R.createElement('span', null, children),
  };
});

import { OwnNameChoiceCard } from './OwnNameChoiceCard';
import { BUSINESS_NAME_CHOICE, OWN_NAME_CHOICE, OWN_NAME_DECLARATION_V1, OWN_NAME_TICK } from '../../lib/ownNameCopy';

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); host = undefined; root = undefined;
});

/** Every choice the card reports, in order. */
const chosen: Array<'OWN_NAME' | 'REGISTERED'> = [];
afterEach(() => { chosen.length = 0; });

/** The store sign-up's own wiring (BusinessSetup.tsx): a choice reported to it sets the basis and clears the tick. */
function Harness({ storeName }: { storeName: string }) {
  const [nameBasis, setNameBasis] = React.useState<'OWN_NAME' | 'REGISTERED'>('REGISTERED');
  const [tick, setTick] = React.useState(false);
  return React.createElement(OwnNameChoiceCard, {
    storeName, nameBasis, ownNameTick: tick,
    onNameBasis: (basis: 'OWN_NAME' | 'REGISTERED') => { chosen.push(basis); setNameBasis(basis); setTick(false); },
    onToggleTick: () => setTick((t) => !t),
  });
}
const mount = async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(React.createElement(Harness, { storeName: 'R. Persaud' })));
};
const control = (role: string, name: string) =>
  [...host!.querySelectorAll(`button[data-role="${role}"]`)].find((b) => b.getAttribute('aria-label') === name) as HTMLButtonElement | undefined;

describe('[OWNER-ASKS 9 Nov] "What name does your store use?" explains every box', () => {
  it('the two choices are radio buttons whose words are on screen', async () => {
    await mount();
    expect(host!.textContent).toContain('What name does your store use?');
    for (const words of [OWN_NAME_CHOICE, BUSINESS_NAME_CHOICE]) {
      const choice = control('radio', words);
      expect(choice, words).toBeTruthy();
      expect(choice!.textContent).toContain(words);
    }
    expect(control('radio', BUSINESS_NAME_CHOICE)!.getAttribute('data-checked')).toBe('true');
    expect(control('radio', OWN_NAME_CHOICE)!.getAttribute('data-checked')).toBe('false');
  });

  it('own name: a plain title and its version, the declaration word for word, and a tick that says what it is', async () => {
    await mount();
    expect(host!.textContent).not.toContain('Declaration: I trade under my own name');
    await act(async () => control('radio', OWN_NAME_CHOICE)!.click());
    expect(control('radio', OWN_NAME_CHOICE)!.getAttribute('data-checked')).toBe('true');
    const text = host!.textContent!;
    expect(text).toContain('Declaration: I trade under my own name');
    expect(text).toContain('Version 1');
    expect(text).not.toContain('I TRADE UNDER MY OWN NAME (v1)');
    for (const line of OWN_NAME_DECLARATION_V1.split('\n').slice(1).filter(Boolean)) expect(text).toContain(line);
    const tick = control('checkbox', OWN_NAME_TICK);
    expect(tick).toBeTruthy();
    expect(tick!.textContent).toContain('I have read and agree to this declaration.');
    await act(async () => tick!.click());
    expect(control('checkbox', OWN_NAME_TICK)!.getAttribute('data-checked')).toBe('true');
  });

  it('tapping the choice already chosen keeps the declaration ticked: only a real change is reported', async () => {
    await mount();
    await act(async () => control('radio', OWN_NAME_CHOICE)!.click());
    await act(async () => control('checkbox', OWN_NAME_TICK)!.click());
    expect(control('checkbox', OWN_NAME_TICK)!.getAttribute('data-checked')).toBe('true');
    await act(async () => control('radio', OWN_NAME_CHOICE)!.click());
    expect(control('radio', OWN_NAME_CHOICE)!.getAttribute('data-checked')).toBe('true');
    expect(control('checkbox', OWN_NAME_TICK)!.getAttribute('data-checked')).toBe('true');
    expect(chosen).toEqual(['OWN_NAME']);
    // Control: a real change is still reported, and the sign-up still clears the tick for it.
    await act(async () => control('radio', BUSINESS_NAME_CHOICE)!.click());
    await act(async () => control('radio', BUSINESS_NAME_CHOICE)!.click());
    expect(chosen).toEqual(['OWN_NAME', 'REGISTERED']);
    await act(async () => control('radio', OWN_NAME_CHOICE)!.click());
    expect(control('checkbox', OWN_NAME_TICK)!.getAttribute('data-checked')).toBe('false');
  });

  it('the copy is the owner’s', () => {
    expect(OWN_NAME_CHOICE).toBe('My own name — I’m one person trading under just my surname, with or without my first names or initials (for example “Persaud” or “R. Persaud”)');
    expect(BUSINESS_NAME_CHOICE).toBe('A registered business name or a company (I have the DCRA certificate)');
    expect(OWN_NAME_TICK).toBe('I have read and agree to this declaration.');
  });
});
