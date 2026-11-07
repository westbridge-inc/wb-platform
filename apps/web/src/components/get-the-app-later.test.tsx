import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetAppBarLater } from './get-the-app-later';

// ---------------------------------------------------------------------------
// [WEB-APPBAR · perf] The layouts carry only a loader for the phone "Get the app" bar: it fetches the bar's code
// after the page has loaded, and only on what may be a phone. A desktop never fetches it.
// ---------------------------------------------------------------------------

const fetched = vi.hoisted(() => ({ count: 0 }));
vi.mock('./get-app-bar', () => {
  fetched.count += 1;
  return { GetAppBar: () => <p>The bar’s code arrived</p> };
});

const restores: Array<() => void> = [];
function device(userAgent: string, coarse: boolean) {
  for (const [target, key, descriptor] of [
    [navigator, 'userAgent', { get: () => userAgent }],
    [window, 'matchMedia', { value: (query: string) => ({ matches: query === '(pointer: coarse)' && coarse, media: query, addEventListener() {}, removeEventListener() {} }) }],
  ] as const) {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
    restores.push(() => { if (original) Object.defineProperty(target, key, original); else delete (target as unknown as Record<string, unknown>)[key]; });
  }
}
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });

async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('[WEB-APPBAR · perf] GetAppBarLater', () => {
  it('draws nothing on first paint, and a desktop never fetches the bar', async () => {
    device('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', false);
    const view = render(<GetAppBarLater />);
    expect(view.container.textContent).toBe('');
    await settle();
    expect(fetched.count).toBe(0);
    expect(screen.queryByText('The bar’s code arrived')).toBeNull();
  });

  it('a phone fetches it after the page (an Android browser, or any touch screen)', async () => {
    device('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36', false);
    const view = render(<GetAppBarLater />);
    expect(view.container.textContent).toBe('');
    expect(await screen.findByText('The bar’s code arrived')).toBeTruthy();
    expect(fetched.count).toBe(1);
  });
});

describe('[WEB-APPBAR review · ruling: table QR = menu only] the store page records a table-QR visit itself', () => {
  it('a store page opened from a table’s QR code marks the visit as it loads; the bar’s gate then draws nothing', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const store = readFileSync(join(process.cwd(), 'src', 'components', 'storefront', 'storefront-experience.tsx'), 'utf8');
    expect(store).toMatch(/if \(!fromQr\) return;\s*\/\/[^\n]*\n\s*markTableQrVisit\(\);/);
    const { markTableQrVisit, qrVisit, forgetQrVisit } = await import('@/lib/table-qr');
    forgetQrVisit();
    expect(qrVisit()).toBe(false);
    markTableQrVisit();
    expect(qrVisit()).toBe(true);
    expect(sessionStorage.getItem('swift.qr-visit')).toBe('1');
    forgetQrVisit();
  });

  it('[perf] the frame’s loader carries no QR code of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const loader = readFileSync(join(process.cwd(), 'src', 'components', 'get-the-app-later.tsx'), 'utf8');
    const imports = loader.split('\n').filter((line) => /^import\s/.test(line)).join('\n');
    expect(imports).not.toMatch(/table-qr|get-the-app'/);
  });
});
