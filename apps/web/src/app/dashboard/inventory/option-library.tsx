'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/modal';
import { storeKey } from '@/lib/store-scope';
import { formatMoney } from '@/lib/money';
import { refusalWords } from '@/lib/menu-api';
import {
  addLibraryOption, attachLibraryGroup, createLibraryGroup, deleteLibraryGroup, deleteLibraryOption, detachLibraryGroup, getLibrary,
  orderLibrary, updateLibraryGroup, updateLibraryOption, type GroupBody, type LibraryGroup, type LibraryOption,
} from '@/lib/menu-api';
// [MENU-OPTIONS · owner 11 Nov 2026 · owner rule 11 Oct: the website copies the app] The app's own rules and words for
// sizes, half-and-half, follow-up groups and the shared library (a plain file, imported as is).
import {
  attachPlan, choicePricePlaceholder, flagsOf, followUpLabel, followUpTargets, groupFlagsBody, groupRuleWords, halfRuleWords,
  libraryDeleteWords, menuOptionsRefusal, moved, parseHalfPercent, sharedEditWarning, sizePriceLabel, usedByWords, type GroupFlags,
} from '../../../../../mobile/src/lib/menuOptionsEditor';

// The phone's Option library screen (apps/mobile/src/modules/vendor/screens/VendorOptionLibraryScreen.tsx), wider:
// the list in the store's order with how many items use each group, a group's rules and choices (price, sold out,
// the follow-up group a choice opens, the kitchen code), the items that use it (attach / detach many at once) and
// delete ("removed from N items"). Every write is the server's to judge; a refusal is shown in its own words.

export const NEW_GROUP_FLAGS: GroupFlags = { required: false, multi: false, setsPrice: false, allowHalves: false, halfPercent: 100 };

export const libraryKey = (storeId: string | null) => storeKey(storeId, 'modifier-groups');

export function useLibrary(storeId: string | null, enabled = true) {
  return useQuery({ queryKey: libraryKey(storeId), queryFn: getLibrary, enabled });
}

/** After a library write: the library and the items (every item that uses a shared group changed) are read again. */
export function rereadAfterLibrary(qc: QueryClient, storeId: string | null) {
  void qc.invalidateQueries({ queryKey: libraryKey(storeId) });
  void qc.invalidateQueries({ queryKey: storeKey(storeId, 'items') });
}

/** The words for a failed option write: the server's rule in its own words, else the caller's plain sentence. */
export function optionWriteFailure(e: unknown, vendorType?: string): string {
  return menuOptionsRefusal(e) ?? refusalWords(e, vendorType) ?? "That didn't save. Check your connection and try again.";
}

function Chip({ label, on, onClick, disabled }: { label: string; on: boolean; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="sw-chip" aria-pressed={on} disabled={disabled} onClick={onClick}>{label}</button>;
}

/** A group's size / half-and-half rule (the app's GroupRuleChips). */
export function GroupRules({ flags, onChange, sizeTaken, disabled, label }: {
  flags: GroupFlags;
  onChange: (_next: Partial<GroupFlags>) => void;
  sizeTaken: boolean;
  disabled?: boolean;
  /** Names the controls of this group for a screen reader ("Size", "New group"). */
  label: string;
}) {
  const [pctText, setPctText] = useState(flags.halfPercent === 100 ? '50' : String(flags.halfPercent));
  const pct = parseHalfPercent(pctText);
  return (
    <div className="mt-2 space-y-2" role="group" aria-label={`Rules: ${label}`}>
      <div className="flex flex-wrap gap-2">
        {!sizeTaken || flags.setsPrice ? (
          <Chip label="Sets the price" on={flags.setsPrice} disabled={disabled} onClick={() => onChange({ setsPrice: !flags.setsPrice, ...(!flags.setsPrice ? { allowHalves: false } : {}) })} />
        ) : null}
        {!flags.setsPrice ? <Chip label="Half-and-half" on={flags.allowHalves} disabled={disabled} onClick={() => onChange({ allowHalves: !flags.allowHalves })} /> : null}
      </div>
      {flags.setsPrice ? <p className="sw-caption">Customers pick exactly one. Each choice’s price is the item’s price (like Small / Large).</p> : null}
      {flags.allowHalves && !flags.setsPrice ? (
        <div className="space-y-2">
          <p className="sw-field-label">A half costs</p>
          <div className="flex flex-wrap gap-2">
            <Chip label="Full price" on={flags.halfPercent === 100} disabled={disabled} onClick={() => onChange({ halfPercent: 100 })} />
            <Chip label="% of the choice price" on={flags.halfPercent !== 100} disabled={disabled} onClick={() => onChange({ halfPercent: pct ?? 50 })} />
          </div>
          {flags.halfPercent !== 100 ? (
            <div className="flex items-center gap-2">
              <input className="sw-input w-28" inputMode="numeric" aria-label={`Half costs (%): ${label}`} placeholder="Half costs (%)" value={pctText} onChange={(e) => setPctText(e.target.value)} />
              <button type="button" className="sw-btn-outline min-h-11 rounded-lg px-3 text-sm font-semibold" disabled={disabled || pct == null || pct === flags.halfPercent}
                onClick={() => { if (pct != null) onChange({ halfPercent: pct }); }}>Set</button>
              <span className="sw-caption">{halfRuleWords(flags.halfPercent)}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const choicePrice = (g: { setsPrice?: boolean }, o: LibraryOption, vatAdded: boolean) => {
  const before = vatAdded ? ' before VAT' : '';
  if (g.setsPrice) return `${sizePriceLabel(o, formatMoney)}${before}`;
  return o.price > 0 ? `+${formatMoney(o.price)}${before}` : 'Free';
};

/** The library: the list, or one group's editor. `focusGroupId` opens that group (from an item's shared group). */
export function OptionLibraryPanel({ storeId, vendorType, vatAdded, items, focusGroupId = null, onDone }: {
  storeId: string | null;
  vendorType?: string;
  vatAdded: boolean;
  /** The store's items, for "Choose items". */
  items: Array<{ id: string; name: string }>;
  focusGroupId?: string | null;
  /** Back from the group opened by `focusGroupId` (or from the list). */
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const library = useLibrary(storeId);
  const groups = library.data ?? [];
  const [editing, setEditing] = useState<string | null>(focusGroupId);
  const [error, setError] = useState<string | null>(null);
  const write = useMutation({
    mutationFn: (send: () => Promise<unknown>) => send(),
    onMutate: () => setError(null),
    onSuccess: () => rereadAfterLibrary(qc, storeId),
    onError: (e) => setError(optionWriteFailure(e, vendorType)),
  });
  const send = async (call: () => Promise<unknown>): Promise<unknown> => {
    if (write.isPending) return undefined;
    return write.mutateAsync(call).catch(() => undefined);
  };
  const current = editing && editing !== 'new' ? groups.find((g) => g.id === editing) ?? null : null;
  const back = () => { setError(null); if (editing && !focusGroupId) setEditing(null); else onDone(); };

  return (
    <section aria-label="Option library">
      <div className="flex items-center gap-3">
        <button type="button" className="min-h-11 px-2 text-sm font-semibold text-[var(--swift-muted)]" onClick={back}>← Back</button>
        <h3 className="font-bold">{editing === 'new' ? 'New shared group' : current ? current.name : 'Option library'}</h3>
      </div>
      {error ? <p role="alert" className="mt-2 text-sm font-semibold text-[var(--swift-red)]">{error}</p> : null}
      {editing ? (
        editing === 'new' || current ? (
          <GroupEditor key={editing} group={current} groups={groups} items={items} vatAdded={vatAdded} pending={write.isPending} send={send}
            onCreated={(id) => setEditing(id)} onDeleted={() => (focusGroupId ? onDone() : setEditing(null))} />
        ) : (
          <p className="sw-caption mt-3">{library.isLoading || library.isFetching ? 'Loading…' : 'This group is no longer in your option library.'}</p>
        )
      ) : (
        <>
          <p className="sw-caption mt-2">Build a group once — like Pizza size, Crust or Toppings — and add it to many items. When you edit it, every item that uses it changes.</p>
          <button type="button" className="sw-btn sw-btn-md mt-3" onClick={() => { setError(null); setEditing('new'); }}>New shared group</button>
          {library.isError ? <p role="alert" className="mt-3 text-sm font-semibold text-[var(--swift-red)]">Couldn’t load your option library. Check your connection and try again.</p>
            : library.isLoading ? <p className="sw-caption mt-3">Loading…</p>
              : groups.length === 0 ? <p className="sw-caption mt-3">No shared groups yet.</p> : null}
          <ul className="mt-3 space-y-2">
            {groups.map((g, i) => (
              <li key={g.id} className="flex items-center gap-2 rounded-lg border border-[var(--swift-border)] p-3">
                <button type="button" className="min-w-0 flex-1 text-left" aria-label={`Edit ${g.name}`} onClick={() => { setError(null); setEditing(g.id); }}>
                  <span className="block text-sm font-semibold">{g.name}</span>
                  <span className="sw-caption block">{groupRuleWords(g)}</span>
                  <span className="block text-xs font-semibold text-[var(--swift-red)]">
                    {usedByWords(g.usedByItemCount)}{g.isFollowUp ? ' · Follow-up group' : ''} · {g.options.length} choice{g.options.length === 1 ? '' : 's'}
                  </span>
                </button>
                <button type="button" className="grid h-11 w-11 place-items-center text-[var(--swift-muted)] disabled:opacity-30" aria-label={`Move ${g.name} up`} disabled={i === 0 || write.isPending}
                  onClick={() => void send(() => orderLibrary(moved(groups.map((x) => x.id), i, -1)))}>↑</button>
                <button type="button" className="grid h-11 w-11 place-items-center text-[var(--swift-muted)] disabled:opacity-30" aria-label={`Move ${g.name} down`} disabled={i === groups.length - 1 || write.isPending}
                  onClick={() => void send(() => orderLibrary(moved(groups.map((x) => x.id), i, 1)))}>↓</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function GroupEditor({ group, groups, items, vatAdded, pending, send, onCreated, onDeleted }: {
  group: LibraryGroup | null;
  groups: LibraryGroup[];
  items: Array<{ id: string; name: string }>;
  vatAdded: boolean;
  pending: boolean;
  send: (_call: () => Promise<unknown>) => Promise<unknown>;
  onCreated: (_id: string) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(group?.name ?? '');
  const [flags, setFlags] = useState<GroupFlags>(group ? flagsOf(group) : NEW_GROUP_FLAGS);
  const [choice, setChoice] = useState({ name: '', price: '', code: '' });
  const [editOption, setEditOption] = useState<{ id: string; name: string; price: string; code: string } | null>(null);
  const [pickItems, setPickItems] = useState<string[] | null>(null);
  const [deleteAsk, setDeleteAsk] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const usedBy = group?.usedByItemCount ?? 0;
  const changed = !group || name.trim() !== group.name || JSON.stringify(flags) !== JSON.stringify(flagsOf(group));
  const targets = group ? followUpTargets(groups, group.id) : [];

  const saveGroup = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (!group) {
      const created = (await send(() => createLibraryGroup({ name: trimmed, ...groupFlagsBody(flags) }))) as LibraryGroup | undefined;
      if (created?.id) onCreated(created.id);
      return;
    }
    const body: GroupBody = { name: trimmed, ...groupFlagsBody(flags, { explicit: true }) };
    await send(() => updateLibraryGroup(group.id, body));
  };
  const addChoice = async () => {
    if (!group || !choice.name.trim()) return;
    const added = await send(() => addLibraryOption(group.id, { name: choice.name.trim(), price: Number(choice.price) || 0, ...(choice.code.trim() ? { externalCode: choice.code.trim() } : {}) }));
    if (added) setChoice({ name: '', price: '', code: '' });
  };
  const saveItems = async () => {
    if (!group || !pickItems) return;
    const plan = attachPlan(group.usedByItems.map((i) => i.id), pickItems);
    setPickItems(null);
    if (plan.attach.length) await send(() => attachLibraryGroup(group.id, plan.attach));
    if (plan.detach.length) await send(() => detachLibraryGroup(group.id, plan.detach));
  };

  return (
    <div className="mt-3 space-y-4">
      {group && usedBy > 0 ? (
        <div role="note" className="rounded-lg bg-[var(--swift-subtle)] p-3">
          <p className="text-sm font-semibold">{sharedEditWarning(usedBy)}</p>
          <p className="sw-caption">Every item that uses this group changes when you save.</p>
        </div>
      ) : null}
      {notice ? <p role="status" className="text-sm font-semibold">{notice}</p> : null}

      <div className="rounded-xl border border-[var(--swift-border)] p-4">
        <input className="sw-input" aria-label="Group name (e.g. Pizza size, Toppings)" placeholder="Group name (e.g. Pizza size, Toppings)" value={name} onChange={(e) => setName(e.target.value)} />
        {!flags.setsPrice ? (
          <div className="mt-2 flex gap-2">
            <Chip label="Required" on={flags.required} onClick={() => setFlags((f) => ({ ...f, required: !f.required }))} />
            <Chip label="Multiple picks" on={flags.multi} onClick={() => setFlags((f) => ({ ...f, multi: !f.multi }))} />
          </div>
        ) : null}
        <GroupRules flags={flags} onChange={(next) => setFlags((f) => ({ ...f, ...next }))} sizeTaken={false} label={name || 'New group'} />
        <button type="button" className="sw-btn sw-btn-md mt-3" disabled={pending || !name.trim() || !changed} onClick={() => void saveGroup()}>
          {group ? 'Save group' : 'Create group'}
        </button>
      </div>

      {group ? (
        <>
          <div className="rounded-xl border border-[var(--swift-border)] p-4">
            <h4 className="font-bold">Choices</h4>
            {group.options.length === 0 ? <p className="sw-caption mt-1">Add the first choice below.</p> : null}
            <ul className="mt-2 space-y-2">
              {group.options.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--swift-subtle)] p-3 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold">{o.name}</span>
                    <span className="sw-caption block">{choicePrice(group, o, vatAdded)}{o.externalCode ? ` · Kitchen code ${o.externalCode}` : ''}</span>
                  </span>
                  {o.followUpGroupId || targets.length > 0 ? (
                    <select className="sw-input w-auto" aria-label={`Opens follow-up group: ${o.name}`} value={o.followUpGroupId ?? ''}
                      onChange={(e) => void send(() => updateLibraryOption(o.id, { followUpGroupId: e.target.value || null }))}>
                      <option value="">Opens nothing</option>
                      {targets.map((t) => <option key={t.id} value={t.id}>{followUpLabel(groups, t.id)}</option>)}
                    </select>
                  ) : null}
                  <Chip label={o.isAvailable ? 'Available' : 'Sold out'} on={o.isAvailable} disabled={pending}
                    onClick={() => void send(() => updateLibraryOption(o.id, { isAvailable: !o.isAvailable }))} />
                  <button type="button" className="min-h-9 px-2 text-sm font-semibold text-[var(--swift-red)]" aria-label={`Edit ${o.name}`}
                    onClick={() => setEditOption({ id: o.id, name: o.name, price: String(o.price), code: o.externalCode ?? '' })}>Edit</button>
                  <button type="button" className="min-h-9 px-2 text-[var(--swift-muted)]" aria-label={`Remove ${o.name}`} disabled={pending}
                    onClick={() => void send(() => deleteLibraryOption(o.id))}>✕</button>
                </li>
              ))}
            </ul>
            {editOption ? (
              <div role="group" aria-label="Edit choice" className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--swift-border)] p-3">
                <input className="sw-input flex-1" aria-label="Choice name" value={editOption.name} onChange={(e) => setEditOption({ ...editOption, name: e.target.value })} />
                <input className="sw-input w-32" inputMode="numeric" aria-label="Choice price" placeholder={choicePricePlaceholder(flags.setsPrice, vatAdded)} value={editOption.price} onChange={(e) => setEditOption({ ...editOption, price: e.target.value })} />
                <input className="sw-input w-36" aria-label="Kitchen code (optional)" placeholder="Kitchen code (optional)" value={editOption.code} onChange={(e) => setEditOption({ ...editOption, code: e.target.value })} />
                <button type="button" className="sw-btn sw-btn-sm" disabled={pending || !editOption.name.trim()} onClick={() => {
                  const e = editOption; setEditOption(null);
                  void send(() => updateLibraryOption(e.id, { name: e.name.trim(), price: Number(e.price) || 0, externalCode: e.code.trim() || null }));
                }}>Save choice</button>
                <button type="button" className="text-sm text-[var(--swift-muted)]" onClick={() => setEditOption(null)}>Cancel</button>
              </div>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input className="sw-input flex-1" aria-label="Choice (e.g. Large)" placeholder="Choice (e.g. Large)" value={choice.name} onChange={(e) => setChoice((c) => ({ ...c, name: e.target.value }))} />
              <input className="sw-input w-32" inputMode="numeric" aria-label={choicePricePlaceholder(flags.setsPrice, vatAdded)} placeholder={choicePricePlaceholder(flags.setsPrice, vatAdded)} value={choice.price} onChange={(e) => setChoice((c) => ({ ...c, price: e.target.value }))} />
              <input className="sw-input w-36" aria-label="New choice kitchen code (optional)" placeholder="Kitchen code (optional)" value={choice.code} onChange={(e) => setChoice((c) => ({ ...c, code: e.target.value }))} />
              <button type="button" className="sw-btn-outline min-h-11 rounded-lg px-4 text-sm font-semibold" disabled={pending || !choice.name.trim()} onClick={() => void addChoice()}>Add choice</button>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--swift-border)] p-4">
            <h4 className="font-bold">Items using it</h4>
            <p className="sw-caption">{usedByWords(usedBy)}</p>
            {group.usedByItems.length ? <p className="mt-1 text-sm">{group.usedByItems.map((i) => i.name).join(', ')}</p> : null}
            {pickItems ? (
              <div role="group" aria-label="Choose items" className="mt-3">
                <p className="sw-caption">Tick every item that uses this group.</p>
                <div className="mt-2 grid max-h-72 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                  {items.map((i) => (
                    <label key={i.id} className="flex min-h-9 items-center gap-2 text-sm">
                      <input type="checkbox" checked={pickItems.includes(i.id)}
                        onChange={(e) => setPickItems((list) => (list ? (e.target.checked ? [...list, i.id] : list.filter((id) => id !== i.id)) : list))} />
                      {i.name}
                    </label>
                  ))}
                </div>
                <div className="mt-3 flex gap-2">
                  <button type="button" className="sw-btn sw-btn-md" disabled={pending} onClick={() => void saveItems()}>Save items</button>
                  <button type="button" className="sw-btn-outline min-h-11 rounded-lg px-4 text-sm font-semibold" onClick={() => setPickItems(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button type="button" className="sw-btn-outline mt-3 min-h-11 rounded-lg px-4 text-sm font-semibold" onClick={() => setPickItems(group.usedByItems.map((i) => i.id))}>Choose items</button>
            )}
          </div>

          {deleteAsk ? (
            <div role="dialog" aria-label={`Delete “${group.name}”?`} className="rounded-xl border border-[var(--swift-border)] p-4">
              <p className="font-bold">Delete “{group.name}”?</p>
              <p className="sw-caption mt-1">{libraryDeleteWords(usedBy)}</p>
              <div className="mt-3 flex gap-3">
                <button type="button" className="sw-btn sw-btn-md" disabled={pending} onClick={async () => {
                  setDeleteAsk(false);
                  const answer = (await send(() => deleteLibraryGroup(group.id))) as { deleted?: boolean; removedFromItems?: number } | undefined;
                  if (answer?.deleted) {
                    const n = Number(answer.removedFromItems) || 0;
                    setNotice(n > 0 ? `Deleted. Removed from ${n} item${n === 1 ? '' : 's'}.` : 'Deleted.');
                    onDeleted();
                  }
                }}>Delete group</button>
                <button type="button" className="sw-btn-outline min-h-11 rounded-lg px-4 text-sm font-semibold" onClick={() => setDeleteAsk(false)}>Keep it</button>
              </div>
            </div>
          ) : (
            <button type="button" className="sw-btn-outline min-h-11 rounded-lg px-4 text-sm font-semibold" onClick={() => setDeleteAsk(true)}>Delete group</button>
          )}
        </>
      ) : (
        <p className="sw-caption">Create the group, then add its choices and the items that use it.</p>
      )}
    </div>
  );
}

/** The library in its own window (the Products page's "Option library"). */
export function OptionLibraryDialog(props: { storeId: string | null; vendorType?: string; vatAdded: boolean; items: Array<{ id: string; name: string }>; onClose: () => void }) {
  return (
    <Modal label="Option library" onClose={props.onClose} className="max-h-[92vh] w-full max-w-3xl overflow-y-auto bg-[var(--swift-card)] px-6 pb-6 pt-5">
      <OptionLibraryPanel storeId={props.storeId} vendorType={props.vendorType} vatAdded={props.vatAdded} items={props.items} onDone={props.onClose} />
    </Modal>
  );
}
