import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SignupPage from './page';

const mocked = vi.hoisted(() => ({
  sendOtp: vi.fn(),
  verifyOtp: vi.fn(),
  registerAccount: vi.fn(),
  becomePartner: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocked.replace, push: mocked.push }),
}));

vi.mock('@/lib/auth', () => ({ sendOtp: mocked.sendOtp }));
vi.mock('@/lib/otp-send', () => ({ sendOtp: mocked.sendOtp }));
vi.mock('@/lib/customer-account', () => ({
  verifyOtp: mocked.verifyOtp,
  registerAccount: mocked.registerAccount,
  becomePartner: mocked.becomePartner,
}));
vi.mock('@/lib/geolocate', () => ({ currentCoords: vi.fn() }));

describe('web signup continuation recovery', () => {
  beforeEach(() => {
    mocked.sendOtp.mockResolvedValue(undefined);
    mocked.verifyOtp.mockResolvedValue({ isNewUser: true, signedIn: false });
    mocked.registerAccount.mockRejectedValue(new Error('Registration could not finish.'));
  });

  it('returns an ambiguous failed registration to a fresh OTP request', async () => {
    const user = userEvent.setup();
    render(<SignupPage />);

    await user.click(screen.getByRole('button', { name: /Order on Swift/i }));
    const phone = screen.getByLabelText('Phone number');
    await user.clear(phone);
    await user.type(phone, '+5926001001');
    await user.click(screen.getByRole('button', { name: 'Send code' }));

    const code = await screen.findByLabelText('Verification code');
    await user.type(code, '246810');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await user.type(await screen.findByLabelText('First name'), 'New');
    await user.type(screen.getByLabelText('Last name'), 'Customer');
    // [Owner ruling 15 Oct 2026] the sign-up's two ticks: Terms + Privacy, and 18+.
    await user.click(screen.getByRole('checkbox', { name: /Terms of Service/ }));
    await user.click(screen.getByRole('checkbox', { name: /18 or older/ }));
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Confirm your phone' })).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('Request a new verification code to try again.');
    expect(screen.queryByLabelText('Verification code')).toBeNull();
    expect(mocked.registerAccount).toHaveBeenCalledTimes(1);
    expect(mocked.replace).not.toHaveBeenCalled();
  });
});

describe('[E27] a new customer is not sent to the camera', () => {
  beforeEach(() => {
    mocked.replace.mockReset();
    mocked.sendOtp.mockResolvedValue(undefined);
    mocked.verifyOtp.mockResolvedValue({ isNewUser: true, signedIn: false });
    mocked.registerAccount.mockResolvedValue({ user: { id: 'u1', roles: ['CUSTOMER'] } });
  });

  async function registerCustomer() {
    const user = userEvent.setup();
    render(<SignupPage />);
    await user.click(screen.getByRole('button', { name: /Order on Swift/i }));
    const phone = screen.getByLabelText('Phone number');
    await user.clear(phone);
    await user.type(phone, '+5926001002');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText('Verification code'), '246810');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('First name'), 'New');
    await user.type(screen.getByLabelText('Last name'), 'Customer');
    // [Owner ruling 15 Oct 2026] the sign-up's two ticks: Terms + Privacy, and 18+.
    await user.click(screen.getByRole('checkbox', { name: /Terms of Service/ }));
    await user.click(screen.getByRole('checkbox', { name: /18 or older/ }));
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(mocked.replace).toHaveBeenCalledTimes(1));
    return String(mocked.replace.mock.calls[0]?.[0]);
  }

  it('lands on ordering, not /selfie', async () => {
    window.history.replaceState(null, '', '/signup');
    // [Q7b · WEB-APPBAR] Ordering is the customer's home: /order (`/` is the welcome page).
    expect(await registerCustomer()).toBe('/order');
  });

  // [WEB-APPBAR review S2] `/` is the welcome page, and this is a client navigation: the welcome page's early check
  // never runs, so a new customer sent to `/` would land on the welcome page. `next=/` means "no deep link".
  it('next=/ (Home’s "Create an account") is no deep link: lands on ordering at /order', async () => {
    window.history.replaceState(null, '', '/signup?next=%2F');
    expect(await registerCustomer()).toBe('/order');
  });

  it('keeps a safe return path, still without the selfie detour', async () => {
    window.history.replaceState(null, '', '/signup?next=%2Fcart');
    expect(await registerCustomer()).toBe('/cart');
  });
});

describe('[WEB-APPBAR review S2] an existing customer who signs in through sign-up', () => {
  beforeEach(() => {
    mocked.replace.mockReset();
    mocked.sendOtp.mockResolvedValue(undefined);
    mocked.verifyOtp.mockResolvedValue({ isNewUser: false, signedIn: true, user: { id: 'u1', roles: ['CUSTOMER'] } });
  });

  async function verifyExisting() {
    const user = userEvent.setup();
    render(<SignupPage />);
    await user.click(screen.getByRole('button', { name: /Order on Swift/i }));
    const phone = screen.getByLabelText('Phone number');
    await user.clear(phone);
    await user.type(phone, '+5926001002');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText('Verification code'), '246810');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(mocked.replace).toHaveBeenCalledTimes(1));
    return String(mocked.replace.mock.calls[0]?.[0]);
  }

  it.each(['/signup', '/signup?next=%2F', '/signup?next=%2F%3Fsource%3Dpwa'])('%s lands on ordering at /order, never the welcome page', async (url) => {
    window.history.replaceState(null, '', url);
    expect(await verifyExisting()).toBe('/order');
  });

  it('a real deep link still comes back to that page', async () => {
    window.history.replaceState(null, '', '/signup?next=%2Fcart');
    expect(await verifyExisting()).toBe('/cart');
  });
});
