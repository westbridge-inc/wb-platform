import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

const nav = { replace: vi.fn(), push: vi.fn(), pathname: '/login' };
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => nav, useSearchParams: () => new URLSearchParams() }));

import LoginPage from './page';
import SecurityPage from '../security/page';

// ---------------------------------------------------------------------------
// [AUDIT-20261113 FABLE-03 #2] When the authenticator step is required, a sign-in does not reach the console until
// the app's code is proved; an admin who has not set it up is walked through setting it up (key shown once, then
// ten recovery codes shown once). Fictional number and key.
// ---------------------------------------------------------------------------

afterEach(() => { vi.unstubAllGlobals(); nav.replace.mockReset(); });
const paths = (fetch: ReturnType<typeof mockApi>) => fetch.mock.calls.map(([input]) => new URL(String(input)).pathname);
const bodyOf = (r: ApiRequest) => JSON.parse(String(r.init?.body ?? '{}')) as Record<string, unknown>;

async function signIn(user: ReturnType<typeof renderWithQuery>['user']) {
  await user.clear(screen.getByLabelText('Phone'));
  await user.type(screen.getByLabelText('Phone'), '+5926009990');
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  await user.type(await screen.findByLabelText('Verification code'), '123456');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('[FABLE-03 #2] the authenticator step of an admin sign-in', () => {
  it('required and set up: the console opens only after the app code is accepted', async () => {
    let verified: Record<string, unknown> | null = null;
    const fetch = mockApi((r) => {
      if (r.url.pathname.endsWith('/auth/send-otp')) return { body: { success: true, data: {} } };
      if (r.url.pathname.endsWith('/auth/verify-otp')) return { body: { success: true, data: { session: 'cookie', isNewUser: false, user: { id: 'a1', roles: ['SUPER_ADMIN'] } } } };
      if (r.url.pathname.endsWith('/auth/admin-mfa') && r.method === 'GET') return { body: { success: true, data: { required: true, enrolled: true, enrolledAt: null, sessionVerified: false, recoveryCodesLeft: 10 } } };
      if (r.url.pathname.endsWith('/auth/admin-mfa/verify')) { verified = bodyOf(r); return { body: { success: true, data: { verified: true } } }; }
      throw new Error(`Unexpected request: ${r.method} ${r.url}`);
    });
    const { user } = renderWithQuery(<LoginPage />);
    await signIn(user);
    expect(nav.replace).not.toHaveBeenCalled();
    await user.type(await screen.findByLabelText('Authenticator code'), '654321');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/dashboard'));
    expect(verified).toEqual({ code: '654321' });
    expect(paths(fetch)).toContain('/api/v1/auth/admin-mfa/verify');
  });

  it('not required: the console opens straight after the sign-in code, as today', async () => {
    mockApi((r) => {
      if (r.url.pathname.endsWith('/auth/send-otp')) return { body: { success: true, data: {} } };
      if (r.url.pathname.endsWith('/auth/verify-otp')) return { body: { success: true, data: { session: 'cookie', isNewUser: false, user: { id: 'a1', roles: ['ADMIN'] } } } };
      if (r.url.pathname.endsWith('/auth/admin-mfa')) return { body: { success: true, data: { required: false, enrolled: false, enrolledAt: null, sessionVerified: false, recoveryCodesLeft: 0 } } };
      throw new Error(`Unexpected request: ${r.method} ${r.url}`);
    });
    const { user } = renderWithQuery(<LoginPage />);
    await signIn(user);
    await vi.waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/dashboard'));
  });

  it('Security: setting the app up shows the key once, confirms a code, then shows ten recovery codes once', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `ABCDE-FGH${String(i).padStart(2, '0')}`.slice(0, 11));
    mockApi((r) => {
      if (r.url.pathname.endsWith('/auth/admin-mfa') && r.method === 'GET') return { body: { success: true, data: { required: false, enrolled: false, enrolledAt: null, sessionVerified: false, recoveryCodesLeft: 0 } } };
      if (r.url.pathname.endsWith('/auth/admin-mfa/enrol')) return { body: { success: true, data: { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/Swift%3ASwift%20admin?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', expiresInSeconds: 600 } } };
      if (r.url.pathname.endsWith('/auth/admin-mfa/enrol/confirm')) return { body: { success: true, data: { enrolled: true, recoveryCodes: codes } } };
      throw new Error(`Unexpected request: ${r.method} ${r.url}`);
    });
    const { user } = renderWithQuery(<SecurityPage />);
    await user.click(await screen.findByRole('button', { name: 'Set up an authenticator app' }));
    expect((await screen.findByLabelText('Authenticator key')).textContent).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    await user.type(screen.getByLabelText('Code from the app'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    const list = await screen.findByLabelText('Recovery codes');
    expect(list.querySelectorAll('li')).toHaveLength(10);
    await user.click(screen.getByRole('button', { name: 'I have written them down' }));
    expect(nav.replace).toHaveBeenCalledWith('/dashboard');
  });
});
