import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VendorDetailPage from './page';
import { fulfilledParams, mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

// [BUG-HUNT F22] What the screens tell a store to ask support for: a type picked by mistake, a checked name.
const REASON = 'The owner picked the wrong type when signing up';
const store = (extra: Record<string, unknown> = {}) => ({
  id: 'vendor-target', name: 'Target Store', status: 'PENDING_APPROVAL', vendorType: 'RESTAURANT', isFeatured: false, acceptingOrders: false,
  city: 'Georgetown', addressLine1: 'Test address', phone: 'test-phone', averageRating: 5, totalRatings: 0, mmgPayUrl: null,
  createdAt: '2026-08-01T00:00:00.000Z', recentOrders: [], subscription: null, firstLiveAt: null, tier: 'REGISTERED',
  owner: { user: { id: 'owner-1', firstName: 'Store', lastName: 'Owner', phone: 'owner-phone', email: null, status: 'ACTIVE' }, vendors: [] },
  _count: { items: 0, orders: 0 }, ...extra,
});
const checklist = {
  vendorId: 'vendor-target', applicantId: 'owner-1', storeStatus: 'PENDING_APPROVAL', suspensionSource: null, ownerAccountStatus: 'ACTIVE', isVerified: false, activationValidUntil: null,
  role: 'RESTAURANT', checklist: { complete: false, items: [] }, disclosure: { engaged: false, complete: true, missing: [] }, ready: false, next: 'NEEDS_DOCUMENTS',
};

function serve(data: unknown) {
  return mockApi((request) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/vendors/vendor-target') return { body: { success: true, data } };
    if (request.method === 'GET' && request.url.pathname.endsWith('/activation-checklist')) return { body: { success: true, data: checklist } };
    if (request.method === 'PUT') return { body: { success: true, data: {} } };
    return { body: { success: true, data: [] } };
  });
}

describe('[BUG-HUNT F22] the store page', () => {
  it('changes a type picked by mistake, with a reason, and never offers the type it already has', async () => {
    const fetchMock = serve(store());
    const { user } = renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />);
    await user.click(await screen.findByRole('button', { name: 'Change type…' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the type of Target Store?' });
    expect(within(dialog).queryByRole('radio', { name: 'Restaurant' })).toBeNull();
    await user.click(within(dialog).getByRole('radio', { name: 'Store' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Change type' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(String(url)).toMatch(/\/vendors\/vendor-target\/type$/);
    expect(JSON.parse(String(init?.body))).toEqual({ vendorType: 'STORE' });
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe(REASON);
  });

  it.each([[{ firstLiveAt: '2026-10-01T00:00:00.000Z' }], [{ subscription: { id: 's1', status: 'TRIAL' } }]])('does not offer a type change on a store that has been live: %j', async (extra) => {
    serve(store(extra));
    renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />);
    await screen.findByRole('button', { name: 'Change name…' });
    expect(screen.queryByRole('button', { name: 'Change type…' })).toBeNull();
  });

  it('changes a checked name, with how it was checked', async () => {
    const fetchMock = serve(store({ firstLiveAt: '2026-10-01T00:00:00.000Z', status: 'ACTIVE' }));
    const { user } = renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />);
    await user.click(await screen.findByRole('button', { name: 'Change name…' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the name of Target Store?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'New store name' }), 'Corner Kitchen');
    // [review-2476 F7] the question describes the name still to be typed: it never quotes a placeholder as the name
    expect(within(dialog).getByRole('group', { name: 'Is the new name exactly the registered name on the store’s certificate?' })).toBeTruthy();
    expect(within(dialog).queryByText(/“the new name”/)).toBeNull();
    // [R3 · review F7] the person says whether the new name matches the certificate: here it is not confirmed
    await user.click(within(dialog).getByRole('radio', { name: /^No, or not checked/ }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Checked the new registration certificate');
    await user.click(within(dialog).getByRole('button', { name: 'Change name' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(String(url)).toMatch(/\/vendors\/vendor-target\/name$/);
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'Corner Kitchen' });
  });

  // [R3 · review F7 · security review] A rename takes the store off its confirmed seller name. The rename itself never
  // confirms one: "Yes" asks the seller-name door as a second step (its own authority), and a refusal there is said.
  async function renameSaying(answer: RegExp, onSellerName: () => { status?: number; body: unknown }) {
    const fetchMock = mockApi((request) => {
      if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/vendors/vendor-target') return { body: { success: true, data: store({ firstLiveAt: '2026-10-01T00:00:00.000Z', status: 'ACTIVE' }) } };
      if (request.method === 'GET' && request.url.pathname.endsWith('/activation-checklist')) return { body: { success: true, data: checklist } };
      if (request.method === 'PUT' && request.url.pathname.endsWith('/seller-name')) return onSellerName();
      if (request.method === 'PUT') return { body: { success: true, data: {} } };
      return { body: { success: true, data: [] } };
    });
    const { user } = renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />);
    await user.click(await screen.findByRole('button', { name: 'Change name…' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the name of Target Store?' });
    expect(within(dialog).getByRole('group', { name: /exactly the registered name on the store’s certificate/ })).toBeTruthy();
    await user.type(within(dialog).getByRole('textbox', { name: 'New store name' }), 'Corner Kitchen Ltd');
    await user.click(within(dialog).getByRole('radio', { name: answer }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Checked the new registration certificate');
    await user.click(within(dialog).getByRole('button', { name: 'Change name' }));
    return fetchMock;
  }

  it('"Yes": renames, then confirms the new name through the seller-name door — two calls, the rename never carrying it', async () => {
    const fetchMock = await renameSaying(/^Yes: it matches the certificate/, () => ({ body: { success: true, data: {} } }));
    expect((await screen.findByRole('status')).textContent).toContain('confirmed as the seller');
    const puts = requestsByMethod(fetchMock, 'PUT');
    expect(puts.map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/v1/admin/vendors/vendor-target/name', '/api/v1/admin/vendors/vendor-target/seller-name']);
    expect(JSON.parse(String(puts[0]![1]?.body))).toEqual({ name: 'Corner Kitchen Ltd' });
    expect(JSON.parse(String(puts[1]![1]?.body))).toEqual({ name: 'Corner Kitchen Ltd' });
  });

  it('"Yes" by someone who may not approve stores: the rename stands, and the page says the confirmation was refused', async () => {
    await renameSaying(/^Yes: it matches the certificate/, () => ({ status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Not allowed' } } }));
    const said = (await screen.findByRole('status')).textContent ?? '';
    expect(said).toContain("The store's name is changed");
    expect(said).toContain('Confirming it as the seller’s name was refused');
  });
});
