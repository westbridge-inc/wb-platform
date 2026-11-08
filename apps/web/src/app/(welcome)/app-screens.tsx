import type { StaticImageData } from 'next/image';
// Real screens of the Swift phone app, cut so that no shop price, rating, review, earning or person's name shows:
//  - Home (the App Store screenshot), cut above the sample "Popular" row; the greeting shows no name and the
//    monogram is the app's own no-name "S" (HomeScreen.tsx greetingLine + monogram), as for an account with no
//    first name;
//  - live order tracking, cut above the timeline's store name;
//  - the taxi booking screen: the destination on the map, and the pickup and destination, cut above the ride choices so no
//    fare shows (owner 30 Oct: "dont show prices");
//  - the rider's home, offline, cut above the earnings card.
import appHome600 from './launching-soon/app-home-600.webp';
import appHome880 from './launching-soon/app-home-880.webp';
import appTracking from './launching-soon/app-tracking.webp';
import appTaxi from './launching-soon/app-taxi.webp';
import appPartner from './launching-soon/app-partner.webp';
import appTracking1206 from './launching-soon/app-tracking-1206.webp';
import appTaxi1206 from './launching-soon/app-taxi-1206.webp';
import appPartner1206 from './launching-soon/app-partner-1206.webp';

/**
 * [WEB-PHONES · owner 8 Nov 2026] The real app screens, in their phone frames, shared by the two front pages that
 * show them: the "Launching soon" front door (its hero and its Order / Ride / Earn cards, drawn exactly as before)
 * and the welcome page at `/` (the Home screen beside the headline and the four doors, and a "See it in action" row).
 *
 * [WEBSITE 30 Oct · perf] A still picture needs no client script: next/image's component (and getImageProps,
 * which brings the same module) added about 5 kB of script to the page. The screens ship as sized WebP files,
 * content-hashed by the build so they cache for good, offered at several widths (srcset) with the drawn width
 * stated (sizes). Width and height are set so the page never jumps; only the hero loads eagerly (and first), the
 * screens below the fold load lazily. This is a server module: it renders on the server only.
 */
export const fileUrl = (image: StaticImageData | string) => (typeof image === 'string' ? image : image.src);

export const HOME_SHOT = {
  src: fileUrl(appHome880),
  srcSet: `${fileUrl(appHome600)} 600w, ${fileUrl(appHome880)} 880w`,
  width: 880,
  height: 887,
  alt: 'The Swift app’s Home screen: a Good afternoon greeting, search, and tiles for Food, Groceries, Taxi, Send, Services, Orders, Favourites and Scan.',
};

/** The Home screen in the phone's frame, rising from the bottom edge of its band as on the app's own store page.
 *  `sizes` is the frame's drawn screen width on the page that shows it; this is the one image that loads first. */
export function PhoneHero({ sizes, className }: { sizes: string; className: string }) {
  return (
    <div className={className}>
      <div aria-hidden="true" className="absolute -inset-x-10 top-10 bottom-0 rounded-t-full bg-[var(--swift-red-50)]" />
      <div className="relative rounded-t-[52px] border-[11px] border-b-0 border-[var(--swift-ink)] bg-[var(--swift-ink)] shadow-[0_30px_80px_-20px_rgba(33,26,26,0.35)]">
        {/* eslint-disable-next-line @next/next/no-img-element -- two sized files and srcset; no client script */}
        <img src={HOME_SHOT.src} srcSet={HOME_SHOT.srcSet} sizes={sizes} width={HOME_SHOT.width} height={HOME_SHOT.height} alt={HOME_SHOT.alt} fetchPriority="high" decoding="async" className="block h-auto w-full rounded-t-[41px]" />
      </div>
    </div>
  );
}

/** Each card screen ships at 640 px and at the phone's full 1206 px, so Retina screens and zoom stay sharp; the
 *  browser picks by the card's drawn width (about 400 px on desktop, 82% of the phone's width below 768 px). */
export type Shot = { image: StaticImageData | string; large: StaticImageData | string; alt: string };
const SCREEN = { width: 640, height: 764, sizes: '(min-width: 768px) 400px, 75vw' };

export const TRACKING_SHOT: Shot = { image: appTracking, large: appTracking1206, alt: 'Live order tracking in the Swift app: the rider on the map and where the order stands.' };
export const TAXI_SHOT: Shot = { image: appTaxi, large: appTaxi1206, alt: 'Booking a taxi in the Swift app: the destination pinned on the map, and the pickup and destination fields.' };
export const PARTNER_SHOT: Shot = { image: appPartner, large: appPartner1206, alt: 'The rider’s side of the Swift app: a map of Georgetown and the button to go online for jobs.' };

/** A real app screen inside a card: the top of a phone's glass, with a hairline, sized and lazy. */
export function Screen({ shot, tone }: { shot: Shot; tone: 'paper' | 'brand' }) {
  const ground = tone === 'brand' ? 'bg-[rgba(255,255,255,0.12)]' : 'bg-[var(--swift-sunken)]';
  return (
    <div className={`overflow-hidden rounded-2xl px-5 pt-5 ${ground}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a sized file and no client script */}
      <img
        src={fileUrl(shot.image)}
        srcSet={`${fileUrl(shot.image)} 640w, ${fileUrl(shot.large)} 1206w`}
        sizes={SCREEN.sizes}
        alt={shot.alt}
        width={SCREEN.width}
        height={SCREEN.height}
        loading="lazy"
        decoding="async"
        className="block h-auto w-full rounded-t-[22px] shadow-[0_0_0_1px_rgba(33,26,26,0.08)]"
      />
    </div>
  );
}
