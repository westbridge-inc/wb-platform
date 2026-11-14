'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Info, X } from 'lucide-react';
import { closedNoticeIds, fetchHomeNotice, rememberClosedNotice } from '@/lib/home-notice';

/** How often an open Home re-reads the notice, and how long an answer counts as fresh. */
export const NOTICE_RECHECK_MS = 60_000;

/**
 * [HOME-NOTICE · owner 13 Nov 2026] The owner's notice at the top of Home, for
 * everyone, closed with an X (lib/home-notice.ts). It is drawn only once the
 * browser has the answer, so the server's page never carries it, and a closed
 * notice never flashes: the closed ids are read before it is first drawn.
 */
export function HomeNotice({ className = '' }: { className?: string }) {
  // [ROUND 2 · REVIEW-A S3-2 · REVIEW-B S3-1] A tab left open drops a notice the owner turned off: it re-reads every
  // minute and when the tab is looked at again (once the answer is a minute old). The browser may answer from its
  // cache for up to a minute (the API says max-age=60), so an open tab drops it within about two minutes.
  const notice = useQuery({
    queryKey: ['public', 'home-notice'], queryFn: fetchHomeNotice, staleTime: NOTICE_RECHECK_MS,
    refetchInterval: NOTICE_RECHECK_MS, refetchOnWindowFocus: true,
  });
  // Read on the first render in the browser; on the server there is no answer yet, so nothing is drawn either way.
  const [closed, setClosed] = useState<string[]>(() => (typeof window === 'undefined' ? [] : closedNoticeIds()));
  const shown = notice.data ?? null;
  if (!shown || closed.includes(shown.id)) return null;

  return (
    <div role="note" aria-label="Notice from Swift" className={`sw-note sw-note-info mt-3 py-3 pr-2 wide:max-w-[640px] ${className}`}>
      <Info size={18} aria-hidden className="mt-px flex-none text-[var(--swift-red)]" />
      <div className="min-w-0 flex-1">
        {shown.title ? <p className="text-[15px] font-semibold leading-5">{shown.title}</p> : null}
        <p className={`text-[13px] leading-[18px] ${shown.title ? 'mt-0.5 text-[var(--swift-muted)]' : ''}`}>{shown.body}</p>
      </div>
      <button
        type="button"
        aria-label="Close notice"
        onClick={() => {
          rememberClosedNotice(shown.id);
          setClosed((ids) => [...ids, shown.id]);
        }}
        className="-my-1.5 grid h-11 w-11 flex-none cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-[var(--swift-ink)] hover:bg-[var(--swift-border)]"
      >
        <X size={18} aria-hidden />
      </button>
    </div>
  );
}
