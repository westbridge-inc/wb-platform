import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * [APP-SPEED C · report item 12] A refresh the person asks for (the pull, Try again) of a paged ("infinite") list
 * starts again from its newest page.
 *
 * TanStack Query refetches an infinite query by re-reading EVERY page it holds, one after the other: a customer who
 * had scrolled five pages into their history paid five sequential round trips (~0.3 s each from Guyana) for one
 * pull. Here the cached pages are cut back to the first one, then the query is read again: one request. The first
 * page stays drawn until the answer lands (a failed refresh never empties the list), and scrolling down reads the
 * next pages again from the fresh first page, so no row is skipped or drawn twice when new orders have shifted the
 * pages. Not for refreshes nobody asked for (a return to the screen): cutting the pages there loses the person's place.
 */
export function firstPageOnly<TPage, TParam>(data: InfiniteData<TPage, TParam>): InfiniteData<TPage, TParam> {
  return data.pages.length <= 1 ? data : { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) };
}

/** Cut the cached pages back to the first, then read that one page again. */
export function refetchFromFirstPage(qc: QueryClient, queryKey: QueryKey): Promise<void> {
  const data = qc.getQueryData<InfiniteData<unknown, unknown>>(queryKey);
  if (data && data.pages.length > 1) qc.setQueryData(queryKey, firstPageOnly(data));
  return qc.refetchQueries({ queryKey, exact: true });
}
