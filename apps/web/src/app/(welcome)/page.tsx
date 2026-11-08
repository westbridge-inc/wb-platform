import Link from 'next/link';
import { ArrowRight, Bike, Car, ShoppingBag, Store } from 'lucide-react';
import { GetTheAppSection } from '@/components/store-badges';
import { launch, site } from '@/site.config';
import { PARTNER_SHOT, PhoneHero, Screen, TAXI_SHOT, TRACKING_SHOT } from './app-screens';

/**
 * [WEB-APPBAR · owner 7 Nov 2026] swiftgy.com's front page: the website first.
 *
 * A NEW visitor lands here: what Swift is, in the site's existing words (the About page's "food, groceries,
 * shops, couriers, rides", the front door's "keep 100% of what they earn", the company line every footer
 * carries), then four doors as big tap targets, and the store badges once the apps are live. No price and no
 * new claim. A RETURNING visitor never sees it flash: they go straight to ordering
 * (lib/welcome.ts: a check in the page's <head>, before anything is painted), and the app's menus link back here
 * (`/?welcome`).
 *
 * The doors go to pages that already exist: ordering Home (/order), the business page (/vendors), and the riders
 * and drivers page (/drivers), which serves both delivery riders and taxi drivers on one page (it has no
 * separate rider and driver sections to point at; its sign-up buttons open each one's own sign-up).
 *
 * [WEB-PHONES · owner 8 Nov 2026] "The phone screen" is back: the app's real Home screen in its phone frame beside
 * the headline and the doors (under them on a phone), and a "See it in action" row with the tracking, taxi and
 * rider screens. The same sanitized screens and frames as the "Launching soon" page (app-screens.tsx: no price,
 * rating, review, earning or name), and each caption is that page's own words. Plain sized images: no client
 * script, and the page never jumps.
 *
 * Served as a static page (no data, no per-visitor work), under the marketing layout's header and footer. While
 * ordering is not open on the public site, middleware.ts answers `/` with the "Launching soon" page instead.
 */
const DOORS = [
  { href: '/order', title: 'Order with Swift', body: 'Browse every store, menu and price, then order food, groceries and more.', icon: ShoppingBag },
  { href: '/vendors', title: 'Sell on Swift', body: 'One flat weekly fee. You keep every dollar you sell.', icon: Store },
  { href: '/drivers', title: 'Deliver with Swift', body: 'Every delivery fee and every tip is yours.', icon: Bike },
  { href: '/drivers', title: 'Drive with Swift', body: 'Drive a taxi with Swift. Every fare and every tip is yours.', icon: Car },
] as const;

/** The "See it in action" row: each screen with a one-line caption in the "Launching soon" page's words. */
const IN_ACTION = [
  { shot: TRACKING_SHOT, title: 'Order', caption: 'Follow every order live on the map.' },
  { shot: TAXI_SHOT, title: 'Ride', caption: 'A PIN check before every ride, and the trip live on the map.' },
  { shot: PARTNER_SHOT, title: 'Earn', caption: 'Sell, deliver, drive or offer a service.' },
] as const;

export default function WelcomeFrontPage() {
  return (
    <>
      {/* The headline, the four doors and the app's Home screen. The phone rises from the bottom edge of the band, as
          on the "Launching soon" page; on a phone it stands under the doors. */}
      <section className="overflow-hidden border-b border-[var(--swift-border)]">
        <div className="mx-auto grid max-w-6xl items-end gap-12 px-5 pt-16 md:pt-20 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-14">
          <div data-welcome-intro className="self-center lg:pb-20">
            <h1 className="text-4xl font-extrabold leading-[1.05] tracking-tight md:text-6xl">
              Food, groceries, shops, couriers and rides.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-[var(--swift-muted)]">
              One app for {launch.markets[0]}. The people doing the work keep 100% of what they earn.
            </p>
            <p className="mt-2 text-sm text-[var(--swift-muted)]">
              Made in Guyana by {site.legalEntityName}, {site.registeredCity}.
            </p>

            <nav aria-label="Get started" className="mt-10">
              <ul className="grid gap-4 sm:grid-cols-2">
                {DOORS.map(({ href, title, body, icon: Icon }) => (
                  <li key={title} className="flex">
                    <Link
                      href={href}
                      className="group flex min-h-32 w-full flex-col gap-3 rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] p-5 text-[var(--swift-ink)] shadow-[var(--swift-elevation-card)] transition-colors hover:border-[var(--swift-border-strong)] hover:bg-[var(--swift-subtle)]"
                    >
                      <Icon aria-hidden="true" className="h-7 w-7 text-[var(--swift-red)]" strokeWidth={1.75} />
                      <span className="flex items-center justify-between gap-2 text-lg font-bold leading-6">
                        {title}
                        <ArrowRight aria-hidden="true" className="h-5 w-5 shrink-0 text-[var(--swift-muted)] transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
                      </span>
                      <span className="text-sm leading-relaxed text-[var(--swift-muted)]">{body}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>

            {/* The store badges, only once the apps are live in both stores (SWIFT_APP_STORES). */}
            <GetTheAppSection className="mt-10" />
          </div>
          {/* Drawn 318 px wide beside the doors (a 340 px column less the frame), 298 px under them. */}
          <PhoneHero sizes="(min-width: 1024px) 318px, 298px" className="relative mx-auto w-full max-w-[320px] lg:max-w-none" />
        </div>
      </section>

      {/* See it in action: a swipe row on a phone (focusable, so a keyboard can scroll it), three columns on a wide
          screen. The screens are below the fold and load lazily. */}
      <section aria-labelledby="in-action-heading" className="bg-[var(--swift-sunken)]">
        <div className="mx-auto max-w-6xl py-16 md:px-5 md:py-20">
          <h2 id="in-action-heading" className="px-5 text-3xl font-bold tracking-tight md:px-0 md:text-4xl">
            See it in action
          </h2>
          <ul
            data-swipe-row
            tabIndex={0}
            aria-labelledby="in-action-heading"
            className="mt-8 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 [scrollbar-width:none] md:grid md:grid-cols-3 md:gap-5 md:overflow-visible md:px-0"
          >
            {IN_ACTION.map(({ shot, title, caption }) => (
              <li key={title} className="flex w-[82%] shrink-0 snap-center sm:w-[60%] md:w-auto">
                <figure className="flex w-full flex-col rounded-3xl bg-[var(--swift-card)] p-4 shadow-[var(--swift-elevation-card)]">
                  <Screen shot={shot} tone="paper" />
                  <figcaption className="px-3 pb-3 pt-6">
                    <h3 className="text-2xl font-bold tracking-tight">{title}</h3>
                    <p className="mt-2 text-[17px] leading-relaxed text-[var(--swift-muted)]">{caption}</p>
                  </figcaption>
                </figure>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
