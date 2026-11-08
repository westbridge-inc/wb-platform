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
    const { default: Welcome } = await load<{ default: () => React.ReactElement }>('app/(welcome)/page.tsx');
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
    const { default: Welcome } = await load<{ default: () => React.ReactElement }>('app/(welcome)/page.tsx');
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
    const { default: Welcome } = await load<{ default: () => React.ReactElement }>('app/(welcome)/page.tsx');
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
    const source = readFileSync(join(SRC, 'app', '(welcome)', 'page.tsx'), 'utf8');
    expect(source).not.toMatch(/next\/headers|cookies\(|headers\(\)|revalidate|dynamic\s*=/);
    expect(source).not.toMatch(/'use client'/);
    for (const file of ['app/(welcome)/page.tsx', 'components/get-app-bar.tsx', 'components/get-app-bar-card.tsx', 'components/app-store-links.tsx', 'lib/get-the-app.ts', 'middleware.ts']) {
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

describe('[WEB-PHONES · owner 8 Nov] the welcome page shows the real app screens', () => {
  beforeEach(() => {
    forgetLaunchAnswer();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ webOrdering: 'live', appStores: 'soon' }))));
  });

  async function welcome() {
    const { default: Welcome } = await load<{ default: () => React.ReactElement }>('app/(welcome)/page.tsx');
    return render(<Welcome />);
  }
  const HOME_ALT = 'The Swift app’s Home screen: a Good afternoon greeting, search, and tiles for Food, Groceries, Taxi, Send, Services, Orders, Favourites and Scan.';
  const SCREEN_ALTS = [
    'Live order tracking in the Swift app: the rider on the map and where the order stands.',
    'Booking a taxi in the Swift app: the destination pinned on the map, and the pickup and destination fields.',
    'The rider’s side of the Swift app: a map of Georgetown and the button to go online for jobs.',
  ];

  it('the Home screen is the hero, beside the headline and the doors (under them on a phone), and loads first', async () => {
    const view = await welcome();
    const images = [...view.container.querySelectorAll('img')];
    expect(images.map((img) => img.getAttribute('alt'))).toEqual([HOME_ALT, ...SCREEN_ALTS]);
    const hero = images[0]!;
    expect(hero.getAttribute('loading')).not.toBe('lazy');
    expect(hero.getAttribute('fetchpriority')).toBe('high');
    // The hero and the intro (headline, doors) share one grid: one column on a phone, the doors first and the phone
    // under them; two columns on a wide screen, the phone beside them.
    const intro = view.container.querySelector('[data-welcome-intro]')!;
    expect(intro.querySelector('h1')).not.toBeNull();
    expect(intro.querySelector('nav[aria-label="Get started"]')).not.toBeNull();
    const grid = intro.parentElement!;
    expect(grid.contains(hero)).toBe(true);
    expect(grid.className).toMatch(/\blg:grid-cols-\[minmax\(0,1fr\)_340px\]/);
    expect(intro.compareDocumentPosition(hero) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a See it in action row: tracking, taxi and the rider’s side, each with a one-line caption, lazy', async () => {
    const view = await welcome();
    const section = screen.getByRole('region', { name: 'See it in action' });
    const figures = [...section.querySelectorAll('figure')];
    expect(figures.map((figure) => figure.querySelector('img')!.getAttribute('alt'))).toEqual(SCREEN_ALTS);
    expect(figures.map((figure) => [figure.querySelector('h3')!.textContent, figure.querySelector('figcaption p')!.textContent])).toEqual([
      ['Order', 'Follow every order live on the map.'],
      ['Ride', 'A PIN check before every ride, and the trip live on the map.'],
      ['Earn', 'Sell, deliver, drive or offer a service.'],
    ]);
    for (const figure of figures) expect(figure.querySelector('img')!.getAttribute('loading')).toBe('lazy');
    // A swipe row on a phone that a keyboard can scroll; three columns on a wide screen.
    const row = section.querySelector('[data-swipe-row]')!;
    expect(row.getAttribute('tabindex')).toBe('0');
    for (const cls of ['overflow-x-auto', 'snap-x', 'md:grid', 'md:grid-cols-3', 'md:overflow-visible']) expect(row.className, cls).toContain(cls);
    expect(view.container.querySelectorAll('img')).toHaveLength(4);
  });

  it('no new claim: every caption is the "Launching soon" page’s own words', async () => {
    const view = await welcome();
    const captions = [...view.container.querySelectorAll('figcaption p')].map((p) => p.textContent!);
    expect(captions).toHaveLength(3);
    const source = readFileSync(join(SRC, 'app', '(welcome)', 'launching-soon', 'page.tsx'), 'utf8').replace(/\s+/g, ' ');
    for (const caption of captions) expect(source, caption).toContain(caption);
  });

  it('no price, fare, rating, review, earning or name in any alt text or caption', async () => {
    const view = await welcome();
    const words = [
      ...[...view.container.querySelectorAll('img')].map((img) => img.alt),
      ...[...view.container.querySelectorAll('figcaption')].map((caption) => caption.textContent ?? ''),
    ].join(' ');
    expect(words).not.toMatch(/\$|GYD|\d|fare|price|fee\b|Demo|Kezia|rating|review|earn(ed|ings)/i);
  });

  it('sized, responsive images with no layout shift: width and height, srcset widths and the drawn size', async () => {
    const view = await welcome();
    const images = [...view.container.querySelectorAll('img')];
    for (const img of images) {
      expect(Number(img.getAttribute('width')), img.alt).toBeGreaterThan(0);
      expect(Number(img.getAttribute('height')), img.alt).toBeGreaterThan(0);
      expect(img.getAttribute('sizes'), img.alt).toBeTruthy();
      expect(img.className, img.alt).toMatch(/\bh-auto\b.*\bw-full\b/);
    }
    const widths = (img: HTMLImageElement) => (img.getAttribute('srcset') ?? '').split(',').map((s) => s.trim().split(/\s+/)[1]);
    expect(widths(images[0]!)).toEqual(['600w', '880w']);
    expect(images[0]!.getAttribute('sizes')).toBe('(min-width: 1024px) 318px, 298px');
    for (const img of images.slice(1)) expect(widths(img), img.alt).toEqual(['640w', '1206w']);
  });

  it('stays a server-rendered page with no client script: plain images, never next/image’s component', () => {
    for (const file of ['app/(welcome)/page.tsx', 'app/(welcome)/app-screens.tsx']) {
      const source = readFileSync(join(SRC, file), 'utf8');
      expect(source, file).not.toMatch(/'use client'/);
      expect(source, file).not.toMatch(/import (?!type\b)[^;]*from 'next\/image'/);
      expect(source, file).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('axe finds nothing on the page', async () => {
    const { axeViolations } = await import('@/test/axe');
    const view = await welcome();
    expect(await axeViolations(view.container)).toEqual([]);
  });
});

describe('[WEB-APPBAR · no cookie] a returning visitor skips the welcome page, decided before it is painted', () => {
  /** Runs the early script exactly as the page's <head> carries it, against a URL and this browser's storage. */
  async function earlyScriptAt(url: string, stored: string | null | 'blocked') {
    const { WELCOME_REDIRECT_SCRIPT } = await import('@/lib/welcome');
    const parsed = new URL(url);
    const replace = vi.fn();
    const location = { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash, replace };
    const localStorage = {
      getItem: (key: string) => {
        if (stored === 'blocked') throw new DOMException('blocked', 'SecurityError');
        return key === 'swift.ordering' ? stored : null;
      },
    };
    new Function('location', 'localStorage', WELCOME_REDIRECT_SCRIPT)(location, localStorage);
    return replace.mock.calls.map((call) => call[0]);
  }

  it('a new visitor stays on the welcome page; a browser that opened ordering goes to /order, query kept', async () => {
    expect(await earlyScriptAt('https://swiftgy.com/', null)).toEqual([]);
    expect(await earlyScriptAt('https://swiftgy.com/', '0')).toEqual([]);
    expect(await earlyScriptAt('https://swiftgy.com/', '1')).toEqual(['/order']);
    expect(await earlyScriptAt('https://swiftgy.com/?src=qr&c=AB12', '1')).toEqual(['/order?src=qr&c=AB12']);
    // [WEB-APPBAR review] The hash travels too.
    expect(await earlyScriptAt('https://swiftgy.com/#stores', '1')).toEqual(['/order#stores']);
    expect(await earlyScriptAt('https://swiftgy.com/?a=1#stores', '1')).toEqual(['/order?a=1#stores']);
    expect(await earlyScriptAt('https://swiftgy.com/?welcome#stores', '1')).toEqual([]);
  });

  it('an installed app’s launch goes to ordering; `/?welcome` always stays; storage that is blocked stays', async () => {
    expect(await earlyScriptAt('https://swiftgy.com/?source=pwa', null)).toEqual(['/order?source=pwa']);
    for (const url of ['https://swiftgy.com/?welcome', 'https://swiftgy.com/?welcome=1', 'https://swiftgy.com/?a=1&welcome']) {
      expect(await earlyScriptAt(url, '1'), url).toEqual([]);
    }
    expect(await earlyScriptAt('https://swiftgy.com/?welcomed=1', '1')).toEqual(['/order?welcomed=1']);
    expect(await earlyScriptAt('https://swiftgy.com/', 'blocked')).toEqual([]);
  });

  it('does nothing on any other page', async () => {
    for (const url of ['https://swiftgy.com/order', 'https://swiftgy.com/vendors', 'https://swiftgy.com/legal/terms', 'https://swiftgy.com/cart?source=pwa']) {
      expect(await earlyScriptAt(url, '1'), url).toEqual([]);
    }
  });

  it('every page’s <head> carries it inline, before anything is painted, under the unchanged policy', async () => {
    const { WELCOME_REDIRECT_SCRIPT } = await import('@/lib/welcome');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { default: RootLayout } = await import('@/app/layout');
    const html = renderToStaticMarkup(RootLayout({ children: null }) as React.ReactElement);
    const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
    expect(head).toContain(`<script>${WELCOME_REDIRECT_SCRIPT}</script>`);
    // Not async, not deferred, not a module: it runs where it stands, before the body is parsed.
    expect(head).not.toMatch(/<script[^>]+(async|defer|type=)/);
    // The policy that allows it is the site's existing one, unchanged: inline scripts were already allowed.
    const policy = readFileSync(join(SRC, 'lib', 'browser-api-origin.ts'), 'utf8');
    expect(policy).toContain(`? "script-src 'self' 'unsafe-inline'"`);
    // Plain ES5 the browser runs as written, with no person, cookie or network in it.
    expect(WELCOME_REDIRECT_SCRIPT).not.toMatch(/=>|\blet\b|\bconst\b|cookie|fetch|XMLHttpRequest/);
  });

  it('the ordering app’s frame records the visit in this site’s own storage (no cookie), and survives blocked storage', async () => {
    const { rememberOrdering, ORDERING_FLAG_KEY } = await import('@/lib/welcome');
    expect(ORDERING_FLAG_KEY).toBe('swift.ordering');
    localStorage.clear();
    rememberOrdering();
    expect(localStorage.getItem('swift.ordering')).toBe('1');
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'QuotaExceededError'); });
    expect(() => rememberOrdering()).not.toThrow();
    setItem.mockRestore();
    const frame = readFileSync(join(SRC, 'app', '(app)', 'layout.tsx'), 'utf8');
    expect(frame).toMatch(/useEffect\(\(\) => \{ rememberOrdering\(\); \}, \[\]\);/);
  });
});
