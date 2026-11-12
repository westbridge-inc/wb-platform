/** @jsxImportSource react */
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { Feather } from '@expo/vector-icons';
import { Card, Chip, ConfirmDialog, Header, LinkText, PillButton, PopupCard, PopupTitle, Screen, T } from '../../../kit';
import { toast } from '../../../kit/toast';
import { GUTTER, InlineInput } from '../shared';
import { GroupRuleChips, NEW_GROUP_FLAGS } from '../GroupRuleChips';
import { vendorApi } from '../../../services/api';
import { useVendorMenu, useVendorProfile } from '../../../hooks/vendorops';
import { menuWriteScope, useMenuOptionsWrite, useOptionLibrary, type LibraryGroup, type LibraryOption, type MenuWriteScope } from '../../../hooks/menuOptions';
import { useVendorPreview } from '../../../stores/vendorPreview';
import { vatPricingOf } from '../../../lib/storeVat';
import { errorMessage } from '../../../lib/apiError';
import { money } from '../../../lib/money';
import {
  attachPlan, choicePriceInput, choicePricePlaceholder, flagsOf, followUpLabel, followUpTargets, groupFlagsBody, groupFlagsEdit,
  groupRuleWords, libraryBasePrice, libraryChoiceDeleteWords, libraryDeleteWords, menuOptionsRefusal, moved, needsSizeSwitchConfirm,
  sharedEditWarning, sizePriceLabel, sizeSwitchBody, sizeSwitchRows, sizeSwitchShown, sizeSwitchTyped, sizeSwitchWords, usedByWords, type GroupFlags,
} from '../../../lib/menuOptionsEditor';

/**
 * [MENU-OPTIONS · owner 11 Nov 2026] The option library: a group built once (Pizza size, Crust, Toppings) and attached
 * to many items; editing it changes every item that uses it. The list (in the store's order, each with how many items
 * use it), a group's editor (its rules, its choices with price, sold out, the follow-up group a choice opens and the
 * kitchen code), the items it is on (attach / detach many at once) and delete ("removed from N items").
 * Every write is the server's to judge (MENU_OPTIONS_RULE / its own words, shown here).
 */

const optionPrice = (g: { setsPrice?: boolean }, o: LibraryOption, vatAdded: boolean) => {
  const before = vatAdded ? ' before VAT' : '';
  if (g.setsPrice) return `${sizePriceLabel(o, money)}${before}`;
  return o.price > 0 ? `+${money(o.price)}${before}` : 'Free';
};

export function VendorOptionLibraryScreen({ navigation, route }: any) {
  const readOnly = !!useVendorPreview((state) => state.previewType);
  const library = useOptionLibrary();
  const groups = library.data ?? [];
  const write = useMenuOptionsWrite();
  const [error, setError] = useState<string | null>(null);
  // The group open in the editor: an id, 'new', or none (the list). Opened from an item's shared group: that group.
  const [editing, setEditing] = useState<string | null>(route?.params?.groupId ?? null);
  const openedFromItem = route?.params?.groupId != null;
  const failed = (e: unknown) => setError(menuOptionsRefusal(e) ?? errorMessage(e, 'That didn’t save. Check your connection and try again.'));

  const reorder = async (index: number, step: -1 | 1) => {
    if (readOnly) return;
    const ids = moved(groups.map((g) => g.id), index, step);
    setError(null);
    try {
      const scope = menuWriteScope();
      await write.mutateAsync(() => vendorApi.orderModifierGroups(ids, scope.session, scope.storeId));
    } catch (e) {
      failed(e);
    }
  };

  const back = () => {
    if (editing && !openedFromItem) { setEditing(null); setError(null); return; }
    navigation.goBack();
  };
  const current = editing && editing !== 'new' ? groups.find((g) => g.id === editing) ?? null : null;

  return (
    <Screen>
      <Header title={editing === 'new' ? 'New shared group' : current ? current.name : 'Option library'} onBack={back} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        {error ? <T variant="caption" tone="error" style={{ marginBottom: space.md }}>{error}</T> : null}
        {editing ? (
          editing === 'new' || current ? (
            <LibraryGroupEditor
              key={editing}
              group={current}
              groups={groups}
              readOnly={readOnly}
              onCreated={(id) => setEditing(id)}
              onDeleted={() => (openedFromItem ? navigation.goBack() : setEditing(null))}
              onError={failed}
              clearError={() => setError(null)}
            />
          ) : (
            <T variant="body" tone="muted">{library.isLoading || library.isFetching ? 'Loading…' : 'This group is no longer in your option library.'}</T>
          )
        ) : (
          <>
            <T variant="body" tone="muted" style={{ marginBottom: space.md }}>
              Build a group once — like Pizza size, Crust or Toppings — and add it to many items. When you edit it, every item that uses it changes.
            </T>
            <PillButton label="New shared group" icon="plus" size="md" disabled={readOnly} onPress={() => { setError(null); setEditing('new'); }} />
            {library.isError ? (
              <T variant="caption" tone="error" style={{ marginTop: space.md }}>Couldn’t load your option library. Check your connection and try again.</T>
            ) : library.isLoading ? (
              <T variant="caption" tone="muted" style={{ marginTop: space.md }}>Loading…</T>
            ) : groups.length === 0 ? (
              <T variant="caption" tone="muted" style={{ marginTop: space.md }}>No shared groups yet.</T>
            ) : null}
            {groups.map((g, i) => (
              <Card key={g.id} style={{ marginTop: space.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <Pressable style={{ flex: 1 }} onPress={() => { setError(null); setEditing(g.id); }} accessibilityRole="button" accessibilityLabel={`Edit ${g.name}`}>
                    <T variant="body" weight="semibold">{g.name}</T>
                    <T variant="caption" tone="muted" style={{ marginTop: 2 }}>{groupRuleWords(g)}</T>
                    <T variant="caption" weight="semibold" tone="brand" style={{ marginTop: 2 }}>
                      {usedByWords(g.usedByItemCount)}{g.isFollowUp ? ' · Follow-up group' : ''} · {g.options.length} choice{g.options.length === 1 ? '' : 's'}
                    </T>
                  </Pressable>
                  <Pressable disabled={readOnly || i === 0 || write.isPending} onPress={() => { void reorder(i, -1); }} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Move ${g.name} up`}>
                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center', opacity: i === 0 ? 0.3 : 1 }}>
                      <Feather name="chevron-up" size={18} color={color.text.muted} />
                    </View>
                  </Pressable>
                  <Pressable disabled={readOnly || i === groups.length - 1 || write.isPending} onPress={() => { void reorder(i, 1); }} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Move ${g.name} down`}>
                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center', opacity: i === groups.length - 1 ? 0.3 : 1 }}>
                      <Feather name="chevron-down" size={18} color={color.text.muted} />
                    </View>
                  </Pressable>
                </View>
              </Card>
            ))}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

/** One shared group: its rules, its choices, the items it is on, and delete. A new group (null) is created first. */
function LibraryGroupEditor({ group, groups, readOnly, onCreated, onDeleted, onError, clearError }: {
  group: LibraryGroup | null;
  groups: LibraryGroup[];
  readOnly: boolean;
  onCreated: (_id: string) => void;
  onDeleted: () => void;
  onError: (_e: unknown) => void;
  clearError: () => void;
}) {
  const write = useMenuOptionsWrite();
  const { store } = useVendorProfile();
  const vatAdded = vatPricingOf(store)?.adds === true;
  const [name, setName] = useState(group?.name ?? '');
  const [flags, setFlags] = useState<GroupFlags>(group ? flagsOf(group) : NEW_GROUP_FLAGS);
  const [choice, setChoice] = useState({ name: '', price: '', code: '' });
  const [editOption, setEditOption] = useState<{ id: string; name: string; price: string; code: string } | null>(null);
  const [followUpFor, setFollowUpFor] = useState<LibraryOption | null>(null);
  const [pickItems, setPickItems] = useState<string[] | null>(null);
  const [deleteAsk, setDeleteAsk] = useState(false);
  // [REVIEW-MENU-B S3-4] A shared choice is removed from every item that uses the group: asked first.
  const [deleteChoice, setDeleteChoice] = useState<LibraryOption | null>(null);
  // [REVIEW-MENU-B S2-1] "Sets the price" switched on a group with choices: the new prices, shown to confirm.
  const [sizeSwitch, setSizeSwitch] = useState<{ turnOn: boolean; typed: Record<string, string>; problem: string | null } | null>(null);
  const usedBy = group?.usedByItemCount ?? 0;
  const savedFlags = group ? flagsOf(group) : null;
  const changed = !group || name.trim() !== group.name || JSON.stringify(flags) !== JSON.stringify(savedFlags);
  const sizeTaken = false; // a library group may set the price; an item with two is refused at attach (server words)
  const send = async (call: (_scope: MenuWriteScope) => Promise<any>): Promise<any> => {
    if (readOnly || write.isPending) return undefined;
    clearError();
    try {
      // [REVIEW-MENU-A S4-11] Each write is pinned to the account that made it and the store it was made in.
      const scope = menuWriteScope();
      return await write.mutateAsync(() => call(scope));
    } catch (e) {
      onError(e);
      return undefined;
    }
  };

  // The store's items: "Choose items", and their prices for a size switch (read when a saved group opens, so they are
  // there by the time the store saves; a price still unknown is left blank for the store to type).
  const menu = useVendorMenu(group != null);

  const saveGroup = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (!group) {
      const created = await send((s) => vendorApi.createModifierGroup({ name: trimmed, ...groupFlagsBody(flags) }, s.session, s.storeId));
      if (created?.id) onCreated(created.id);
      return;
    }
    // [REVIEW-MENU-B S2-1] Switching "Sets the price" with choices: the converted prices are confirmed first.
    if (needsSizeSwitchConfirm(group, { setsPrice: flags.setsPrice })) {
      const users = ((menu.data ?? []) as any[]).flatMap((c) => c.items ?? []).filter((i: any) => group.usedByItems.some((u) => u.id === i.id));
      const rows = sizeSwitchRows(group.options, { turnOn: flags.setsPrice, itemPrice: libraryBasePrice(users) });
      setSizeSwitch({ turnOn: flags.setsPrice, typed: sizeSwitchTyped(rows), problem: null });
      return;
    }
    // [REVIEW-MENU-B S3-2] Only what changed: the group's own limits are not rewritten by a rule chip.
    const edit = { ...(trimmed !== group.name ? { name: trimmed } : {}), ...groupFlagsEdit(group, flags) };
    if (Object.keys(edit).length === 0) return;
    await send((s) => vendorApi.updateModifierGroup(group.id, edit, s.session, s.storeId));
  };

  const switchUsers = sizeSwitch && group ? ((menu.data ?? []) as any[]).flatMap((c) => c.items ?? []).filter((i: any) => group.usedByItems.some((u) => u.id === i.id)) : [];
  const confirmSizeSwitch = async () => {
    if (!group || !sizeSwitch) return;
    const read = sizeSwitchBody(group.options, sizeSwitch.typed, { turnOn: sizeSwitch.turnOn });
    if ('problem' in read) { setSizeSwitch({ ...sizeSwitch, problem: read.problem }); return; }
    setSizeSwitch(null);
    const trimmed = name.trim();
    const edit = { ...(trimmed && trimmed !== group.name ? { name: trimmed } : {}), ...groupFlagsEdit(group, flags), ...read.body };
    await send((s) => vendorApi.updateModifierGroup(group.id, edit, s.session, s.storeId));
  };

  const addChoice = async () => {
    if (!group || !choice.name.trim()) return;
    // [REVIEW-MENU-B S3-3] A typed price is read, never guessed (a size needs its full price).
    const read = choicePriceInput(choice.price, { size: group.setsPrice });
    if ('problem' in read) { onError({ code: 'MENU_OPTIONS_RULE', message: read.problem }); return; }
    const answer = await send((s) => vendorApi.addModifierOption(group.id, {
      name: choice.name.trim(), price: read.price, ...(choice.code.trim() ? { externalCode: choice.code.trim() } : {}),
    }, s.session, s.storeId));
    if (answer) setChoice({ name: '', price: '', code: '' });
  };

  const allItems: Array<{ id: string; name: string }> = ((menu.data ?? []) as any[]).flatMap((c) => c.items ?? []).filter((i: any) => i.fulfillment !== 'APPOINTMENT');
  const saveItems = async () => {
    if (!group || !pickItems) return;
    const plan = attachPlan(group.usedByItems.map((i) => i.id), pickItems);
    setPickItems(null);
    if (plan.attach.length) await send((s) => vendorApi.attachModifierGroup(group.id, plan.attach, s.session, s.storeId));
    if (plan.detach.length) await send((s) => vendorApi.detachModifierGroup(group.id, plan.detach, s.session, s.storeId));
  };

  return (
    <View>
      {group && usedBy > 0 ? (
        <Card style={{ marginBottom: space.md, backgroundColor: color.surface.subtle }}>
          <T variant="label" weight="semibold">{sharedEditWarning(usedBy)}</T>
          <T variant="caption" tone="muted" style={{ marginTop: 2 }}>Every item that uses this group changes when you save.</T>
        </Card>
      ) : null}

      <Card>
        <InlineInput value={name} onChangeText={setName} placeholder="Group name (e.g. Pizza size, Toppings)" />
        {!flags.setsPrice ? (
          <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
            <Chip label="Required" selected={flags.required} onPress={readOnly ? undefined : () => setFlags((f) => ({ ...f, required: !f.required }))} style={{ height: 38, paddingHorizontal: space.lg }} />
            <Chip label="Multiple picks" selected={flags.multi} onPress={readOnly ? undefined : () => setFlags((f) => ({ ...f, multi: !f.multi }))} style={{ height: 38, paddingHorizontal: space.lg }} />
          </View>
        ) : null}
        <GroupRuleChips flags={flags} onChange={(next) => setFlags((f) => ({ ...f, ...next }))} sizeTaken={sizeTaken} disabled={readOnly} />
        <PillButton
          label={group ? 'Save group' : 'Create group'}
          size="md"
          style={{ marginTop: space.md }}
          loading={write.isPending}
          disabled={readOnly || !name.trim() || !changed}
          onPress={() => { void saveGroup(); }}
        />
      </Card>

      {group ? (
        <>
          <Card style={{ marginTop: space.lg }}>
            <T variant="heading">Choices</T>
            {group.options.length === 0 ? <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>Add the first choice below.</T> : null}
            {group.options.map((o) => (
              <View key={o.id} style={{ marginTop: space.md, borderRadius: radius.lg, backgroundColor: color.surface.subtle, padding: space.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <View style={{ flex: 1 }}>
                    <T variant="label" weight="semibold">{o.name}</T>
                    <T variant="caption" tone="muted">{optionPrice(group, o, vatAdded)}{o.externalCode ? ` · Kitchen code ${o.externalCode}` : ''}</T>
                  </View>
                  <Chip label={o.isAvailable ? 'Available' : 'Sold out'} selected={o.isAvailable}
                    onPress={readOnly ? undefined : () => { void send((s) => vendorApi.updateModifierOption(o.id, { isAvailable: !o.isAvailable }, s.session, s.storeId)); }}
                    style={{ height: 32, paddingHorizontal: space.md }} />
                  <Pressable disabled={readOnly} onPress={() => setDeleteChoice(o)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${o.name}`}>
                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                      <Feather name="x" size={16} color={color.text.muted} />
                    </View>
                  </Pressable>
                </View>
                <View style={{ flexDirection: 'row', gap: space.lg, marginTop: space.xs }}>
                  <LinkText label="Edit" disabled={readOnly} onPress={() => setEditOption({ id: o.id, name: o.name, price: String(o.price), code: o.externalCode ?? '' })} />
                  {o.followUpGroupId || followUpTargets(groups, group.id).length > 0 ? (
                    <LinkText label={followUpLabel(groups, o.followUpGroupId)} tone={o.followUpGroupId ? 'brand' : 'muted'} disabled={readOnly} onPress={() => setFollowUpFor(o)} />
                  ) : null}
                </View>
              </View>
            ))}
            <View style={{ marginTop: space.md, gap: space.sm }}>
              <View style={{ flexDirection: 'row', gap: space.md }}>
                <InlineInput style={{ flex: 1 }} value={choice.name} onChangeText={(t) => setChoice((c) => ({ ...c, name: t }))} placeholder="Choice (e.g. Large)" />
                <InlineInput style={{ width: 110 }} value={choice.price} onChangeText={(t) => setChoice((c) => ({ ...c, price: t }))} placeholder={choicePricePlaceholder(flags.setsPrice, vatAdded)} keyboardType="number-pad" />
              </View>
              <InlineInput value={choice.code} onChangeText={(t) => setChoice((c) => ({ ...c, code: t }))} placeholder="Kitchen code (optional)" />
              <PillButton label="Add choice" variant="soft" size="md" disabled={readOnly || !choice.name.trim() || write.isPending} onPress={() => { void addChoice(); }} />
            </View>
          </Card>

          <Card style={{ marginTop: space.lg }}>
            <T variant="heading">Items using it</T>
            <T variant="caption" tone="muted" style={{ marginTop: 2 }}>{usedByWords(usedBy)}</T>
            {group.usedByItems.map((i) => (
              <T key={i.id} variant="label" style={{ marginTop: space.xs }}>{i.name}</T>
            ))}
            <PillButton label="Choose items" variant="outline" size="md" style={{ marginTop: space.md }} disabled={readOnly} onPress={() => setPickItems(group.usedByItems.map((i) => i.id))} />
          </Card>

          <PillButton label="Delete group" variant="outline" size="md" style={{ marginTop: space.lg }} disabled={readOnly} onPress={() => setDeleteAsk(true)} />
        </>
      ) : (
        <T variant="caption" tone="muted" style={{ marginTop: space.md }}>Create the group, then add its choices and the items that use it.</T>
      )}

      {/* A choice's name, price and kitchen code. */}
      <PopupCard visible={!!editOption} onClose={() => setEditOption(null)}>
        <PopupTitle variant="title" center>Edit choice</PopupTitle>
        {editOption ? (
          <View style={{ gap: space.sm, marginTop: space.md, alignSelf: 'stretch' }}>
            <InlineInput value={editOption.name} onChangeText={(t) => setEditOption((e) => (e ? { ...e, name: t } : e))} placeholder="Choice name" />
            <InlineInput value={editOption.price} onChangeText={(t) => setEditOption((e) => (e ? { ...e, price: t } : e))} placeholder={choicePricePlaceholder(flags.setsPrice, vatAdded)} keyboardType="number-pad" />
            <InlineInput value={editOption.code} onChangeText={(t) => setEditOption((e) => (e ? { ...e, code: t } : e))} placeholder="Kitchen code (optional)" />
          </View>
        ) : null}
        <PillButton
          label="Save choice"
          style={{ alignSelf: 'stretch', marginTop: space.lg }}
          disabled={readOnly || !editOption?.name.trim()}
          onPress={() => {
            const e = editOption;
            if (!e || !group) return;
            // [REVIEW-MENU-B S3-3] Never a guessed $0: a blank or mistyped price is refused, a size needs its full price.
            const read = choicePriceInput(e.price, { size: group.setsPrice });
            if ('problem' in read) { onError({ code: 'MENU_OPTIONS_RULE', message: read.problem }); return; }
            setEditOption(null);
            void send((s) => vendorApi.updateModifierOption(e.id, { name: e.name.trim(), price: read.price, externalCode: e.code.trim() || null }, s.session, s.storeId));
          }}
        />
        <PillButton label="Cancel" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setEditOption(null)} />
      </PopupCard>

      {/* The follow-up group a choice opens: another library group, one level deep. */}
      <PopupCard visible={!!followUpFor} onClose={() => setFollowUpFor(null)}>
        <PopupTitle variant="title" center>Opens follow-up group</PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          When a customer picks this choice, the group you pick here opens under it. Add that group to the same items.
        </T>
        {group && followUpFor ? followUpTargets(groups, group.id).map((t) => (
          <Chip key={t.id} label={t.name} selected={followUpFor.followUpGroupId === t.id}
            onPress={() => { const o = followUpFor; setFollowUpFor(null); void send((s) => vendorApi.updateModifierOption(o.id, { followUpGroupId: t.id }, s.session, s.storeId)); }}
            style={{ height: 38, paddingHorizontal: space.md, marginTop: space.sm, alignSelf: 'stretch' }} />
        )) : null}
        <Chip label="Opens nothing" selected={followUpFor?.followUpGroupId == null}
          onPress={() => { const o = followUpFor; setFollowUpFor(null); if (o) void send((s) => vendorApi.updateModifierOption(o.id, { followUpGroupId: null }, s.session, s.storeId)); }}
          style={{ height: 38, paddingHorizontal: space.md, marginTop: space.sm, alignSelf: 'stretch' }} />
        <PillButton label="Cancel" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.lg }} onPress={() => setFollowUpFor(null)} />
      </PopupCard>

      {/* Bulk attach / detach: the items that use this group. */}
      <PopupCard visible={pickItems != null} onClose={() => setPickItems(null)}>
        <PopupTitle variant="title" center>Choose items</PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>Tick every item that uses this group.</T>
        <ScrollView style={{ maxHeight: 360, alignSelf: 'stretch', marginTop: space.md }}>
          {menu.isLoading ? <T variant="caption" tone="muted">Loading…</T> : null}
          {allItems.map((i) => {
            const on = pickItems?.includes(i.id) ?? false;
            return (
              <Chip key={i.id} label={i.name} selected={on}
                onPress={() => setPickItems((list) => (list ? (on ? list.filter((id) => id !== i.id) : [...list, i.id]) : list))}
                style={{ height: 38, paddingHorizontal: space.md, marginTop: space.sm, alignSelf: 'stretch' }} />
            );
          })}
        </ScrollView>
        <PillButton label="Save items" style={{ alignSelf: 'stretch', marginTop: space.lg }} disabled={readOnly} onPress={() => { void saveItems(); }} />
        <PillButton label="Cancel" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setPickItems(null)} />
      </PopupCard>

      <ConfirmDialog
        open={deleteAsk}
        title={`Delete “${group?.name ?? ''}”?`}
        body={libraryDeleteWords(usedBy)}
        confirmLabel="Delete group"
        cancelLabel="Keep it"
        destructive
        loading={write.isPending}
        onConfirm={async () => {
          setDeleteAsk(false);
          if (!group) return;
          const answer = await send((s) => vendorApi.deleteModifierGroup(group.id, s.session, s.storeId));
          if (answer?.deleted) {
            const n = Number(answer.removedFromItems) || 0;
            toast.show(n > 0 ? `Deleted. Removed from ${n} item${n === 1 ? '' : 's'}.` : 'Deleted.');
            onDeleted();
          }
        }}
        onClose={() => setDeleteAsk(false)}
      />

      {/* [REVIEW-MENU-B S3-4] A shared choice leaves every item that uses the group: asked first. */}
      <ConfirmDialog
        open={!!deleteChoice}
        title={deleteChoice ? libraryChoiceDeleteWords(deleteChoice.name, usedBy).title : ''}
        body={deleteChoice ? libraryChoiceDeleteWords(deleteChoice.name, usedBy).body : ''}
        confirmLabel="Remove choice"
        cancelLabel="Keep it"
        destructive
        loading={write.isPending}
        onConfirm={async () => {
          const o = deleteChoice;
          setDeleteChoice(null);
          if (o) await send((s) => vendorApi.deleteModifierOption(o.id, s.session, s.storeId));
        }}
        onClose={() => setDeleteChoice(null)}
      />

      {/* [REVIEW-MENU-B S2-1] "Sets the price" on a shared group with choices: every item that uses it gets these prices,
          shown (and editable) before anything is saved. */}
      <PopupCard visible={!!sizeSwitch} onClose={() => setSizeSwitch(null)}>
        <PopupTitle variant="title" center>{sizeSwitch?.turnOn ? 'Make these sizes?' : 'Stop setting the price?'}</PopupTitle>
        {sizeSwitch && group ? (
          <>
            <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
              {sizeSwitchWords(
                sizeSwitchShown(group.options, sizeSwitch.typed),
                { turnOn: sizeSwitch.turnOn, sharedBy: usedBy },
                money,
              )}
            </T>
            {sizeSwitch.turnOn && switchUsers.length > 1 ? (
              <T variant="caption" tone="muted" center style={{ marginTop: space.xs }}>Started from the lowest price of the items that use it. Change any size before you save.</T>
            ) : null}
            <View style={{ gap: space.sm, marginTop: space.md, alignSelf: 'stretch' }}>
              {group.options.map((o) => (
                <View key={o.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <T variant="label" style={{ flex: 1 }}>{o.name}</T>
                  <InlineInput
                    style={{ width: 120 }}
                    value={sizeSwitch.typed[o.id] ?? ''}
                    onChangeText={(t: string) => setSizeSwitch((a) => (a ? { ...a, typed: { ...a.typed, [o.id]: t }, problem: null } : a))}
                    placeholder={choicePricePlaceholder(sizeSwitch.turnOn, vatAdded)}
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
    </View>
  );
}
