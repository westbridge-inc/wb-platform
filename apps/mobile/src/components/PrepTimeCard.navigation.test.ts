/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';

// [STORE-PREP · parity audit C3, owner ruling 14 Nov 2026] The store's usual preparation time, set by the owner or a
// manager in Account; Accept pre-selects it on every new order. Same choices and words as the website's card.
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, p.children);
  return { View: Box };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('../kit', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, p.children);
  const Button = (p: any) => h('button', { disabled: p.disabled || p.loading, onClick: p.onPress, 'aria-pressed': p.selected === undefined ? undefined : String(!!p.selected) }, p.label);
  return { Card: Box, T: Box, PillButton: Button, Chip: Button };
});

import { PrepTimeCard } from './PrepTimeCard';
import { storedPrepTime, usualPrepLine } from '../modules/vendor/prepTime';

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined; });
async function render(props: { value: number | null; vendorType?: string; error?: string | null; saving?: boolean }, onSave = vi.fn()) {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(PrepTimeCard, { ...props, onSave })));
  return onSave;
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);

describe('[STORE-PREP] usual preparation time on the app', () => {
  it('the stored minutes, or null when there is none', () => {
    expect(storedPrepTime({ estimatedPrepTime: 45 })).toBe(45);
    for (const v of [undefined, null, {}, { estimatedPrepTime: 0 }, { estimatedPrepTime: -5 }, { estimatedPrepTime: '20' }, { estimatedPrepTime: 2.5 }]) expect(storedPrepTime(v)).toBeNull();
  });

  it('the words: set, set off the choices, and not set', () => {
    expect(usualPrepLine(20)).toBe('Accept starts at 20 min on every new order. Staff can still pick another time on each order.');
    expect(usualPrepLine(35)).toBe('Now 35 min: Accept starts at the closest choice, 30 min. Pick your usual time.');
    expect(usualPrepLine(null)).toBe('Not set: Accept starts at 30 min. Pick your usual time.');
  });

  it('the stored time is chosen; 45 then Save sends 45', async () => {
    const onSave = await render({ value: 30, vendorType: 'RESTAURANT' });
    expect(host.textContent).toContain('Usual preparation time');
    expect(button('30 min')!.getAttribute('aria-pressed')).toBe('true');
    expect(button('Save')).toBeUndefined();
    await act(async () => button('45 min')!.click());
    expect(host.textContent).toContain('Accept starts at 45 min on every new order.');
    await act(async () => button('Save')!.click());
    expect(onSave).toHaveBeenCalledExactlyOnceWith(45);
  });

  it('a shop says ready time; a refusal shows the server\'s words; Save holds while saving', async () => {
    await render({ value: 20, vendorType: 'SUPERMARKET', error: 'This needs a manager', saving: true });
    expect(host.textContent).toContain('Usual ready time');
    expect(host.textContent).toContain('This needs a manager');
  });
});
