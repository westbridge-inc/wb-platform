import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import InventoryPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import { setSelectedStore } from '@/lib/auth';

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
// The browser's selected-store key (lib/auth STORE_KEY): another tab writes it directly.
const SELECTED_STORE_KEY = 'swift_web_store';
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
// [REVIEW-MENU-B] A restaurant's existing "Size" stored as add-ons (Small +0 / Large +500 on a 2,000 curry), and a
// "pick 2 to 3" sauce group.
const CURRY: Row = {
  id: 'curry', name: 'Curry', basePrice: '2000.00', categoryId: 'mains', category: { id: 'mains', name: 'Mains' }, isAvailable: true, stockQuantity: null, bulk: 'normal',
  optionGroups: [
    { id: 'g-addon-size', name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1, setsPrice: false, allowHalves: false, halfPricePercent: 100, libraryGroupId: null,
      options: [{ id: 'o-small', name: 'Small', additionalPrice: '0' }, { id: 'o-large', name: 'Large', additionalPrice: '500' }] },
    { id: 'g-sauces', name: 'Sauces', isRequired: true, minSelect: 2, maxSelect: 3, setsPrice: false, allowHalves: false, halfPricePercent: 100, libraryGroupId: null,
      options: [{ id: 'o-bbq', name: 'BBQ', additionalPrice: '100' }] },
  ],
};
const DIPS: Row = {
  id: 'lib-dips', name: 'Dips', isRequired: false, minSelect: 0, maxSelect: 1, sortOrder: 1, setsPrice: false, allowHalves: false, halfPricePercent: 100,
  isFollowUp: false, usedByItemCount: 0, usedByItems: [], options: [],
};

beforeEach(() => {
  items = [PIZZA, { id: 'calzone', name: 'Calzone', basePrice: '2000.00', categoryId: 'mains', category: { id: 'mains', name: 'Mains' }, isAvailable: true, stockQuantity: null, bulk: 'normal', optionGroups: [] },
    { id: 'garlic', name: 'Garlic bread', basePrice: '600.00', categoryId: 'mains', category: { id: 'mains', name: 'Mains' }, isAvailable: true, stockQuantity: null, bulk: 'normal', optionGroups: [] }];
  items.push(CURRY);
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
    const groupPut = path.match(/^\/api\/v1\/vendor\/option-groups\/([^/]+)$/);
    if (groupPut && method === 'PUT') {
      const g = items.flatMap((i) => (i['optionGroups'] as Row[]) ?? []).find((x) => x.id === groupPut[1])!;
      const b = body(r);
      const priceOf = new Map((b.prices ?? []).map((p: { id: string; price: number }) => [p.id, p.price]));
      return { body: { data: { ...g, ...b, options: (g['options'] as Row[]).map((o) => ({ ...o, additionalPrice: String(priceOf.get(o.id) ?? o['additionalPrice']) })) } } };
    }
    const optionPost = path.match(/^\/api\/v1\/vendor\/option-groups\/([^/]+)\/options$/);
    if (optionPost && method === 'POST') return { body: { data: { id: 'o-new', ...body(r) } } };
    const groupPost = path.match(/^\/api\/v1\/vendor\/items\/([^/]+)\/option-groups$/);
    if (groupPost && method === 'POST') return { body: { data: { id: 'g-new', ...body(r), options: (body(r).options ?? []).map((o: Row, i: number) => ({ ...o, id: `o-new-${i}` })) } } };
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
    // [REVIEW-MENU-B S3-5] Every option write says the tools edit sizes, halves and follow-ups (an older app is refused).
    await waitFor(() => expect(sent('PUT', '/api/v1/vendor/options/o-stuffed')).toEqual([{ followUpGroupId: 'g-cheese', capabilities: ['MENU_OPTIONS_V2'] }]));
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
    // [REVIEW-MENU-B S3-2] Only what changed: never a rewrite of the group's own limits.
    await waitFor(() => expect(sent('PUT', '/api/v1/vendor/modifier-groups/lib-top')).toEqual([{ halfPricePercent: 100, capabilities: ['MENU_OPTIONS_V2'] }]));
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
    await waitFor(() => expect(sent('POST', '/api/v1/vendor/modifier-groups/lib-dips/attach')).toEqual([{ itemIds: ['pizza'], capabilities: ['MENU_OPTIONS_V2'] }]));
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
    await waitFor(() => expect(sent('PUT', '/api/v1/vendor/modifier-groups/order')).toEqual([{ ids: ['lib-dips', 'lib-top'], capabilities: ['MENU_OPTIONS_V2'] }]));
    await click(within(win).getByRole('button', { name: 'New shared group' }));
    await type(win, 'Group name (e.g. Pizza size, Toppings)', 'Crust');
    await click(within(win).getByRole('button', { name: 'Required' }));
    await click(within(win).getByRole('button', { name: 'Create group' }));
    await waitFor(() => expect(sent('POST', '/api/v1/vendor/modifier-groups')).toEqual([{ name: 'Crust', isRequired: true, minSelect: 1, maxSelect: 1, capabilities: ['MENU_OPTIONS_V2'] }]));
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
    await waitFor(() => expect(sent('POST', '/api/v1/vendor/modifier-groups/lib-top/detach')).toEqual([{ itemIds: ['calzone'], capabilities: ['MENU_OPTIONS_V2'] }]));
    expect(sent('POST', '/api/v1/vendor/modifier-groups/lib-top/attach')).toEqual([{ itemIds: ['garlic'], capabilities: ['MENU_OPTIONS_V2'] }]);

    await click(within(win).getByRole('button', { name: 'Delete group' }));
    const ask = within(win).getByRole('dialog', { name: 'Delete “Toppings”?' });
    expect(within(ask).getByText('It is removed from 4 items that use it.')).toBeTruthy();
    await click(within(ask).getByRole('button', { name: 'Delete group' }));
    await waitFor(() => expect(writes.map((w) => `${w.method} ${w.url.pathname}`)).toContain('DELETE /api/v1/vendor/modifier-groups/lib-top'));
  });
});

describe('[REVIEW-MENU-B] the website\'s option tools, as the app\'s', () => {
  const CAP = ['MENU_OPTIONS_V2'];

  it('S2-1: "Sets the price" on an add-on Size shows each size\'s full price first, and sends them with the switch in one request', async () => {
    const editor = await openEditor('Curry');
    const size = within(editor).getByRole('group', { name: 'Group Size' });
    await click(within(within(size).getByRole('group', { name: 'Rules: Size' })).getByRole('button', { name: 'Sets the price' }));
    expect(sent('PUT', '/api/v1/vendor/option-groups/g-addon-size'), 'nothing saved at the tap').toEqual([]);
    const ask = within(size).getByRole('dialog', { name: 'Make these sizes?' });
    expect(within(ask).getByText('Small $2,000 / Large $2,500 — the item’s price becomes its sizes’ prices.')).toBeTruthy();
    await click(within(ask).getByRole('button', { name: 'Save these prices' }));
    await waitFor(() => expect(sent('PUT', '/api/v1/vendor/option-groups/g-addon-size')).toEqual([
      { setsPrice: true, prices: [{ id: 'o-small', price: 2000 }, { id: 'o-large', price: 2500 }], capabilities: CAP },
    ]));
    expect(await within(size).findByText('Price $2,500')).toBeTruthy();
  });

  it('S2-1: a size left at 0 in the confirm is refused there, and nothing is sent', async () => {
    const editor = await openEditor('Curry');
    const size = within(editor).getByRole('group', { name: 'Group Size' });
    await click(within(within(size).getByRole('group', { name: 'Rules: Size' })).getByRole('button', { name: 'Sets the price' }));
    const ask = within(size).getByRole('dialog', { name: 'Make these sizes?' });
    await type(ask, 'Price: Small', '0');
    await click(within(ask).getByRole('button', { name: 'Save these prices' }));
    expect(within(ask).getByRole('alert').textContent).toBe('Small: Type this size’s full price (more than 0).');
    expect(sent('PUT', '/api/v1/vendor/option-groups/g-addon-size')).toEqual([]);
  });

  it('S3-2: Half-and-half on a "pick 2 to 3" group sends that rule only (its limits stay)', async () => {
    const editor = await openEditor('Curry');
    const sauces = within(editor).getByRole('group', { name: 'Group Sauces' });
    await click(within(within(sauces).getByRole('group', { name: 'Rules: Sauces' })).getByRole('button', { name: 'Half-and-half' }));
    await waitFor(() => expect(sent('PUT', '/api/v1/vendor/option-groups/g-sauces')).toEqual([{ allowHalves: true, capabilities: CAP }]));
  });

  it('S3-3: a size typed "1,500" is 1500; one left blank is refused (never a $0 pizza)', async () => {
    const editor = await openEditor('Pizza');
    const size = within(editor).getByRole('group', { name: 'Group Size' });
    await type(size, 'Choice for Size', 'XL');
    await click(within(size).getByRole('button', { name: 'Add choice to Size' }));
    expect(await within(editor).findByText('Type this size’s full price (more than 0).')).toBeTruthy();
    expect(sent('POST', '/api/v1/vendor/option-groups/g-size/options')).toEqual([]);
    await type(size, 'Price for Size', '1,500');
    await click(within(size).getByRole('button', { name: 'Add choice to Size' }));
    await waitFor(() => expect(sent('POST', '/api/v1/vendor/option-groups/g-size/options')).toEqual([{ name: 'XL', additionalPrice: 1500, capabilities: CAP }]));
  });

  it('S2-1: a new size group asks for its first size and sends it with the group', async () => {
    const editor = await openEditor('Calzone');
    await type(editor, 'New group (e.g. Size, Toppings)', 'Size');
    await click(within(within(editor).getByRole('group', { name: 'Rules: New group' })).getByRole('button', { name: 'Sets the price' }));
    await click(within(editor).getByRole('button', { name: 'Add option group' }));
    expect(within(editor).getByText('Add the first size (like Small) with its full price.')).toBeTruthy();
    await type(editor, 'First size (e.g. Small)', 'Regular');
    await type(editor, 'First size price', '2,000');
    await click(within(editor).getByRole('button', { name: 'Add option group' }));
    await waitFor(() => expect(sent('POST', '/api/v1/vendor/items/calzone/option-groups')).toEqual([{
      name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1, setsPrice: true, options: [{ name: 'Regular', additionalPrice: 2000 }], capabilities: CAP,
    }]));
  });

  it('S3-4 + S2-1 (library): removing a shared choice asks first; "Sets the price" on a shared group starts each size from the lowest item price + add-on', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Pizza' });
    await click(await screen.findByRole('button', { name: 'Option library' }));
    const win = await dialog();
    await click(await within(win).findByRole('button', { name: 'Edit Toppings' }));
    await click(within(win).getByRole('button', { name: 'Remove Pepperoni' }));
    const ask = within(win).getByRole('dialog', { name: 'Remove “Pepperoni”?' });
    expect(within(ask).getByText('It is removed from 4 items that use this group.')).toBeTruthy();
    expect(writes.some((w) => w.method === 'DELETE'), 'nothing removed at the tap').toBe(false);
    await click(within(ask).getByRole('button', { name: 'Keep it' }));

    await click(within(win).getByRole('button', { name: 'Sets the price' }));
    await click(within(win).getByRole('button', { name: 'Save group' }));
    expect(sent('PUT', '/api/v1/vendor/modifier-groups/lib-top')).toEqual([]);
    const sw = within(win).getByRole('dialog', { name: 'Make these sizes?' });
    expect(within(sw).getByText('Pepperoni $2,200 — every item that uses this group (4 items) costs these sizes’ prices.')).toBeTruthy();
    await click(within(sw).getByRole('button', { name: 'Save these prices' }));
    await waitFor(() => expect(sent('PUT', '/api/v1/vendor/modifier-groups/lib-top')).toEqual([
      { setsPrice: true, allowHalves: false, prices: [{ id: 'lo-pep', price: 2200 }], capabilities: CAP },
    ]));
  });

  it('A S4-11: the library\'s reads and writes name the store it was opened for; a store switched meanwhile sends nothing', async () => {
    setSelectedStore('store-1');
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Pizza' });
    await click(await screen.findByRole('button', { name: 'Option library' }));
    const win = await dialog();
    await click(await within(win).findByRole('button', { name: 'Edit Toppings' }));
    await click(within(win).getByRole('button', { name: 'Remove Pepperoni' }));
    await click(within(within(win).getByRole('dialog', { name: 'Remove “Pepperoni”?' })).getByRole('button', { name: 'Remove choice' }));
    await waitFor(() => expect(writes.map((w) => `${w.method} ${w.url.pathname}`)).toContain('DELETE /api/v1/vendor/modifier-options/lo-pep'));
    expect((writes.at(-1)!.init!.headers as Record<string, string>)['x-vendor-id']).toBe('store-1');

    // Another tab selects another store (its notice not delivered yet): this window's write is refused, never sent there.
    localStorage.setItem(SELECTED_STORE_KEY, 'store-2');
    const before = writes.length;
    await click(within(win).getByRole('button', { name: 'Remove Pepperoni' }));
    await click(within(within(win).getByRole('dialog', { name: 'Remove “Pepperoni”?' })).getByRole('button', { name: 'Remove choice' }));
    expect(await within(win).findByText(/selected store changed/)).toBeTruthy();
    expect(writes.length, 'nothing sent to the other store').toBe(before);
  });
});
