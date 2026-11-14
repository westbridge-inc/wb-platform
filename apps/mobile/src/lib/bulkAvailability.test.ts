import { describe, expect, it } from 'vitest';
import { bulkConfirmBody, bulkConfirmTitle, bulkResultLine, keepSelectable, selectAll, toggleSelected } from './bulkAvailability';

// [MENU-BULK · parity audit C2, owner 14 Nov 2026] Tick several items on the menu list and mark them sold out, or
// back on, in one go: the words the app and the website show (both use this file), and the ticks.

describe('the ask before it is sent', () => {
  it('names how many and what happens', () => {
    expect(bulkConfirmTitle(12, false)).toBe('Mark 12 items sold out?');
    expect(bulkConfirmTitle(1, false)).toBe('Mark 1 item sold out?');
    expect(bulkConfirmTitle(3, true)).toBe('Make 3 items available?');
    expect(bulkConfirmBody(false)).toBe('Customers can’t add them to a new order. If a current order has one, the customer is asked to choose a replacement or it is marked for a refund.');
    expect(bulkConfirmBody(true)).toBe('Customers can order them again.');
  });
});

describe('the answer, counted', () => {
  it('how many changed', () => {
    expect(bulkResultLine({ changedIds: ['a', 'b'], unchangedIds: [], refused: [] }, false)).toBe('2 items marked sold out.');
    expect(bulkResultLine({ changedIds: ['a'], unchangedIds: [], refused: [] }, true)).toBe('1 item made available.');
  });
  it('those already so, and those Swift does not allow, named', () => {
    expect(bulkResultLine({ changedIds: ['a'], unchangedIds: ['b', 'c'], refused: [] }, false))
      .toBe('1 item marked sold out. 2 were already sold out.');
    expect(bulkResultLine({ changedIds: [], unchangedIds: ['b'], refused: [] }, true))
      .toBe('0 items made available. 1 was already available.');
    expect(bulkResultLine({ changedIds: ['a'], unchangedIds: [], refused: [{ id: 'x', name: 'Tonic', message: 'm' }] }, true))
      .toBe('1 item made available. Swift does not allow 1, so it stays off: Tonic.');
    expect(bulkResultLine({ changedIds: [], unchangedIds: [], refused: [{ id: 'x', name: 'A', message: 'm' }, { id: 'y', name: 'B', message: 'm' }] }, true))
      .toBe('0 items made available. Swift does not allow 2, so they stay off: A, B.');
  });
});

describe('the ticks', () => {
  it('a tick toggles one item, never touching the others', () => {
    const one = toggleSelected(new Set<string>(), 'a');
    expect([...one]).toEqual(['a']);
    const two = toggleSelected(one, 'b');
    expect([...two].sort()).toEqual(['a', 'b']);
    expect([...toggleSelected(two, 'a')]).toEqual(['b']);
    expect([...one], 'a new set each time').toEqual(['a']);
  });
  it('"Select all shown" adds every item on screen to the ticks already made', () => {
    expect([...selectAll(new Set(['z']), ['a', 'b'])].sort()).toEqual(['a', 'b', 'z']);
  });
  it('an item no longer on the menu (deleted elsewhere) drops out of the ticks', () => {
    const kept = keepSelectable(new Set(['a', 'gone']), ['a', 'b']);
    expect([...kept]).toEqual(['a']);
    const same = new Set(['a']);
    expect(keepSelectable(same, ['a', 'b']), 'unchanged ticks keep their set').toBe(same);
  });
});
