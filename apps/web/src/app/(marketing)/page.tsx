import Link from 'next/link';
import { ArrowRight, Bike, Car, ShoppingBag, Store } from 'lucide-react';
import { Section } from '@/components/site';
import { GetTheAppSection } from '@/components/store-badges';
import { launch, site } from '@/site.config';

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
 * Served as a static page (no data, no per-visitor work), under the marketing layout's header and footer. While
 * ordering is not open on the public site, middleware.ts answers `/` with the "Launching soon" page instead.
 */
const DOORS = [
  { href: '/order', title: 'Order with Swift', body: 'Browse every store, menu and price, then order food, groceries and more.', icon: ShoppingBag },
  { href: '/vendors', title: 'Sell on Swift', body: 'One flat weekly fee. You keep every dollar you sell.', icon: Store },
  { href: '/drivers', title: 'Deliver with Swift', body: 'Every delivery fee and every tip is yours.', icon: Bike },
  { href: '/drivers', title: 'Drive with Swift', body: 'Drive a taxi with Swift. Every fare and every tip is yours.', icon: Car },
] as const;

export default function WelcomeFrontPage() {
  return (
    <Section>
      <div className="max-w-3xl">
        <h1 className="text-4xl font-extrabold leading-[1.05] tracking-tight md:text-6xl">
          Food, groceries, shops, couriers and rides.
        </h1>
        <p className="mt-5 max-w-xl text-lg leading-relaxed text-[var(--swift-muted)]">
          One app for {launch.markets[0]}. The people doing the work keep 100% of what they earn.
        </p>
        <p className="mt-2 text-sm text-[var(--swift-muted)]">
          Made in Guyana by {site.legalEntityName}, {site.registeredCity}.
        </p>
      </div>

      <nav aria-label="Get started" className="mt-10">
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
    </Section>
  );
}
