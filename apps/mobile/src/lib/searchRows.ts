/**
 * [APP-SPEED C · report item 12] The Search tab's engine answer (places, then dishes) as the rows of ONE
 * virtualised list. It used to be a ScrollView that mounted every place and every dish of the answer at once
 * (each with its photo); a FlatList draws only the rows near the screen. Pure, so the order and the keys are pinned
 * without a native renderer.
 */
export type SearchRow =
  | { kind: 'count' }
  | { kind: 'place'; row: any; index: number }
  | { kind: 'dishes' }
  | { kind: 'dish'; row: any; index: number };

/** The count line and the places (when there are any), then the "Dishes" heading and the dishes (when there are any). */
export function engineSearchRows(places: readonly any[], dishes: readonly any[]): SearchRow[] {
  const rows: SearchRow[] = [];
  if (places.length > 0) {
    rows.push({ kind: 'count' });
    places.forEach((row, index) => rows.push({ kind: 'place', row, index }));
  }
  if (dishes.length > 0) {
    rows.push({ kind: 'dishes' });
    dishes.forEach((row, index) => rows.push({ kind: 'dish', row, index }));
  }
  return rows;
}

/** A row's key: a place and a dish may share an id (different tables), so the kind is part of it. */
export function searchRowKey(row: SearchRow, index: number): string {
  if (row.kind === 'place' || row.kind === 'dish') return `${row.kind}:${String(row.row?.id ?? `#${index}`)}`;
  return row.kind;
}
