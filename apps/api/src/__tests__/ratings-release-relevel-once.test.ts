import { describe, it, expect, vi, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { scheduleRecurringJobs, RATINGS_RELEASE_RELEVEL_JOB_ID } from '../jobs/queue';
import { wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [RATINGS-RELEASE · REVIEW-2506-A S3-1] The deploy that moved the stars to
// release time leaves every figure holding the OLD write-time count until the
// next 04:30 nightly. In that gap the first rating written to a store would
// re-level it at that very moment (its count drops by the unreleased ratings),
// which is the write-time signal the owner ruled out. So the first worker boot
// after the deploy queues ONE full re-level (the nightly job's own handler),
// under a fixed job id: later boots add nothing while the completed job is kept.
// ---------------------------------------------------------------------------

type Q = { add: ReturnType<typeof vi.fn>; getRepeatableJobs: ReturnType<typeof vi.fn>; removeRepeatableByKey: ReturnType<typeof vi.fn> };
function mockQueues() {
  const make = (): Q => ({
    add: vi.fn().mockResolvedValue(undefined),
    getRepeatableJobs: vi.fn().mockResolvedValue([]),
    removeRepeatableByKey: vi.fn().mockResolvedValue(true),
  });
  return {
    orderQueue: make(), subscriptionQueue: make(), settlementQueue: make(), notificationQueue: make(),
    verificationQueue: make(), dispatchQueue: make(), offerQueue: make(), safetyQueue: make(), searchQueue: make(),
  };
}

describe('the post-deploy catch-up re-level runs once [RATINGS-RELEASE S3-1]', () => {
  it('worker boot queues ONE rating-stats-recompute under the fixed job id, beside the nightly repeat', async () => {
    const q = mockQueues();
    await scheduleRecurringJobs(q as never);
    const calls = q.dispatchQueue.add.mock.calls.filter((c: unknown[]) => c[0] === 'rating-stats-recompute');
    const once = calls.filter((c) => (c[2] as { jobId?: string }).jobId === RATINGS_RELEASE_RELEVEL_JOB_ID);
    expect(once, 'the one-off catch-up must be queued at boot').toHaveLength(1);
    const opts = once[0]![2] as { repeat?: unknown; removeOnComplete?: unknown; removeOnFail?: unknown };
    expect(opts.repeat).toBeUndefined(); // a one-off, not a second schedule
    expect(opts.removeOnComplete).toBe(false); // kept, so the next boot's add is a no-op
    expect(opts.removeOnFail).toBe(true); // a failed run is not kept, so the next boot tries again
    // the nightly leg is still there, unchanged
    expect(calls.some((c) => (c[2] as { repeat?: { pattern?: string } }).repeat?.pattern === '30 4 * * *')).toBe(true);
  });

  describe('with real BullMQ: a second boot adds nothing', () => {
    const redis = new Redis(process.env['REDIS_URL']!, { maxRetriesPerRequest: null });
    const queue = new Queue(`ratings-release-once-${wordFreeTag(8)}`, { connection: redis });
    afterAll(async () => {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      await redis.quit();
    });

    it('the same job id, added on two boots, is one job', async () => {
      const add = () => queue.add('rating-stats-recompute', { reason: RATINGS_RELEASE_RELEVEL_JOB_ID }, {
        jobId: RATINGS_RELEASE_RELEVEL_JOB_ID, removeOnComplete: false, removeOnFail: true,
      });
      await add();
      await add();
      const counts = await queue.getJobCounts('waiting', 'delayed', 'active', 'completed', 'failed');
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);
    });
  });
});
