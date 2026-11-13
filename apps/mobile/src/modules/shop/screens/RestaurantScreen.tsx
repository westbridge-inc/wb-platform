/** @jsxImportSource react */
import React, { useCallback, useMemo, useState } from 'react';
import { Dimensions, FlatList, Linking, Pressable, ScrollView, Share, TextInput, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, font, fontSize, radius, space, withAlpha } from '@swift/ui';
import { useCart, useReportContent, useToggleFavorite, useVendor } from '../../../hooks/customer';
import { useCartStepperQty, useCartSteppers } from '../../../hooks/useCartSteppers';
import { isBooking } from '../../../lib/cartSteppers';
import { ActionSheet } from '../../../kit/action-sheet';
import { useAuthStore } from '../../../stores/authStore';
import { requestAuthContinuation } from '../../../navigation/authContinuation';
import { distanceLabel } from '../../../lib/geo';
import { STORE_REPORT_REASONS } from '../../../lib/reportReasons';
import { forgivingFilter } from '../../../lib/forgivingSearch';
import { HERO_PHOTO_WIDTH, itemPhoto, vendorPhoto } from '../../../lib/images';
import { money } from '../../../lib/money';
import { itemVatNote, storefrontVat, storefrontVatLine, type StorefrontVat } from '../../../lib/storeVat';
import { formatPhoneForDisplay } from '../../../lib/phoneDisplay';
import { readStorePreview, type StorePreview } from '../../../lib/doorPreview';
import { storeKindWords } from '../../../lib/storeKindWords';
import { SellerInfo } from '../../../components/SellerInfo';
import { SectionPhotoHeader } from '../../../components/SectionPhotoHeader';
import { toast } from '../../../kit/toast';
import { Scrim } from '../../../kit/scrim';
import { STORE_PICKS_TITLE } from '../../../lib/storePick';
import { useLocationStore } from '../../../stores/locationStore';
import { afterDismiss } from '../../../kit/after-dismiss';
import { grantedLocationFix } from '../../../lib/deviceLocation';
import { branchAddress, branchFactsLine, currentBranchLabel, showsBranchSwitcher, type BrandBranch } from '../../../lib/brandCard';
import { hasSizes } from '../../../lib/menuSheet';
import { firstLineByItem, storeMenuRows, type StoreMenuRow } from '../storeMenuRows';
import {
  AddMorph,
  CartBar,
  useCartBarClearance,
  Chip,
  CircleChip,
  ErrorState,
  FoodCard,
  Header,
  HeartBadge,
  IconChip,
  LoadingBlock,
  MenuRow,
  Money,
  Photo,
  PillButton,
  PopupCard,
  PopupTitle,
  SectionHeader,
  T,
  TonePill,
} from '../../../kit';

const SCREEN_W = Dimensions.get('window').width;
const GUTTER = space['2xl'];
const RAIL_W = 200;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function hoursLabel(hours: any[] | undefined): string | null {
  if (!hours?.length) return null;
  const today = hours.find((h) => h.dayOfWeek === new Date().getDay());
  if (!today || today.isClosed) return 'Closed today';
  return `${today.openTime}–${today.closeTime}`;
}

/** Info-strip column: icon + value on top, muted caption beneath (kit 14). */
function StatCol({
  icon,
  value,
  caption,
  onPress,
  last = false,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  value: string;
  caption: string;
  onPress?: () => void;
  last?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      // One spoken name from the visible words. Without it a screen reader
      // reads the icon-font glyph too ("\uf1e5, New, See reviews").
      accessible
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={`${value}, ${caption}`}
      style={{
        flex: 1,
        borderRightWidth: last ? 0 : 1,
        borderRightColor: color.border.subtle,
        paddingHorizontal: space.sm,
        gap: 4,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <Feather name={icon} size={14} color={icon === 'star' ? color.star : color.brand[500]} />
        <T variant="label" weight="semibold" numberOfLines={1}>
          {value}
        </T>
      </View>
      <T variant="caption" tone={onPress ? 'brand' : 'muted'} numberOfLines={1}>
        {caption}
      </T>
    </Pressable>
  );
}

const TILE_W = (SCREEN_W - GUTTER * 2 - space.md * 2) / 3;

/** Mart product tile (Grab-Mart density): square photo, tight name, price +
 *  on-card add. In-cart shows a mini stepper — shopping without detail hops. */
function ProductTile({
  item,
  qty,
  onAdd,
  onSetQty,
  onOpen,
  busy,
  vat = null,
}: {
  item: any;
  /** [TAP-AUDIT] What the customer has tapped to (hooks/useCartSteppers), else the cart's quantity. */
  qty: number;
  onAdd: () => void;
  onSetQty: (qty: number) => void;
  onOpen: () => void;
  busy: boolean;
  /** [STORE-VAT] The store's VAT (null for every store but a person-approved VAT store). */
  vat?: StorefrontVat | null;
}) {
  // [BOOK-POLISH · #2205] A booking is one appointment: its + opens the booking screen (pick a time), never a quantity.
  const opensItem = (item.optionGroups?.length ?? 0) > 0 || isBooking(item);
  const out = item.stockQuantity === 0;
  return (
    <View style={{ width: TILE_W }}>
      <Pressable onPress={onOpen}>
        <Photo
          uri={itemPhoto(item)}
          label={item.name}
          transition={150}
          style={{ width: TILE_W, height: TILE_W, borderRadius: radius.md, backgroundColor: color.surface.base, opacity: out ? 0.5 : 1 }}
          contentFit="cover"
        />
      </Pressable>
      <T variant="caption" weight="medium" numberOfLines={2} style={{ marginTop: 6, minHeight: 32 }}>
        {item.name}
      </T>
      {item.unit ? (
        <T variant="caption" tone="faint" numberOfLines={1}>
          {item.unit}
        </T>
      ) : null}
      <View style={{ marginTop: 2, gap: 4 }}>
        {/* [MENU-OPTIONS] A sized item's listed price is its smallest size: "From". */}
        {hasSizes(item) ? <T variant="micro" tone="faint">From</T> : null}
        <Money amount={item.customerPrice ?? item.basePrice} tone={out ? 'muted' : 'brand'} numberOfLines={1} />
        {itemVatNote(vat, item) ? <T variant="micro" tone="faint">{itemVatNote(vat, item)}</T> : null}
        {out ? (
          <T variant="micro" tone="warning">
            Sold out
          </T>
        ) : (
          <View style={{ alignSelf: 'flex-end' }}>
            <AddMorph
              size="sm"
              qty={opensItem ? 0 : qty}
              busy={busy}
              onAdd={opensItem ? onOpen : onAdd}
              onInc={() => onSetQty(qty + 1)}
              onDec={() => onSetQty(qty - 1)}
            />
          </View>
        )}
      </View>
    </View>
  );
}

/** Service listing row: what it costs, how long it takes, where it happens —
 *  tapping opens the booking screen (slots), never a qty flow. */
function ServiceRow({ item, onOpen, vat = null }: { item: any; onOpen: () => void; vat?: StorefrontVat | null }) {
  const cfg = (item.bookingConfig ?? {}) as { durationMinutes?: number; serviceMode?: string };
  const modeLabel =
    cfg.serviceMode === 'MOBILE' ? 'Comes to you' : cfg.serviceMode === 'BOTH' ? 'Your choice' : 'At their place';
  return (
    <Pressable onPress={onOpen}>
      {({ pressed }) => (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            borderRadius: radius.lg,
            backgroundColor: pressed ? color.surface.subtle : color.surface.base,
            padding: space.md,
          }}
        >
          {/* [UI-SWEEP U-P3] No photo: the icon alone. The name is printed
              beside the tile; squeezed into 64pt it broke across lines. */}
          <Photo
            uri={itemPhoto(item)}
            label={item.name}
            showLabel={false}
            style={{ width: 64, height: 64, borderRadius: radius.md }}
            contentFit="cover"
          />
          <View style={{ flex: 1 }}>
            <T variant="body" weight="semibold" numberOfLines={1}>
              {item.name}
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 4 }}>
              {cfg.durationMinutes ? <TonePill label={`${cfg.durationMinutes} min`} tone="neutral" /> : null}
              <TonePill label={modeLabel} tone="brand" />
            </View>
            <View style={{ marginTop: 6, alignSelf: 'flex-start' }}>
              {/* [law 3] Money is ink — maroon stays on the acts. */}
              <Money amount={item.customerPrice ?? item.basePrice} />
              {itemVatNote(vat, item) ? <T variant="micro" tone="faint">{itemVatNote(vat, item)}</T> : null}
            </View>
          </View>
          <View style={{ alignItems: 'center', gap: 2 }}>
            <Feather name="calendar" size={18} color={color.brand[500]} />
            <T variant="caption" tone="brand" weight="semibold">
              Book
            </T>
          </View>
        </View>
      )}
    </Pressable>
  );
}

/** [APP-SPEED C] A tap on a row's stepper: the item, its cart line (if any) and the number tapped to. */
type StepperTap = (item: any, line: any, next: number) => void;

/** [APP-SPEED C] One menu row with its own number (hooks/useCartSteppers): a + redraws this row only, never the page. */
const MenuItemRow = React.memo(function MenuItemRow({
  item,
  line,
  vat,
  last,
  onOpenItem,
  onTap,
}: {
  item: any;
  line: any;
  vat: StorefrontVat | null;
  last: boolean;
  onOpenItem: (item: any) => void;
  onTap: StepperTap;
}) {
  // [BOOK-POLISH · #2205] An item with choices, or a booking (one appointment, its time picked on
  // the item screen), opens the item: no quantity on the row.
  const opensItem = (item.optionGroups?.length ?? 0) > 0 || isBooking(item);
  const qty = useCartStepperQty(item.id, line);
  const shown = opensItem ? 0 : qty;
  return (
    <MenuRow
      name={item.name}
      description={item.description}
      price={item.customerPrice ?? item.basePrice}
      fromPrice={hasSizes(item)}
      priceNote={itemVatNote(vat, item)}
      image={itemPhoto(item)}
      soldOut={item.stockQuantity === 0}
      qty={shown}
      busy={false}
      last={last}
      onOpen={() => onOpenItem(item)}
      onAdd={() => (opensItem ? onOpenItem(item) : onTap(item, line, shown + 1))}
      onInc={() => onTap(item, line, shown + 1)}
      onDec={() => onTap(item, line, shown - 1)}
    />
  );
});

/** [APP-SPEED C] A shelf tile with its own number: a + redraws this tile only. */
const MartTile = React.memo(function MartTile({
  item,
  line,
  vat,
  onOpenItem,
  onTap,
}: {
  item: any;
  line: any;
  vat: StorefrontVat | null;
  onOpenItem: (item: any) => void;
  onTap: StepperTap;
}) {
  const qty = useCartStepperQty(item.id, line);
  return (
    <ProductTile
      item={item}
      vat={vat}
      qty={qty}
      busy={false}
      onOpen={() => onOpenItem(item)}
      onAdd={() => onTap(item, line, qty + 1)}
      onSetQty={(next) => onTap(item, line, next)}
    />
  );
});

/** [APP-SPEED A] A store opening from its card: the card's photo and name in the hero's place, a
 *  visible Back, and the menu loading below. Drawn only from what the server sent the card. */
function StoreOpening({ preview, top, onBack }: { preview: StorePreview; top: number; onBack: () => void }) {
  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }} accessibilityLabel={`${preview.name}. ${preview.vendorType === 'RESTAURANT' ? 'Loading the menu' : 'Loading the store'}`}>
      <View>
        <Photo
          uri={vendorPhoto(preview, HERO_PHOTO_WIDTH)}
          label={preview.name}
          showLabel={false}
          glyph="shops"
          transition={200}
          style={{ width: SCREEN_W, height: 300 }}
          contentFit="cover"
        />
        <Scrim anchor="top" height={top + 76} to={withAlpha(color.text.primary, 0.45)} />
        <Scrim height={170} />
        <View style={{ position: 'absolute', left: GUTTER, right: GUTTER, bottom: radius.xl + space.lg }}>
          <T variant="title" tone="onBrand" numberOfLines={2}>
            {preview.name}
          </T>
        </View>
        <View style={{ position: 'absolute', top: top + space.sm, left: GUTTER }}>
          <CircleChip icon="chevron-left" label="Back" onPress={onBack} />
        </View>
      </View>
      <View
        style={{
          flex: 1,
          marginTop: -radius.xl,
          borderTopLeftRadius: radius.xl,
          borderTopRightRadius: radius.xl,
          backgroundColor: color.surface.subtle,
          paddingTop: space['2xl'],
        }}
      >
        <LoadingBlock />
      </View>
    </View>
  );
}

// Kit 14–20: cover hero + floating chips, white sheet w/ name + info strip,
// promos row, Recommended/Best-seller rails, then the full menu by category.
export function RestaurantScreen() {
  const route = useRoute<any>();
  // [UI-SWEEP U10 S3-1] A store link or QR goes back to a store page already
  // in the stack (navigate + pop) and hands the SAME mounted page the new
  // store. The aisle, menu section, search and open sheets below belong to
  // ONE store: a new store id is a new page, so store A's menu section can
  // never empty store B's menu and A's report sheet can never file against B.
  return <RestaurantStore key={route.params?.vendorId ?? ''} />;
}

function RestaurantStore() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const vendorId: string = route.params?.vendorId;
  const { isAuthenticated, wantsAuth, promptLogin } = useAuthStore();

  // [CHAINS PR3] With the customer's place, the branch switcher can say which branch delivers to them.
  const { latitude: hereLat, longitude: hereLng, status: hereStatus } = useLocationStore();
  const here = grantedLocationFix(hereLat, hereLng, hereStatus);
  const vendor = useVendor<any>(vendorId, here ? { lat: here.latitude, lng: here.longitude } : null);
  const [showBranches, setShowBranches] = useState(false);
  const toggleFav = useToggleFavorite();
  const [showHours, setShowHours] = useState(false);
  const [showPromos, setShowPromos] = useState(false);
  // [B15/STORE-001] Store reporting — the moderation queue's storefront door.
  const [reportOpen, setReportOpen] = useState(false);
  const reportContent = useReportContent();
  // Mart mode: aisle filter + in-store search + on-card add (Grab Mart, not a menu)
  const [aisleId, setAisleId] = useState<string | null>(null);
  const [menuCatId, setMenuCatId] = useState<string | null>(null);
  const [storeQuery, setStoreQuery] = useState('');
  // D6-MOB-01: a supermarket/store can carry hundreds of SKUs. [APP-SPEED C] The menu is one FlashList
  // (storeMenuRows): only the rows near the screen are drawn, so no item window is needed any more.
  const cart = useCart<any>();
  // [E09] While this store's cart bar floats over the menu, the last row must scroll clear of it.
  const cartClearance = useCartBarClearance({ vendorId });
  // [TAP-AUDIT] + and − answer at the tap and add up; only that item has a request out (hooks/useCartSteppers).
  // [APP-SPEED C] 'settled': the page no longer redraws on every tap; each row reads its own number.
  const steppers = useCartSteppers(cart, 'settled');

  const v = vendor.data;
  // [STORE-VAT · owner O-5] Only a store whose VAT a person approved sends `vat`; every other store (and an older server) shows none.
  // [APP-SPEED C] Kept by value, so the memoised menu rows are not redrawn by a new object on every page draw.
  const storeVat = useMemo(() => storefrontVat(v?.vat), [v?.vat]);
  const categories: any[] = useMemo(() => v?.categories ?? [], [v?.categories]);
  const allItems = useMemo(() => categories.flatMap((c: any) => c.items ?? []), [categories]);
  const recommended = useMemo(() => allItems.filter((i: any) => i.isPopular).slice(0, 8), [allItems]);
  const bestSellers = useMemo(
    () => [...allItems].sort((a: any, b: any) => (b.totalOrdered ?? 0) - (a.totalOrdered ?? 0)).slice(0, 8),
    [allItems],
  );
  const closed = v && !v.isCurrentlyOpen;
  // The one store-distance formatter (lib/geo) — the same words Home and Search use.
  const distance = distanceLabel(v?.distanceKm);
  const promos: any[] = v?.activePromos ?? [];
  const isMart = v?.vendorType === 'SUPERMARKET' || v?.vendorType === 'STORE';
  const isServiceStore = v?.vendorType === 'SERVICE';
  // Hero identity pill: the store's own words first (cuisineTypes is a String[]
  // on the vendor), falling back to its type. Never invented.
  const kindLabel: string | null = (() => {
    const cuisines: unknown = v?.cuisineTypes;
    const first = Array.isArray(cuisines) ? cuisines.find((c) => typeof c === 'string' && c.trim()) : null;
    const raw = (first as string | undefined) ?? v?.vendorType;
    return raw ? String(raw).replaceAll('_', ' ').toLowerCase() : null;
  })();
  const martItems = useMemo(() => {
    const base = aisleId ? (categories.find((c: any) => c.id === aisleId)?.items ?? []) : allItems;
    // Owner, 13 Oct: the in-store search forgives like the Search tab — any
    // word order, a typed plural, one slip — exact matches first (lib/forgivingSearch).
    return forgivingFilter(base, storeQuery, (i: any) => ({ name: i?.name, description: i?.description }));
  }, [aisleId, storeQuery, categories, allItems]);

  // [APP-SPEED C] The menu as one list's rows; each row finds its cart line here (the first line of its item).
  const menuRows = useMemo(
    () => storeMenuRows({ mode: isMart ? 'mart' : isServiceStore ? 'services' : 'menu', categories, menuCatId, martItems, allItems }),
    [isMart, isServiceStore, categories, menuCatId, martItems, allItems],
  );
  const lineByItem = useMemo(() => firstLineByItem<any>(cart.data?.items), [cart.data?.items]);
  // Stable for the memoised rows: they keep their callbacks while the page redraws.
  const openItem = useCallback(
    (item: any) => navigation.navigate('MenuItem', { vendorId, itemId: item.id }),
    [navigation, vendorId],
  );
  const setStepper = steppers.set;
  const onTap = useCallback<StepperTap>((item, line, next) => {
    const tap = () => setStepper(item.id, line, next, { vendorId, itemId: item.id });
    if (isAuthenticated) return tap();
    requestAuthContinuation({ screen: 'Restaurant', vendorId }, promptLogin);
    // A scan can open the public menu over an already active sign-in flow.
    // In that case its root gate is mounted already, so return to it directly.
    if (wantsAuth) navigation.getParent()?.navigate('Auth');
  }, [isAuthenticated, wantsAuth, promptLogin, navigation, vendorId, setStepper]);
  const rowsDrawnWith = useMemo(() => ({ lineByItem, storeVat, openItem, onTap }), [lineByItem, storeVat, openItem, onTap]);

  if (vendor.isLoading) {
    // [APP-SPEED A] The tapped card handed over the store's name and photo: draw them at once, the
    // menu's place loading below. Nothing here can be pressed but Back — no Add, no stepper, no
    // heart — until the store's own answer replaces it.
    const preview = readStorePreview(route.params?.preview);
    if (preview) return <StoreOpening preview={preview} top={insets.top} onBack={() => navigation.goBack()} />;
    return (
      <View style={{ flex: 1, backgroundColor: color.surface.subtle, paddingTop: insets.top }}>
        {/* [UI-SWEEP U32] A visible way back while this loads or fails, not swipe only. */}
        <Header />
        <LoadingBlock />
      </View>
    );
  }
  if (vendor.isError || !v) {
    return (
      <View style={{ flex: 1, backgroundColor: color.surface.subtle, paddingTop: insets.top }}>
        {/* [UI-SWEEP U32] A visible way back while this loads or fails, not swipe only. */}
        <Header />
        <ErrorState onRetry={() => vendor.refetch()} />
      </View>
    );
  }

  const itemCard = (item: any, width: number) => (
    <FoodCard
      key={item.id}
      width={width}
      image={itemPhoto(item)}
      name={item.name}
      priceLabel={`${hasSizes(item) ? 'From ' : ''}${money(item.customerPrice ?? item.basePrice)}`}
      priceNote={itemVatNote(storeVat, item)}
      onPress={() => openItem(item)}
    />
  );

  // [APP-SPEED C] One row of the menu list (storeMenuRows). A category's card is drawn by its rows: the first closes
  // it above, the last below, the others carry its sides.
  const renderMenuRow = (row: StoreMenuRow) => {
    if (row.kind === 'section') {
      const cat = row.cat;
      return <SectionPhotoHeader title={cat.name} imageUrl={cat.imageUrl} style={{ paddingHorizontal: GUTTER, marginTop: space['2xl'] }} />;
    }
    if (row.kind === 'item') {
      const corner = (on: boolean) => (on ? radius.lg : 0);
      return (
        <View
          style={{
            marginHorizontal: GUTTER,
            marginTop: row.first ? space.md : 0,
            paddingHorizontal: space.lg,
            backgroundColor: color.surface.base,
            borderColor: color.border.subtle,
            borderLeftWidth: 1,
            borderRightWidth: 1,
            borderTopWidth: row.first ? 1 : 0,
            borderBottomWidth: row.last ? 1 : 0,
            borderTopLeftRadius: corner(row.first),
            borderTopRightRadius: corner(row.first),
            borderBottomLeftRadius: corner(row.last),
            borderBottomRightRadius: corner(row.last),
          }}
        >
          <MenuItemRow item={row.item} line={lineByItem.get(row.item.id)} vat={storeVat} last={row.last} onOpenItem={openItem} onTap={onTap} />
        </View>
      );
    }
    if (row.kind === 'tiles') {
      return (
        <View style={{ flexDirection: 'row', gap: space.md, paddingHorizontal: GUTTER, paddingTop: row.first ? space.lg : space.md }}>
          {row.items.map((item: any) => (
            <MartTile key={item.id} item={item} line={lineByItem.get(item.id)} vat={storeVat} onOpenItem={openItem} onTap={onTap} />
          ))}
        </View>
      );
    }
    return (
      <View style={{ paddingHorizontal: GUTTER, paddingTop: row.first ? space.lg : space.md }}>
        <ServiceRow item={row.item} vat={storeVat} onOpen={() => openItem(row.item)} />
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      <FlashList
        data={menuRows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.kind}
        renderItem={({ item: row }) => renderMenuRow(row)}
        // A cart read or a sign-in redraws the rows on screen (each row is memoised: only a changed one redraws).
        extraData={rowsDrawnWith}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: space['3xl'] + cartClearance }}
        ListHeaderComponent={
          <>
        {/* Cover hero — the MerchantCard treatment at hero scale: a real
            gradient (never a flat band), the store's identity riding its own
            photograph, and frosted pills for the facts. Photography is the
            colour; nothing here tints the image. */}
        <View>
          <Photo
            uri={vendorPhoto(v, HERO_PHOTO_WIDTH)}
            label={v.name}
            // The store's name is set ON this photo, in the title below — so
            // a store with no cover photo must not print it a second time in
            // the placeholder's centre. One name, drawn once [Q3].
            showLabel={false}
            glyph="shops"
            transition={200}
            style={{ width: SCREEN_W, height: 300 }}
            contentFit="cover"
          />
          {/* Top: keeps the back/heart/share chips legible over a bright photo
              — the exact case Scrim's `anchor="top"` was built for. */}
          <Scrim anchor="top" height={insets.top + 76} to={withAlpha(color.text.primary, 0.45)} />
          {/* Bottom: carries the name and pills, and softens the meeting point
              with the sheet below. */}
          <Scrim height={170} />
          <View style={{ position: 'absolute', left: GUTTER, right: GUTTER, bottom: radius.xl + space.lg, gap: space.sm }}>
            <T variant="title" tone="onBrand" numberOfLines={2}>
              {v.name}
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
              {closed ? (
                <View style={{ backgroundColor: color.brand[600], paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.full }}>
                  <T variant="micro" weight="bold" tone="onBrand">
                    Closed right now
                  </T>
                </View>
              ) : (
                // [Wave 3 vs reference 06] "● Open" — the reference states the
                // GOOD state too, not only the bad one. Same server fact
                // (isCurrentlyOpen) that gates ordering.
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: withAlpha(color.white, 0.92), paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.full }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color.success }} />
                  <T variant="micro" weight="bold" style={{ color: color.success }}>
                    Open
                  </T>
                </View>
              )}
              {v.displayRating != null || v.ratingBucket ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: withAlpha(color.white, 0.92), paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.full }}>
                  <Feather name="star" size={11} color={color.star} />
                  <T variant="micro" weight="bold">
                    {v.displayRating != null ? Number(v.displayRating).toFixed(1) : (v.ratingBucket ?? 'New')}
                  </T>
                </View>
              ) : null}
              {kindLabel ? (
                <View style={{ backgroundColor: withAlpha(color.white, 0.92), paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.full }}>
                  <T variant="micro" weight="semibold">
                    {kindLabel}
                  </T>
                </View>
              ) : null}
            </View>
          </View>
          <View
            style={{
              position: 'absolute',
              top: insets.top + space.sm,
              left: GUTTER,
              right: GUTTER,
              flexDirection: 'row',
              alignItems: 'center',
            }}
          >
            <CircleChip icon="chevron-left" label="Back" onPress={() => navigation.goBack()} />
            <View style={{ flex: 1 }} />
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <HeartBadge
                size={44}
                active={!!v.isFavorite}
                onPress={() =>
                  isAuthenticated ? !toggleFav.isPending && toggleFav.mutate({ vendorId, isFavorite: !!v.isFavorite }) : promptLogin()
                }
              />
              <CircleChip
                icon="share-2"
                label="Share this store"
                onPress={() => void Share.share({ message: `${v.name} is on Swift — ${v.description ?? 'order in the app'}` }).catch(() => toast.show("Couldn't open the share sheet."))}
              />
              {/* [B15] The flag beside the share — quiet, auth-gated like the
                  favourite. Apple 1.2 / Google UGC require reporting from
                  INSIDE the app; the queue existed, the door did not. */}
              <CircleChip
                icon="flag"
                label="Report this store"
                onPress={() => (isAuthenticated ? setReportOpen(true) : promptLogin())}
              />
            </View>
          </View>
        </View>

        {/* Sheet over the photo */}
        <View
          style={{
            marginTop: -radius.xl,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            backgroundColor: color.surface.subtle,
            paddingTop: space['2xl'],
          }}
        >
          {/* The name and status now ride the hero photograph (above), so the
              sheet leads with the facts instead of repeating the title. */}
          {/* Info strip */}
          <View style={{ flexDirection: 'row', paddingHorizontal: GUTTER }}>
            <StatCol
              icon="star"
              value={
                v.displayRating != null
                  ? // [Wave 3 vs reference 06] "4.8 (212)" — the count is the
                    // rating's credibility and it already rides the payload.
                    `${Number(v.displayRating).toFixed(1)}${Number(v.totalRatings ?? 0) > 0 ? ` (${v.totalRatings})` : ''}`
                  : 'New'
              }
              caption="See reviews"
              onPress={() => navigation.navigate('VendorReviews', { vendorId })}
            />
            {distance ? <StatCol icon="map-pin" value={distance} caption="Distance" /> : null}
            {v.etaMin != null ? <StatCol icon="clock" value={`${v.etaMin} min`} caption="Arrive" /> : null}
            {/* Pickup spec 2.4 — quiet honesty: goods stores take order-ahead
                pickup; the Cart's mode toggle is where it's chosen. */}
            {!isServiceStore ? <StatCol icon="shopping-bag" value="Pickup" caption="Order ahead" /> : null}
            {hoursLabel(v.operatingHours) ? (
              <StatCol
                icon="clock"
                value={hoursLabel(v.operatingHours)!}
                caption="Hours"
                onPress={() => setShowHours(true)}
                last
              />
            ) : null}
          </View>

          {/* [Wave 3 vs reference 06] The street closes the facts line — a
              pickup customer needs WHERE, and the payload has always carried
              addressLine1 unrendered here. */}
          {v.addressLine1 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: GUTTER, marginTop: space.lg }}>
              <Feather name="map-pin" size={13} color={color.text.muted} />
              <T variant="caption" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
                {v.addressLine1}
              </T>
            </View>
          ) : null}

          {/* [CHAINS PR3 · owner 29 Oct 2026] One brand card opened this branch (the best for this customer); they can
              pick another branch of the same brand. */}
          {showsBranchSwitcher(v.brand) ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${currentBranchLabel(v.brand, v.addressLine1 ?? v.name)}. Change branch`}
              onPress={() => setShowBranches(true)}
            >
              {({ pressed }) => (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: GUTTER, marginTop: space.sm, minHeight: 44, opacity: pressed ? 0.75 : 1 }}>
                  <Feather name="git-branch" size={13} color={color.text.muted} />
                  <T variant="caption" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
                    {`${v.brand.name} · ${currentBranchLabel(v.brand, v.addressLine1 ?? v.name)}`}
                  </T>
                  <T variant="caption" weight="semibold" tone="brand">
                    Change
                  </T>
                </View>
              )}
            </Pressable>
          ) : null}

          {/* Live promos (real active codes) */}
          {promos.length > 0 ? (
            <Pressable onPress={() => setShowPromos(true)}>
              {({ pressed }) => (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.md,
                  paddingHorizontal: GUTTER,
                  marginTop: space.xl,
                  opacity: pressed ? 0.7 : 1,
                }}
              >
                <IconChip icon="tag" />
                <T variant="body" weight="medium" style={{ flex: 1 }}>
                  {promos.length} promo{promos.length > 1 ? 's' : ''} available
                </T>
                <Feather name="chevron-right" size={20} color={color.text.muted} />
              </View>
              )}
            </Pressable>
          ) : null}

          {/* The store's own number, published by the store. Shown whether or
              not it is open: a closed store is exactly when someone wants to
              ask when it reopens. The server withholds this for suspended and
              unapproved stores, so its presence here is already the decision —
              this renders what it is given and adds no rule of its own. */}
          {v.publicPhone ? (
            <Pressable
              onPress={() => { void Linking.openURL(`tel:${v.publicPhone}`); }}
              accessibilityRole="button"
              accessibilityLabel={`Call ${v.name} on ${formatPhoneForDisplay(v.publicPhone)}`}
            >
              {({ pressed }) => (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.md,
                    paddingHorizontal: GUTTER,
                    marginTop: space.xl,
                    opacity: pressed ? 0.7 : 1,
                  }}
                >
                  <IconChip icon="phone" />
                  <View style={{ flex: 1 }}>
                    <T variant="body" weight="medium">
                      Call the store
                    </T>
                    <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                      {formatPhoneForDisplay(v.publicPhone)}
                    </T>
                  </View>
                  <Feather name="chevron-right" size={20} color={color.text.muted} />
                </View>
              )}
            </Pressable>
          ) : null}

          {closed ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
                marginHorizontal: GUTTER,
                marginTop: space.xl,
                padding: space.lg,
                borderRadius: radius.md,
                backgroundColor: color.brand[50],
              }}
            >
              <Feather name="info" size={16} color={color.brand[600]} />
              <T variant="label" tone="deep" style={{ flex: 1 }}>
                Closed right now — browse the menu; ordering opens with the store.
              </T>
            </View>
          ) : null}

          {isMart ? (
            <>
              {/* In-store search + aisles + dense grid (Grab Mart) */}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.sm,
                  marginHorizontal: GUTTER,
                  marginTop: space.xl,
                  height: 44,
                  borderRadius: 9999,
                  paddingHorizontal: space.lg,
                  backgroundColor: color.surface.base,
                  borderWidth: 1,
                  borderColor: color.border.subtle,
                }}
              >
                <Feather name="search" size={16} color={color.text.muted} />
                <TextInput
                  value={storeQuery}
                  onChangeText={setStoreQuery}
                  placeholder={`Search ${v.name}…`}
                  placeholderTextColor={color.text.muted}
                  style={{ flex: 1, fontFamily: font.body, fontSize: fontSize.sm, color: color.text.primary }}
                />
                {storeQuery ? (
                  <Pressable onPress={() => setStoreQuery('')} hitSlop={8}>
                    <Feather name="x" size={16} color={color.text.muted} />
                  </Pressable>
                ) : null}
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginTop: space.lg, flexGrow: 0 }}
                contentContainerStyle={{ paddingHorizontal: GUTTER, gap: space.md }}
              >
                <Chip label="All" selected={!aisleId} onPress={() => setAisleId(null)} style={{ height: 38, paddingHorizontal: space.lg }} />
                {categories.map((c: any) => (
                  <Chip
                    key={c.id}
                    label={c.name}
                    selected={aisleId === c.id}
                    onPress={() => setAisleId(c.id)}
                    style={{ height: 38, paddingHorizontal: space.lg }}
                  />
                ))}
              </ScrollView>
            </>
          ) : isServiceStore ? (
            <>
              {/* Bookable services: duration + where-it-happens, tap to book */}
              <SectionHeader title="Services" style={{ paddingHorizontal: GUTTER, marginTop: space['2xl'] }} />
            </>
          ) : (
            <>
          {/* The store's own picks (its isPopular tick), named as such: never "Recommended for you". */}
          {recommended.length > 0 ? (
            <>
              <SectionHeader title={STORE_PICKS_TITLE} style={{ paddingHorizontal: GUTTER, marginTop: space['3xl'] }} />
              <FlatList
                horizontal
                showsHorizontalScrollIndicator={false}
                data={recommended}
                keyExtractor={(i: any) => i.id}
                contentContainerStyle={{ paddingHorizontal: GUTTER, gap: space.lg, paddingTop: space.lg }}
                renderItem={({ item }) => itemCard(item, RAIL_W)}
              />
            </>
          ) : null}

          {/* Best seller rail */}
          {bestSellers.length > 0 && allItems.length > 4 ? (
            <>
              <SectionHeader title="Best seller" style={{ paddingHorizontal: GUTTER, marginTop: space['3xl'] }} />
              <FlatList
                horizontal
                showsHorizontalScrollIndicator={false}
                data={bestSellers}
                keyExtractor={(i: any) => `bs-${i.id}`}
                contentContainerStyle={{ paddingHorizontal: GUTTER, gap: space.lg, paddingTop: space.lg }}
                renderItem={({ item }) => itemCard(item, RAIL_W)}
              />
            </>
          ) : null}

          {/* The menu — set like a real menu (design-100×): category chips filter
              (one mental model with the mart aisles), rows with name/description/
              price on one card per category. */}
          {categories.length > 1 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginTop: space['2xl'], flexGrow: 0 }}
              contentContainerStyle={{ paddingHorizontal: GUTTER, gap: space.md }}
            >
              <Chip label={storeKindWords(v?.vendorType).allItemsChip} selected={!menuCatId} onPress={() => setMenuCatId(null)} style={{ height: 44, paddingHorizontal: space.lg }} />
              {categories.map((c: any) => (
                <Chip
                  key={c.id}
                  label={c.name}
                  selected={menuCatId === c.id}
                  onPress={() => setMenuCatId(c.id)}
                  style={{ height: 44, paddingHorizontal: space.lg }}
                />
              ))}
            </ScrollView>
          ) : null}

            </>
          )}
        </View>
          </>
        }
        ListFooterComponent={
          <>
          {isMart && martItems.length === 0 ? (
            <T variant="label" tone="muted" center style={{ marginTop: space['2xl'] }}>
              Nothing matches — try another search or aisle.
            </T>
          ) : null}

          {allItems.length === 0 ? (
            <T variant="label" tone="muted" center style={{ marginTop: space['3xl'] }}>
              This store hasn’t published a menu yet.
            </T>
          ) : null}

          {/* [R3 · CAA s.70] Who sells, how payment works and the store's refund rule (the server's block; none from an older API). */}
          {/* [STORE-VAT · VAT Act s.90(2)] A person-approved VAT store's prices include VAT, and the page says so. */}
          {storefrontVatLine(storeVat) ? (
            <T variant="caption" tone="muted" style={{ marginTop: space.lg, marginHorizontal: GUTTER }}>
              {storefrontVatLine(storeVat)}
            </T>
          ) : null}
          {v.seller ? <SellerInfo seller={v.seller} gutter={GUTTER} /> : null}
          </>
        }
      />

      {/* [E09] One pinned cart bar for every surface: the storefront passes its
          vendorId so the bar only shows for THIS store's basket. */}
      <CartBar vendorId={vendorId} />

      {/* [CHAINS PR3] The brand's branches, the best for this customer first. */}
      <PopupCard visible={showBranches} onClose={() => setShowBranches(false)}>
        <IconChip icon="map-pin" size={56} />
        <PopupTitle variant="heading" style={{ marginTop: space.md }}>
          {v.brand ? `${v.brand.name} branches` : 'Branches'}
        </PopupTitle>
        <View style={{ alignSelf: 'stretch', marginTop: space.lg }}>
          {((v.brand?.branches ?? []) as BrandBranch[]).map((b) => (
            <Pressable
              key={b.id}
              accessibilityRole="button"
              accessibilityLabel={`${b.name}. ${branchAddress(b)}. ${branchFactsLine(b)}`}
              disabled={b.current}
              onPress={() => {
                setShowBranches(false);
                // The popup tears down first (kit/after-dismiss), then the other branch's page opens.
                afterDismiss(() => navigation.navigate('Restaurant', { vendorId: b.id }));
              }}
            >
              {({ pressed }) => (
                <View style={{ paddingVertical: space.sm, opacity: pressed ? 0.75 : 1 }}>
                  <T variant="label" weight="semibold" numberOfLines={1}>
                    {b.current ? `${b.name} (this branch)` : b.name}
                  </T>
                  <T variant="caption" tone="muted" numberOfLines={1}>
                    {branchAddress(b)}
                  </T>
                  <T variant="caption" tone="muted" numberOfLines={1}>
                    {branchFactsLine(b)}
                  </T>
                </View>
              )}
            </Pressable>
          ))}
        </View>
        <PillButton label="Done" size="md" onPress={() => setShowBranches(false)} style={{ alignSelf: 'stretch', marginTop: space.lg }} />
      </PopupCard>

      {/* Operating hours (kit 17) */}
      <PopupCard visible={showHours} onClose={() => setShowHours(false)}>
        <IconChip icon="clock" size={56} />
        <PopupTitle variant="heading" style={{ marginTop: space.md }}>
          Opening hours
        </PopupTitle>
        <View style={{ alignSelf: 'stretch', marginTop: space.lg }}>
          {(v.operatingHours ?? [])
            .slice()
            .sort((a: any, b: any) => a.dayOfWeek - b.dayOfWeek)
            .map((h: any) => (
              <View
                key={h.dayOfWeek}
                style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}
              >
                <T variant="label" tone="muted">
                  {DAYS[h.dayOfWeek]}
                </T>
                <T variant="label" weight="semibold" tone={h.isClosed ? 'error' : 'ink'}>
                  {h.isClosed ? 'Closed' : `${h.openTime} – ${h.closeTime}`}
                </T>
              </View>
            ))}
        </View>
        <PillButton label="Done" size="md" onPress={() => setShowHours(false)} style={{ alignSelf: 'stretch', marginTop: space.lg }} />
      </PopupCard>

      {/* Active promos */}
      <PopupCard visible={showPromos} onClose={() => setShowPromos(false)}>
        <IconChip icon="tag" size={56} />
        <PopupTitle variant="heading" style={{ marginTop: space.md }}>
          Promos
        </PopupTitle>
        <View style={{ alignSelf: 'stretch', marginTop: space.lg, gap: space.md }}>
          {promos.map((p: any) => (
            <View key={p.code} style={{ borderWidth: 1, borderColor: color.border.subtle, borderRadius: radius.md, padding: space.md }}>
              <T variant="body" weight="bold" tone="brand">
                {p.code}
              </T>
              <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                {p.description}
              </T>
              {p.minOrderAmount ? (
                <T variant="caption" tone="faint" style={{ marginTop: 2 }}>
                  Min order {money(p.minOrderAmount)}
                </T>
              ) : null}
            </View>
          ))}
        </View>
        <T variant="caption" tone="muted" center style={{ marginTop: space.md }}>
          Enter the code at checkout.
        </T>
        <PillButton label="Got it" size="md" onPress={() => setShowPromos(false)} style={{ alignSelf: 'stretch', marginTop: space.md }} />
      </PopupCard>

      {/* [B15] Report this store — curated reasons in the reporter's words;
          selecting IS filing. The server is idempotent per (reporter, store),
          so a repeat tap reads as the same calm thanks. */}
      <ActionSheet
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        title="Report this store"
        // [R19] the shared list, Child safety (CSAE) included
        actions={STORE_REPORT_REASONS.map((reason) => ({
          label: reason.label,
          onPress: () => {
            setReportOpen(false);
            reportContent.mutate(
              { targetType: 'VENDOR', targetId: vendorId, reason: reason.key },
              {
                onSuccess: () => toast.success('Thanks — our team will look', 'Reports are reviewed by a human.'),
                onError: () => toast.error('Couldn’t send that report', 'Check your connection and try again.'),
              },
            );
          },
        }))}
      />
    </View>
  );
}
