import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetLaunchAnswer } from '@/lib/use-web-ordering';
import { STORE_BADGES, StoreBadges } from './store-badges';
import { APPLE_TRADEMARKS, GOOGLE_TRADEMARKS, SiteFooter } from './site';

// ---------------------------------------------------------------------------
// [WEB-APPBAR · owner 7 Nov 2026] Every store link the site draws as a button is the stores' OFFICIAL badge,
// served from this site exactly as Apple and Google publish it, sized by their guidelines, one link each.
//   - Apple: the black en-us "Download on the App Store" SVG from Apple's marketing tools (served today at
//     toolbox.marketingtools.apple.com/api/v2/badges/download-on-the-app-store/black/en-us; the older
//     tools.applemarketingtools.com name no longer resolves).
//   - Google: en_badge_web_generic.png from play.google.com/intl/en_us/badges.
// ---------------------------------------------------------------------------

const PUBLIC = join(process.cwd(), 'public');
const setUrl = (url: string) => (window as unknown as { happyDOM: { setURL(_u: string): void } }).happyDOM.setURL(url);
beforeEach(() => setUrl('https://swiftgy.com/about'));
afterEach(() => { vi.unstubAllGlobals(); setUrl('http://localhost:3000/'); });
const sha256 = (path: string) => createHash('sha256').update(readFileSync(join(PUBLIC, path))).digest('hex');

describe('[WEB-APPBAR] the official badges, unmodified', () => {
  it('the files are byte for byte the ones Apple and Google publish', () => {
    expect(sha256('badges/download-on-the-app-store.svg')).toBe('a26fc5b38380272c92e9019a2eb8b45542a66814b3e2b203772db8904b9fb99f');
    expect(sha256('badges/get-it-on-google-play.png')).toBe('f72611e2df8e88204009fd896d05d5e8e83c77009c63943bbffa169559934849');
    const svg = readFileSync(join(PUBLIC, 'badges/download-on-the-app-store.svg'), 'utf8');
    expect(svg).toMatch(/^<svg id="livetype" xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="119\.66407" height="40" viewBox="0 0 119\.66407 40">/);
    expect(svg).not.toMatch(/<script|on\w+=|<foreignObject|href="http/i);
    const png = readFileSync(join(PUBLIC, 'badges/get-it-on-google-play.png'));
    // The PNG header's own size: 646 x 250 (the badge and its transparent clear space).
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([646, 250]);
  });

  it('are served from this site, never hotlinked', () => {
    for (const badge of Object.values(STORE_BADGES)) expect(badge.src.startsWith('/badges/'), badge.src).toBe(true);
  });

  it('read the same height: Apple at its 40 px minimum, Google’s PNG drawn so the badge inside it is 40 px too', () => {
    expect(STORE_BADGES.ios.height).toBe(40);
    // 168 of the PNG's 250 px rows are the badge itself (41 px of clear space above and below).
    expect(Math.abs((STORE_BADGES.android.height * 168) / 250 - 40)).toBeLessThan(0.5);
    expect(Math.abs(STORE_BADGES.android.width / STORE_BADGES.android.height - 646 / 250)).toBeLessThan(0.01);
    // Apple's clear space is a quarter of the badge's height on every side; Google's is inside its file.
    expect(STORE_BADGES.ios.link).toBe('p-[10px]');
    expect(STORE_BADGES.android.link).toBe('');
  });

  it('each badge is one link, named by its alt text, with a target of 44 px or more and no animation', () => {
    render(<StoreBadges />);
    const apple = screen.getByRole('link', { name: 'Download on the App Store' });
    const google = screen.getByRole('link', { name: 'Get it on Google Play' });
    for (const link of [apple, google]) {
      expect(link.querySelectorAll('img')).toHaveLength(1);
      expect(link.className).toMatch(/\bmin-h-11\b/);
      expect(link.className).not.toMatch(/animate|transition|opacity|scale|rotate|grayscale|invert|hue/);
      expect(link.querySelector('img')!.getAttribute('style')).not.toMatch(/filter|transform|opacity/);
    }
    // [WEB-APPBAR · owner, live page] Never inline boxes on a text line: the line's baseline set the padded Apple
    // badge 3 px lower than Google's (measured on swiftgy.com at 375 px: 1172.4 vs 1169.2; with flex boxes 1169.4 vs
    // 1169.2). Each link is a flex box inside a flex item, centred in the row.
    for (const link of [apple, google]) {
      expect(link.className.split(' ')).toContain('flex');
      expect(link.className).not.toMatch(/\binline-flex\b|\binline-block\b/);
      expect(link.parentElement!.className.split(' ')).toContain('flex');
    }
    expect(apple.closest('ul')!.className).toMatch(/\bitems-center\b/);
    expect(apple.querySelector('img')!.getAttribute('style')).toMatch(/height: 40px/);
    expect(google.querySelector('img')!.getAttribute('style')).toMatch(/height: 60px/);
  });

  it('a single store shows only its own badge', () => {
    render(<StoreBadges stores={['android']} />);
    expect(screen.getAllByRole('link').map((link) => link.querySelector('img')?.getAttribute('alt'))).toEqual(['Get it on Google Play']);
  });

  it('the footer carries both trademark lines in its legal area, word for word, only while the badges can show', async () => {
    expect(APPLE_TRADEMARKS).toBe('Apple and the Apple logo are trademarks of Apple Inc., registered in the U.S. and other countries and regions. App Store is a service mark of Apple Inc.');
    expect(GOOGLE_TRADEMARKS).toBe('Google Play and the Google Play logo are trademarks of Google LLC.');
    for (const appStores of ['soon', 'live'] as const) {
      forgetLaunchAnswer();
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ webOrdering: 'live', appStores }))));
      const view = render(<SiteFooter />);
      await act(async () => { for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0)); });
      const lines = view.container.querySelector('[data-trademarks]');
      if (appStores === 'soon') {
        expect(lines).toBeNull();
        expect(view.container.textContent).not.toMatch(/trademark/);
      } else {
        expect([...lines!.querySelectorAll('p')].map((p) => p.textContent)).toEqual([APPLE_TRADEMARKS, GOOGLE_TRADEMARKS]);
      }
      view.unmount();
    }
  });
});
