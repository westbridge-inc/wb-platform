import { SiteFooter } from '@/components/site';
import { SiteNav } from '@/components/site-nav';
import { GetAppBarLater } from '@/components/get-the-app-later';

/**
 * [WEB-APPBAR · owner 7 Nov 2026] The frame of the front pages that show the store badges themselves: the welcome
 * page (`/`, its "Get the app" section), /welcome (its hero) and /launching-soon (its store area). The same header
 * and footer as every marketing page, with one difference: the footer leaves out its store badges, so the badges
 * appear once per page (owner, on the live page). Every other page keeps the footer's badges.
 */
export default function WelcomeLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteNav />
      <main id="main" tabIndex={-1}>{children}</main>
      <SiteFooter storeBadges={false} />
      <GetAppBarLater />
    </>
  );
}
