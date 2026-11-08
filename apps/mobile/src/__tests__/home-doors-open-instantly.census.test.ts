import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [APP-SPEED D · owner 7 Nov: "customer side, everything — you tap the
// Services tab or Taxi or Groceries — it LOADS, then goes to it"]
//
// THE LAW for every door the customer Home opens (its tiles, chips, "See all"
// links, its header's bell and place pill, and the Market tab): the first
// frame is the content or its shape (kit/skeletons), never a full-screen
// spinner. Read as source: a new `<LoadingBlock` in one of these screens, or a
// Home tile that stops reading its door ahead, fails here.
//
// The behaviour itself (first frame read ahead = content; cold = shape; failed
// = the failure, never empty) is rendered in
// modules/shop/screens/HomeDoors.firstFrame.navigation.test.ts and
// hooks/homeDoors.navigation.test.ts.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel: string) => strip(readFileSync(join(SRC, rel), 'utf8'));

const DOORS = [
  'modules/shop/screens/SearchScreen.tsx', // Food, Groceries, the search field, "Find by category", "See all"
  'modules/services/screens/ServicesScreen.tsx', // Services
  'modules/orders/screens/OrdersHistoryScreen.tsx', // Orders, "Order again · See all"
  'modules/shop/screens/FavoritesScreen.tsx', // Favourites
  'modules/shop/screens/CategoryFeedScreen.tsx', // a category rail chip
  'modules/shop/screens/CategoryGridScreen.tsx', // the rail's "See all"
  'modules/shop/screens/RecommendedScreen.tsx', // "Recommended · See all"
  'modules/shop/screens/NearbyScreen.tsx', // "Nearby · See all"
  'modules/shop/screens/MarketScreen.tsx', // the Market tab
  'modules/profile/screens/NotificationsScreen.tsx', // the bell
  'modules/profile/screens/AddressesScreen.tsx', // the place pill
];

describe('[APP-SPEED D] every door from Home opens on its content or its shape', () => {
  it('no door draws a full-screen spinner', () => {
    const offenders = DOORS.filter((rel) => /<LoadingBlock\b/.test(read(rel)));
    expect(offenders).toEqual([]);
  });

  it('every door draws a skeleton while its first read is on its way (the census is not vacuous)', () => {
    const without = DOORS.filter((rel) => !/<(ListSkeleton|GridSkeleton|ChipsSkeleton)\b/.test(read(rel)));
    expect(without).toEqual([]);
  });

  it('Taxi and Send draw the map only once the screen has slid in', () => {
    for (const rel of ['modules/movement/screens/TaxiScreen.tsx', 'modules/movement/screens/CourierScreen.tsx']) {
      const src = read(rel);
      expect(src, rel).toMatch(/const opened = useScreenOpened\(navigation\);/);
      expect(src, rel).toMatch(/\{opened \? \(\s*<MapView\b/);
    }
  });
});

describe('[APP-SPEED D] Home reads its doors ahead', () => {
  const HOME = read('modules/shop/screens/HomeScreen.tsx');

  it('each tile that opens on a read names its door; Send and Scan (a form, the camera) have none', () => {
    for (const [key, door] of [['food', "'food'"], ['groceries', "'groceries'"], ['taxi', "'taxi'"], ['services', "'services'"], ['orders', "'orders'"], ['favourites', "'favourites'"], ['send', 'null'], ['scan', 'null']]) {
      expect(HOME, key).toMatch(new RegExp(`\\{ key: '${key}', label: '[^']+', door: ${door},`));
    }
  });

  it('the tile spreads its door’s press-in read, and Home asks the doors only while it is in front with a fresh feed', () => {
    expect(HOME).toMatch(/<PressableScale\s+strong\s+\{\.\.\.press\}/);
    expect(HOME).toMatch(/press=\{doorPress\(s\.door\)\}/);
    expect(HOME).toMatch(/useHomeDoorReads\(live && feedState === 'content' && !home\.isPlaceholderData, home\.dataUpdatedAt, doorContext\)/);
  });
});
