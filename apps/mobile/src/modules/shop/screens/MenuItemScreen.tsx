/** @jsxImportSource react */
import React, { useMemo, useState } from 'react';
import { Dimensions, ScrollView, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, elevation, radius, space } from '@swift/ui';
import { useAddToCart, useItemSlots, useVendor } from '../../../hooks/customer';
import { requestAuthContinuation, type MenuItemAddDraft } from '../../../navigation/authContinuation';
import { useAuthStore } from '../../../stores/authStore';
import { useBookingStore, type ServiceVisitMode } from '../../../stores/bookingStore';
import { HERO_PHOTO_WIDTH, itemPhoto } from '../../../lib/images';
import { money } from '../../../lib/money';
import { itemVatNote, storefrontVat } from '../../../lib/storeVat';
import { addAppointmentDays, appointmentDayKey, appointmentWeekday, formatAppointmentClock } from '../../../lib/appointmentTime';
import { listingConfirmsInstantly } from '../../../lib/appointmentBooking';
import {
  Photo,
  Chip,
  EmptyState,
  CircleChip,
  ErrorState,
  Header,
  IconChip,
  LabeledInput,
  LoadingBlock,
  Money,
  PillButton,
  PopupCard,
  PopupTitle,
  QtyStepper,
  SectionHeader,
  T,
  TonePill,
} from '../../../kit';
import { afterDismiss } from '../../../kit/after-dismiss';
import { STORE_PICK } from '../../../lib/storePick';
import { ItemDescription } from '../components/ItemDescription';
import { readItemPreview, type ItemPreview } from '../../../lib/doorPreview';
import { readyTimeLabel, storeKindWords } from '../../../lib/storeKindWords';
import { KeyboardAvoider } from '../../../kit/keyboard-avoider';
import { ItemChoices } from '../components/ItemChoices';
import { asSheetSelection, chooseOption, defaultSelection, hasSizes, placeOption, sizeChosen, wireSelection, type Placement, type SheetSelection } from '../../../lib/menuSheet';
import { selectionProblem, sheetUnitPrice } from '../../../lib/menuPrice';

/** [P35 · board 4b] "Craft & Kind · Georgetown": the store's name, and its city when it has one. */
export function storeLine(store: { name?: string | null; city?: string | null }): string {
  const city = store.city?.trim();
  return city ? `${store.name ?? ''} · ${city}` : (store.name ?? '');
}

const SCREEN_W = Dimensions.get('window').width;
const GUTTER = space['2xl'];

// [MENU-OPTIONS · owner 11 Nov 2026] The choices are lib/menuSheet's (size sets the price, half-and-half, follow-up
// groups; a sold-out default is never pre-selected) and the price the server's own rules (lib/menuPrice).

/** [APP-SPEED A] A dish opening from its card: the card's photo and name, a visible Back, and the
 *  rest loading below. Drawn only from what the server sent the card. */
function ItemOpening({ preview, top, onBack }: { preview: ItemPreview; top: number; onBack: () => void }) {
  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }} accessibilityLabel={`${preview.name}. Loading`}>
      <View>
        <Photo
          uri={itemPhoto(preview, HERO_PHOTO_WIDTH)}
          label={preview.name}
          transition={200}
          style={{ width: SCREEN_W, height: 340 }}
          contentFit="cover"
        />
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
          paddingHorizontal: GUTTER,
        }}
      >
        <T variant="title">{preview.name}</T>
        <LoadingBlock />
      </View>
    </View>
  );
}

// Kit Menu Detail V1 (21–24): hero + floating chips, sheet w/ name/price,
// tinted info bar, description, modifiers (Swift option groups — the kit has
// none, composed in kit chip language), sticky stepper + Add to cart, success
// popup. Out-of-stock (23): disabled dark CTA.
export function MenuItemScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const { vendorId, itemId } = route.params ?? {};
  const { isAuthenticated, wantsAuth, promptLogin } = useAuthStore();

  const addDraft: MenuItemAddDraft | undefined = route.params?.addDraft;
  const vendor = useVendor<any>(vendorId);
  const addToCart = useAddToCart();
  const [qty, setQty] = useState(addDraft?.quantity ?? 1);
  const [added, setAdded] = useState(false);

  // Appointment listings book a moment, not a quantity (kit chips reused as
  // day + time pickers). Dates follow the market calendar used by the API.
  const [dayOffset, setDayOffset] = useState(addDraft?.dayOffset ?? 0);
  const [slot, setSlot] = useState<string | null>(addDraft?.slot ?? null);
  const [visitMode, setVisitMode] = useState<ServiceVisitMode>(addDraft?.visitMode ?? 'AT_BUSINESS');
  const setAppointment = useBookingStore((st) => st.setAppointment);

  const item = useMemo(
    () => vendor.data?.categories?.flatMap((c: any) => c.items ?? []).find((i: any) => i.id === itemId),
    [vendor.data, itemId],
  );
  const groups: any[] = useMemo(() => item?.optionGroups ?? [], [item]);
  const [selected, setSelected] = useState<SheetSelection>(() => (addDraft ? asSheetSelection(addDraft.selectedOptions) : defaultSelection(groups)));
  // [row 70] A note for the store travels with this line (and through sign-in).
  // Declared after the existing state so the screen's hook order is unchanged.
  const [note, setNote] = useState(addDraft?.notes ?? '');
  const trimmedNote = note.trim();

  const isBooking = item?.fulfillment === 'APPOINTMENT';
  const selectedDate = useMemo(() => {
    return addAppointmentDays(appointmentDayKey(new Date()), dayOffset);
  }, [dayOffset]);
  const slotsQ = useItemSlots<any>(isBooking ? itemId : '', selectedDate);
  const serviceMode: 'AT_BUSINESS' | 'MOBILE' | 'BOTH' = slotsQ.data?.serviceMode ?? 'AT_BUSINESS';
  const bookableWeekdays: number[] | undefined = slotsQ.data?.bookableWeekdays;
  const daySlots: string[] = useMemo(() => slotsQ.data?.slots ?? [], [slotsQ.data]);
  // [BOOK-S6a · owner A4] Only the server's own answer (switch on + the business's setting) earns the badge.
  const instantConfirmation = isBooking && listingConfirmsInstantly(slotsQ.data);
  // [STORE-WORDS · owner 9 Nov 2026] The clock chip in the store's own words (a booking keeps its service length).
  const readyLine = isBooking
    ? `${slotsQ.data?.durationMinutes ?? 30} min service`
    : readyTimeLabel(vendor.data?.vendorType, vendor.data?.estimatedPrepTime);

  // A slot can disappear during the 20-second freshness poll because another
  // customer won it. Never leave a now-unavailable selection armed in the
  // sticky booking button; checkout remains the final server-side judge.
  React.useEffect(() => {
    const available = slotsQ.data?.slots as string[] | undefined;
    if (slot && available && !available.includes(slot)) setSlot(null);
  }, [slot, slotsQ.data]);

  // Re-seed defaults when the item arrives after a cold load.
  const seededFor = React.useRef<string | null>(item || addDraft ? itemId : null);
  React.useEffect(() => {
    if (item && seededFor.current !== itemId) {
      seededFor.current = itemId;
      setSelected(defaultSelection(item.optionGroups ?? []));
    }
  }, [item, itemId]);

  const outOfStock = item?.stockQuantity === 0;
  const basePrice = Number(item?.customerPrice ?? item?.basePrice) || 0;

  // [MENU-OPTIONS] One unit as the server prices it: the chosen size IS the price, extras on top, a half topping at
  // the store's half price, a follow-up choice its own price.
  const unitPrice = item ? (sheetUnitPrice(item, selected) ?? basePrice) : basePrice;
  const total = unitPrice * qty;
  const sized = hasSizes(item);

  // [MENU-OPTIONS] Add waits until the server's own validator would accept the choices (required, minimum, maximum,
  // a size, an open follow-up group, nothing sold out).
  const requiredUnmet = item ? selectionProblem(item, selected) !== null : false;

  const toggleOption = (groupId: string, optionId: string) => {
    setSelected((prev) => chooseOption(groups, prev, groupId, optionId));
  };
  const placeTopping = (groupId: string, optionId: string, placement: Placement) => {
    setSelected((prev) => placeOption(groups, prev, groupId, optionId, placement));
  };
  const wireOptions = wireSelection(groups, selected);

  const resumedAdd = React.useRef(false);
  const onAdd = React.useCallback(() => {
    if (!isAuthenticated) {
      requestAuthContinuation({ screen: 'MenuItem', vendorId, itemId,
        addDraft: { quantity: qty, selectedOptions: wireOptions, dayOffset, slot, visitMode, ...(trimmedNote ? { notes: trimmedNote } : {}) },
      }, promptLogin);
      // If Auth already owns the root, promptLogin does not change its key.
      if (wantsAuth) navigation.getParent()?.navigate('Auth');
      return;
    }
    // Manual Add also consumes a queued replay (for example, booking from
    // last-known slots during a failed refresh). Recovery must not add twice.
    resumedAdd.current = true;
    if (route.params?.addAfterSignIn) navigation.setParams({ addAfterSignIn: undefined, addDraft: undefined });
    addToCart.mutate(
      {
        vendorId, itemId, quantity: isBooking ? 1 : qty, selectedOptions: Object.keys(wireOptions).length ? wireOptions : undefined,
        ...(trimmedNote ? { specialInstructions: trimmedNote } : {}),
      },
      {
        onSuccess: () => {
          if (isBooking && slot) {
            setAppointment(itemId, { slotStart: slot, ...(serviceMode === 'BOTH' ? { mode: visitMode } : {}), ...(instantConfirmation ? { instant: true } : {}) });
          }
          setAdded(true);
        },
      },
    );
  }, [isAuthenticated, wantsAuth, vendorId, itemId, qty, wireOptions, dayOffset, slot, visitMode, trimmedNote, promptLogin, navigation, addToCart, isBooking, serviceMode, instantConfirmation, setAppointment, route.params?.addAfterSignIn]);
  React.useEffect(() => {
    if (!route.params?.addAfterSignIn || resumedAdd.current || !isAuthenticated || !item || vendor.isLoading || vendor.isError) return;
    if (outOfStock || item.isAvailable === false || requiredUnmet || addToCart.isPending) return;
    // Restored options were revalidated against the current menu above: `requiredUnmet` is the server's own
    // validator (an unknown, sold-out or too-many choice, a missing size or follow-up), so nothing stale replays.
    if (isBooking && (!slot || !daySlots.includes(slot) || slotsQ.isError || slotsQ.isPending)) return;
    onAdd();
  }, [route.params?.addAfterSignIn, isAuthenticated, item, vendor.isLoading, vendor.isError, outOfStock, requiredUnmet, addToCart.isPending, isBooking, slot, daySlots, slotsQ.isError, slotsQ.isPending, navigation, onAdd]);

  if (vendor.isLoading) {
    // [APP-SPEED A] Opened from a dish card: its photo and name at once, the rest loading below.
    // No Add, no quantity and no price until the store's own menu answers.
    const preview = readItemPreview(route.params?.preview);
    if (preview) return <ItemOpening preview={preview} top={insets.top} onBack={() => navigation.goBack()} />;
    return (
      <View style={{ flex: 1, backgroundColor: color.surface.subtle, paddingTop: insets.top }}>
        {/* [UI-SWEEP U32] A visible way back while this loads or fails, not swipe only. */}
        <Header />
        <LoadingBlock />
      </View>
    );
  }
  if (vendor.isError || !item) {
    return (
      <View style={{ flex: 1, backgroundColor: color.surface.subtle, paddingTop: insets.top }}>
        {/* [UI-SWEEP U32] A visible way back while this loads or fails, not swipe only. */}
        <Header />
        {vendor.isError ? (
          <ErrorState onRetry={() => vendor.refetch()} />
        ) : (
          // The store answered and the item is gone: Retry cannot bring it back.
          <EmptyState
            icon="slash"
            // [STORE-WORDS] "on the menu" is a restaurant's line; a shop's item is "no longer for sale".
            title={storeKindWords(vendor.data?.vendorType).itemGoneTitle}
            body={storeKindWords(vendor.data?.vendorType).itemGoneBody}
            // [#1915 review S4-1] Opened from Home, Market or Search, Back does not lead to the store.
            actionLabel="Go back"
            onAction={() => navigation.goBack()}
          />
        )}
      </View>
    );
  }

  const addErr = addToCart.isError
    ? ((addToCart.error as any)?.response?.data?.error?.message ?? 'Could not add this. Try again.')
    : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      {/* [KEYBOARD 10 Nov] Lifted above the keyboard (kit/keyboard-avoider), so the last fields can scroll into view. */}
      <KeyboardAvoider style={{ flex: 1 }}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 140 }}>
          {/* Hero + floating header */}
          <View>
            <Photo
              uri={itemPhoto(item, HERO_PHOTO_WIDTH)}
              label={item.name}
              transition={200}
              style={{ width: SCREEN_W, height: 340 }}
              contentFit="cover"
            />
            <View
              style={{
                position: 'absolute',
                top: insets.top + space.sm,
                left: GUTTER,
                right: GUTTER,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <CircleChip icon="chevron-left" label="Back" onPress={() => navigation.goBack()} />
            </View>
          </View>

          {/* Sheet */}
          <View
            style={{
              marginTop: -radius.xl,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              backgroundColor: color.surface.subtle,
              paddingTop: space['2xl'],
              paddingHorizontal: GUTTER,
            }}
          >
            <T variant="title">{item.name}</T>
            {/* [P35 · board 4b] The store this item is sold by, where it is, and whether a person approved its papers
                (the store row's isVerified; an older server sends nothing and the pill stays away). */}
            {vendor.data?.name ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs }}>
                <T variant="caption" tone="muted" numberOfLines={1}>
                  {storeLine(vendor.data)}
                </T>
                {vendor.data?.isVerified === true ? <TonePill label="Verified seller" tone="success" /> : null}
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.sm }}>
              {/* [Wave 3 audit · law 3] Money is INK, never brand — maroon is
                  reserved for the acts (the CTA below), not the numbers. */}
              {/* [MENU-OPTIONS] A sized item: "From" its smallest size until a size is chosen, then that size's price
                  with the choices made (the price the Add shows for one). */}
              {sized && !sizeChosen(groups, selected) ? <T variant="label" tone="muted">From</T> : null}
              <Money amount={sized && sizeChosen(groups, selected) ? unitPrice : basePrice} size="l" />
              {/* [STORE-VAT · VAT Act s.90(2)] A person-approved VAT store's standard-rated price includes VAT and says so. */}
              {itemVatNote(storefrontVat(vendor.data?.vat), item) ? <T variant="caption" tone="muted">{itemVatNote(storefrontVat(vendor.data?.vat), item)}</T> : null}
              {outOfStock ? (
                <View
                  style={{
                    paddingHorizontal: space.md,
                    paddingVertical: 4,
                    borderRadius: 9999,
                    backgroundColor: color.soft.warning,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 5,
                  }}
                >
                  <Feather name="slash" size={12} color={color.warning} />
                  <T variant="caption" weight="semibold" tone="warning">
                    Out of stock
                  </T>
                </View>
              ) : null}
            </View>

            {/* Tinted info bar — real vendor facts */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                // [STORE-WORDS] "Ready in about 30 min" is longer than "30 min prep": a gap keeps it off its neighbours.
                gap: space.md,
                backgroundColor: color.brand[50],
                borderRadius: radius.md,
                paddingHorizontal: space.lg,
                paddingVertical: space.md,
                marginTop: space.lg,
              }}
            >
              {/* [STORE-WORDS] "20 min prep" is a kitchen's word: any other store reads "Ready in about 20 min",
                  and a store that sent no time shows no chip rather than an invented one. */}
              {readyLine ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
                  <Feather name="clock" size={14} color={color.brand[600]} />
                  <T variant="label" tone="deep" style={{ flexShrink: 1 }}>
                    {readyLine}
                  </T>
                </View>
              ) : null}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Feather name="star" size={14} color={color.star} />
                <T variant="label" tone="deep">
                  {vendor.data?.displayRating != null ? Number(vendor.data.displayRating).toFixed(1) : 'New'}
                </T>
              </View>
              {item.isPopular ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Feather name="thumbs-up" size={14} color={color.brand[600]} />
                  <T variant="label" tone="deep">
                    {STORE_PICK}
                  </T>
                </View>
              ) : null}
            </View>

            {item.description ? (
              <>
                <SectionHeader title="Description" style={{ marginTop: space['2xl'] }} />
                <View style={{ marginTop: space.md }}>
                  <ItemDescription text={item.description} />
                </View>
              </>
            ) : null}

            {/* [MENU-OPTIONS] The item's choices, like a pizza shop's sheet (components/ItemChoices). */}
            <ItemChoices groups={groups} selection={selected} onChoose={toggleOption} onPlace={placeTopping} />

            {isBooking ? (
              <>
                {/* [BOOK-S6a · owner A3/A4] The server says this listing confirms a cash booking at once.
                    No badge (and no "instant" word) when it does not say so: switch off, an older server,
                    or a business that confirms each booking itself. */}
                {instantConfirmation ? (
                  <View style={{ marginTop: space['2xl'], gap: space.xs }}>
                    <View style={{ flexDirection: 'row' }}>
                      <TonePill label="Instant confirmation" tone="success" />
                    </View>
                    <T variant="caption" tone="muted">
                      Pay at your appointment and your time is confirmed as soon as you book.
                    </T>
                  </View>
                ) : null}
                {/* Where it happens — the business's setting; BOTH lets you pick */}
                <SectionHeader title="Where" style={{ marginTop: space['2xl'] }} />
                {serviceMode === 'BOTH' ? (
                  <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
                    <Chip
                      label="You go to them"
                      selected={visitMode === 'AT_BUSINESS'}
                      onPress={() => setVisitMode('AT_BUSINESS')}
                      style={{ height: 42, paddingHorizontal: space.lg }}
                    />
                    <Chip
                      label="They come to you"
                      selected={visitMode === 'MOBILE'}
                      onPress={() => setVisitMode('MOBILE')}
                      style={{ height: 42, paddingHorizontal: space.lg }}
                    />
                  </View>
                ) : (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: space.md }}>
                    <Feather name={serviceMode === 'MOBILE' ? 'navigation' : 'map-pin'} size={14} color={color.brand[600]} />
                    <T variant="label" tone="muted" style={{ flex: 1 }}>
                      {serviceMode === 'MOBILE'
                        ? `They come to your address${slotsQ.data?.serviceRadiusKm ? ` (within ${slotsQ.data.serviceRadiusKm} km)` : ''}`
                        : `At ${vendor.data?.name ?? 'their place'}${vendor.data?.addressLine1 ? ` — ${vendor.data.addressLine1}` : ''}`}
                    </T>
                  </View>
                )}
                {serviceMode === 'BOTH' && visitMode === 'MOBILE' ? (
                  <T variant="caption" tone="faint" style={{ marginTop: 6 }}>
                    They travel to your saved address{slotsQ.data?.serviceRadiusKm ? ` (within ${slotsQ.data.serviceRadiusKm} km)` : ''}.
                  </T>
                ) : null}

                {/* When — day chips + real availability from the booking engine */}
                <SectionHeader title="Pick a time" style={{ marginTop: space['2xl']}} />
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: space.md, flexGrow: 0 }} contentContainerStyle={{ gap: space.md }}>
                  {Array.from({ length: 7 }, (_, i) => {
                    const key = addAppointmentDays(appointmentDayKey(new Date()), i);
                    const wd = appointmentWeekday(key);
                    const closed = bookableWeekdays ? !bookableWeekdays.includes(wd) : false;
                    const label =
                      i === 0
                        ? 'Today'
                        : i === 1
                          ? 'Tomorrow'
                          : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][wd]} ${Number(key.slice(-2))}`;
                    return (
                      <Chip
                        key={i}
                        label={closed ? `${label} · closed` : label}
                        selected={dayOffset === i}
                        onPress={() => {
                          if (closed) return;
                          setDayOffset(i);
                          setSlot(null);
                        }}
                        style={{ height: 40, paddingHorizontal: space.lg, opacity: closed ? 0.45 : 1 }}
                      />
                    );
                  })}
                </ScrollView>
                {slotsQ.isPending ? (
                  <T variant="label" tone="muted" style={{ marginTop: space.md }}>
                    Checking times…
                  </T>
                ) : slotsQ.isError && !slotsQ.data ? (
                  <View style={{ marginTop: space.md, alignItems: 'flex-start', gap: space.sm }}>
                    <T variant="label" tone="error">
                      Couldn’t load available times. Check your connection and try again.
                    </T>
                    <Chip
                      label="Try again"
                      selected={false}
                      onPress={() => void slotsQ.refetch()}
                      style={{ height: 40, paddingHorizontal: space.lg }}
                    />
                  </View>
                ) : daySlots.length === 0 ? (
                  <T variant="label" tone="muted" style={{ marginTop: space.md }}>
                    No times left this day — try another.
                  </T>
                ) : (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.md }}>
                    {daySlots.map((iso) => (
                      <Chip
                        key={iso}
                        label={formatAppointmentClock(iso)}
                        selected={slot === iso}
                        onPress={() => setSlot(iso)}
                        style={{ height: 42, paddingHorizontal: space.lg }}
                      />
                    ))}
                  </View>
                )}
                {slotsQ.isError && slotsQ.data ? (
                  <View style={{ marginTop: space.sm, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                    <T variant="caption" tone="warning" style={{ flex: 1 }}>
                      These are the last known times. Refresh before choosing if your connection is back.
                    </T>
                    <Chip
                      label="Refresh"
                      selected={false}
                      onPress={() => void slotsQ.refetch()}
                      style={{ height: 36, paddingHorizontal: space.md }}
                    />
                  </View>
                ) : null}
                {slotsQ.data?.durationMinutes ? (
                  <T variant="caption" tone="faint" style={{ marginTop: space.sm }}>
                    Each appointment runs about {slotsQ.data.durationMinutes} minutes.
                  </T>
                ) : null}
              </>
            ) : null}

            {!isBooking ? (
              <LabeledInput
                label="Note for the store"
                placeholder={storeKindWords(vendor.data?.vendorType).itemNotePlaceholder}
                value={note}
                onChangeText={setNote}
                maxLength={500}
                accessibilityLabel="Note for the store"
                testID="menu-item-note"
                containerStyle={{ marginTop: space.xl }}
              />
            ) : null}

            {addErr ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.lg }}>
                <Feather name="alert-circle" size={14} color={color.error} />
                <T variant="label" tone="error">
                  {addErr}
                </T>
              </View>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoider>

      {/* Sticky action bar — stepper + Add to cart (kit 21) */}
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          paddingHorizontal: GUTTER,
          paddingTop: space.lg,
          paddingBottom: insets.bottom + space.lg,
          backgroundColor: color.surface.base,
          borderTopLeftRadius: radius.xl,
          borderTopRightRadius: radius.xl,
          ...elevation.dock,
          elevation: 12,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.lg,
        }}
      >
        {isBooking ? null : (
          <QtyStepper value={qty} onDec={() => setQty((q) => Math.max(1, q - 1))} onInc={() => setQty((q) => q + 1)} min={1} />
        )}
        <PillButton
          label={
            outOfStock
              ? 'Out of stock'
              : isBooking
                ? slot
                  ? requiredUnmet
                    ? 'Choose required options'
                    : `Book ${formatAppointmentClock(slot)} · ${money(total)}`
                  : 'Pick a time'
                : requiredUnmet
                  ? 'Choose required options'
                  : `Add to cart · ${money(total)}`
          }
          icon={isBooking ? 'calendar' : 'shopping-cart'}
          variant={outOfStock ? 'dark' : 'primary'}
          disabled={outOfStock || requiredUnmet || (isBooking && !slot)}
          loading={addToCart.isPending}
          onPress={onAdd}
          style={{ flex: 1 }}
        />
      </View>

      {/* Success popup (kit 24) */}
      <PopupCard visible={added} onClose={() => setAdded(false)}>
        <IconChip icon="shopping-cart" size={64} />
        <PopupTitle variant="heading" center style={{ marginTop: space.md }}>
          {isBooking ? 'Booking added — confirm at checkout' : 'Added to your cart!'}
        </PopupTitle>
        <View style={{ alignSelf: 'stretch', gap: space.md, marginTop: space.xl }}>
          <PillButton
            label="View cart"
            size="md"
            onPress={() => {
              setAdded(false);
              afterDismiss(() => navigation.navigate('Tabs', { screen: 'Cart' }, { pop: true }));
            }}
          />
          <PillButton label="Keep browsing" variant="soft" size="md" onPress={() => setAdded(false)} />
        </View>
      </PopupCard>
    </View>
  );
}
