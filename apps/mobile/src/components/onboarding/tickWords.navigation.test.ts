/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [OWNER-ASKS 9 Nov 2026] "It doesn't really explain the box": the kit's tick box (BrandCheckbox) carries its words
// only as a screen-reader label, so on the store's sign-up and go-live steps every box stood on screen with no words
// beside it: the own-name declaration's tick, the food handlers' tick and the weekly fee's tick. Each tick here is
// drawn with the REAL kit control (only native drawing is mocked) and its words must be on screen, beside the box,
// and a tap on the words ticks it.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
  feeData: null as unknown,
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, children);
  // The accessible name is an attribute, never text: only what is drawn counts as "on screen".
  const Pressable = ({ children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID }: any) =>
    R.createElement('button', {
      type: 'button', 'aria-label': accessibilityLabel, 'data-role': accessibilityRole, 'data-checked': String(!!accessibilityState?.checked),
      'data-testid': testID, onClick: onPress,
    }, typeof children === 'function' ? children({ pressed: false }) : children);
  return { View, Pressable, Switch: () => null, StyleSheet: { flatten: (s: unknown) => s, create: (s: unknown) => s } };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
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
    PillButton: ({ label }: { label: string }) => R.createElement('div', null, label),
    T: ({ children }: any) => R.createElement('span', null, children),
  };
});
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
  useMutation: () => ({ mutate: () => {}, isPending: false, isError: false, isSuccess: false, error: null }),
  useQuery: () => ({ data: fx.feeData, isError: false, refetch: () => Promise.resolve() }),
}));
vi.mock('../../services/api', () => ({ vendorApi: {} }));

import { OwnNameCard } from './OwnNameCard';
import { FoodHandlersCard } from './FoodHandlersCard';
import { StoreWeeklyFeeCard } from './StoreWeeklyFeeCard';
import { OWN_NAME_TICK } from '../../lib/ownNameCopy';

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
const mount = async (el: React.ReactElement) => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(el));
};
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); host = undefined; root = undefined; fx.feeData = null;
});

/** The tick whose accessible name is these words: its own drawn text must say them, and a tap on it ticks it. */
async function expectWordsBesideTheBox(words: string) {
  const box = [...host!.querySelectorAll('button[data-role="checkbox"]')].find((b) => b.getAttribute('aria-label') === words);
  expect(box, `a tick named "${words}"`).toBeTruthy();
  expect(box!.textContent, 'the words are drawn beside the box, inside the tappable row').toContain(words);
  expect(box!.getAttribute('data-checked')).toBe('false');
  await act(async () => (box as HTMLButtonElement).click());
  const after = [...host!.querySelectorAll('button[data-role="checkbox"]')].find((b) => b.getAttribute('aria-label') === words);
  expect(after!.getAttribute('data-checked')).toBe('true');
}

describe('[OWNER-ASKS 9 Nov] every tick on the store steps shows its words', () => {
  it('the own-name declaration (Documents): the tick reads the owner’s words', async () => {
    await mount(React.createElement(OwnNameCard, { role: 'STORE', mode: 'sign', storeName: 'R. Persaud' }));
    expect(OWN_NAME_TICK).toBe('I have read and agree to this declaration.');
    await expectWordsBesideTheBox(OWN_NAME_TICK);
  });

  it('the food handlers tick', async () => {
    const tick = 'Everyone who handles food here holds a current food handler’s certificate.';
    await mount(React.createElement(FoodHandlersCard, {
      role: 'RESTAURANT',
      status: { checklist: ['food_handler_attestation'], foodHandlerAttestation: { version: 'v1', tick, stores: [{ vendorId: 'v1', name: 'Sample Kitchen', attested: false }] } },
    }));
    await expectWordsBesideTheBox(tick);
  });

  it('the weekly fee tick', async () => {
    const tick = 'I understand the weekly fee.';
    fx.feeData = {
      vendorId: 'v1', set: false, required: true, ticked: false, items: 10, cardRate: 4000, dealRate: null, why: 'A small store.',
      weeklyFee: { amount: 4000, currencyCode: 'GYD', tier: 'small', version: 'v1' },
      terms: { version: 'v1', items: [{ heading: 'What it covers', text: 'The Swift app.' }], tick },
    };
    await mount(React.createElement(StoreWeeklyFeeCard, { role: 'STORE', scope: { vendorId: 'v1', isOwner: true } }));
    await expectWordsBesideTheBox(tick);
  });
});
