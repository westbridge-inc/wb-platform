/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [APP-PREPTIME · owner 14 Nov 2026] The preparation time chips beside the
// app's Accept: the website's six choices as large tablet buttons, the chosen
// one marked selected (structurally, not by colour alone), one tap to change.
// ---------------------------------------------------------------------------

vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', { role: p.accessibilityRole, 'aria-label': p.accessibilityLabel }, p.children);
  const Press = (p: any) => h('button', {
    role: p.accessibilityRole,
    'aria-label': p.accessibilityLabel,
    'aria-checked': p.accessibilityState?.checked ? 'true' : 'false',
    'data-min-height': (Array.isArray(p.style) ? Object.assign({}, ...p.style) : p.style)?.minHeight,
    disabled: p.disabled,
    onClick: p.onPress,
  }, p.children);
  return { View: Box, Pressable: Press };
});
vi.mock('../../kit', async () => {
  const { createElement: h } = await import('react');
  return { T: (p: any) => h('span', null, p.children) };
});
vi.mock('../../lib/haptics', () => ({ haptic: { select: vi.fn() } }));

import { PrepTimeChips } from './PrepTimeChips';

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined; });
async function render(props: { value: number; vendorType?: string; disabled?: boolean }, onChange = vi.fn()) {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(PrepTimeChips, { ...props, onChange })));
  return onChange;
}
const chips = () => [...host.querySelectorAll('button')];
const chip = (label: string) => chips().find((b) => b.textContent === label);

describe('[APP-PREPTIME] the preparation time chips', () => {
  it('the six website choices, 20 selected, under "Preparation time" for a restaurant', async () => {
    await render({ value: 20, vendorType: 'RESTAURANT' });
    expect(chips().map((b) => b.textContent)).toEqual(['10 min', '15 min', '20 min', '30 min', '45 min', '60 min']);
    expect(chips().filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.textContent)).toEqual(['20 min']);
    expect(host.textContent).toContain('Preparation time');
    expect(host.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Preparation time');
    // The website's own words for each choice, read aloud.
    expect(chip('45 min')!.getAttribute('aria-label')).toBe('45 min prep');
  });

  it('a shop reads "Ready time" and "Ready in about N min"', async () => {
    await render({ value: 30, vendorType: 'SUPERMARKET' });
    expect(host.textContent).toContain('Ready time');
    expect(chip('30 min')!.getAttribute('aria-label')).toBe('Ready in about 30 min');
  });

  it('one tap picks another time; the chosen one again changes nothing', async () => {
    const onChange = await render({ value: 20, vendorType: 'RESTAURANT' });
    await act(async () => chip('45 min')!.click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith(45);
    await act(async () => chip('20 min')!.click());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('large tablet targets: every chip at least 56 tall', async () => {
    await render({ value: 20 });
    for (const b of chips()) expect(Number(b.getAttribute('data-min-height'))).toBeGreaterThanOrEqual(56);
  });

  it('held while a tap is on its way', async () => {
    const onChange = await render({ value: 20, disabled: true });
    expect(chips().every((b) => b.disabled)).toBe(true);
    await act(async () => chip('45 min')!.click());
    expect(onChange).not.toHaveBeenCalled();
  });
});
