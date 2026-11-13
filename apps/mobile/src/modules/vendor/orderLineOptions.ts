/**
 * [L09 · M026] The choices a customer made for one order line, as the store
 * reads them while making it: "Size: Large · Extras: Cheese". The server sends
 * each line's snapshotted options (group, choice, price) on the order board
 * and the order detail; a line with none shows nothing.
 *
 * [MENU-OPTIONS · owner 11 Nov 2026] A pizza reads clearly in the kitchen: the size alone ("Large"), a follow-up
 * choice under the choice that opened it ("Crust: Stuffed crust → Cheese: Cheddar") and a half-and-half group laid out
 * by half ("Toppings — Left: Pepperoni / Right: Mushroom / Whole: Onion"). The server sends each choice's parts
 * (plainGroup, plainName, placement, parentOptionName, setsPrice) in menu order, each follow-up right after its opener.
 * An older server sends only the display words: each choice then reads "group: name", as before.
 *
 * Import-free: the website's order detail imports this file as is, so both read a pizza the same way.
 */
export interface OrderLineOption {
  group?: string | null;
  name?: string | null;
  plainGroup?: string | null;
  plainName?: string | null;
  placement?: 'WHOLE' | 'LEFT' | 'RIGHT' | string | null;
  parentOptionName?: string | null;
  setsPrice?: boolean | null;
}

const HALVES: ReadonlyArray<readonly [string, string]> = [['LEFT', 'Left'], ['RIGHT', 'Right'], ['WHOLE', 'Whole']];

type Run = { group: string; parent: string | null; size: boolean; picks: Array<{ name: string; placement: string }> };

function runText(run: Run): string {
  const names = (picks: Run['picks']) => picks.map((p) => p.name).join(', ');
  if (run.size) return names(run.picks);
  const halved = run.picks.some((p) => p.placement === 'LEFT' || p.placement === 'RIGHT');
  if (!halved) return run.group ? `${run.group}: ${names(run.picks)}` : names(run.picks);
  const byHalf = HALVES
    .map(([key, word]) => [word, run.picks.filter((p) => p.placement === key)] as const)
    .filter(([, picks]) => picks.length > 0)
    .map(([word, picks]) => `${word}: ${names(picks)}`)
    .join(' / ');
  return run.group ? `${run.group} — ${byHalf}` : byHalf;
}

/** The line's choices in parts, one per group (a follow-up joined to its opener's part): the kitchen ticket's lines. */
export function orderLineOptionsParts(options: readonly OrderLineOption[] | null | undefined): string[] {
  const rows = (options ?? []).filter((o) => o?.name || o?.plainName);
  if (rows.length === 0) return [];
  // An older server: the display words only.
  if (!rows.every((o) => typeof o.plainName === 'string' && o.plainName)) {
    return rows.filter((o) => o.name).map((o) => (o.group ? `${o.group}: ${o.name}` : String(o.name)));
  }
  const runs: Run[] = [];
  for (const o of rows) {
    const group = o.plainGroup || o.group || '';
    const parent = o.parentOptionName || null;
    const size = o.setsPrice === true;
    const pick = { name: String(o.plainName), placement: o.placement === 'LEFT' || o.placement === 'RIGHT' ? o.placement : 'WHOLE' };
    const last = runs[runs.length - 1];
    if (last && last.group === group && last.parent === parent && last.size === size) last.picks.push(pick);
    else runs.push({ group, parent, size, picks: [pick] });
  }
  const parts: string[] = [];
  for (const run of runs) {
    const text = runText(run);
    if (run.parent && parts.length > 0) parts[parts.length - 1] += ` → ${text}`;
    else parts.push(text);
  }
  return parts;
}

export function orderLineOptionsText(options: readonly OrderLineOption[] | null | undefined): string | null {
  const parts = orderLineOptionsParts(options);
  return parts.length ? parts.join(' · ') : null;
}
