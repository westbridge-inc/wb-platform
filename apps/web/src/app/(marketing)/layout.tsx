import { SiteFooter } from '@/components/site';
import { SiteNav } from '@/components/site-nav';
import { GetAppBarLater } from '@/components/get-the-app-later';

// Marketing chrome lives on the (marketing) group only — the vendor dashboard
// is an app, not a brochure.
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteNav />
      <main id="main" tabIndex={-1}>{children}</main>
      <SiteFooter />
      {/* [WEB-APPBAR] On a phone, after the visitor has engaged: a gentle offer of the app (company pages only). */}
      <GetAppBarLater />
    </>
  );
}
