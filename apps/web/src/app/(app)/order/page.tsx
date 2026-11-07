import type { Metadata } from 'next';
import { fetchGuestHome } from '@/lib/browse-server';
import { launch, SITE_ORIGIN } from '@/site.config';
import { HomeScreen } from '../home-screen';

/**
 * [Q7b] The customer app's Home, inside the app shell, the way the phone app opens.
 *
 * [WEB-APPBAR · owner 7 Nov 2026] It lives at /order: `/` is the site's welcome page, with four doors (Order,
 * Sell, Deliver, Drive), and a returning visitor (one who has opened ordering before, or an installed app's
 * launch) is sent from `/` straight here before the welcome page is painted (lib/welcome.ts).
 *
 * What this page owes the site:
 *   - SEO: canonical at its own address, listed in the sitemap after `/`. The heading, the services and their
 *     links are server-rendered, so a crawler reads a real page, not a spinner.
 *   - The legal duties: the site footer below the feed (privacy, terms, child safety, account deletion, the
 *     support inbox and the operating company's name), the same footer every marketing page carries.
 *   - Store links: the footer's, shown only while the web server's SWIFT_APP_STORES switch is live.
 */
const ORDER_TITLE = 'Order food, groceries and more';
// The installed app's own words (app/manifest.ts): what ordering on Swift is, with no price and no new claim.
const ORDER_DESCRIPTION = `Food, groceries and more from businesses in ${launch.markets[0]} — pay the business directly, cash or MMG.`;
export const metadata: Metadata = {
  title: ORDER_TITLE,
  description: ORDER_DESCRIPTION,
  alternates: { canonical: `${SITE_ORIGIN}/order` },
  // A page's Open Graph replaces the site's whole card, so the card is stated in full, at this page's own address.
  openGraph: { type: 'website', siteName: 'Swift', locale: 'en_GY', url: `${SITE_ORIGIN}/order`, title: `${ORDER_TITLE} — Swift`, description: ORDER_DESCRIPTION },
};

/**
 * [W2] The page arrives with the stores in it. The server reads the GUEST Home
 * feed (no cookie, no person — lib/browse-server.ts) and hands it to the page as
 * Home's first answer, so a phone on a slow line sees the stores before
 * any script has run; the browser re-reads it only once it is a minute old.
 * The page itself is rebuilt at most once a minute (ISR), never per visitor.
 */
export const revalidate = 60;

export default async function HomePage() {
  return <HomeScreen seed={await fetchGuestHome()} />;
}
