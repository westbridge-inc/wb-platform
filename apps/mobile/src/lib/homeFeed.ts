import type { QueryClient } from '@tanstack/react-query';

/** Every variant of Home's feed (place, ad scope): hooks/customer customerKeys.homeAll is this key. */
export const HOME_FEED_ALL = ['customer', 'home'] as const;

/**
 * [APP-SPEED C · review S2-2] Something Home shows has just been created — an order placed (or found placed after
 * an unanswered checkout), a parcel sent, a pro booked. Home's feed is marked out of date (and read again now while
 * Home is mounted), so a return to Home never shows the feed from before it: the "~30 s fresh" return gate
 * (lib/homeReliability homeFocusRefreshDue) always re-reads an invalidated feed.
 */
export function homeFeedChanged(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: HOME_FEED_ALL });
}
