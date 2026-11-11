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
import { useMenuOptionsWrite, useOptionLibrary, type LibraryGroup, type LibraryOption } from '../../../hooks/menuOptions';
import { useVendorPreview } from '../../../stores/vendorPreview';
import { vatPricingOf } from '../../../lib/storeVat';
import { errorMessage } from '../../../lib/apiError';
import { money } from '../../../lib/money';
import {
  attachPlan, choicePricePlaceholder, flagsOf, followUpLabel, followUpTargets, groupFlagsBody, groupRuleWords, libraryDeleteWords,
  menuOptionsRefusal, moved, sharedEditWarning, sizePriceLabel, usedByWords, type GroupFlags,
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
      await write.mutateAsync(() => vendorApi.orderModifierGroups(ids));
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
            {library.isLoading ? <T variant="caption" tone="muted" style={{ marginTop: space.md }}>Loading…</T> : null}
            {!library.isLoading && groups.length === 0 ? (
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
  const usedBy = group?.usedByItemCount ?? 0;
  const savedFlags = group ? flagsOf(group) : null;
  const changed = !group || name.trim() !== group.name || JSON.stringify(flags) !== JSON.stringify(savedFlags);
  const sizeTaken = false; // a library group may set the price; an item with two is refused at attach (server words)
  const send = async (call: () => Promise<any>): Promise<any> => {
    if (readOnly) return undefined;
    clearError();
    try {
      return await write.mutateAsync(call);
    } catch (e) {
      onError(e);
      return undefined;
    }
  };

  const saveGroup = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (!group) {
      const created = await send(() => vendorApi.createModifierGroup({ name: trimmed, ...groupFlagsBody(flags) }));
      if (created?.id) onCreated(created.id);
      return;
    }
    await send(() => vendorApi.updateModifierGroup(group.id, { name: trimmed, ...groupFlagsBody(flags, { explicit: true }) }));
  };

  const addChoice = async () => {
    if (!group || !choice.name.trim()) return;
    const answer = await send(() => vendorApi.addModifierOption(group.id, {
      name: choice.name.trim(), price: Number(choice.price) || 0, ...(choice.code.trim() ? { externalCode: choice.code.trim() } : {}),
    }));
    if (answer) setChoice({ name: '', price: '', code: '' });
  };

  const menu = useVendorMenu(pickItems != null);
  const allItems: Array<{ id: string; name: string }> = ((menu.data ?? []) as any[]).flatMap((c) => c.items ?? []).filter((i: any) => i.fulfillment !== 'APPOINTMENT');
  const saveItems = async () => {
    if (!group || !pickItems) return;
    const plan = attachPlan(group.usedByItems.map((i) => i.id), pickItems);
    setPickItems(null);
    if (plan.attach.length) await send(() => vendorApi.attachModifierGroup(group.id, plan.attach));
    if (plan.detach.length) await send(() => vendorApi.detachModifierGroup(group.id, plan.detach));
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
        <GroupRuleChips flags={flags} change={(next) => setFlags((f) => ({ ...f, ...next }))} sizeTaken={sizeTaken} disabled={readOnly} />
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
            {group.options.length === 0 ? <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>No choices yet.</T> : null}
            {group.options.map((o) => (
              <View key={o.id} style={{ marginTop: space.md, borderRadius: radius.lg, backgroundColor: color.surface.subtle, padding: space.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <View style={{ flex: 1 }}>
                    <T variant="label" weight="semibold">{o.name}</T>
                    <T variant="caption" tone="muted">{optionPrice(group, o, vatAdded)}{o.externalCode ? ` · Kitchen code ${o.externalCode}` : ''}</T>
                  </View>
                  <Chip label={o.isAvailable ? 'Available' : 'Sold out'} selected={o.isAvailable}
                    onPress={readOnly ? undefined : () => { void send(() => vendorApi.updateModifierOption(o.id, { isAvailable: !o.isAvailable })); }}
                    style={{ height: 32, paddingHorizontal: space.md }} />
                  <Pressable disabled={readOnly} onPress={() => { void send(() => vendorApi.deleteModifierOption(o.id)); }} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${o.name}`}>
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
            setEditOption(null);
            if (e) void send(() => vendorApi.updateModifierOption(e.id, { name: e.name.trim(), price: Number(e.price) || 0, externalCode: e.code.trim() || null }));
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
            onPress={() => { const o = followUpFor; setFollowUpFor(null); void send(() => vendorApi.updateModifierOption(o.id, { followUpGroupId: t.id })); }}
            style={{ height: 38, paddingHorizontal: space.md, marginTop: space.sm, alignSelf: 'stretch' }} />
        )) : null}
        <Chip label="Opens nothing" selected={followUpFor?.followUpGroupId == null}
          onPress={() => { const o = followUpFor; setFollowUpFor(null); if (o) void send(() => vendorApi.updateModifierOption(o.id, { followUpGroupId: null })); }}
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
              <Chip key={i.id} label={on ? `✓ ${i.name}` : i.name} selected={on}
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
          const answer = await send(() => vendorApi.deleteModifierGroup(group.id));
          if (answer?.deleted) {
            const n = Number(answer.removedFromItems) || 0;
            toast.show(n > 0 ? `Deleted. Removed from ${n} item${n === 1 ? '' : 's'}.` : 'Deleted.');
            onDeleted();
          }
        }}
        onClose={() => setDeleteAsk(false)}
      />
    </View>
  );
}
