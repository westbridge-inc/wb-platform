/** @jsxImportSource react */
import { useVendorMutation } from '../../../hooks/useVendorMutation';
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { usePreventRemove } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { Pressable, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { color, radius, space } from '@swift/ui';
import { Feather } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as Crypto from 'expo-crypto';
import {
  BrandSwitch,
  Card,
  Chip,
  ConfirmDialog,
  IconChip,
  LabeledInput,
  LinkText,
  PhotoDrop,
  PillButton,
  PopupCard,
  PopupTitle,
  Screen,
  Segmented,
  T,
} from '../../../kit';
import { DAY_LABELS, GUTTER, InlineInput, SubHeader } from '../shared';
import { itemGoneWords } from '../../../lib/storeKindWords';
import { vendorApi } from '../../../services/api';
import { toast } from '../../../kit/toast';
import { useRowHold } from '../../../lib/useRowHold';
import { SOLD_IN_STORE } from '../../../lib/inStoreSale';
import { afterDismiss } from '../../../kit/after-dismiss';
import {
  useVendorProfile,
  useSaveItem,
  useUploadItemImage,
  useAddOptionGroup,
  useDeleteOptionGroup,
  useAddOption,
  useDeleteOption,
  MENU_WRITE_KEY,
  answerIntoMenu,
  menuScope,
} from '../../../hooks/vendorops';
import { menuWithItemFields } from '../../../lib/menuAnswers';
import {
  AuthSessionBoundaryError,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
} from '../../../stores/authStore';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';
import { useVendorPreview } from '../../../stores/vendorPreview';
import {
  beforeVatAtCheckoutHint, beforeVatNote, editablePrice, itemPricePayload, newItemBeforeVatHint, newOptionPrice, optionPriceLabel, vatClassChoices, vatPricingOf, type VatClass,
} from '../../../lib/storeVat';
import { useStoreVat } from '../../../hooks/storeVat';
import { isKeptPhoto, storePhotoUrl, HERO_PHOTO_WIDTH } from '../../../lib/images';
import { STORE_PICK } from '../../../lib/storePick';
import { BULK_WORDS } from '../../../lib/bulkWords';
import { useAuthStore } from '../../../stores/authStore';
import { homeVisitPhotoNeeded } from '../homeVisitPhoto';
import { HomeVisitPhotoCard } from '../HomeVisitPhotoCard';
import {
  BUFFER_CHOICES, NOTICE_CHOICES, choicesWith, instantBookingAvailable, minutesLabel, nextWindow, openingBookingSettings,
  slotsFromWeekHours, weekHoursFromSlots, weekHoursProblem, type WeekHours,
} from '../../../lib/bookingHours';
import { KeyboardAvoider } from '../../../kit/keyboard-avoider';
import { menuWriteScope, useMenuOptionsWrite, useOptionLibrary } from '../../../hooks/menuOptions';
import { GroupRuleChips, NEW_GROUP_FLAGS } from '../GroupRuleChips';
import { errorMessage } from '../../../lib/apiError';
import { money } from '../../../lib/money';
import {
  choicePriceInput, choicePricePlaceholder, flagsOf, followUpLabel, followUpTargets, fromPriceWords, groupFlagsBody, groupFlagsEdit,
  groupRuleWords, isFollowUpGroup, itemTypedPrice, libraryGroupsToAdd, lowestSizePrice, menuOptionsRefusal, needsSizeSwitchConfirm,
  parseStorePrice, sharedEditWarning, sharedUse, sizePriceLabel, sizeSwitchBody, sizeSwitchRows, sizeSwitchShown, sizeSwitchTyped,
  sizeSwitchWords, usedByWords, type GroupFlags,
} from '../../../lib/menuOptionsEditor';

/** [TAP-AUDIT] An option group (with its choices) written on a NEW item, before its first save: kept on the phone and
 *  sent with the item in the one create request (POST /vendor/items takes `optionGroups`), so a store adds an item
 *  with its sizes in one visit instead of saving, finding the item again and adding each choice one request at a time.
 *  [MENU-OPTIONS] With its size / half-and-half rule (a follow-up group is chosen once the item is saved). */
export type DraftOptionGroup = {
  key: string;
  name: string;
  isRequired: boolean;
  maxSelect: number;
  setsPrice?: boolean;
  allowHalves?: boolean;
  halfPricePercent?: number;
  options: { key: string; name: string; additionalPrice: number }[];
};

/** The create request's `optionGroups`, exactly what the store typed (the server checks every name, as it does for
 *  a group added later). [MENU-OPTIONS] A size / half-and-half flag is sent only when it is on: a plain group's
 *  request is what it always was. */
export function draftOptionGroupsPayload(groups: DraftOptionGroup[], vatAdded = false) {
  return groups.map((g) => ({
    name: g.name,
    ...groupFlagsBody({
      required: g.isRequired, multi: g.maxSelect > 1, setsPrice: g.setsPrice === true, allowHalves: g.allowHalves === true,
      halfPercent: g.halfPricePercent ?? 100,
    }),
    // [REVIEW-M #2255 S4-2] A new option's price as the store typed it (before VAT where VAT is added).
    options: g.options.map((o) => ({ name: o.name, ...newOptionPrice(o.additionalPrice, vatAdded) })),
  }));
}

/** [MENU-OPTIONS] An item save without its price fields (a sized item's price is its lowest size, kept by the server). */
export function withoutItemPrice<T extends Record<string, unknown>>(sized: boolean, data: T): T {
  if (!sized) return data;
  const rest: Record<string, unknown> = { ...data };
  delete rest['basePrice'];
  delete rest['vatListedPrice'];
  return rest as T;
}

let draftKeys = 0;
const nextDraftKey = () => `draft-${++draftKeys}`;

// [REVIEW-F #2141 S4-2] The item or its section was deleted on another phone: the server's "Category with id … not
// found" names an internal id, so the store reads plain words instead. [STORE-WORDS sweep] They follow the store's
// kind (lib/storeKindWords itemGoneWords): "open the menu again" only for a restaurant.

/** [TAP-AUDIT] Why the server would not save the item, in its own words (a banned word, documents not yet checked).
 *  A refusal with no words for a person (the form's shape, a duplicate, a server fault) keeps the editor's own
 *  sentence; a missing item or section says so in plain words. */
export function saveRefusal(error: unknown, vendorType?: string | null): string | null {
  const body = (error as { response?: { data?: { error?: { code?: unknown; message?: unknown } } } } | null)?.response?.data?.error;
  if (body?.code === 'NOT_FOUND') return itemGoneWords(vendorType);
  if (!body || body.code === 'VALIDATION_ERROR' || body.code === 'DUPLICATE' || body.code === 'INTERNAL_ERROR') return null;
  if (typeof body.message !== 'string' || !body.message.trim()) return null;
  return body.message;
}

/**
 * Modifiers editor (master plan §4.2): size / add-ons / toppings on an item.
 * The OptionGroup CRUD already exists server-side — this is its operator UI.
 * Mutations resolve to the created row, so the list updates from the response
 * instead of waiting on the menu query. On a NEW item (no id yet) the groups and
 * choices are a draft the editor sends with the item ([TAP-AUDIT], `staged`).
 *
 * [MENU-OPTIONS · owner 11 Nov 2026] Each group may set the price (Size), be half-and-half (with the store's price
 * rule for a half), and each choice may open one follow-up group of the item (one level). A group shared from the
 * option library shows "Used by N items"; it is edited in the library (every item changes) and Remove takes it off
 * this item only. "Add from option library" attaches a library group.
 */
function ModifiersSection({ item, staged, vatPricing, navigation, onGroupsChange, draftItemPrice = null }: {
  item: any;
  staged?: { groups: DraftOptionGroup[]; set: Dispatch<SetStateAction<DraftOptionGroup[]>> };
  /** [REVIEW-MENU-B S2-1] A new item's price as typed in the form (a size switch on its draft groups starts from it). */
  draftItemPrice?: number | null;
  /** [security review #2256] The store's VAT word from the profile (vatPricingOf): wording and payload agree. */
  vatPricing: { adds: boolean; ratePercent: number } | null;
  navigation?: any;
  /** [MENU-OPTIONS] The item's saved groups as they change (the item's "From" price follows its sizes). */
  onGroupsChange?: (_groups: any[]) => void;
}) {
  const vatAdded = vatPricing?.adds === true;
  const readOnly = !!useVendorPreview((state) => state.previewType);
  const [savedGroups, setGroups] = useState<any[]>(item?.optionGroups ?? []);
  const groups: any[] = staged
    ? staged.groups.map((g) => ({
        id: g.key, name: g.name, isRequired: g.isRequired, maxSelect: g.maxSelect,
        setsPrice: g.setsPrice === true, allowHalves: g.allowHalves === true, halfPricePercent: g.halfPricePercent ?? 100,
        options: g.options.map((o) => ({ id: o.key, name: o.name, additionalPrice: o.additionalPrice })),
      }))
    : savedGroups;
  const addGroup = useAddOptionGroup();
  const delGroup = useDeleteOptionGroup();
  const addOption = useAddOption();
  const delOption = useDeleteOption();
  // [MENU-OPTIONS] The library (shared groups' use counts, "Add from option library") and the option writes.
  const library = useOptionLibrary(!staged && !readOnly);
  const write = useMenuOptionsWrite();
  const [error, setError] = useState<string | null>(null);
  const failed = (e: unknown) => setError(menuOptionsRefusal(e) ?? errorMessage(e, 'That didn’t save. Check your connection and try again.'));

  useEffect(() => {
    if (!staged) onGroupsChange?.(savedGroups);
  }, [savedGroups, staged, onGroupsChange]);

  const [groupName, setGroupName] = useState('');
  const [groupFlags, setGroupFlags] = useState<GroupFlags>(NEW_GROUP_FLAGS);
  const [drafts, setDrafts] = useState<Record<string, { name: string; price: string }>>({});
  const [removeGroupId, setRemoveGroupId] = useState<string | null>(null);
  const [followUpFor, setFollowUpFor] = useState<{ groupId: string; optionId: string; current: string | null } | null>(null);
  const [libraryPick, setLibraryPick] = useState(false);
  // [REVIEW-MENU-B S2-1] A new size group comes with its first size (the server refuses a size group with none).
  const [firstSize, setFirstSize] = useState({ name: '', price: '' });
  // [REVIEW-MENU-B S2-1] "Sets the price" switched on a group with choices: the converted prices, shown to confirm.
  const [sizeSwitch, setSizeSwitch] = useState<{ group: any; turnOn: boolean; typed: Record<string, string>; problem: string | null } | null>(null);
  const draft = (gid: string) => drafts[gid] ?? { name: '', price: '' };
  const sizeTaken = groups.some((g) => g.setsPrice);
  const resetGroupForm = () => { setGroupName(''); setGroupFlags(NEW_GROUP_FLAGS); setFirstSize({ name: '', price: '' }); };

  /** [MENU-OPTIONS] The item's groups as the server now holds them (an attach / a shared group's removal changes
   *  more than one group: the follow-up groups come and go with their opener). */
  const rereadGroups = async () => {
    if (!item?.id) return;
    const r = await vendorApi.categories();
    const fresh = ((r?.data?.data ?? []) as any[]).flatMap((c) => c.items ?? []).find((i: any) => i.id === item.id);
    if (fresh) setGroups(fresh.optionGroups ?? []);
  };
  // Back from the option library (a shared group edited there): the item's copy is read again.
  useEffect(() => {
    if (staged || !navigation?.addListener) return undefined;
    let first = true;
    return navigation.addListener('focus', () => {
      if (first) { first = false; return; }
      rereadGroups().catch(() => undefined);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one listener per editor
  }, []);

  const submitGroup = async () => {
    if (readOnly) return;
    const name = groupName.trim();
    if (!name || addGroup.isPending) return;
    setError(null);
    if (staged) {
      const body = groupFlagsBody(groupFlags);
      staged.set((gs) => [...gs, {
        key: nextDraftKey(), name, isRequired: body.isRequired, maxSelect: body.maxSelect,
        ...(body.setsPrice ? { setsPrice: true } : {}),
        ...(body.allowHalves ? { allowHalves: true, halfPricePercent: body.halfPricePercent } : {}),
        options: [],
      }]);
      resetGroupForm();
      return;
    }
    // [REVIEW-MENU-B S2-1] A size group is created with its first size and that size's full price.
    let sizes: Array<{ name: string; additionalPrice?: number; vatListedAdditionalPrice?: number }> | undefined;
    if (groupFlags.setsPrice) {
      const sizeName = firstSize.name.trim();
      const read = choicePriceInput(firstSize.price, { size: true });
      if (!sizeName) { setError('Add the first size (like Small) with its full price.'); return; }
      if ('problem' in read) { setError(read.problem); return; }
      sizes = [{ name: sizeName, ...newOptionPrice(read.price, vatAdded) }];
    }
    const owner = requireAuthSessionSnapshot();
    let g: any;
    try {
      g = await addGroup.mutateAsync({ itemId: item.id, data: { name, ...groupFlagsBody(groupFlags), ...(sizes ? { options: sizes } : {}) }, authSession: owner });
    } catch (e) {
      failed(e);
      return;
    }
    requireAuthSessionForPrincipal(owner);
    setGroups((gs) => [...gs, { options: [], ...g }]);
    resetGroupForm();
  };

  /** [MENU-OPTIONS] A saved group's size / half-and-half rule, changed at the tap (the server judges the item).
   *  [REVIEW-MENU-B S2-1] Switching "Sets the price" on a group with choices first shows the converted prices (an add-on
   *  becomes a whole price, or back) and sends them with the switch; [S3-2] any other change sends only that rule. */
  const changeFlags = async (g: any, next: Partial<GroupFlags>) => {
    if (readOnly || write.isPending) return;
    setError(null);
    const flags = { ...flagsOf(g), ...next };
    if (needsSizeSwitchConfirm(g, next)) {
      const turnOn = next.setsPrice === true;
      const rows = sizeSwitchRows(g.options ?? [], { turnOn, itemPrice: item ? itemTypedPrice(item) : draftItemPrice });
      setSizeSwitch({ group: g, turnOn, typed: sizeSwitchTyped(rows), problem: null });
      return;
    }
    if (staged) {
      const body = groupFlagsBody(flags);
      staged.set((gs) => gs.map((d) => (d.key === g.id ? {
        ...d, isRequired: body.isRequired, maxSelect: body.maxSelect, setsPrice: body.setsPrice === true,
        allowHalves: body.allowHalves === true, halfPricePercent: body.halfPricePercent ?? 100,
      } : d)));
      return;
    }
    const edit = groupFlagsEdit(g, flags);
    if (Object.keys(edit).length === 0) return;
    const owner = requireAuthSessionSnapshot();
    try {
      const answer = await write.mutateAsync(() => vendorApi.updateOptionGroup(g.id, edit, owner));
      if (answer?.id) setGroups((gs) => gs.map((x) => (x.id === answer.id ? { ...x, ...answer } : x)));
    } catch (e) {
      failed(e);
    }
  };

  /** [REVIEW-MENU-B S2-1] The confirmed switch: the rule and every choice's new price in one request. */
  const confirmSizeSwitch = async () => {
    const ask = sizeSwitch;
    if (!ask || readOnly || write.isPending) return;
    const read = sizeSwitchBody(ask.group.options ?? [], ask.typed, { turnOn: ask.turnOn, halves: ask.group.allowHalves === true });
    if ('problem' in read) { setSizeSwitch({ ...ask, problem: read.problem }); return; }
    const priceOf = new Map(read.body.prices.map((p) => [p.id, p.price]));
    if (staged) {
      staged.set((gs) => gs.map((d) => (d.key === ask.group.id ? {
        ...d, setsPrice: ask.turnOn, isRequired: ask.turnOn ? true : d.isRequired, maxSelect: ask.turnOn ? 1 : d.maxSelect,
        ...(ask.turnOn ? { allowHalves: false } : {}),
        options: d.options.map((o) => ({ ...o, additionalPrice: priceOf.get(o.key) ?? o.additionalPrice })),
      } : d)));
      setSizeSwitch(null);
      return;
    }
    setSizeSwitch(null);
    setError(null);
    const owner = requireAuthSessionSnapshot();
    try {
      const answer = await write.mutateAsync(() => vendorApi.updateOptionGroup(ask.group.id, read.body, owner));
      if (answer?.id) setGroups((gs) => gs.map((x) => (x.id === answer.id ? { ...x, ...answer, options: answer.options ?? x.options } : x)));
    } catch (e) {
      failed(e);
    }
  };

  /** [MENU-OPTIONS] The group a choice opens (null = none). */
  const setFollowUp = async (pick: { groupId: string; optionId: string }, followUpGroupId: string | null) => {
    setFollowUpFor(null);
    if (readOnly || write.isPending) return;
    setError(null);
    try {
      const owner = requireAuthSessionSnapshot();
      const answer = await write.mutateAsync(() => vendorApi.updateOption(pick.optionId, { followUpGroupId }, owner));
      setGroups((gs) => gs.map((g) => (g.id === pick.groupId
        ? { ...g, options: (g.options ?? []).map((o: any) => (o.id === pick.optionId ? { ...o, ...(answer ?? {}), followUpGroupId } : o)) }
        : g)));
    } catch (e) {
      failed(e);
    }
  };

  /** [MENU-OPTIONS] A library group attached to this item. */
  const attachFromLibrary = async (libraryGroupId: string) => {
    setLibraryPick(false);
    if (readOnly || write.isPending || !item?.id) return;
    setError(null);
    try {
      // [REVIEW-MENU-A S4-11] The account and the store the tap was made in.
      const scope = menuWriteScope();
      await write.mutateAsync(() => vendorApi.attachModifierGroup(libraryGroupId, [item.id], scope.session, scope.storeId));
      await rereadGroups();
    } catch (e) {
      failed(e);
    }
  };

  const submitOption = async (groupId: string) => {
    if (readOnly) return;
    const d = draft(groupId);
    const name = d.name.trim();
    if (!name || addOption.isPending || vatPricing == null) return;
    setError(null);
    // [REVIEW-MENU-B S3-3] A typed price is read, never guessed: "1,500" is 1500; a blank or a mistype is refused
    // (never a $0 size), and a size needs its full price.
    const group = groups.find((x) => x.id === groupId);
    const read = choicePriceInput(d.price, { size: group?.setsPrice === true });
    if ('problem' in read) { setError(read.problem); return; }
    if (staged) {
      const additionalPrice = read.price;
      staged.set((gs) => gs.map((g) => (g.key === groupId ? { ...g, options: [...g.options, { key: nextDraftKey(), name, additionalPrice }] } : g)));
      setDrafts((s) => ({ ...s, [groupId]: { name: '', price: '' } }));
      return;
    }
    const owner = requireAuthSessionSnapshot();
    let opt: any;
    try {
      opt = await addOption.mutateAsync({
        groupId,
        data: { name, ...newOptionPrice(read.price, vatAdded) },
        authSession: owner,
      });
    } catch (e) {
      failed(e);
      return;
    }
    requireAuthSessionForPrincipal(owner);
    setGroups((gs) => gs.map((g) => (g.id === groupId ? { ...g, options: [...(g.options ?? []), opt] } : g)));
    setDrafts((s) => ({ ...s, [groupId]: { name: '', price: '' } }));
  };

  // [BUG-GUARDS C2] Each option's x waits for its own delete (a second tap on it is ignored); another option's x goes through.
  const holdRow = useRowHold();
  const removeOption = (groupId: string, optionId: string) => {
    if (readOnly) return;
    if (staged) {
      staged.set((gs) => gs.map((g) => (g.key === groupId ? { ...g, options: g.options.filter((o) => o.key !== optionId) } : g)));
      return;
    }
    const owner = requireAuthSessionSnapshot();
    // [REVIEW-F #2123 S3-1] The option comes off on ITS OWN call's promise: with two options' x in flight, per-call
    // callbacks (mutate/mutateAsync options) reach only the latest call. A sample preview never gets here (readOnly).
    holdRow(optionId, () => delOption.mutateAsync({ id: optionId, authSession: owner }).then(() => {
      try {
        requireAuthSessionForPrincipal(owner);
        setGroups((gs) =>
          gs.map((g) => (g.id === groupId ? { ...g, options: (g.options ?? []).filter((o: any) => o.id !== optionId) } : g)),
        );
      } catch {
        // The editor belongs to an older account and is being unmounted.
      }
    }, () => undefined)); // a failed delete is told by the app's mutation error notice; the row is released for another try
  };

  const removingShared = removeGroupId ? sharedUse(groups.find((g) => g.id === removeGroupId) ?? {}, library.data) : null;
  const addable = libraryGroupsToAdd(library.data, groups);

  return (
    <Card style={{ marginTop: space.lg }}>
      <T variant="heading">Options &amp; add-ons</T>
      <T variant="label" tone="muted" style={{ marginTop: 4 }}>
        Sizes, toppings, extras — customers pick these when ordering.
      </T>
      {staged && groups.length > 0 ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
          Saved with the item when you tap Add item.
        </T>
      ) : null}
      {readOnly ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
          Read-only in the sample preview.
        </T>
      ) : null}
      {error ? (
        <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
          {error}
        </T>
      ) : null}

      {groups.map((g) => {
        const shared = staged ? null : sharedUse(g, library.data);
        const followUp = isFollowUpGroup(groups, g.id);
        const targets = followUpTargets(groups, g.id);
        return (
        <View key={g.id} style={{ marginTop: space.md, borderRadius: radius.lg, backgroundColor: color.surface.subtle, padding: space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <T variant="body" weight="semibold">
                {g.name}
              </T>
              <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                {groupRuleWords(g)}
              </T>
              {shared ? (
                <T variant="caption" weight="semibold" tone="brand" style={{ marginTop: 2 }}>
                  {`Shared · ${usedByWords(shared.usedBy)}`}
                </T>
              ) : null}
              {followUp ? (
                <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                  Follow-up group: shown when its choice is picked.
                </T>
              ) : null}
            </View>
            <Pressable
              disabled={readOnly}
              onPress={() => (staged ? staged.set((gs) => gs.filter((d) => d.key !== g.id)) : setRemoveGroupId(g.id))}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${g.name}`}
            >
              <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
                <Feather name="trash-2" size={18} color={color.text.muted} />
              </View>
            </Pressable>
          </View>

          {shared ? (
            <View style={{ marginTop: space.sm, gap: space.xs }}>
              <T variant="caption" tone="muted">{sharedEditWarning(shared.usedBy)} when you edit it.</T>
              <LinkText label="Edit shared group" disabled={readOnly} onPress={() => navigation?.navigate?.('VendorOptionLibrary', { groupId: shared.libraryGroupId })} />
            </View>
          ) : (
            <GroupRuleChips flags={flagsOf(g)} onChange={(next) => { void changeFlags(g, next); }} sizeTaken={sizeTaken && !g.setsPrice} disabled={readOnly || write.isPending} live={!staged} />
          )}

          {(g.options ?? []).map((o: any) => (
            <View key={o.id} style={{ marginTop: space.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <T variant="label" style={{ flex: 1 }}>
                  {o.name}{o.isAvailable === false ? ' · Sold out' : ''}
                </T>
                <T variant="label" tone="muted" style={{ marginRight: space.md }}>
                  {g.setsPrice ? sizePriceLabel(o, money) : <>{optionPriceLabel(o)}</>}
                </T>
                {shared ? null : (
                  <Pressable disabled={readOnly} onPress={() => removeOption(g.id, o.id)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${o.name}`}>
                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                      <Feather name="x" size={16} color={color.text.muted} />
                    </View>
                  </Pressable>
                )}
              </View>
              {/* [MENU-OPTIONS] The follow-up group this choice opens (a saved item's own group; one level). */}
              {!staged && !shared && (o.followUpGroupId || targets.length > 0) ? (
                <LinkText
                  label={followUpLabel(groups, o.followUpGroupId)}
                  tone={o.followUpGroupId ? 'brand' : 'muted'}
                  disabled={readOnly}
                  onPress={() => setFollowUpFor({ groupId: g.id, optionId: o.id, current: o.followUpGroupId ?? null })}
                />
              ) : shared && o.followUpGroupId ? (
                <T variant="caption" tone="muted">{followUpLabel(groups, o.followUpGroupId)}</T>
              ) : null}
            </View>
          ))}

          {shared ? null : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.sm }}>
            <InlineInput
              style={{ flex: 1 }}
              value={draft(g.id).name}
              onChangeText={(t: string) => setDrafts((s) => ({ ...s, [g.id]: { ...draft(g.id), name: t } }))}
              placeholder="Choice (e.g. Large)"
            />
            {g.setsPrice ? (
              // [MENU-OPTIONS] A size's price is the item's whole price ("Price", not "+").
              <InlineInput
                style={{ width: 96 }}
                value={draft(g.id).price}
                onChangeText={(t: string) => setDrafts((s) => ({ ...s, [g.id]: { ...draft(g.id), price: t } }))}
                placeholder={choicePricePlaceholder(true, vatAdded)}
                keyboardType="number-pad"
              />
            ) : (
              <InlineInput
                style={{ width: 96 }}
                value={draft(g.id).price}
                onChangeText={(t: string) => setDrafts((s) => ({ ...s, [g.id]: { ...draft(g.id), price: t } }))}
                placeholder={vatAdded ? '+GYD before VAT' : '+GYD'}
                keyboardType="number-pad"
              />
            )}
            <Pressable onPress={() => submitOption(g.id)} disabled={readOnly || addOption.isPending}>
              {({ pressed }) => (
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: pressed ? color.brand[600] : color.brand[500],
                  }}
                >
                  <Feather name="plus" size={18} color={color.white} />
                </View>
              )}
            </Pressable>
          </View>
          )}
        </View>
        );
      })}

      <View style={{ marginTop: space.md }}>
        <InlineInput value={groupName} onChangeText={setGroupName} placeholder="New group (e.g. Size, Toppings)" />
        <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
          {!groupFlags.setsPrice ? (
            <>
              <Chip label="Required" selected={groupFlags.required} onPress={() => setGroupFlags((f) => ({ ...f, required: !f.required }))} style={{ height: 38, paddingHorizontal: space.lg }} />
              <Chip label="Multiple picks" selected={groupFlags.multi} onPress={() => setGroupFlags((f) => ({ ...f, multi: !f.multi }))} style={{ height: 38, paddingHorizontal: space.lg }} />
            </>
          ) : null}
        </View>
        <GroupRuleChips flags={groupFlags} onChange={(next) => setGroupFlags((f) => ({ ...f, ...next }))} sizeTaken={sizeTaken} disabled={readOnly} />
        {groupFlags.setsPrice && !staged ? (
          // [REVIEW-MENU-B S2-1] The group's first size and its full price, sent with the group.
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.md }}>
            <InlineInput style={{ flex: 1 }} value={firstSize.name} onChangeText={(t: string) => setFirstSize((f) => ({ ...f, name: t }))} placeholder="First size (e.g. Small)" />
            <InlineInput style={{ width: 110 }} value={firstSize.price} onChangeText={(t: string) => setFirstSize((f) => ({ ...f, price: t }))} placeholder={choicePricePlaceholder(true, vatAdded)} keyboardType="number-pad" />
          </View>
        ) : null}
        <PillButton
          label="Add option group"
          variant="soft"
          size="md"
          style={{ marginTop: space.md }}
          loading={addGroup.isPending}
          disabled={readOnly || !groupName.trim()}
          onPress={submitGroup}
        />
        {/* [MENU-OPTIONS] A group from the store's option library, built once and shared by many items. */}
        {!staged ? (
          <PillButton
            label="Add from option library"
            variant="outline"
            size="md"
            style={{ marginTop: space.sm }}
            loading={write.isPending && libraryPick}
            disabled={readOnly}
            onPress={() => setLibraryPick(true)}
          />
        ) : null}
      </View>

      {/* [REVIEW-MENU-B S2-1] "Sets the price" on a group with choices: every choice's price changes meaning, so the
          store sees (and may correct) the converted prices before anything is saved. */}
      <PopupCard visible={!!sizeSwitch} onClose={() => setSizeSwitch(null)}>
        <PopupTitle variant="title" center>{sizeSwitch?.turnOn ? 'Make these sizes?' : 'Stop setting the price?'}</PopupTitle>
        {sizeSwitch ? (
          <>
            <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
              {sizeSwitchWords(
                sizeSwitchShown(sizeSwitch.group.options ?? [], sizeSwitch.typed),
                { turnOn: sizeSwitch.turnOn },
                money,
              )}
            </T>
            <View style={{ gap: space.sm, marginTop: space.md, alignSelf: 'stretch' }}>
              {(sizeSwitch.group.options ?? []).map((o: any) => (
                <View key={o.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <T variant="label" style={{ flex: 1 }}>{o.name}</T>
                  <InlineInput
                    style={{ width: 120 }}
                    value={sizeSwitch.typed[o.id] ?? ''}
                    onChangeText={(t: string) => setSizeSwitch((a) => (a ? { ...a, typed: { ...a.typed, [o.id]: t }, problem: null } : a))}
                    placeholder={sizeSwitch.turnOn ? choicePricePlaceholder(true, vatAdded) : choicePricePlaceholder(false, vatAdded)}
                    keyboardType="number-pad"
                  />
                </View>
              ))}
            </View>
            {sizeSwitch.problem ? <T variant="caption" tone="error" center style={{ marginTop: space.sm }}>{sizeSwitch.problem}</T> : null}
          </>
        ) : null}
        <PillButton label="Save these prices" style={{ alignSelf: 'stretch', marginTop: space.lg }} loading={write.isPending} disabled={readOnly} onPress={() => { void confirmSizeSwitch(); }} />
        <PillButton label="Cancel" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setSizeSwitch(null)} />
      </PopupCard>

      <PopupCard visible={!!removeGroupId} onClose={() => setRemoveGroupId(null)}>
        <IconChip icon="trash-2" size={56} tone="error" />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          {removingShared ? 'Remove from this item?' : 'Remove group?'}
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {removingShared ? 'The shared group stays in your option library and on the other items that use it.' : 'Delete this option group and all its choices.'}
        </T>
        <PillButton
          label={removingShared ? 'Remove' : 'Delete'}
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          loading={delGroup.isPending}
          onPress={() => {
            if (readOnly || delGroup.isPending) return;
            const gid = removeGroupId!;
            const wasShared = !!removingShared;
            setRemoveGroupId(null);
            const owner = requireAuthSessionSnapshot();
            delGroup.mutate({ id: gid, authSession: owner }, {
              onSuccess: () => {
                try {
                  requireAuthSessionForPrincipal(owner);
                  setGroups((gs) => gs.filter((g) => g.id !== gid));
                  // [MENU-OPTIONS] A shared group leaves with the follow-up groups only it opened.
                  if (wasShared) rereadGroups().catch(() => undefined);
                } catch {
                  // The editor belongs to an older account and is being unmounted.
                }
              },
            });
          }}
        />
        <PillButton label="Cancel" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setRemoveGroupId(null)} />
      </PopupCard>

      {/* [MENU-OPTIONS] Which group a choice opens: another group of this item, one level deep. */}
      <PopupCard visible={!!followUpFor} onClose={() => setFollowUpFor(null)}>
        <PopupTitle variant="title" center>
          Opens follow-up group
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          When a customer picks this choice, the group you pick here opens under it.
        </T>
        {followUpFor ? followUpTargets(groups, followUpFor.groupId).map((t) => (
          <Chip key={t.id} label={t.name} selected={followUpFor.current === t.id} onPress={() => { void setFollowUp(followUpFor, t.id); }} style={{ height: 38, paddingHorizontal: space.md, marginTop: space.sm, alignSelf: 'stretch' }} />
        )) : null}
        <Chip label="Opens nothing" selected={followUpFor?.current == null} onPress={() => { if (followUpFor) void setFollowUp(followUpFor, null); }} style={{ height: 38, paddingHorizontal: space.md, marginTop: space.sm, alignSelf: 'stretch' }} />
        <PillButton label="Cancel" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.lg }} onPress={() => setFollowUpFor(null)} />
      </PopupCard>

      {/* [MENU-OPTIONS] Attach a group from the option library. */}
      <PopupCard visible={libraryPick} onClose={() => setLibraryPick(false)}>
        <PopupTitle variant="title" center>
          Add from option library
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {library.isError
            ? 'Couldn’t load your option library. Check your connection and try again.'
            : addable.length > 0 ? 'A shared group: edit it once in the library and every item that uses it changes.' : 'No other groups in your option library yet.'}
        </T>
        {addable.map((l) => (
          <Chip key={l.id} label={`${l.name} · ${usedByWords(l.usedByItemCount)}`} onPress={() => { void attachFromLibrary(l.id); }} style={{ height: 38, paddingHorizontal: space.md, marginTop: space.sm, alignSelf: 'stretch' }} />
        ))}
        <PillButton label="Open option library" variant="outline" style={{ alignSelf: 'stretch', marginTop: space.lg }} onPress={() => { setLibraryPick(false); afterDismiss(() => navigation?.navigate?.('VendorOptionLibrary')); }} />
        <PillButton label="Cancel" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setLibraryPick(false)} />
      </PopupCard>
    </Card>
  );
}

/** §5.6 reasoned stock movement — the audit-trail path, not a raw overwrite:
 *  ±delta with a reason (received / damaged / manual / reconcile / return). */
function StockAdjustRow({ item }: { item: any }) {
  const readOnly = !!useVendorPreview((state) => state.previewType);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState<'RECEIVED' | 'DAMAGED' | 'MANUAL' | 'RECONCILE' | 'RETURN'>('RECEIVED');
  // [MASTER-025] One key per adjustment as entered: tapping Apply again after a
  // failure cannot move stock twice; changing the entry is a new adjustment.
  const [commandKey, setCommandKey] = useState(() => Crypto.randomUUID());
  const adjust = useVendorMutation({
    mutationKey: MENU_WRITE_KEY,
    mutationFn: () => vendorApi.adjustStock(item.id, { delta: Number(delta), reason }, commandKey),
    onMutate: menuScope,
    onSuccess: (res: any, _vars: void, scope) => {
      setCommandKey(Crypto.randomUUID());
      setOpen(false);
      setDelta('');
      // [TAP-AUDIT] The count the ledger now holds goes into the menu at once; the menu is read again once, later.
      const answer = res?.data?.data;
      const fields = {
        ...(typeof answer?.stockQuantity === 'number' ? { stockQuantity: answer.stockQuantity } : {}),
        ...(typeof answer?.isAvailable === 'boolean' ? { isAvailable: answer.isAvailable } : {}),
      };
      answerIntoMenu(qc, scope, (menu) => menuWithItemFields(menu, item.id, fields));
    },
  });
  const n = Number(delta);
  const valid = delta.trim() !== '' && Number.isInteger(n) && n !== 0;

  if (!open) {
    if (readOnly) {
      return (
        <T variant="caption" tone="muted">
          Stock adjustment is read-only in preview.
        </T>
      );
    }
    return (
      <Pressable onPress={() => setOpen(true)} hitSlop={6}>
        <T variant="caption" weight="semibold" tone="brand">
          Adjust stock (received / damaged)…
        </T>
      </Pressable>
    );
  }
  return (
    <View style={{ gap: space.sm }}>
      <InlineInput value={delta} onChangeText={(v) => { setDelta(v); setCommandKey(Crypto.randomUUID()); }} placeholder="+50 received, -3 damaged" keyboardType="default" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {(['RECEIVED', 'DAMAGED', 'MANUAL', 'RECONCILE', 'RETURN'] as const).map((r) => (
          <Chip key={r} label={r.toLowerCase()} selected={reason === r} onPress={() => { setReason(r); setCommandKey(Crypto.randomUUID()); }} style={{ height: 32, paddingHorizontal: space.md }} />
        ))}
      </View>
      {adjust.isError ? (
        <T variant="caption" tone="error">
          {((adjust.error as any)?.response?.data?.error?.message) ?? 'Adjustment failed.'}
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <PillButton label="Apply" size="sm" style={{ flex: 1 }} loading={adjust.isPending} disabled={readOnly || !valid || adjust.isPending} onPress={() => adjust.mutate()} />
        <PillButton label="Cancel" variant="soft" size="sm" style={{ flex: 1 }} onPress={() => setOpen(false)} />
      </View>
    </View>
  );
}

export function VendorItemEditorScreen({ navigation, route }: any) {
  const readOnly = !!useVendorPreview((state) => state.previewType);
  const existing = route.params?.item;
  const categories: { id: string; name: string }[] = route.params?.categories ?? [];
  const save = useSaveItem();
  const uploadImage = useUploadItemImage();
  const [name, setName] = useState<string>(existing?.name ?? '');
  // [VAT-DOCS] An item Swift adds VAT to is edited by the price the store typed before VAT.
  const [price, setPrice] = useState<string>(editablePrice(existing));
  const [description, setDescription] = useState<string>(existing?.description ?? '');
  const [categoryId, setCategoryId] = useState<string>(existing?.categoryId ?? categories[0]?.id ?? '');
  const [available, setAvailable] = useState<boolean>(existing ? existing.isAvailable !== false : true);
  const [popular, setPopular] = useState<boolean>(!!existing?.isPopular);
  const [sku, setSku] = useState<string>(existing?.sku ?? '');
  const [unit, setUnit] = useState<string>(existing?.unit ?? '');
  // [G2] The load hint dispatch needs to keep a 20 kg rice bag off a bicycle.
  // Three words, never units: the server maps them. An item saved before the
  // field existed reads as normal, which is exactly how it has always behaved.
  const [bulk, setBulk] = useState<'normal' | 'bulky' | 'very_bulky'>(existing?.bulk ?? 'normal');
  const [stock, setStock] = useState<string>(existing?.stockQuantity != null ? String(existing.stockQuantity) : '');
  const [lowStock, setLowStock] = useState<string>(existing?.lowStockThreshold != null ? String(existing.lowStockThreshold) : '');
  const [localPhoto, setLocalPhoto] = useState<{ uri: string; name: string; type: string } | null>(null);
  const [photoErr, setPhotoErr] = useState<string | null>(null);

  // Service businesses configure a bookable appointment instead of stock.
  const { store, myRole } = useVendorProfile();
  const isService = store?.vendorType === 'SERVICE';
  // [STORE-VAT · owner O-5] The owner of a store that told Swift it is VAT-registered gives each item its VAT class.
  // A sample preview has no VAT; a manager does not see it (the business's tax registration is the owner's).
  const samplePreview = useVendorPreview((st) => st.previewType) != null;
  const storeVat = useStoreVat(myRole === 'OWNER' && !samplePreview);
  // [VAT-DOCS · security review #2256] Whether VAT is added to this store's prices: the profile's word, which every role
  // that edits the menu reads (the VAT read above is the owner's). The ONE word for the before-VAT wording and the payload.
  const vatPricing = vatPricingOf(store);
  const vatAdded = vatPricing?.adds === true;
  // [STORE-VAT-EXCLUSIVE] A store pricing before VAT: the price is labelled "before VAT" and sent as typed (nothing is added
  // into it; VAT is its own line at checkout).
  const pricesBeforeVat = vatPricing?.beforeVat === true;
  const vatRate = storeVat.data && storeVat.data.status !== 'NONE' ? storeVat.data.ratePercent : null;
  const vatEffective = storeVat.data?.effective === true;
  const [vatClass, setVatClass] = useState<VatClass>((existing?.vatClass as VatClass | undefined) ?? 'STANDARD');
  const existingBooking = (existing?.bookingConfig ?? {}) as any;
  const [duration, setDuration] = useState<number>(existingBooking.durationMinutes ?? 30);
  // [BOOK-S5a] Hours per day, more than one window a day (a break is the gap between two). Every
  // stored window is kept: the old editor put the first window's times on every day when it saved.
  const [week, setWeek] = useState<WeekHours>(() => weekHoursFromSlots(existingBooking.slots));
  // [BOOK-S5a · owner A4/C2] The gap after each booking, the minimum notice and "Confirm bookings
  // automatically". null = not touched: the opening value follows the server (the switch's word on
  // the profile can arrive after the editor opens).
  const instantAvailable = isService && instantBookingAvailable(store);
  const opening = openingBookingSettings(existing?.bookingConfig ?? null, instantAvailable);
  const [instantTouched, setInstant] = useState<boolean | null>(null);
  const [bufferTouched, setBuffer] = useState<number | null>(null);
  const [noticeTouched, setNotice] = useState<number | null>(null);
  const instant = instantTouched ?? opening.instantBooking;
  const buffer = bufferTouched ?? opening.bufferMinutes;
  const notice = noticeTouched ?? opening.minNoticeMinutes;
  const hoursProblem = isService ? weekHoursProblem(week) : null;
  const setDayWindows = (day: number, update: (windows: WeekHours[number]) => WeekHours[number]) =>
    setWeek((w) => w.map((windows, d) => (d === day ? update(windows) : windows)));
  const [mode, setMode] = useState<'AT_BUSINESS' | 'MOBILE' | 'BOTH'>(existingBooking.serviceMode ?? 'AT_BUSINESS');
  const [radiusKm, setRadiusKm] = useState<string>(existingBooking.serviceRadiusKm != null ? String(existingBooking.serviceRadiusKm) : '5');
  // [OWNER-ASKS · owner ruling 9 Nov 2026] A business that goes to the customer takes the profile photo: asked here, the
  // moment it offers a home visit without one. In-shop listings never ask. The photo is the OWNER's (the server reads
  // the owner's): staff editing a listing are never asked for their own.
  const hasPhoto = useAuthStore((s) => !!s.user?.selfieCapturedAt);
  const askHomeVisitPhoto = myRole === 'OWNER' && !samplePreview && homeVisitPhotoNeeded({ mode, hasPhoto });

  // [UI-SWEEP U67] Typed, unsaved changes are never thrown away silently.
  // Back, a swipe, or a board door to the menu list (navigate + pop) stops on
  // "Discard your changes?"; Discard lets that same navigation through. A
  // change is a difference from how the editor opened (a toggle put back is
  // not one); a saved item, or a read-only preview, leaves without an ask.
  // [TAP-AUDIT] A new item's option groups and choices, sent with it in the one create request.
  const [draftGroups, setDraftGroups] = useState<DraftOptionGroup[]>([]);
  const formNow = JSON.stringify([
    name, price, description, categoryId, available, popular, sku, unit, bulk, stock, lowStock,
    duration, week, instantTouched, bufferTouched, noticeTouched, mode, radiusKm,
    draftGroups.map((g) => [g.name, g.isRequired, g.maxSelect, g.setsPrice, g.allowHalves, g.halfPricePercent, g.options.map((o) => [o.name, o.additionalPrice])]),
  ]);
  const [formAtOpen] = useState(formNow);
  const [leaving, setLeaving] = useState(false);
  const [discardAsk, setDiscardAsk] = useState<{ action: any } | null>(null);
  const unsaved = !readOnly && !leaving && (formNow !== formAtOpen || localPhoto !== null);
  usePreventRemove(unsaved, ({ data }) => setDiscardAsk({ action: data.action }));
  // The ask is lifted (a render) before the saved editor closes itself.
  useEffect(() => {
    if (leaving) navigation.goBack();
  }, [leaving, navigation]);

  // [MENU-OPTIONS · owner 11 Nov 2026] SIZE SETS THE PRICE: an item with a group that sets the price costs its chosen
  // size; its own price is the lowest size, kept so by the server. The field is then read-only ("From $X").
  const [liveGroups, setLiveGroups] = useState<any[]>(existing?.optionGroups ?? []);
  const sizedFrom = isService ? null : lowestSizePrice(existing ? liveGroups : draftGroups.map((g) => ({
    setsPrice: g.setsPrice, options: g.options.map((o) => ({ additionalPrice: o.additionalPrice })),
  })));
  const priceNum = sizedFrom ?? Number(price);
  const valid =
    name.trim().length >= 1 && Number.isFinite(priceNum) && priceNum >= 0 && !!categoryId && (!isService || hoursProblem == null)
    // A new item's price waits for the store's VAT word (it decides whether the price is before VAT).
    && (existing != null || vatPricing != null);
  const busy = save.isPending || uploadImage.isPending;
  // [IMAGES-E2E PR4] Only a photo Swift keeps is drawn (an outside address is not shown to customers either).
  const previewUri = localPhoto?.uri ?? (isKeptPhoto(existing?.imageUrl) ? storePhotoUrl(existing?.imageUrl, HERO_PHOTO_WIDTH) : null) ?? undefined;

  const [photoMenu, setPhotoMenu] = useState(false);

  const applyAsset = (res: ImagePicker.ImagePickerResult) => {
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    setLocalPhoto({ uri: a.uri, name: a.fileName ?? 'item.jpg', type: a.mimeType ?? 'image/jpeg' });
  };

  const pickFromLibrary = async () => {
    setPhotoMenu(false);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      // [G9 · #917's law] A denied permission explains itself. The camera
      // path already did; the library path failed silent — same sentence
      // shape now, Settings named as the way back.
      setPhotoErr('Photo library access needed — allow it in Settings to choose a photo.');
      return;
    }
    setPhotoErr(null);
    applyAsset(await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 }));
  };

  const takePhoto = async () => {
    setPhotoMenu(false);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setPhotoErr('Camera access needed — allow it in Settings to take photos.');
      return;
    }
    setPhotoErr(null);
    applyAsset(await ImagePicker.launchCameraAsync({ quality: 0.8 }));
  };

  const submit = async () => {
    if (readOnly || !valid || busy) return;
    const owner = requireAuthSessionSnapshot();
    const operationStoreId = useStoreSwitcher.getState().selectedStoreId;
    const stockNum = stock.trim() === '' ? undefined : Number(stock);
    const bookingConfig = isService
      ? {
          durationMinutes: duration,
          slots: slotsFromWeekHours(week),
          serviceMode: mode,
          bufferMinutes: buffer,
          minNoticeMinutes: notice,
          // [BOOK-S5a] Sent only while the server says it can be chosen; otherwise the listing keeps what it stores.
          ...(instantAvailable ? { instantBooking: instant } : {}),
          ...(mode !== 'AT_BUSINESS' ? { serviceRadiusKm: Number(radiusKm) || 0 } : {}),
        }
      : undefined;
    const saved: any = await save.mutateAsync({
      id: existing?.id,
      authSession: owner,
      storeId: operationStoreId,
      // [MENU-OPTIONS] A sized item's price is its lowest size, kept by the server: an edit never sends one.
      data: withoutItemPrice(existing != null && sizedFrom != null, {
        categoryId,
        name: name.trim(),
        description: description.trim() || undefined,
        ...itemPricePayload(existing, priceNum, vatAdded),
        isAvailable: available,
        isPopular: popular,
        ...(isService
          ? { fulfillment: 'APPOINTMENT' as const, bookingConfig }
          : {
              sku: sku.trim() || undefined,
              unit: unit.trim() || undefined,
              bulk,
              // [STORE-VAT] Sent only when the owner sees the choice; otherwise the item keeps its class.
              ...(vatRate != null ? { vatClass } : {}),
              // '' clears tracking (null) so a vendor can stop tracking stock.
              stockQuantity: stock.trim() === '' ? null : Number.isFinite(stockNum as number) ? stockNum : undefined,
              lowStockThreshold: lowStock.trim() === '' ? null : Number(lowStock) >= 0 ? Number(lowStock) : undefined,
              // [TAP-AUDIT] A new item's groups and choices travel with it (one request, not one per choice).
              ...(!existing && draftGroups.length > 0 ? { optionGroups: draftOptionGroupsPayload(draftGroups, vatAdded) } : {}),
            }),
      }),
    });
    let current = requireAuthSessionForPrincipal(owner);
    const itemId = existing?.id ?? saved?.id;
    if (localPhoto && itemId) {
      // Item is already saved; a failed photo upload shouldn't block the flow.
      try {
        await uploadImage.mutateAsync({
          id: itemId,
          file: localPhoto,
          authSession: current,
          storeId: operationStoreId,
        });
      } catch (uploadError) {
        if (uploadError instanceof AuthSessionBoundaryError) throw uploadError;
        // [WR-034] The item is durable but the vendor must KNOW the photo
        // didn't make it — a silent miss ships a photo-less listing.
        toast.show("Item saved, but the photo didn't upload — open the item and add it again.");
      }
      current = requireAuthSessionForPrincipal(owner);
    }
    requireAuthSessionForPrincipal(current);
    setLeaving(true);
  };

  return (
    <Screen>
      <SubHeader title={existing ? 'Edit Item' : 'New Item'} navigation={navigation} />
      {/* [KEYBOARD 10 Nov] Lifted above the keyboard (kit/keyboard-avoider), so the last fields can scroll into view. */}
      <KeyboardAvoider style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
          {/* Photo — the kit's PhotoDrop when the slot is empty (WS-2: a dashed
              CONTROL inviting the one person who can fix it, never a grey state);
              the pressable preview once a photograph exists. First adoption of
              the primitive — the hand-rolled twin retires. */}
          {previewUri ? (
            <Pressable disabled={readOnly} onPress={() => setPhotoMenu(true)}>
              {({ pressed }) => (
                <View
                  style={{
                    height: 160,
                    borderRadius: radius.lg,
                    overflow: 'hidden',
                    marginBottom: space.sm,
                    opacity: pressed ? 0.85 : 1,
                  }}
                >
                  <Image source={{ uri: previewUri }} style={{ width: '100%', height: 160 }} contentFit="cover" />
                </View>
              )}
            </Pressable>
          ) : (
            <PhotoDrop
              onPress={() => setPhotoMenu(true)}
              disabled={readOnly}
              uploading={uploadImage.isPending}
              hint="Bright and straight-on — customers choose with their eyes"
              style={{ marginBottom: space.sm }}
            />
          )}
          {previewUri ? (
            <View style={{ alignItems: 'center', marginBottom: space.lg }}>
              {readOnly ? (
                <T variant="caption" tone="muted">Read-only sample photo</T>
              ) : (
                <LinkText label={uploadImage.isPending ? 'Uploading…' : 'Change photo'} onPress={() => setPhotoMenu(true)} />
              )}
            </View>
          ) : null}
          {photoErr ? (
            <T variant="caption" tone="error" center style={{ marginBottom: space.md }}>
              {photoErr}
            </T>
          ) : null}

          <View style={{ gap: space.md }}>
            <LabeledInput value={name} onChangeText={setName} placeholder="Item name" />
            {sizedFrom != null ? (
              // [MENU-OPTIONS] The item's price follows its sizes (read-only).
              <View testID="item-from-price">
                <T variant="body" weight="semibold">{fromPriceWords(sizedFrom, money)}</T>
                <T variant="caption" tone="muted" style={{ marginTop: 2 }}>Set by the choices of the group that sets the price.</T>
              </View>
            ) : (
              <LabeledInput value={price} onChangeText={setPrice} placeholder={beforeVatNote(existing) || (!existing && vatAdded) || pricesBeforeVat ? 'Price before VAT (GYD)' : 'Price (GYD)'} keyboardType="decimal-pad" />
            )}
            {/* [VAT-DOCS] What customers pay for an item Swift adds VAT to (the saved price, from the server). */}
            {beforeVatNote(existing) ? <T variant="caption" tone="muted" testID="item-before-vat-note">{beforeVatNote(existing)}</T> : null}
            {!existing && vatPricing?.adds ? (
              <T variant="caption" tone="muted" testID="item-new-before-vat-hint">{newItemBeforeVatHint(vatPricing.ratePercent)}</T>
            ) : null}
            {pricesBeforeVat && vatPricing ? (
              <T variant="caption" tone="muted" testID="item-before-vat-at-checkout-hint">{beforeVatAtCheckoutHint(vatPricing.ratePercent)}</T>
            ) : null}
            <InlineInput value={description} onChangeText={setDescription} placeholder="Description (optional)" multiline />
          </View>

          {isService ? (
            <Card style={{ marginTop: space.lg }}>
              <T variant="heading" style={{ marginBottom: space.md }}>
                Appointment booking
              </T>

              <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
                Appointment length
              </T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg }}>
                {[15, 30, 45, 60, 90, 120].map((m) => (
                  <Chip key={m} label={`${m} min`} selected={duration === m} onPress={() => setDuration(m)} style={{ height: 36, paddingHorizontal: space.md }} />
                ))}
              </View>

              {/* [BOOK-S5a] Hours per day. A day with no hours is closed; a break is the gap between two windows. */}
              <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
                Hours each day
              </T>
              <View style={{ gap: space.sm, marginBottom: space.lg }}>
                {DAY_LABELS.map((label, d) => {
                  const windows = week[d] ?? [];
                  const open = windows.length > 0;
                  return (
                    <View key={label} style={{ gap: space.xs }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                        <Chip
                          label={open ? label : `${label} · closed`}
                          selected={open}
                          onPress={() => setDayWindows(d, (w) => (w.length > 0 ? [] : [nextWindow([])]))}
                          style={{ height: 36, paddingHorizontal: space.md, minWidth: 64 }}
                        />
                        {open ? (
                          <LinkText label="Add hours" onPress={() => setDayWindows(d, (w) => [...w, nextWindow(w)])} />
                        ) : null}
                      </View>
                      {windows.map((w, i) => (
                        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                          <InlineInput
                            style={{ flex: 1 }}
                            value={w.start}
                            onChangeText={(t) => setDayWindows(d, (ws) => ws.map((x, j) => (j === i ? { ...x, start: t } : x)))}
                            placeholder="09:00"
                            center
                          />
                          <T variant="label" tone="muted">to</T>
                          <InlineInput
                            style={{ flex: 1 }}
                            value={w.end}
                            onChangeText={(t) => setDayWindows(d, (ws) => ws.map((x, j) => (j === i ? { ...x, end: t } : x)))}
                            placeholder="17:00"
                            center
                          />
                          <Pressable
                            onPress={() => setDayWindows(d, (ws) => ws.filter((_, j) => j !== i))}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={`Remove ${label} ${w.start}–${w.end}`}
                          >
                            <Feather name="x" size={18} color={color.text.muted} />
                          </Pressable>
                        </View>
                      ))}
                    </View>
                  );
                })}
                {hoursProblem ? (
                  <T variant="caption" tone="error">{hoursProblem}</T>
                ) : null}
              </View>

              <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
                Gap after each booking
              </T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg }}>
                {choicesWith(BUFFER_CHOICES, buffer).map((m) => (
                  <Chip key={m} label={minutesLabel(m)} selected={buffer === m} onPress={() => setBuffer(m)} style={{ height: 36, paddingHorizontal: space.md }} />
                ))}
              </View>

              <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.xs }}>
                Minimum notice
              </T>
              <T variant="caption" tone="muted" style={{ marginBottom: space.sm }}>
                How close to its start a customer can still book a time.
              </T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg }}>
                {choicesWith(NOTICE_CHOICES, notice).map((m) => (
                  <Chip key={m} label={minutesLabel(m)} selected={notice === m} onPress={() => setNotice(m)} style={{ height: 36, paddingHorizontal: space.md }} />
                ))}
              </View>

              {/* [BOOK-S5a · owner A3/A4] Shown only while the server says it can be chosen. */}
              {instantAvailable ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.lg }}>
                  <View style={{ flex: 1 }}>
                    <T variant="label" weight="semibold">Confirm bookings automatically</T>
                    <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                      {instant
                        ? 'Bookings paid in cash at the appointment are confirmed as soon as the customer books. MMG bookings still wait for you to accept.'
                        : 'Every booking waits for you to accept it.'}
                    </T>
                  </View>
                  <BrandSwitch value={instant} onChange={setInstant} label="Confirm bookings automatically" />
                </View>
              ) : null}

              <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
                Where does it happen?
              </T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.md }}>
                <Chip label="At my place" selected={mode === 'AT_BUSINESS'} onPress={() => setMode('AT_BUSINESS')} style={{ height: 38, paddingHorizontal: space.md }} />
                <Chip label="I travel to them" selected={mode === 'MOBILE'} onPress={() => setMode('MOBILE')} style={{ height: 38, paddingHorizontal: space.md }} />
                <Chip label="Both" selected={mode === 'BOTH'} onPress={() => setMode('BOTH')} style={{ height: 38, paddingHorizontal: space.md }} />
              </View>

              {askHomeVisitPhoto ? <HomeVisitPhotoCard /> : null}

              {mode !== 'AT_BUSINESS' ? (
                <View>
                  <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
                    How far will you travel from your store? (km)
                  </T>
                  <InlineInput value={radiusKm} onChangeText={setRadiusKm} placeholder="5" keyboardType="number-pad" />
                </View>
              ) : null}
            </Card>
          ) : (
            <>
              {/* Inventory — used by groceries/shops; optional for restaurants */}
              <T variant="label" weight="semibold" tone="muted" style={{ marginTop: space.lg, marginBottom: space.sm }}>
                Inventory (optional)
              </T>
              <View style={{ gap: space.md }}>
                <View style={{ flexDirection: 'row', gap: space.md }}>
                  <InlineInput style={{ flex: 1 }} value={stock} onChangeText={setStock} placeholder="Stock qty" keyboardType="number-pad" />
                  <InlineInput style={{ flex: 1 }} value={unit} onChangeText={setUnit} placeholder="Unit (kg, ea)" />
                </View>
                {/* How big is one of these to carry? An order holding a bulky or very bulky
                    item is never offered to a bicycle (lib/bulkWords; the server's utils/load).
                    A choice, not a number — nobody should be asked to think in units. */}
                <View>
                  <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
                    How bulky is one of these to carry?
                  </T>
                  <Segmented
                    options={[
                      { key: 'normal', label: 'Normal' },
                      { key: 'bulky', label: 'Bulky' },
                      { key: 'very_bulky', label: 'Very bulky' },
                    ] as const}
                    value={bulk}
                    onChange={setBulk}
                  />
                  <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                    {BULK_WORDS[bulk]}
                  </T>
                </View>
                {vatRate != null ? (
                  <View>
                    <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
                      VAT on this item
                    </T>
                    <Segmented
                      options={vatClassChoices(vatRate, vatEffective, pricesBeforeVat).map((c) => ({ key: c.value, label: c.value === 'STANDARD' ? 'Standard' : c.value === 'ZERO_RATED' ? 'Zero-rated' : 'Exempt' }))}
                      value={vatClass}
                      onChange={(k) => setVatClass(k as VatClass)}
                    />
                    <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                      {vatClassChoices(vatRate, vatEffective, pricesBeforeVat).find((c) => c.value === vatClass)?.label}. You choose each item’s VAT class and
                      are responsible for it; check with the GRA.
                    </T>
                  </View>
                ) : null}
                <InlineInput value={sku} onChangeText={setSku} placeholder="SKU / barcode (optional)" />
                <InlineInput value={lowStock} onChangeText={setLowStock} placeholder="Low-stock alert at (e.g. 5)" keyboardType="number-pad" />
                {stock.trim() !== '' ? (
                  <T variant="caption" tone="muted">
                    Tracked items sell down automatically and hide at 0. You’ll get an alert at your low-stock level.
                  </T>
                ) : (
                  // [IN-STORE-SALE] Why the menu list shows no "Sold in store −1" for this item.
                  <T variant="caption" tone="muted">
                    {SOLD_IN_STORE.untracked}
                  </T>
                )}
                {/* Reasoned movements (received/damaged/…) keep an audit trail —
                    different from overwriting the number above. */}
                {existing && existing.stockQuantity != null ? (
                  <StockAdjustRow item={existing} />
                ) : null}
              </View>
            </>
          )}

          {existing && !isService ? (
            <ModifiersSection item={existing} vatPricing={vatPricing} navigation={navigation} onGroupsChange={setLiveGroups} />
          ) : !isService ? (
            <ModifiersSection item={null} staged={{ groups: draftGroups, set: setDraftGroups }} vatPricing={vatPricing} navigation={navigation} draftItemPrice={parseStorePrice(price)} />
          ) : null}

          <T variant="label" weight="semibold" tone="muted" style={{ marginTop: space.lg, marginBottom: space.sm }}>
            Category
          </T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg }}>
            {categories.map((c) => (
              <Chip key={c.id} label={c.name} selected={c.id === categoryId} onPress={() => setCategoryId(c.id)} style={{ height: 38, paddingHorizontal: space.md }} />
            ))}
          </View>

          <View style={{ flexDirection: 'row', gap: space.md, marginBottom: space.lg }}>
            <Chip label={available ? 'Available' : 'Sold out'} selected={available} onPress={() => setAvailable((v) => !v)} style={{ height: 38, paddingHorizontal: space.md }} />
            <Chip label={`★ ${STORE_PICK}`} selected={popular} onPress={() => setPopular((v) => !v)} style={{ height: 38, paddingHorizontal: space.md }} />
          </View>

          {save.isError ? (
            <T variant="label" tone="error" style={{ marginBottom: space.md }}>
              {saveRefusal(save.error, store?.vendorType) ?? "Couldn't save. Check the details and try again."}
            </T>
          ) : null}
          {/* [#947's grammar] A disabled button says WHY — the first unmet
              requirement, in the vendor's own order of work. */}
          <PillButton
            label={
              readOnly
                ? 'Read-only preview'
                : !existing && vatPricing == null
                  ? 'Loading the store’s prices…'
                : !name.trim()
                  ? 'Name the item first'
                  : !(Number.isFinite(priceNum) && priceNum >= 0)
                    ? 'Set a price'
                    : !categoryId
                      ? 'Pick a category'
                      : isService && hoursProblem
                        ? 'Fix the hours'
                        : existing
                          ? 'Save changes'
                          : 'Add item'
            }
            loading={busy}
            disabled={readOnly || !valid}
            onPress={submit}
          />
        </ScrollView>
      </KeyboardAvoider>

      {/* Photo source picker — kit popup */}
      <PopupCard visible={photoMenu} onClose={() => setPhotoMenu(false)}>
        <IconChip icon="camera" size={56} />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Item photo
        </PopupTitle>
        <PillButton label="Take photo" style={{ alignSelf: 'stretch', marginTop: space['2xl'] }} onPress={takePhoto} />
        <PillButton label="Choose from library" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={pickFromLibrary} />
        {localPhoto ? (
          <PillButton
            label="Remove selected photo"
            variant="outline"
            style={{ alignSelf: 'stretch', marginTop: space.md }}
            onPress={() => {
              setLocalPhoto(null);
              setPhotoMenu(false);
            }}
          />
        ) : null}
      </PopupCard>

      {/* [UI-SWEEP U67] The ask before typed changes are thrown away. */}
      <ConfirmDialog
        open={discardAsk !== null}
        title="Discard your changes?"
        body="What you changed on this item is not saved."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => {
          const ask = discardAsk;
          setDiscardAsk(null);
          if (ask) afterDismiss(() => navigation.dispatch(ask.action));
        }}
        onClose={() => setDiscardAsk(null)}
      />
    </Screen>
  );
}
