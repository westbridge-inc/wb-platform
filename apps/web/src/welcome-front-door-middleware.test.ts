// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest, type NextResponse } from 'next/server';
import { getRedirectUrl, getRewrittenUrl, unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [WEB-APPBAR · COORD ruling 7 Nov: no new cookie] The welcome front page sets NO cookie and the server makes no
// returning-visitor decision: the privacy policy says Swift sets no cookies on the site, and that stays true. Who
// skips the welcome page is decided in the browser from the site's own local storage, before the page is
// painted (lib/welcome.ts; welcome-front-page.test.tsx). The middleware does only what it did before: while
// ordering is closed on the public site, `/` and the ordering addresses are the "Launching soon" page.
//
// Runs in Node: a browser-style Request drops the Host header, and the middleware decides by it.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');

async function load<T>(relativePath: string): Promise<T> {
  const path = join(SRC, relativePath);
  expect(existsSync(path), `${relativePath} does not exist`).toBe(true);
  return (await import(/* @vite-ignore */ path)) as T;
}

type Middleware = { middleware: (_r: NextRequest) => NextResponse; config: { matcher: string[] } };

async function server(webOrdering: 'live' | '') {
  vi.resetModules();
  vi.stubEnv('SWIFT_WEB_ORDERING', webOrdering);
  return load<Middleware>('middleware.ts');
}

function request(path: string, { host = 'swiftgy.com', cookie }: { host?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = { host };
  if (cookie) headers['cookie'] = cookie;
  return new NextRequest(`https://${host}${path}`, { headers });
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('[WEB-APPBAR] the welcome page sets no cookie, and the server redirects no one', () => {
  it('`/` and `/order` responses carry no Set-Cookie, open or closed, with or without cookies sent', async () => {
    for (const open of ['live', ''] as const) {
      const { middleware } = await server(open);
      for (const path of ['/', '/?source=pwa', '/order', '/order?source=pwa', '/order/browse', '/store/kfc', '/cart']) {
        for (const cookie of [undefined, 'swift_ordering=1', 'anything=1']) {
          const response = middleware(request(path, { cookie }));
          expect(response.headers.get('set-cookie'), `${open} ${path} ${cookie}`).toBeNull();
          expect(response.cookies.getAll(), `${open} ${path} ${cookie}`).toEqual([]);
        }
      }
    }
  });

  it('while ordering is open, `/` is the welcome page for everyone: no redirect, no rewrite', async () => {
    const { middleware } = await server('live');
    for (const path of ['/', '/?source=pwa', '/?welcome']) {
      for (const cookie of [undefined, 'swift_ordering=1']) {
        const response = middleware(request(path, { cookie }));
        expect(getRedirectUrl(response), path).toBeNull();
        expect(getRewrittenUrl(response), path).toBeNull();
        expect(response.status).toBe(200);
      }
    }
  });

  it('while ordering is closed, `/` and `/order` are still the "Launching soon" page', async () => {
    const { middleware, config } = await server('');
    for (const path of ['/', '/order']) {
      expect(unstable_doesMiddlewareMatch({ config, url: `https://swiftgy.com${path}` }), path).toBe(true);
      expect(new URL(getRewrittenUrl(middleware(request(path)))!).pathname, path).toBe('/launching-soon');
    }
  });

  it('no source in the site sets a cookie for this: the middleware is what it was, and nothing writes document.cookie', () => {
    const middleware = readFileSync(join(SRC, 'middleware.ts'), 'utf8');
    expect(middleware).not.toMatch(/cookies\.set|Set-Cookie|swift_ordering|redirect\(/i);
    for (const file of ['lib/welcome.ts', 'app/layout.tsx', 'app/(app)/layout.tsx', 'app/(welcome)/page.tsx', 'lib/web-ordering.ts']) {
      expect(readFileSync(join(SRC, file), 'utf8'), file).not.toMatch(/document\.cookie|swift_ordering/);
    }
  });
});
