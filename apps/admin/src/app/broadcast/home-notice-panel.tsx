'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchHomeNotice, startHomeNotice, stopHomeNotice } from '@/lib/api';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionRunner } from '@/components/mc/useActionRunner';
import { gyDateTime } from '@/lib/dates';

// ---------------------------------------------------------------------------
// [HOME-NOTICE · owner 13 Nov 2026] The small notice at the top of every
// customer's Home, on the phone app and the website, signed in or not. A person
// closes it with an X; it stays until it is turned off here.
//
//   · Show on Home: platform text for every customer, so a second admin approves
//     it first (C5; while the owner is the only admin, solo approval after the
//     wait, in Approvals).
//   · Turn off now: at once (C3: a reason, no second admin).
// The status line shows what the SERVER holds; nothing is shown as changed
// before it says so. Limits match the server's (ops/home-notice.ts).
// ---------------------------------------------------------------------------

const TITLE_MAX = 60;
const BODY_MAX = 280;

export function HomeNoticePanel() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['home-notice'], queryFn: fetchHomeNotice });
  const stored = data?.data?.notice ?? null;
  const live = data?.data?.live === true;
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [seeded, setSeeded] = useState(false);
  // The form starts from the words last set (live or stopped), once: re-reads never overwrite typing.
  useEffect(() => {
    if (seeded || !data) return;
    setSeeded(true);
    if (stored) { setTitle(stored.title ?? ''); setBody(stored.body); }
  }, [data, seeded, stored]);
  const actions = useActionRunner(() => void qc.invalidateQueries({ queryKey: ['home-notice'] }));

  const words = { title: title.trim(), body: body.trim() };
  const canShow = words.body.length > 0 && words.body.length <= BODY_MAX && words.title.length <= TITLE_MAX;

  const show = () => void actions.run({
    title: live ? 'Replace the notice on Home?' : 'Show this notice on Home?',
    body: (
      <>
        {words.title ? <p><strong>{words.title}</strong></p> : null}
        <p>{words.body}</p>
        <p>Every customer sees it on Home, in the app and on the website, until it is turned off. A second admin must approve it first.</p>
      </>
    ),
    confirmLabel: 'Show on Home',
    submit: ({ reason }) => startHomeNotice(words, reason),
    success: () => 'The notice is on Home now.',
  });

  const stop = () => void actions.run({
    title: 'Turn the Home notice off?',
    // [ROUND 2 · REVIEW-A S3-2 · REVIEW-B S3-1] What really happens: the website re-reads every minute (an open page
    // too) behind the API's one-minute cache; the app re-reads when someone comes back to Home or to Swift, and every
    // 5 minutes on a Home left open (plus the phone's one-minute cache).
    body: (
      <>
        <p>It goes off at once.</p>
        <p>The website drops it within about 2 minutes, a page left open included.</p>
        <p>The app drops it when someone comes back to Home or to Swift, and within about 6 minutes on a Home left open.</p>
      </>
    ),
    confirmLabel: 'Turn off now',
    submit: ({ reason }) => stopHomeNotice(reason),
    success: () => 'The notice is off.',
  });

  return (
    <section className="mt-8 max-w-2xl" aria-labelledby="home-notice-title">
      <h2 id="home-notice-title" className="mc-section-title">Home notice</h2>
      <p className="mc-muted mb-4 text-sm">
        A short notice at the top of Home for every customer, signed in or not, in the app and on the website. People can
        close it with an X. Closed stays closed on that phone until the words change.
      </p>
      {actions.banner}
      {error ? (
        <QueryFailed error={error} what="the Home notice" onRetry={() => void refetch()} retrying={isFetching} />
      ) : isLoading || !data ? (
        <p className="mc-muted">Loading…</p>
      ) : (
        <div className="mc-card space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              {live ? <strong>Live on Home now.</strong> : 'Off. No notice shows on Home.'}
              {stored ? <span className="mc-muted"> Last changed {gyDateTime(stored.updatedAt)}.</span> : null}
            </p>
            {live ? (
              <button type="button" className="mc-btn mc-btn-primary" onClick={stop}>Turn off now</button>
            ) : null}
          </div>

          <div className="mc-field">
            <label htmlFor="home-notice-title-input">Title (optional, max {TITLE_MAX})</label>
            <input
              id="home-notice-title-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={TITLE_MAX}
              placeholder="e.g. Pickup is open on Swift"
              className="mc-input"
            />
          </div>
          <div className="mc-field">
            <label htmlFor="home-notice-body-input">Notice (max {BODY_MAX})</label>
            <textarea
              id="home-notice-body-input"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={BODY_MAX}
              rows={3}
              placeholder="One or two short sentences."
              className="mc-input"
            />
            <p className="mc-field-hint">{words.body.length}/{BODY_MAX}. Plain text, one paragraph.</p>
          </div>

          {words.body ? (
            <div className="rounded-[var(--mc-radius)] bg-[var(--mc-surface)] p-4">
              <p className="mc-label mb-2">Preview on Home</p>
              <div data-testid="home-notice-preview" className="rounded-[var(--mc-radius)] border border-[var(--mc-line)] bg-[var(--mc-card)] p-3">
                {words.title ? <p className="font-semibold">{words.title}</p> : null}
                <p className="mc-muted mt-0.5 text-xs">{words.body}</p>
              </div>
            </div>
          ) : null}

          <button type="button" onClick={show} disabled={!canShow} className="mc-btn w-full">Show on Home</button>
        </div>
      )}
    </section>
  );
}
