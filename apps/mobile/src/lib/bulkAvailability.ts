// ---------------------------------------------------------------------------
// [MENU-BULK · parity audit C2, owner 14 Nov 2026] SEVERAL ITEMS AT ONCE.
//
// Tick several items on the menu list and mark them sold out, or back on, in one go (POST
// /vendor/items/availability/bulk). The app's Menu tab and the website's menu page show the SAME words, from here.
// Pure on purpose: no React, no React Native, so the website imports it too.
// ---------------------------------------------------------------------------

const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

/** The ask before the batch is sent. */
export function bulkConfirmTitle(count: number, isAvailable: boolean): string {
  return isAvailable ? `Make ${items(count)} available?` : `Mark ${items(count)} sold out?`;
}

/** What happens, under the ask (the menu's own footer words for a sold-out item). */
export function bulkConfirmBody(isAvailable: boolean): string {
  return isAvailable
    ? 'Customers can order them again.'
    : 'Customers can’t add them to a new order. If a current order has one, the customer is asked to choose a replacement or it is marked for a refund.';
}

export type BulkAnswer = {
  changedIds: readonly string[];
  unchangedIds: readonly string[];
  refused: ReadonlyArray<{ id: string; name: string; message: string }>;
};

/** The answer, counted: how many changed, how many were already so, and any Swift does not allow (named). */
export function bulkResultLine(answer: BulkAnswer, isAvailable: boolean): string {
  const done = isAvailable ? 'made available' : 'marked sold out';
  const state = isAvailable ? 'available' : 'sold out';
  const parts = [`${items(answer.changedIds.length)} ${done}.`];
  const already = answer.unchangedIds.length;
  if (already > 0) parts.push(`${already} ${already === 1 ? 'was' : 'were'} already ${state}.`);
  const refused = answer.refused.length;
  if (refused > 0) {
    parts.push(`Swift does not allow ${refused}, so ${refused === 1 ? 'it stays' : 'they stay'} off: ${answer.refused.map((r) => r.name).join(', ')}.`);
  }
  return parts.join(' ');
}

/** [REVIEW-2520-A S4-4] The bar's count: every tick (all are sent), and how many the search or a button now hides. */
export function selectedLine(selected: ReadonlySet<string>, shownIds: readonly string[]): string {
  const shown = new Set(shownIds);
  let hidden = 0;
  for (const id of selected) if (!shown.has(id)) hidden += 1;
  return hidden > 0 ? `${selected.size} selected · ${hidden} not shown` : `${selected.size} selected`;
}

/** One item ticked or unticked (a new set; the others untouched). */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** "Select all shown": every item on screen added to the ticks already made. */
export function selectAll(selected: ReadonlySet<string>, shownIds: readonly string[]): Set<string> {
  const next = new Set(selected);
  for (const id of shownIds) next.add(id);
  return next;
}

/** The ticks still on the menu (an item deleted elsewhere drops out); the same set when none dropped. */
export function keepSelectable<S extends ReadonlySet<string>>(selected: S, menuIds: readonly string[]): S | Set<string> {
  const live = new Set(menuIds);
  for (const id of selected) {
    if (!live.has(id)) return new Set([...selected].filter((x) => live.has(x)));
  }
  return selected;
}
