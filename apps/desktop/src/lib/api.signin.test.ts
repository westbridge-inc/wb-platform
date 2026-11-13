import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

// ---------------------------------------------------------------------------
// [REVIEW-2501-B B-S4-2] Every sign-in of an admin account is emailed to the account, naming the app from a fixed
// list. The desktop sent nothing, so its sign-ins read "a device Swift could not name": the same words a script
// produces. It names itself now, with the one word the server's list knows for it.
// ---------------------------------------------------------------------------

afterEach(() => { vi.unstubAllGlobals(); });

describe('the desktop sign-in names its app', () => {
  it('verify-otp carries x-device-type: desktop', async () => {
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ success: false, error: { message: 'That code is not valid.' } }), { status: 400 });
    }));
    const { verifyAdminLogin, DESKTOP_DEVICE_TYPE } = await import('./api');
    await expect(verifyAdminLogin('+5920000000', '000000')).rejects.toThrow();
    const call = sent.find((r) => r.url.endsWith('/api/v1/auth/verify-otp'));
    expect(call?.headers['x-device-type']).toBe('desktop');
    expect(DESKTOP_DEVICE_TYPE).toBe('desktop');
  });
});
