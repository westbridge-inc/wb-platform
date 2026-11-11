import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import InventoryPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [MENU-OPTIONS · owner 11 Nov 2026 · owner rule 11 Oct: the website copies the app] Pizza-grade options on the web
// Products page, as the phone's item editor and Option library do them (same rules and words, imported from
// apps/mobile/src/lib/menuOptionsEditor.ts): a group that SETS THE PRICE (the item's own price becomes "From $X
// (lowest size)", read-only, and an edit never sends a price), HALF-AND-HALF with the store's half price rule, a choice
// that OPENS A FOLLOW-UP GROUP of the item, and the SHARED option library ("Used by N items", edited once for every
// item, Remove = off this item only, bulk attach / detach, delete "removed from N items"). The server is the judge;
// its refusal is shown in its own words.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string; name: string };
let items: Row[];
let library: Row[];
let writes: ApiRequest[];
let refuse: Record<string, { status: number; body: unknown }>;

const body = (r: ApiRequest) => (typeof r.init?.body === 'string' ? JSON.parse(r.init.body) : r.init?.body);
const sent = (method: string, path: string) => writes.filter((w) => w.method === method && w.url.pathname === path).map(body);

const PIZZA: Row = {
  id: 'pizza', name: 'Pizza', basePrice: '1800.00', categoryId: 'mains', category: { id: 'mains', name: 'Mains' }, isAvailable: true, stockQuantity: null, bulk: 'normal',
  optionGroups: [
    { id: 'g-size', name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1, setsPrice: true, allowHalves: false, halfPricePercent: 100, libraryGroupId: null,
      options: [{ id: 'o-s', name: 'Small', additionalPrice: '1800' }, { id: 'o-l', name: 'Large', additionalPrice: '3200' }] },
    { id: 'g-crust', name: 'Crust', isRequired: true, minSelect: 1, maxSelect: 1, setsPrice: false, allowHalves: false, halfPricePercent: 100, libraryGroupId: null,
      options: [{ id: 'o-stuffed', name: 'Stuffed crust', additionalPrice: '300', followUpGroupId: null }] },
    { id: 'g-cheese', name: 'Cheese', isRequired: false, minSelect: 0, maxSelect: 1, setsPrice: false, allowHalves: false, halfPricePercent: 100, libraryGroupId: null,
      options: [{ id: 'o-ched', name: 'Cheddar', additionalPrice: '0', followUpGroupId: null }] },
    { id: 'copy-top', name: 'Toppings', isRequired: false, minSelect: 0, maxSelect: 10, setsPrice: false, allowHalves: true, halfPricePercent: 50, libraryGroupId: 'lib-top',
      options: [{ id: 'c-pep', name: 'Pepperoni', additionalPrice: '400' }] },
  ],
};
const TOPPINGS: Row = {
  id: 'lib-top', name: 'Toppings', isRequired: false, minSelect: 0, maxSelect: 10, sortOrder: 0, setsPrice: false, allowHalves: true, halfPricePercent: 50,
  isFollowUp: false, usedByItemCount: 4, usedByItems: [{ id: 'pizza', name: 'Pizza' }, { id: 'calzone', name: 'Calzone' }],
  options: [{ id: 'lo-pep', name: 'Pepperoni', price: 400, isDefault: false, isAvailable: true, sortOrder: 0, followUpGroupId: null, externalCode: 'PEP' }],
};
const DIPS: Row = {
  id: 'lib-dips', name: 'Dips', isRequired: false, minSelect: 0, maxSelect: 1, sortOrder: 1, setsPrice: false, allowHalves: false, halfPricePercent: 100,
  isFollowUp: false, usedByItemCount: 0, usedByItems: [], options: [],
};

beforeEach(() => {
  items = [PIZZA, { id: 'calzone', name: 'Calzone', basePrice: '2000.00', categoryId: 'mains', category: { id: 'mains', name: 'Mains' }, isAvailable: true, stockQuantity: null, bulk: 'normal', optionGroups: [] },
    { id: 'garlic', name: 'Garlic bread', basePrice: '600.00', categoryId: 'mains', category: { id: 'mains', name: 'Mains' }, isAvailable: true, stockQuantity: null, bulk: 'normal', optionGroups: [] }];
  library = [TOPPINGS, DIPS];
  writes = [];
  refuse = {};
  mockApi(async (r) => {
    const { url, method } = r;
    const path = url.pathname;
    if (method !== 'GET') writes.push(r);
    const refused = refuse[`${method} ${path}`];
    if (refused) return refused;
    if (path === '/api/v1/vendor/items' && method === 'GET') return { body: { data: items } };
    if (path === '/api/v1/vendor/categories' && method === 'GET') return { body: { data: [{ id: 'mains', name: 'Mains' }] } };
    if (path === '/api/v1/vendor/stores') return { body: { data: { stores: [{ id: 'store-1', name: 'Pizzeria', vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true }], selectedId: 'store-1', myRole: 'OWNER' } } };
    if (path === '/api/v1/vendor/profile') return { body: { data: { myRole: 'OWNER', vendors: [] } } };
    if (path === '/api/v1/vendor/modifier-groups' && method === 'GET') return { body: { data: library } };
    if (path === '/api/v1/vendor/modifier-groups' && method === 'POST') return { body: { data: { ...DIPS, id: 'lib-new', ...body(r) } } };
    if (path === '/api/v1/vendor/items' && method === 'POST') return { body: { data: { id: 'new-1', ...body(r), category: { id: 'mains', name: 'Mains' } } } };
    const one = path.match(/^\/api\/v1\/vendor\/items\/([^/]+)$/);
    if (one && method === 'PUT') return { body: { data: { ...items.find((i) => i.id === one[1]), ...body(r) } } };
    if (/^\/api\/v1\/vendor\/options\/[^/]+$/.test(path) && method === 'PUT') return { body: { data: { id: path.split('/').pop(), ...body(r) } } };
    if (/^\/api\/v1\/vendor\/option-groups\/[^/]+$/.test(path) && method === 'DELETE') return { body: { data: { deleted: true } } };
    if (/^\/api\/v1\/vendor\/modifier-groups\/[^/]+\/(attach|detach)$/.test(path)) return { body: { data: { attached: [], already: [], detached: [] } } };
    if (/^\/api\/v1\/vendor\/modifier-groups\/[^/]+$/.test(path) && method === 'DELETE') return { body: { data: { deleted: true, removedFromItems: 4 } } };
    if (/^\/api\/v1\/vendor\/modifier-groups\/[^/]+$/.test(path) && method === 'PUT') return { body: { data: { ...TOPPINGS, ...body(r) } } };
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
});

const dialog = () => screen.findByRole('dialog');
const field = (scope: HTMLElement, label: string) => within(scope).getByLabelText(label) as HTMLInputElement;
async function type(scope: HTMLElement, label: string, value: string) {
  await act(async () => { fireEvent.change(field(scope, label), { target: { value } }); });
}
async function click(el: HTMLElement) { await act(async () => { fireEvent.click(el); }); }
async function openEditor(name: string) {
  renderWithQuery(<InventoryPage />);
  const row = await screen.findByRole('article', { name });
  await click(within(row).getByRole('button', { name: /^Edit/ }));
  return dialog();
}

describe('[MENU-OPTIONS] a new pizza on the website', () => {
  it('size sets the price ("From $X", read-only), toppings are half-and-half at the store\'s percent, all in the one create request', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Pizza' });
    await click(await screen.findByRole('button', { name: '+ Add item' }));
    const editor = await dialog();
    await type(editor, 'Item name', 'Pizza');
    await type(editor, 'New group (e.g. Size, Toppings)', 'Size');
    await click(within(within(editor).getByRole('group', { name: 'Rules: New group' })).getByRole('button', { name: 'Sets the price' }));
    expect(within(editor).queryByRole('button', { name: 'Required' }), 'a group that sets the price is always "pick one"').toBeNull();
    await click(within(editor).getByRole('button', { name: 'Add option group' }));
    const size = within(editor).getByRole('group', { name: 'Group Size' });
    expect(within(size).getByText('Sets the price · pick one')).toBeTruthy();
    await type(size, 'Choice for Size', 'Small');
    await type(size, 'Price for Size', '1800');
    await click(within(size).getByRole('button', { name: 'Add choice to Size' }));
    await type(size, 'Choice for Size', 'Large');
    await type(size, 'Price for Size', '3200');
    await click(within(size).getByRole('button', { name: 'Add choice to Size' }));
    expect(within(size).getByText('Price $3,200')).toBeTruthy();
    expect(within(editor).queryByLabelText('Price (GYD)'), 'no price box of its own once it has sizes').toBeNull();
    expect(within(editor).getByTestId('item-from-price').textContent).toContain('From $1,800 (lowest size)');

    await type(editor, 'New group (e.g. Size, Toppings)', 'Toppings');
    await click(within(editor).getByRole('button', { name: 'Multiple picks' }));
    const rules = within(editor).getByRole('group', { name: 'Rules: New group' });
    expect(within(rules).queryByRole('button', { name: 'Sets the price' }), 'one group per item sets the price').toBeNull();
    await click(within(rules).getByRole('button', { name: 'Half-and-half' }));
    await click(within(rules).getByRole('button', { name: '% of the choice price' }));
    await type(rules, 'Half costs (%): New group', '60');
    await click(within(rules).getByRole('button', { name: 'Set' }));
    await click(within(editor).getByRole('button', { name: 'Add option group' }));
    const toppings = within(editor).getByRole('group', { name: 'Group Toppings' });
    expect(within(toppings).getByText('Optional · up to 10 · Half-and-half (a half costs 60% of the choice price)')).toBeTruthy();
    await type(toppings, 'Choice for Toppings', 'Pepperoni');
    await type(toppings, 'Extra price for Toppings', '400');
    await click(within(toppings).getByRole('button', { name: 'Add choice to Toppings' }));

    await click(within(editor).getByRole('button', { name: 'Mains' }));
    await click(within(editor).getByRole('button', { name: 'Add item' }));
    await waitFor(() => expect(sent('POST', '/api/v1/vendor/items')).toHaveLength(1));
    const created = sent('POST', '/api/v1/vendor/items')[0];
    expect(created.basePrice, 'the lowest size (the server keeps it so)').toBe(1800);
    expect(created.optionGroups).toEqual([
      { name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1, setsPrice: true, options: [{ name: 'Small', additionalPrice: 1800 }, { name: 'Large', additionalPrice: 3200 }] },
      { name: 'Toppings', isRequired: false, minSelect: 0, maxSelect: 10, allowHalves: true, halfPricePercent: 60, options: [{ name: 'Pepperoni', additionalPrice: 400 }] },
    ]);
  });
});

describe('[MENU-OPTIONS] a saved pizza on the website', () => {
  it('an edit of a sized item never sends a price', async () => {
    const editor = await openEditor('Pizza');
    expect(within(editor).getByTestId('item-from-price').textContent).toContain('From $1,800 (lowest size)');
    await type(editor, 'Item name', 'Pizza pie');
    await click(within(editor).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sent('PUT', '/api/v1/vendor/items/pizza')).toHaveLength(1));
    const saved = sent('PUT', '/api/v1/vendor/items/pizza')[0];
    expect(saved.name).toBe('Pizza pie');
    expect(saved).not.toHaveProperty('basePrice');
    expect(saved).not.toHaveProperty('vatListedPrice');
  });

  it('a choice opens a follow-up group of the item: never the size, never a group that opens others; a refusal shows the server\'s words', async () => {
    const editor = await openEditor('Pizza');
    const picker = field(editor, 'Opens follow-up group: Stuffed crust') as unknown as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.textContent)).toEqual(['Opens nothing', 'Opens: Cheese', 'Opens: Toppings']);
    await act(async () => { fireEvent.change(picker, { target: { value: 'g-cheese' } }); });
    await waitFor(() => expect(sent('PUT', '/api/v1/vendor/options/o-stuffed')).toEqual([{ followUpGroupId: 'g-cheese' }]));
    expect(await within(editor).findByText('Follow-up group: shown when its choice is picked.')).toBeTruthy();

    refuse['PUT /api/v1/vendor/options/o-s'] = { status: 400, body: { success: false, error: { code: 'MENU_OPTIONS_RULE', message: '"Small" cannot open "Cheese": it is already a follow-up group.' } } };
    await act(async () => { fireEvent.change(field(editor, 'Opens follow-up group: Small'), { target: { value: 'copy-top' } }); });
    expect(await within(editor).findByText('"Small" cannot open "Cheese": it is already a follow-up group.')).toBeTruthy();
  });

  it('a shared group: "Used by N items", edited in the library with the warning, and Remove takes it off this item only', async () => {
    const editor = await openEditor('Pizza');
    const shared = within(editor).getByRole('group', { name: 'Group Toppings' });
    expect(await within(shared).findByText('Shared · Used by 4 items')).toBeTruthy();
    expect(within(shared).queryByLabelText('Choice for Toppings'), 'no choice is typed onto a shared copy').toBeNull();

    await click(within(shared).getByRole('button', { name: 'Remove Toppings' }));
    const ask = within(editor).getByRole('dialog', { name: 'Remove from this item?' });
    expect(within(ask).getByText('The shared group stays in your option library and on the other items that use it.')).toBeTruthy();
    await click(within(ask).getByRole('button', { name: 'Cancel' }));

    await click(within(shared).getByRole('button', { name: 'Edit shared group' }));
    const panel = within(editor).getByRole('region', { name: 'Option library' });
    expect(within(panel).getByText('Changes apply to all 4 items')).toBeTruthy();
    await click(within(panel).getByRole('button', { name: 'Full price' }));
    await click(within(panel).getByRole('button', { name: 'Save group' }));
    await waitFor(() => expect(sent('PUT', '/api/v1/vendor/modifier-groups/lib-top')).toEqual([
      { name: 'Toppings', isRequired: false, minSelect: 0, maxSelect: 10, setsPrice: false, allowHalves: true, halfPricePercent: 100 },
    ]));
  });

  it('Remove on a shared group sends the item\'s copy only', async () => {
    const editor = await openEditor('Pizza');
    const shared = within(editor).getByRole('group', { name: 'Group Toppings' });
    await within(shared).findByText('Shared · Used by 4 items');
    await click(within(shared).getByRole('button', { name: 'Remove Toppings' }));
    await click(within(within(editor).getByRole('dialog', { name: 'Remove from this item?' })).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(writes.map((w) => `${w.method} ${w.url.pathname}`)).toContain('DELETE /api/v1/vendor/option-groups/copy-top'));
  });

  it('"Add from option library" attaches a group the item does not have yet', async () => {
    const editor = await openEditor('Pizza');
    const pick = field(editor, 'Add from option library') as unknown as HTMLSelectElement;
    await waitFor(() => expect(Array.from(pick.options).map((o) => o.textContent)).toEqual(['Add from option library…', 'Dips · Used by 0 items']));
    await act(async () => { fireEvent.change(pick, { target: { value: 'lib-dips' } }); });
    await click(within(editor).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(sent('POST', '/api/v1/vendor/modifier-groups/lib-dips/attach')).toEqual([{ itemIds: ['pizza'] }]));
  });
});

describe('[MENU-OPTIONS] the Option library window', () => {
  async function openLibrary() {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Pizza' });
    await click(await screen.findByRole('button', { name: 'Option library' }));
    const win = await dialog();
    await within(win).findByText('Toppings');
    return win;
  }

  it('lists each group with how many items use it, reorders, and creates a group with its rules', async () => {
    const win = await openLibrary();
    expect(within(win).getByText(/Used by 4 items/)).toBeTruthy();
    await click(within(win).getByRole('button', { name: 'Move Dips up' }));
    await waitFor(() => expect(sent('PUT', '/api/v1/vendor/modifier-groups/order')).toEqual([{ ids: ['lib-dips', 'lib-top'] }]));
    await click(within(win).getByRole('button', { name: 'New shared group' }));
    await type(win, 'Group name (e.g. Pizza size, Toppings)', 'Crust');
    await click(within(win).getByRole('button', { name: 'Required' }));
    await click(within(win).getByRole('button', { name: 'Create group' }));
    await waitFor(() => expect(sent('POST', '/api/v1/vendor/modifier-groups')).toEqual([{ name: 'Crust', isRequired: true, minSelect: 1, maxSelect: 1 }]));
  });

  it('bulk attach / detach sends only the change; delete says how many items lose it', async () => {
    const win = await openLibrary();
    await click(within(win).getByRole('button', { name: 'Edit Toppings' }));
    expect(within(win).getByText('Changes apply to all 4 items')).toBeTruthy();
    expect(within(win).getByText('+$400 · Kitchen code PEP')).toBeTruthy();
    await click(within(win).getByRole('button', { name: 'Choose items' }));
    const pick = within(win).getByRole('group', { name: 'Choose items' });
    await click(within(pick).getByLabelText('Calzone'));
    await click(within(pick).getByLabelText('Garlic bread'));
    await click(within(pick).getByRole('button', { name: 'Save items' }));
    await waitFor(() => expect(sent('POST', '/api/v1/vendor/modifier-groups/lib-top/detach')).toEqual([{ itemIds: ['calzone'] }]));
    expect(sent('POST', '/api/v1/vendor/modifier-groups/lib-top/attach')).toEqual([{ itemIds: ['garlic'] }]);

    await click(within(win).getByRole('button', { name: 'Delete group' }));
    const ask = within(win).getByRole('dialog', { name: 'Delete “Toppings”?' });
    expect(within(ask).getByText('It is removed from 4 items that use it.')).toBeTruthy();
    await click(within(ask).getByRole('button', { name: 'Delete group' }));
    await waitFor(() => expect(writes.map((w) => `${w.method} ${w.url.pathname}`)).toContain('DELETE /api/v1/vendor/modifier-groups/lib-top'));
  });
});
