import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OWN_NAME_DECLARATION_WEB } from '@/lib/own-name-copy';
import SignupPage from './page';

// ---------------------------------------------------------------------------
// [ROLE-DOCS · owner ruling 21 Oct 2026 · #2046] A store may trade under its owner's own name (BNA s.3). On the
// web sign-up the owner picks it on the business step, reads the declaration and ticks it; the store is created
// with nameBasis OWN_NAME and the declaration is signed right after. The choice and the declaration's words load
// on demand (own-name-loader.ts; page-size.test.ts) — this file proves the owner still sees and signs them.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  become: vi.fn(), sign: vi.fn(), replace: vi.fn(), probe: vi.fn(), search: vi.fn(), api: vi.fn(), loadFails: { n: 0 },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fx.replace }) }));
vi.mock('@/lib/auth', () => ({ sendOtp: vi.fn(), sessionProbe: fx.probe, apiFetch: fx.api }));
vi.mock('@/lib/otp-send', () => ({ sendOtp: vi.fn() }));
vi.mock('@/lib/customer-account', () => ({ verifyOtp: vi.fn(), registerAccount: vi.fn(), becomePartner: fx.become, signOwnName: fx.sign }));
vi.mock('@/lib/customer-places', () => ({ placesAutocomplete: fx.search, placeDetails: vi.fn() }));
vi.mock('@/lib/geolocate', () => ({ currentCoords: vi.fn() }));
vi.mock('./weekly-fee-loader', () => ({ loadWeeklyFee: () => import('@/test/weekly-fee-fixture') }));
vi.mock('./own-name-loader', async () => {
  const real = await vi.importActual<typeof import('./own-name-loader')>('./own-name-loader');
  return { loadOwnNameChoice: () => (fx.loadFails.n-- > 0 ? Promise.reject(new Error('chunk')) : real.loadOwnNameChoice()) };
});

const DOOR = { placeId: 'door', primary: '12 Regent Street', secondary: 'Georgetown', lat: 6.812, lng: -58.163 };
const loadMap = () => screen.getByRole('application').querySelectorAll('img').forEach((tile) => fireEvent.load(tile));
const OWN = /I trade under my own name — I’m one person trading under just my surname/;

beforeEach(() => {
  vi.resetAllMocks();
  fx.loadFails.n = 0;
  fx.become.mockResolvedValue({});
  fx.sign.mockResolvedValue({});
  fx.probe.mockResolvedValue({ ok: true, user: { id: 'u1', phone: '+5926001008' } });
  fx.search.mockResolvedValue([DOOR]);
  fx.api.mockResolvedValue({ data: { address: 'Store entrance, Georgetown' } });
  window.history.replaceState(null, '', '/signup?resume=business');
});

/** The business step (a signed-in account without a store), filled in, store placed, agreement ticked. */
async function businessStep(storeName = 'Persaud') {
  const user = userEvent.setup();
  render(<SignupPage />);
  expect(await screen.findByRole('heading', { name: 'Your business' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Business name'), { target: { value: storeName } });
  for (const [label, value] of [['Street address', '12 Regent Street'], ['City or town', 'Georgetown'], ['Region (optional)', 'Demerara-Mahaica']]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  }
  await user.click(screen.getByRole('checkbox', { name: /I agree to the Business Agreement/ }));
  await user.click(screen.getByRole('button', { name: 'Place your store on the map' }));
  await screen.findByRole('button', { name: /12 Regent Street.*Georgetown/ });
  loadMap();
  await user.click(screen.getByRole('button', { name: /12 Regent Street.*Georgetown/ }));
  loadMap();
  await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
  return user;
}

describe('[ROLE-DOCS] the web sign-up offers and signs the own-name declaration', () => {
  it('shows the choice (business name by default) and, for own name, the declaration’s exact words for this store', async () => {
    const user = await businessStep();
    const own = (await screen.findByRole('radio', { name: OWN })) as HTMLInputElement;
    expect(own.checked).toBe(false);
    expect((screen.getByRole('radio', { name: 'We’re a registered business (a business name registered with the DCRA)' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(/I TRADE UNDER MY OWN NAME/)).toBeNull();
    await user.click(own);
    // [OWNER-ASKS 9 Nov 2026] a plain title and its version, then the signed words unchanged: title line + body = the text
    expect(document.querySelector('[data-own-name-title]')?.textContent).toBe('Declaration: I trade under my own nameVersion 1');
    expect(screen.queryByText(/I TRADE UNDER MY OWN NAME \(v1\)/)).toBeNull();
    expect(`I TRADE UNDER MY OWN NAME (v1)\n\n${document.querySelector('pre')?.textContent}`).toBe(OWN_NAME_DECLARATION_WEB);
    expect(screen.getByText('You sign this for “Persaud” only.')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'I have read and agree to this declaration.' }) as HTMLInputElement).checked).toBe(false);
  });

  it('own name without the tick creates nothing; with the tick the store is created as own-name, then signed', async () => {
    const user = await businessStep();
    await user.click(await screen.findByRole('radio', { name: OWN }));
    // [FLOW-QA F19] the button waits for the signed declaration, and the line under it says so
    expect((screen.getByRole('button', { name: 'Create business' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-signup-ask]')?.textContent).toBe('Sign the own-name declaration');
    expect(fx.become).not.toHaveBeenCalled();
    expect(fx.sign).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox', { name: 'I have read and agree to this declaration.' }));
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    expect(fx.become).toHaveBeenCalledTimes(1);
    expect(fx.become.mock.calls[0]![0]).toMatchObject({ role: 'VENDOR', business: { name: 'Persaud', nameBasis: 'OWN_NAME' } });
    expect(fx.sign).toHaveBeenCalledTimes(1);
    expect(fx.become.mock.invocationCallOrder[0]!).toBeLessThan(fx.sign.mock.invocationCallOrder[0]!);
    expect(fx.replace).toHaveBeenCalledWith('/dashboard');
  });

  it('a business name sends no nameBasis and signs nothing', async () => {
    const user = await businessStep('Test shop');
    await screen.findByRole('radio', { name: OWN });
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    expect(fx.become).toHaveBeenCalledTimes(1);
    expect(fx.become.mock.calls[0]![0].business).not.toHaveProperty('nameBasis');
    expect(fx.sign).not.toHaveBeenCalled();
  });

  it('a services business is never offered the own-name choice', async () => {
    await businessStep('Test services');
    await screen.findByRole('radio', { name: OWN });
    fireEvent.change(screen.getByLabelText('Business type'), { target: { value: 'SERVICE' } });
    expect(screen.queryByRole('radio', { name: OWN })).toBeNull();
  });
});

// [COMPANY-DOCS · owner rulings 10 Nov 2026] ONE choice, three options: the papers follow it.
describe('[COMPANY-DOCS] a registered company, a registered business or its manager, or my own name', () => {
  const COMPANY = 'We’re a registered company (incorporated, for example a “Ltd.” or “Inc.”)';
  const REGISTERED = 'We’re a registered business (a business name registered with the DCRA)';
  const MANAGER = 'I’m the manager, not the owner';

  it('the question asks how the business is set up, with three choices in the owner’s order', async () => {
    await businessStep('Chicken Co');
    await screen.findByRole('radio', { name: OWN });
    expect(screen.getByText('How is your business set up?')).toBeTruthy();
    expect(screen.getAllByRole('radio').map((r) => r.closest('label')!.textContent!.trim())).toEqual([COMPANY, REGISTERED, expect.stringMatching(OWN)]);
  });

  it('a company says what it uploads, that branches and staff upload nothing, and signs up as a company', async () => {
    const user = await businessStep('Chicken Co');
    await user.click(await screen.findByRole('radio', { name: COMPANY }));
    expect(screen.getByText(/One person manages your Swift account for the whole company: your branches and your staff don’t upload anything\./)).toBeTruthy();
    expect(screen.getByText(/Certificate of Incorporation/)).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: MANAGER })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    expect(fx.become).toHaveBeenCalledTimes(1);
    expect(fx.become.mock.calls[0]![0].business).toMatchObject({ accountBasis: 'COMPANY' });
    expect(fx.become.mock.calls[0]![0].business).not.toHaveProperty('nameBasis');
    expect(fx.sign).not.toHaveBeenCalled();
  });

  it('“I’m the manager, not the owner” under a registered business signs up as the manager', async () => {
    const user = await businessStep('Chicken Co');
    await screen.findByRole('radio', { name: OWN });
    await user.click(screen.getByRole('checkbox', { name: MANAGER }));
    expect(screen.getByText(/a letter of authority signed by the owner/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    expect(fx.become.mock.calls[0]![0].business).toMatchObject({ accountBasis: 'MANAGER' });
  });

  it('the owner of a registered business sends no account basis, exactly as before', async () => {
    const user = await businessStep('Chicken Co');
    await screen.findByRole('radio', { name: OWN });
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    expect(fx.become.mock.calls[0]![0].business).not.toHaveProperty('accountBasis');
  });

  it('a services business is asked: a registered company, or I own this business', async () => {
    await businessStep('Test services');
    await screen.findByRole('radio', { name: OWN });
    fireEvent.change(screen.getByLabelText('Business type'), { target: { value: 'SERVICE' } });
    expect(screen.getAllByRole('radio').map((r) => r.closest('label')!.textContent!.trim())).toEqual([COMPANY, 'I own this business']);
    expect(screen.queryByRole('checkbox', { name: MANAGER })).toBeNull();
  });

  it('a failed load of the choice offers a retry that brings it back (nothing typed is lost)', async () => {
    fx.loadFails.n = 1;
    const user = await businessStep();
    await user.click(await screen.findByRole('button', { name: 'Couldn’t load the business-type choice — try again' }));
    expect(await screen.findByRole('radio', { name: OWN })).toBeTruthy();
    expect((screen.getByLabelText('Business name') as HTMLInputElement).value).toBe('Persaud');
  });
});
