'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { storeKey } from '@/lib/store-scope';
import { REVIEW_REPLY_MAX, getStoreReviews, respondToReview } from '@/lib/store-insights-api';

/** A review's day: the server sends only its Guyana calendar day, so it is read on the Guyana clock. */
const reviewDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GY', { month: 'short', day: 'numeric', timeZone: 'America/Guyana' });
};

/**
 * [WEB-INSIGHTS · audit B3] The app's ReviewsCard ("see ratings, respond"): the ten newest reviews, what was said and
 * never who said it (the server sends no reviewer), the store's own public reply, and Reply / Edit reply / Post reply
 * (POST /vendor/reviews/:id/respond; owners and managers, at most 1000 characters; the reviewer is told).
 */
export function ReviewsCard({ storeId }: { storeId: string }) {
  const queryClient = useQueryClient();
  const reviewsQ = useQuery({ queryKey: storeKey(storeId, 'reviews'), queryFn: getStoreReviews });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const respond = useMutation({
    mutationFn: ({ id, response }: { id: string; response: string }) => respondToReview(id, response),
    onSuccess: () => {
      setOpenId(null);
      void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'reviews') });
    },
  });
  const reviews = (reviewsQ.data?.reviews ?? []).slice(0, 10);
  const open = (id: string, text: string) => {
    respond.reset();
    setOpenId(id);
    setDrafts((s) => ({ ...s, [id]: s[id] ?? text }));
  };

  return (
    <section aria-label="Recent reviews" className="sw-card min-w-0 p-5">
      <h3 className="font-semibold">Recent reviews</h3>
      {reviewsQ.isLoading && !reviewsQ.data ? <p className="sw-caption mt-2">Loading reviews…</p>
        : reviewsQ.isError && !reviewsQ.data ? (
          <div className="mt-2">
            <p className="sw-caption">Reviews are unavailable right now.</p>
            <button type="button" onClick={() => void reviewsQ.refetch()} className="sw-btn sw-btn-md sw-btn-outline mt-2">Retry</button>
          </div>
        ) : (
          <>
            {reviewsQ.isError && <p className="sw-caption mt-1">Showing the last loaded reviews — refresh did not complete.</p>}
            {reviewsQ.isSuccess && reviews.length === 0 ? <p className="sw-caption mt-2">Reviews land here after customers rate their orders.</p> : (
              <ul>
                {reviews.map((r) => {
                  const score = Math.max(0, Math.min(5, Math.round(Number(r.score) || 0)));
                  const draft = drafts[r.id] ?? '';
                  return (
                    <li key={r.id} className="mt-3 border-t border-[var(--swift-border)] pt-3">
                      <div className="flex items-center gap-3">
                        <p className="sw-label flex-1 font-semibold">
                          Customer · <span className="text-amber-500" aria-label={`${score} out of 5 stars`}>{'★'.repeat(score)}</span>
                        </p>
                        <span className="sw-caption">{reviewDay(r.createdAt)}</span>
                      </div>
                      {r.comment && <p className="sw-caption mt-1 break-words">{r.comment}</p>}
                      {r.response && openId !== r.id ? (
                        <div className="ml-4 mt-2 rounded-lg bg-[var(--swift-sunken)] px-3 py-2">
                          <p className="sw-caption break-words">You replied: {r.response}</p>
                          <button type="button" onClick={() => open(r.id, r.response ?? '')} className="mt-1 min-h-11 text-sm font-semibold text-[var(--swift-red)]">Edit reply</button>
                        </div>
                      ) : openId === r.id ? (
                        <div className="mt-2">
                          <textarea value={draft} onChange={(e) => setDrafts((s) => ({ ...s, [r.id]: e.target.value }))} placeholder="Write a public reply…"
                            aria-label="Your public reply" maxLength={REVIEW_REPLY_MAX} rows={3}
                            className="w-full rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] p-3 text-sm" />
                          {respond.isError && <p role="alert" className="mt-1 text-sm text-[var(--swift-red)]">{respond.error instanceof Error && respond.error.message ? respond.error.message : 'Couldn’t post the reply. Try again.'}</p>}
                          <div className="mt-2 flex gap-3">
                            <button type="button" disabled={respond.isPending || !draft.trim()} onClick={() => respond.mutate({ id: r.id, response: draft.trim() })}
                              className="sw-btn sw-btn-md flex-1 disabled:opacity-60">{respond.isPending ? 'Posting…' : 'Post reply'}</button>
                            <button type="button" onClick={() => { respond.reset(); setOpenId(null); }} className="sw-btn sw-btn-md sw-btn-outline flex-1">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <button type="button" onClick={() => open(r.id, '')} className="mt-1 min-h-11 text-sm font-semibold text-[var(--swift-red)]">Reply</button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
    </section>
  );
}
