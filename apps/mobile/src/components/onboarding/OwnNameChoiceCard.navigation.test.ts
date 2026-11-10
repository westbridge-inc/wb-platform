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
import { COMPANY_CHOICE, COMPANY_HINT, MANAGER_HINT, MANAGER_TICK, REGISTERED_HINT, SERVICE_OWNER_CHOICE } from '../../lib/businessBasisCopy';

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); host = undefined; root = undefined;
});

/** Every choice the card reports, in order. */
const chosen: Array<'OWN_NAME' | 'REGISTERED' | 'COMPANY'> = [];
afterEach(() => { chosen.length = 0; });

/** The store sign-up's own wiring (BusinessSetup.tsx): a choice reported to it sets the basis and clears the ticks. */
function Harness({ storeName, vendorType }: { storeName: string; vendorType?: string }) {
  const [nameBasis, setNameBasis] = React.useState<'OWN_NAME' | 'REGISTERED' | 'COMPANY'>('REGISTERED');
  const [tick, setTick] = React.useState(false);
  const [manager, setManager] = React.useState(false);
  return React.createElement(OwnNameChoiceCard, {
    storeName, nameBasis, ownNameTick: tick, vendorType, managerNotOwner: manager,
    onNameBasis: (basis: 'OWN_NAME' | 'REGISTERED' | 'COMPANY') => { chosen.push(basis); setNameBasis(basis); setTick(false); setManager(false); },
    onToggleTick: () => setTick((t) => !t),
    onToggleManager: () => setManager((m) => !m),
  });
}
const mount = async (vendorType?: string) => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(React.createElement(Harness, { storeName: 'R. Persaud', vendorType })));
};
const control = (role: string, name: string) =>
  [...host!.querySelectorAll(`button[data-role="${role}"]`)].find((b) => b.getAttribute('aria-label') === name) as HTMLButtonElement | undefined;

describe('[OWNER-ASKS 9 Nov · COMPANY-DOCS 10 Nov] "How is your business set up?" explains every box', () => {
  it('the three choices are radio buttons whose words are on screen, in the owner’s order', async () => {
    await mount();
    expect(host!.textContent).toContain('How is your business set up?');
    const radios = [...host!.querySelectorAll('button[data-role="radio"]')].map((b) => b.getAttribute('aria-label'));
    expect(radios).toEqual([COMPANY_CHOICE, BUSINESS_NAME_CHOICE, OWN_NAME_CHOICE]);
    for (const words of [OWN_NAME_CHOICE, BUSINESS_NAME_CHOICE, COMPANY_CHOICE]) {
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
    expect(OWN_NAME_CHOICE).toBe('I trade under my own name — I’m one person trading under just my surname, with or without my first names or initials (for example “Persaud” or “R. Persaud”)');
    expect(BUSINESS_NAME_CHOICE).toBe('We’re a registered business (a business name registered with the DCRA)');
    expect(COMPANY_CHOICE).toBe('We’re a registered company (incorporated, for example a “Ltd.” or “Inc.”)');
    expect(OWN_NAME_TICK).toBe('I have read and agree to this declaration.');
  });
});

describe('[COMPANY-DOCS · owner 10 Nov 2026] a company, a registered business or its manager: each says what it uploads', () => {
  it('a company is told its three papers, that one person manages the account, and that branches and staff upload nothing', async () => {
    await mount();
    await act(async () => control('radio', COMPANY_CHOICE)!.click());
    expect(chosen).toEqual(['COMPANY']);
    const text = host!.textContent!;
    expect(text).toContain(COMPANY_HINT);
    expect(COMPANY_HINT).toContain('Certificate of Incorporation');
    expect(COMPANY_HINT).toContain('One person manages your Swift account');
    expect(COMPANY_HINT).toContain('your branches and your staff don’t upload anything');
    expect(COMPANY_HINT).toContain('passport');
    expect(text).not.toContain('Declaration: I trade under my own name');
    expect(control('checkbox', MANAGER_TICK)).toBeUndefined();
  });

  it('a registered business offers “I’m the manager, not the owner”, which changes what it says to upload', async () => {
    await mount();
    expect(host!.textContent).toContain(REGISTERED_HINT);
    const manager = control('checkbox', MANAGER_TICK);
    expect(manager).toBeTruthy();
    await act(async () => manager!.click());
    expect(control('checkbox', MANAGER_TICK)!.getAttribute('data-checked')).toBe('true');
    expect(host!.textContent).toContain(MANAGER_HINT);
    expect(MANAGER_HINT).toContain('letter of authority signed by the owner');
    // another choice drops the manager tick
    await act(async () => control('radio', COMPANY_CHOICE)!.click());
    await act(async () => control('radio', BUSINESS_NAME_CHOICE)!.click());
    expect(control('checkbox', MANAGER_TICK)!.getAttribute('data-checked')).toBe('false');
  });

  it('a service business is asked only: a registered company, or its owner (no manager, no own name)', async () => {
    await mount('SERVICE');
    const radios = [...host!.querySelectorAll('button[data-role="radio"]')].map((b) => b.getAttribute('aria-label'));
    expect(radios).toEqual([COMPANY_CHOICE, SERVICE_OWNER_CHOICE]);
    expect(control('checkbox', MANAGER_TICK)).toBeUndefined();
  });
});
