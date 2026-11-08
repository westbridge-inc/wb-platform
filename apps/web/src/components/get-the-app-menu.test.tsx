import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteNav } from './site-nav';
import { MoreMenu, SideRail } from './customer-shell';
import { forgetLaunchAnswer } from '@/lib/use-web-ordering';
import { APP_STORE_URL, GOOGLE_PLAY_URL } from '@/lib/app-stores';

// ---------------------------------------------------------------------------
// [WEB-APPBAR · owner 7 Nov 2026] "Get the app" in the site's menus, on every device: the header's
// menu (wide: one item that opens the two store links; phone: the links in the menu), and the shopping
// app's rail (wide) and "More from Swift" menu (phone). Only once the stores switch is live.
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));

function storesSwitch(appStores: 'live' | 'soon') {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (
    String(input).endsWith('/api/launch-state')
      ? new Response(JSON.stringify({ webOrdering: 'live', appStores }))
      : new Response('{}', { status: 404 })
  )));
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const hrefs = (root: Element) => [...root.querySelectorAll('a')].map((a) => a.getAttribute('href')).filter((h) => h === APP_STORE_URL || h === GOOGLE_PLAY_URL);

beforeEach(() => {
  forgetLaunchAnswer();
  (window as unknown as { happyDOM: { setURL(_u: string): void } }).happyDOM.setURL('https://swiftgy.com/about');
});
afterEach(() => {
  (window as unknown as { happyDOM: { setURL(_u: string): void } }).happyDOM.setURL('http://localhost:3000/');
});

describe('[WEB-APPBAR] the header’s "Get the app"', () => {
  it('wide: one item that opens and closes the two store links', async () => {
    storesSwitch('live');
    render(<SiteNav />);
    await settle();
    const main = screen.getByRole('navigation', { name: 'Main' });
    const item = within(main).getByRole('button', { name: 'Get the app' });
    expect(item.getAttribute('aria-expanded')).toBe('false');
    expect(hrefs(main)).toEqual([]);
    fireEvent.click(item);
    expect(item.getAttribute('aria-expanded')).toBe('true');
    // The badges' code comes when the item opens (never in the header's first load).
    await waitFor(() => expect(hrefs(main)).toEqual([APP_STORE_URL, GOOGLE_PLAY_URL]));
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(hrefs(main)).toEqual([]);
    expect(document.activeElement).toBe(item);
    fireEvent.click(item);
    fireEvent.pointerDown(document.body);
    expect(hrefs(main)).toEqual([]);
  });

  it('phone: the menu lists the two store links under "Get the app"', async () => {
    storesSwitch('live');
    render(<SiteNav />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const menu = screen.getByRole('dialog', { name: 'Swift site menu' });
    const section = await within(menu).findByRole('region', { name: 'Get the app' });
    expect(hrefs(section)).toEqual([APP_STORE_URL, GOOGLE_PLAY_URL]);
  });

  it('while the switch is off there is no item and no store link', async () => {
    storesSwitch('soon');
    render(<SiteNav />);
    await settle();
    expect(screen.queryByRole('button', { name: 'Get the app' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    await settle();
    const menu = screen.getByRole('dialog', { name: 'Swift site menu' });
    expect(within(menu).queryByRole('region', { name: 'Get the app' })).toBeNull();
    expect(hrefs(document.body)).toEqual([]);
  });
});

describe('[WEB-APPBAR] the shopping app’s menus', () => {
  it('the phone "More from Swift" menu shows the two store links once live', async () => {
    storesSwitch('live');
    const more = render(<MoreMenu guest returnPath={() => '/'} onClose={() => undefined} />);
    await settle();
    expect(hrefs(await screen.findByRole('region', { name: 'Get the app' }))).toEqual([APP_STORE_URL, GOOGLE_PLAY_URL]);
    more.unmount();
  });

  // [WEB-APPBAR · owner, live page: the badges appear ONCE per page] The wide rail draws no badges of its own: a
  // plain "Get the app" item opens them, side by side, in a panel beside the rail.
  it('the wide rail has a plain "Get the app" item, no badges until it is opened, then the two side by side', async () => {
    storesSwitch('live');
    const rail = render(<SideRail activeTab="home" marketVisible={false} cartCount={0} status="guest" person={null} returnPath={() => '/'} onSwitchApp={() => undefined} />);
    await settle();
    const item = await screen.findByRole('button', { name: 'Get the app' });
    expect(hrefs(rail.container)).toEqual([]);
    expect(item.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(item);
    expect(item.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByRole('group', { name: 'Get the Swift app' });
    expect(hrefs(panel)).toEqual([APP_STORE_URL, GOOGLE_PLAY_URL]);
    expect(panel.querySelector('ul')!.className).toMatch(/\bflex-nowrap\b/);
    expect(panel.className).toMatch(/\bfixed\b/);
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Get the Swift app' })).toBeNull();
    expect(document.activeElement).toBe(item);
    fireEvent.click(item);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('group', { name: 'Get the Swift app' })).toBeNull();
    rail.unmount();
  });

  it('the rail item is not there while the switch is off', async () => {
    storesSwitch('soon');
    render(<SideRail activeTab="home" marketVisible={false} cartCount={0} status="guest" person={null} returnPath={() => '/'} onSwitchApp={() => undefined} />);
    await settle();
    expect(screen.queryByRole('button', { name: 'Get the app' })).toBeNull();
  });

  it('nothing while the switch is off', async () => {
    storesSwitch('soon');
    render(<MoreMenu guest returnPath={() => '/'} onClose={() => undefined} />);
    await settle();
    expect(screen.queryByRole('region', { name: 'Get the app' })).toBeNull();
    expect(hrefs(document.body)).toEqual([]);
  });
});

describe('[WEB-APPBAR · perf] the header and the frames carry only an after-load loader', () => {
  it('the header imports no store badge code; the menus fetch it after the page', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = join(process.cwd(), 'src', 'components');
    for (const file of ['site-nav.tsx', 'customer-shell.tsx', 'site.tsx']) {
      const imports = readFileSync(join(src, file), 'utf8').split('\n').filter((line) => /^import\s/.test(line)).join('\n');
      expect(imports, file).not.toMatch(/app-store-links'|get-app-bar'|get-app-bar-card'/);
    }
    // The footer module no longer re-exports the header: a page that draws only the footer never ships the header.
    expect(readFileSync(join(src, 'site.tsx'), 'utf8')).not.toMatch(/export \{ SiteNav \}/);
  });
});
