import { APP_STORE_URL, GOOGLE_PLAY_URL } from '@/lib/app-stores';
import { StoresLive } from './stores-live';

/**
 * [WEB-APPBAR · owner 7 Nov 2026] Every store link the site shows as a button is the stores' OFFICIAL badge:
 * Apple's black "Download on the App Store" (en-us SVG from Apple's marketing tools) and Google's "Get it on
 * Google Play" (en_badge_web_generic PNG from play.google.com/intl/en_us/badges). Both files are served from
 * this site unmodified (public/badges; a test pins their bytes), never redrawn, recoloured, cropped or animated.
 * Sizes follow both guidelines: the Apple badge at its 40 px minimum height with a quarter of its height (10 px)
 * of clear space around it, and Google's PNG (whose own transparent margin is its clear space) drawn 60 px tall,
 * so its visible badge is 40 px too: the two read the same height. Each badge is one link, 60 px tall.
 *
 * No client directive: a server page draws the badges into its HTML and ships no script for them; only the
 * small switch around them (StoresLive, components/app-store-links.tsx) runs in the browser. A client
 * component (the phone bar, the menus) may import them too.
 */
export type StoreKey = 'ios' | 'android';

export const STORE_BADGES = {
  ios: {
    href: APP_STORE_URL,
    alt: 'Download on the App Store',
    src: '/badges/download-on-the-app-store.svg',
    // The file is 119.66 x 40: drawn at its own size.
    width: 120,
    height: 40,
    link: 'p-[10px]',
  },
  android: {
    href: GOOGLE_PLAY_URL,
    alt: 'Get it on Google Play',
    src: '/badges/get-it-on-google-play.png',
    // The file is 646 x 250 with a 41 px transparent margin (its clear space): at 60 px tall the badge inside is 40 px.
    width: 155,
    height: 60,
    link: '',
  },
} as const;

const BOTH: readonly StoreKey[] = ['ios', 'android'];

/**
 * The badges as one row of links (wrapping only where the screen is too narrow, unless told not to). The row
 * hangs 10 px into the margin on each side (unless `bleed` is off), so the badges' clear space does not push
 * them off the text's edge.
 */
export function StoreBadges({
  stores = BOTH,
  className = '',
  wrap = true,
  bleed = true,
  onPick,
}: {
  stores?: readonly StoreKey[];
  className?: string;
  wrap?: boolean;
  /** Hang the row's outer clear space into the margin (off inside a card, which has its own padding). */
  bleed?: boolean;
  onPick?: () => void;
}) {
  return (
    <ul aria-label="Get the Swift app" className={`flex ${wrap ? 'flex-wrap' : 'flex-nowrap'} items-center${bleed ? ' -mx-[10px]' : ''} ${className}`}>
      {stores.map((key) => {
        const badge = STORE_BADGES[key];
        return (
          <li key={key} className="shrink-0">
            <a href={badge.href} onClick={onPick} className={`inline-flex min-h-11 items-center rounded-lg ${badge.link}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- the official badge file as published, with no client script */}
              <img src={badge.src} alt={badge.alt} width={badge.width} height={badge.height} style={{ height: badge.height, width: 'auto' }} decoding="async" />
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** The two badges, drawn by the server; nothing at all until the apps are live. */
export function StoreBadgesWhenLive({ className = '' }: { className?: string }) {
  return <StoresLive><StoreBadges className={className} /></StoresLive>;
}

/** A page's "Get the app" line: a heading and the two badges, only once the apps are live in both stores. */
export function GetTheAppSection({ className = '' }: { className?: string }) {
  return (
    <StoresLive>
      <section aria-label="Get the app" className={className}>
        <h2 className="sw-eyebrow">Get the app</h2>
        <StoreBadges className="mt-2" />
      </section>
    </StoresLive>
  );
}

/**
 * [WEBSITE 30 Oct · G11] The front door's store area. While the switch is off (and while its answer is on the way,
 * or if the question fails) it is one calm line saying where the app is coming: no dead badge, no disclaimer. Once
 * the switch says live (on the public site only), the line becomes the two official badges. The badges are one
 * 60 px row that never wraps (with their clear space hanging into the margin, the two fit a 320 px phone), and the
 * page reserves that row's height (min-h-[60px] around this), so turning the stores on moves nothing on the page.
 */
export function StoreButtons() {
  return (
    <StoresLive
      soon={(
        <p className="inline-flex items-center gap-2.5 rounded-full border border-[var(--swift-border)] bg-[var(--swift-card)] px-4 py-2.5 text-sm font-medium text-[var(--swift-ink)]">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--swift-red)]" />
          Coming to the App Store and Google Play
        </p>
      )}
    >
      <StoreBadges wrap={false} />
    </StoresLive>
  );
}
