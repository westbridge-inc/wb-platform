import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { act, render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetLaunchAnswer } from '@/lib/use-web-ordering';
import { APP_STORE_URL, GOOGLE_PLAY_URL } from '@/lib/app-stores';

// ---------------------------------------------------------------------------
// [WEB-APPBAR · owner, on the live site: "the badges appear ONCE per page"] With the stores switch live, no page
// draws more than one App Store badge link (or Google Play badge link). Pages that show the badges themselves
// (`/`, /welcome, /launching-soon) sit under the (welcome) layout, whose footer leaves its badges out; every other
// page shows the footer's; the ordering app's rail has a plain "Get the app" item that opens the badges on demand.
// Menus that open on demand (the header's item, the phone menus, the rail's panel) are not part of a page's render.
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

const SRC = join(process.cwd(), 'src');

beforeEach(() => {
  forgetLaunchAnswer();
  (window as unknown as { happyDOM: { setURL(_u: string): void } }).happyDOM.setURL('https://swiftgy.com/');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (
    String(input).endsWith('/api/launch-state') ? new Response(JSON.stringify({ webOrdering: 'live', appStores: 'live' })) : new Response('{}', { status: 404 })
  )));
});
afterEach(() => {
  vi.unstubAllGlobals();
  (window as unknown as { happyDOM: { setURL(_u: string): void } }).happyDOM.setURL('http://localhost:3000/');
});

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/** The badge links a rendered page shows: a link to a store whose content is a badge image. */
function badges(root: HTMLElement) {
  const count = (href: string) => [...root.querySelectorAll(`a[href="${href}"]`)].filter((a) => a.querySelector('img[src^="/badges/"]')).length;
  return { appStore: count(APP_STORE_URL), googlePlay: count(GOOGLE_PLAY_URL) };
}

type Layout = (_p: { children: ReactNode }) => ReactElement;
type Page = () => ReactNode | Promise<ReactNode>;
const load = async <T,>(path: string) => (await import(/* @vite-ignore */ join(SRC, path))) as T;

describe('[WEB-APPBAR] the store badges appear once per page', () => {
  it.each(['app/(welcome)/page.tsx', 'app/(welcome)/welcome/page.tsx', 'app/(welcome)/launching-soon/page.tsx'])('%s: its own badges, and none in the footer', async (pagePath) => {
    const { default: Layout } = await load<{ default: Layout }>('app/(welcome)/layout.tsx');
    const { default: Page } = await load<{ default: Page }>(pagePath);
    const view = render(<Layout>{await Page()}</Layout>);
    await settle();
    expect(badges(view.container)).toEqual({ appStore: 1, googlePlay: 1 });
    expect(view.container.querySelector('footer a[href^="https://apps.apple.com"]')).toBeNull();
  });

  it.each(['app/(marketing)/about/page.tsx', 'app/(marketing)/faq/page.tsx', 'app/(marketing)/vendors/page.tsx', 'app/(marketing)/drivers/page.tsx', 'app/(marketing)/contact/page.tsx', 'app/(marketing)/how-it-works/page.tsx'])('%s: the footer’s badges only', async (pagePath) => {
    const { default: Layout } = await load<{ default: Layout }>('app/(marketing)/layout.tsx');
    const { default: Page } = await load<{ default: Page }>(pagePath);
    const view = render(<Layout>{await Page()}</Layout>);
    await settle();
    expect(badges(view.container)).toEqual({ appStore: 1, googlePlay: 1 });
  });

  it('a legal page: the footer’s badges only', async () => {
    const { default: Layout } = await load<{ default: Layout }>('app/legal/layout.tsx');
    const view = render(<Layout><p>Policy</p></Layout>);
    await settle();
    expect(badges(view.container)).toEqual({ appStore: 1, googlePlay: 1 });
  });

  it('the ordering app (rail and footer, as on /order and a store page): the footer’s badges only; the rail’s item opens them on demand', async () => {
    const { SideRail } = await import('@/components/customer-shell');
    const { SiteFooter } = await import('@/components/site');
    const view = render(<>
      <SideRail activeTab="home" marketVisible={false} cartCount={0} status="guest" person={null} returnPath={() => '/'} onSwitchApp={() => undefined} />
      <SiteFooter />
    </>);
    await settle();
    expect(view.container.querySelector('button[aria-controls="rail-get-the-app"]')).not.toBeNull();
    expect(badges(view.container)).toEqual({ appStore: 1, googlePlay: 1 });
  });

  it('source census: only the footer and the (welcome) front pages draw badges by default, and the (welcome) footer leaves them out', () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) files.push(path); } };
    walk(SRC);
    const drawsBadges = files
      .filter((path) => /<(StoreBadgesWhenLive|StoreButtons|GetTheAppSection|AppStoreLinks|StoreBadges)\b/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path).split(sep).join('/'))
      .sort();
    // The badge components themselves, the on-demand menus (the header's item, the phone menus' section, the rail's
    // panel and the phone bar), the footer, and the three (welcome) front pages. Nothing else.
    expect(drawsBadges).toEqual([
      'app/(welcome)/launching-soon/page.tsx',
      'app/(welcome)/page.tsx',
      'app/(welcome)/welcome/page.tsx',
      'components/app-store-links.tsx',
      'components/get-app-bar-card.tsx',
      'components/site.tsx',
      'components/store-badges.tsx',
    ]);
    expect(readFileSync(join(SRC, 'app', '(welcome)', 'layout.tsx'), 'utf8')).toMatch(/<SiteFooter storeBadges=\{false\} \/>/);
    for (const layout of ['app/(marketing)/layout.tsx', 'app/legal/layout.tsx', 'app/(app)/store/[slug]/layout.tsx', 'app/(app)/home-screen.tsx']) {
      expect(readFileSync(join(SRC, layout), 'utf8'), layout).toMatch(/<SiteFooter \/>/);
    }
  });
});
