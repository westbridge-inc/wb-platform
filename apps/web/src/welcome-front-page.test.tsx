import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetLaunchAnswer } from '@/lib/use-web-ordering';
import { APP_STORE_URL, GOOGLE_PLAY_URL } from '@/lib/app-stores';

// ---------------------------------------------------------------------------
// [WEB-APPBAR · owner 7 Nov 2026] swiftgy.com's front page is a WELCOME page: what Swift is, four doors (Order
// with Swift, the ordering Home now at /order; Sell on Swift; Deliver with Swift; Drive with Swift), and the
// official store badges once the apps are live. Who sees it, and who skips it, is the server's decision
// (welcome-front-door-middleware.test.ts).
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));

const SRC = join(process.cwd(), 'src');

async function load<T>(relativePath: string): Promise<T> {
  const path = join(SRC, relativePath);
  expect(existsSync(path), `${relativePath} does not exist`).toBe(true);
  return (await import(/* @vite-ignore */ path)) as T;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('[WEB-APPBAR] the welcome page itself', () => {
  beforeEach(() => {
    forgetLaunchAnswer();
    (window as unknown as { happyDOM: { setURL(_u: string): void } }).happyDOM.setURL('https://swiftgy.com/');
  });
  afterEach(() => {
    (window as unknown as { happyDOM: { setURL(_u: string): void } }).happyDOM.setURL('http://localhost:3000/');
  });

  function storesSwitch(appStores: 'live' | 'soon') {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith('/api/launch-state') ? new Response(JSON.stringify({ webOrdering: 'live', appStores })) : new Response('{}', { status: 404 })
    )));
  }
  async function settle() {
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }

  it('says what Swift is, in the site’s own words, with no price', async () => {
    storesSwitch('soon');
    const { default: Welcome } = await load<{ default: () => React.ReactElement }>('app/(marketing)/page.tsx');
    const view = render(<Welcome />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Food, groceries, shops, couriers and rides.');
    expect(view.container.textContent).toContain('The people doing the work keep 100% of what they earn.');
    expect(view.container.textContent).toMatch(/Made in Guyana by .+, .+\./);
    // No price: no currency, and no number but the 100% everyone keeps.
    expect(view.container.textContent).not.toMatch(/\$|GYD/);
    expect(view.container.textContent!.replace('100%', '')).not.toMatch(/\d/);
  });

  it('opens on four doors, big tap targets, each to the page that already exists', async () => {
    storesSwitch('soon');
    const { default: Welcome } = await load<{ default: () => React.ReactElement }>('app/(marketing)/page.tsx');
    render(<Welcome />);
    const doors = within(screen.getByRole('navigation', { name: 'Get started' })).getAllByRole('link');
    expect(doors.map((door) => [door.querySelector('span')!.textContent, door.getAttribute('href')])).toEqual([
      ['Order with Swift', '/order'],
      ['Sell on Swift', '/vendors'],
      ['Deliver with Swift', '/drivers'],
      ['Drive with Swift', '/drivers'],
    ]);
    for (const door of doors) {
      expect(door.className).toMatch(/\bmin-h-32\b/);
      // A line icon from the site's own set (lucide), never an emoji.
      expect(door.querySelector('svg.lucide')).not.toBeNull();
      expect(door.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
    }
    // Each door leads to a real page.
    const app = join(SRC, 'app');
    for (const page of ['(app)/order/page.tsx', '(marketing)/vendors/page.tsx', '(marketing)/drivers/page.tsx']) expect(existsSync(join(app, page)), page).toBe(true);
  });

  it('shows the official store badges only once the stores switch is live', async () => {
    storesSwitch('soon');
    const { default: Welcome } = await load<{ default: () => React.ReactElement }>('app/(marketing)/page.tsx');
    let view = render(<Welcome />);
    await settle();
    expect(screen.queryByRole('region', { name: 'Get the app' })).toBeNull();
    view.unmount();

    forgetLaunchAnswer();
    storesSwitch('live');
    view = render(<Welcome />);
    await settle();
    const badges = within(await screen.findByRole('region', { name: 'Get the app' })).getAllByRole('link');
    expect(badges.map((link) => [link.getAttribute('href'), link.querySelector('img')?.getAttribute('alt')])).toEqual([
      [APP_STORE_URL, 'Download on the App Store'],
      [GOOGLE_PLAY_URL, 'Get it on Google Play'],
    ]);
    view.unmount();
  });

  it('is a static page: no cookies, headers or per-visitor work, and no emoji anywhere in this work', () => {
    const source = readFileSync(join(SRC, 'app', '(marketing)', 'page.tsx'), 'utf8');
    expect(source).not.toMatch(/next\/headers|cookies\(|headers\(\)|revalidate|dynamic\s*=/);
    expect(source).not.toMatch(/'use client'/);
    for (const file of ['app/(marketing)/page.tsx', 'components/get-app-bar.tsx', 'components/get-app-bar-card.tsx', 'components/app-store-links.tsx', 'lib/get-the-app.ts', 'middleware.ts']) {
      expect(readFileSync(join(SRC, file), 'utf8'), file).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('the app’s menus keep a way back to the welcome page that the server never redirects', async () => {
    const shell = readFileSync(join(SRC, 'components', 'customer-shell.tsx'), 'utf8');
    expect(shell).toMatch(/\{ href: WELCOME_PATH, label: 'Welcome' \}/);
    const { WELCOME_PATH, HOME_PATH } = await import('@/lib/customer-routes');
    expect(WELCOME_PATH).toBe('/?welcome');
    expect(HOME_PATH).toBe('/order');
  });
});
