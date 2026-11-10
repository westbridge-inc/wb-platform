// ---------------------------------------------------------------------------
// [RATINGS · owner report 10 Nov 2026] The rating sheet's tag chips follow the stars: 1–3 stars show
// "What went wrong?" chips, 4–5 stars show "What was great?" chips (the server checks every tag
// against the same band: rating/tag-taxonomy.seed.ts tagsForRole). A chip picked under one band
// stayed picked, unseen, after the customer moved the stars into the other band — and was sent.
// The server refused the whole rating ("Unknown tag for vendor: great-value"), so the stars and
// the words never registered. What is sent is now exactly what is on screen.
// ---------------------------------------------------------------------------

export type RatingBand = 'negative' | 'positive';

export interface RatingTagSets {
  positive: ReadonlyArray<{ slug: string }>;
  negative: ReadonlyArray<{ slug: string }>;
}

/** The chip set a star score shows (the server's split: 3 stars and under is "What went wrong?"). */
export function ratingBand(score: number): RatingBand {
  return score <= 3 ? 'negative' : 'positive';
}

/**
 * The picked tags the customer can see picked right now: only those in the chip set the stars
 * show, and that fit the store (`fits`). No stars or no chip sets: nothing.
 */
export function tagsOnScreen(
  selected: readonly string[],
  score: number,
  sets: RatingTagSets | undefined,
  fits: (slug: string) => boolean = () => true,
): string[] {
  if (!score || !sets) return [];
  const shown = new Set(sets[ratingBand(score)].map((t) => t.slug).filter(fits));
  return selected.filter((slug) => shown.has(slug));
}
