// ---------------------------------------------------------------------------
// [APP-SPEED D · owner 7 Nov: "you tap Groceries — it LOADS, then goes to it"]
// The store list Search asks for when it browses (a Home tile presets the type:
// Food = RESTAURANT, Groceries = SUPERMARKET). Search and the read Home asks
// ahead of those doors (hooks/homeDoors) build it HERE, so the answer read
// ahead is the very key the screen opens on: one question, never two spellings
// of it (a second spelling would download the list twice and still open on a
// spinner).
// ---------------------------------------------------------------------------

export interface SearchBrowseInput {
  /** The typed words (already debounced); blank browses the whole type. */
  text?: string;
  type?: string;
  sort?: string;
  openNow?: boolean;
  /** The customer's GRANTED place only (lib/deviceLocation grantedLocationFix). */
  latitude?: number;
  longitude?: number;
}

/** The browse endpoint's query for Search's state (GET /customer/vendors). */
export function searchBrowseParams({ text, type, sort, openNow, latitude, longitude }: SearchBrowseInput): Record<string, string> {
  const p: Record<string, string> = {};
  const words = (text ?? '').trim();
  if (words) p['search'] = words;
  if (type) p['type'] = type;
  if (sort) p['sort'] = sort;
  // The browse endpoint already understands `open` — the chip is a real
  // server filter, not a client-side hide.
  if (openNow) p['open'] = 'true';
  if (latitude !== undefined && longitude !== undefined) {
    p['lat'] = String(latitude);
    p['lng'] = String(longitude);
  }
  return p;
}
