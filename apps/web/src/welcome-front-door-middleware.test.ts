// @vitest-environment node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest, type NextResponse } from 'next/server';
import { getRedirectUrl, getRewrittenUrl, unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [WEB-APPBAR · owner 7 Nov 2026] swiftgy.com's front page is a WELCOME page, and a smart one: the server decides.
//
// A NEW visitor to `/` sees the welcome page (app/(marketing)/page.tsx; welcome-front-page.test.tsx). A RETURNING
// visitor (this browser opened ordering before, which every ordering page records in a first-party cookie; a
// customer's sign-in lands there too) or an installed app's launch goes straight to ordering at /order, by a
// server redirect: no welcome page flashes first. `/?welcome` always shows the welcome page. While ordering is
// not open on the public site, `/` stays the "Launching soon" page, cookie or not.
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

/** The web server, running with the ordering switch set to `webOrdering`. */
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

const RETURNING = 'swift_ordering=1';
/** What the middleware did: sent the visitor elsewhere, answered with another page, or let the page through. */
function outcome(response: NextResponse) {
  const redirect = getRedirectUrl(response);
  const rewrite = getRewrittenUrl(response);
  return {
    status: response.status,
    redirect: redirect ? new URL(redirect) : null,
    rewrite: rewrite ? new URL(rewrite).pathname : null,
    cookie: response.cookies.get('swift_ordering') ?? null,
  };
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('[WEB-APPBAR] who sees the welcome page at `/`, decided by the server', () => {
  it('the middleware runs on `/` and on every ordering address', async () => {
    const { config } = await server('live');
    for (const path of ['/', '/order', '/order/browse', '/store/kfc', '/cart', '/checkout', '/orders/o1', '/account']) {
      expect(unstable_doesMiddlewareMatch({ config, url: `https://swiftgy.com${path}` }), path).toBe(true);
    }
  });

  it('a new visitor sees the welcome page: no redirect, no rewrite, no cookie', async () => {
    const { middleware } = await server('live');
    for (const host of ['swiftgy.com', 'www.swiftgy.com', 'staging.swiftgy.com']) {
      const result = outcome(middleware(request('/', { host })));
      expect(result, host).toEqual({ status: 200, redirect: null, rewrite: null, cookie: null });
    }
  });

  it('a returning visitor goes straight to ordering, keeping the query, with a temporary redirect', async () => {
    const { middleware } = await server('live');
    let result = outcome(middleware(request('/', { cookie: RETURNING })));
    expect(result.status).toBe(307);
    expect(result.redirect?.pathname).toBe('/order');
    result = outcome(middleware(request('/?src=qr&c=AB12', { cookie: `other=x; ${RETURNING}` })));
    expect(result.redirect?.pathname).toBe('/order');
    expect(result.redirect?.search).toBe('?src=qr&c=AB12');
  });

  it('an installed app’s launch (?source=pwa) goes to ordering even without the cookie', async () => {
    const { middleware } = await server('live');
    const result = outcome(middleware(request('/?source=pwa')));
    expect(result.status).toBe(307);
    expect(result.redirect?.pathname).toBe('/order');
    expect(result.redirect?.searchParams.get('source')).toBe('pwa');
  });

  it('`/?welcome` always shows the welcome page, and a cookie that is not exactly "1" is not a returning visitor', async () => {
    const { middleware } = await server('live');
    expect(outcome(middleware(request('/?welcome', { cookie: RETURNING }))).redirect).toBeNull();
    expect(outcome(middleware(request('/?welcome=1&source=pwa'))).redirect).toBeNull();
    for (const cookie of ['swift_ordering=0', 'swift_ordering=', 'swift_ordering=yes', 'xswift_ordering=1']) {
      expect(outcome(middleware(request('/', { cookie }))).redirect, cookie).toBeNull();
    }
  });

  it('while ordering is closed, `/` is the "Launching soon" page, cookie or not, and nothing is recorded', async () => {
    const { middleware } = await server('');
    for (const cookie of [undefined, RETURNING]) {
      const result = outcome(middleware(request('/', { cookie })));
      expect(result.rewrite, String(cookie)).toBe('/launching-soon');
      expect(result.redirect).toBeNull();
    }
    expect(outcome(middleware(request('/order'))).cookie).toBeNull();
    expect(outcome(middleware(request('/order'))).rewrite).toBe('/launching-soon');
  });
});

describe('[WEB-APPBAR] opening ordering is remembered, server-side, with nothing personal in it', () => {
  it('every ordering page sets the first-party cookie: "1", whole site, a year, HttpOnly, Lax, Secure over TLS', async () => {
    const { middleware } = await server('live');
    for (const path of ['/order', '/order/browse', '/order/search', '/order/vendor/v1', '/store/kfc', '/store/kfc?src=qr&c=AB12', '/explore', '/market', '/cart', '/checkout', '/orders', '/orders/o1', '/courier', '/taxi', '/account', '/account/profile']) {
      const result = outcome(middleware(request(path)));
      expect(result.redirect, path).toBeNull();
      expect(result.rewrite, path).toBeNull();
      expect(result.cookie, path).toMatchObject({ name: 'swift_ordering', value: '1', path: '/', maxAge: 365 * 24 * 60 * 60, httpOnly: true, sameSite: 'lax', secure: true });
    }
  });

  it('is set once: a browser that already carries it is not sent it again', async () => {
    const { middleware } = await server('live');
    expect(outcome(middleware(request('/order', { cookie: RETURNING }))).cookie).toBeNull();
  });

  it('company pages, the public deletion page, the store directory and the selfie step record nothing', async () => {
    const { middleware } = await server('live');
    for (const path of ['/account/delete', '/stores', '/stores/kfc', '/selfie']) {
      expect(outcome(middleware(request(path))).cookie, path).toBeNull();
    }
  });

  it('a plain-HTTP local run gets the cookie without Secure (a browser would drop a Secure cookie over HTTP)', async () => {
    const { middleware } = await server('live');
    const local = new NextRequest('http://localhost:3002/order', { headers: { host: 'localhost:3002' } });
    expect(outcome(middleware(local)).cookie).toMatchObject({ value: '1', secure: false });
  });
});

