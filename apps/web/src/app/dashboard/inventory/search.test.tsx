import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import InventoryPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// [MENU-SEARCH · owner 14 Nov 2026] The website's "Search name or SKU" and the app's Menu tab search match: both use
// the app's lib/catalogueSearch, so the same words find the same items. What the app gained, the website has too:
// accents never decide a match, a choice inside an item's options is found, every word typed counts in any order, an
// x empties the box, the empty answer names what was typed, and "Low stock only" is offered only to a store that
// counts stock.

let items: Array<Record<string, unknown>>;
beforeEach(() => {
  items = [
    { id: 'i1', name: 'Crème Brûlée', sku: 'DES-01', basePrice: '900.00', stockQuantity: null, isAvailable: true, category: { id: 'c1', name: 'Desserts' } },
    { id: 'i2', name: 'Family Pizza', sku: 'PIZ-01', basePrice: '4000.00', stockQuantity: null, isAvailable: true, category: { id: 'c2', name: 'Pizza' },
      optionGroups: [{ id: 'g1', name: 'Toppings', options: [{ id: 'o1', name: 'Jalapeño' }] }] },
    { id: 'i3', name: 'White Rice', sku: 'RIC-05', basePrice: '600.00', stockQuantity: null, isAvailable: true, category: { id: 'c2', name: 'Pizza' } },
  ];
  mockApi(({ url, method }) => {
    if (url.pathname === '/api/v1/vendor/items' && method === 'GET') return { body: { data: items } };
    if (url.pathname === '/api/v1/vendor/categories') return { body: { data: [{ id: 'c1', name: 'Desserts' }, { id: 'c2', name: 'Pizza' }] } };
    if (url.pathname === '/api/v1/vendor/stores') return { body: { data: { stores: [], selectedId: null, myRole: 'OWNER' } } };
    if (url.pathname === '/api/v1/vendor/profile') return { body: { data: { myRole: 'OWNER', vendors: [] } } };
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
});

const box = () => screen.getByRole('textbox', { name: 'Search name or SKU' });
const type = async (words: string) => { await act(async () => { fireEvent.change(box(), { target: { value: words } }); }); };
const shown = () => screen.queryAllByRole('article').map((a) => a.getAttribute('aria-label'));

describe('[MENU-SEARCH] the website searches as the app does', () => {
  it('accents and case never decide a match', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'White Rice' });
    await type('creme brulee');
    await waitFor(() => expect(shown()).toEqual(['Crème Brûlée']));
    expect(screen.getByText('1 item', { selector: '[aria-live]' })).toBeTruthy();
  });

  it('finds a choice inside an item\'s options, and every word in any order', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'White Rice' });
    await type('jalapeno');
    await waitFor(() => expect(shown()).toEqual(['Family Pizza']));
    await type('rice white');
    await waitFor(() => expect(shown()).toEqual(['White Rice']));
  });

  it('an x empties the box and every item is back', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'White Rice' });
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    await type('rice');
    await waitFor(() => expect(shown()).toEqual(['White Rice']));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear search' })); });
    expect((box() as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(shown()).toHaveLength(3));
  });

  it('no match: the answer names what was typed', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'White Rice' });
    await type('burger');
    expect(await screen.findByText('No items match “burger”.')).toBeTruthy();
    expect(shown()).toEqual([]);
  });

  it('"Low stock" is not offered to a store that counts no stock; it is once an item is counted', async () => {
    const first = renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'White Rice' });
    expect(screen.queryByRole('button', { name: /^Low stock · / })).toBeNull();
    first.unmount();
    items[2] = { ...items[2], stockQuantity: 3, lowStockThreshold: 5 };
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'White Rice' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Low stock · 1' })); });
    await waitFor(() => expect(shown()).toEqual(['White Rice']));
  });

});

// [MENU-FILTERS · parity audit C1, owner 14 Nov 2026] The filter buttons, as on the app: Sold out, Low stock (a store
// that counts stock only), No photo. Each says how many it holds; one at a time; pressed again, it is off.
describe('[MENU-FILTERS] the filter buttons', () => {
  beforeEach(() => {
    items[1] = { ...items[1], isAvailable: false };
    items[0] = { ...items[0], imageUrl: 'stores/v1/creme.jpg' };
  });
  const button = (name: string) => screen.getByRole('button', { name });

  it('Sold out and No photo, with their counts, not pressed', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'White Rice' });
    expect(button('Sold out · 1').getAttribute('aria-pressed')).toBe('false');
    expect(button('No photo · 2').getAttribute('aria-pressed')).toBe('false');
  });

  it('Sold out shows the switched-off items only; pressed again, every item', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'White Rice' });
    await act(async () => { fireEvent.click(button('Sold out · 1')); });
    await waitFor(() => expect(shown()).toEqual(['Family Pizza']));
    expect(button('Sold out · 1').getAttribute('aria-pressed')).toBe('true');
    await act(async () => { fireEvent.click(button('Sold out · 1')); });
    await waitFor(() => expect(shown()).toHaveLength(3));
  });

  it('No photo, with a search too; one button at a time', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'White Rice' });
    await act(async () => { fireEvent.click(button('Sold out · 1')); });
    await act(async () => { fireEvent.click(button('No photo · 2')); });
    expect(button('Sold out · 1').getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => expect(shown()).toEqual(['Family Pizza', 'White Rice']));
    await type('rice');
    await waitFor(() => expect(shown()).toEqual(['White Rice']));
  });

  it('nothing under the button: the page says which button is on', async () => {
    items[1] = { ...items[1], isAvailable: true };
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'White Rice' });
    await act(async () => { fireEvent.click(button('Sold out · 0')); });
    expect(await screen.findByText('No items match. Showing sold out items only.')).toBeTruthy();
  });
});

// [REVIEW #2514 S4-2] As the app: while searching (or a button is on), each section chip counts its matches; the
// section heading still counts the whole section.
describe('[REVIEW #2514 S4-2] section chips count what the search finds', () => {
  it('searching: All and each section count their matches; cleared, the whole sections', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'White Rice' });
    const chips = () => Array.from(screen.getByLabelText('Sections').querySelectorAll('button')).map((b) => b.textContent);
    expect(chips()).toEqual(expect.arrayContaining(['All · 3', 'Desserts · 1', 'Pizza · 2']));
    await type('rice');
    await waitFor(() => expect(chips()).toEqual(expect.arrayContaining(['All · 1', 'Desserts · 0', 'Pizza · 1'])));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear search' })); });
    await waitFor(() => expect(chips()).toEqual(expect.arrayContaining(['All · 3', 'Desserts · 1', 'Pizza · 2'])));
  });
});
