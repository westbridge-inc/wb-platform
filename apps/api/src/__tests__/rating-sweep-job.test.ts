import { describe, it, expect, vi, afterEach } from 'vitest';
import { runFlagRatingsSweep } from '../jobs/queue';
import { RatingService } from '../modules/rating/rating.service';

// ---------------------------------------------------------------------------
// [REVIEW-2506-B S3-1] The 04:00 flag-ratings job runs three passes: flag
// rating-bombing, the 72 h double-blind release, and the rating-outbox pass —
// the ONLY sweep for orphaned SAFETY_INTAKE / RELEASE / STATS commands. The job
// is not retry-certified (recovery-policy: NOT_CERTIFIED), so its first error is
// final until 04:00 tomorrow. A throw in an earlier pass must therefore never
// skip the outbox pass: it runs whatever happened before it, and the first
// error is still raised afterwards so the failure stays visible.
// ---------------------------------------------------------------------------

const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
const ctx = { prisma: {} as never, io: {} as never, log: log as never };

afterEach(() => { vi.restoreAllMocks(); log.info.mockClear(); log.error.mockClear(); });

describe('the flag-ratings sweep always reaches the rating-outbox pass', () => {
  it('a release sweep that throws still runs the outbox pass, then fails the job with that error', async () => {
    vi.spyOn(RatingService.prototype, 'flagSuspiciousRatings').mockResolvedValue(0);
    vi.spyOn(RatingService.prototype, 'releaseDoubleBlind').mockRejectedValue(new Error('release failed'));
    const outbox = vi.spyOn(RatingService.prototype, 'processRatingOutbox').mockResolvedValue({ processed: 2, failed: 0 });
    await expect(runFlagRatingsSweep(ctx, () => undefined)).rejects.toThrow('release failed');
    expect(outbox).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalled();
  });

  it('a flagging pass that throws still runs the release and the outbox pass', async () => {
    vi.spyOn(RatingService.prototype, 'flagSuspiciousRatings').mockRejectedValue(new Error('flag failed'));
    const release = vi.spyOn(RatingService.prototype, 'releaseDoubleBlind').mockResolvedValue(3);
    const outbox = vi.spyOn(RatingService.prototype, 'processRatingOutbox').mockResolvedValue({ processed: 0, failed: 0 });
    await expect(runFlagRatingsSweep(ctx, () => undefined)).rejects.toThrow('flag failed');
    expect(release).toHaveBeenCalledTimes(1);
    expect(outbox).toHaveBeenCalledTimes(1);
  });

  it('all passes fine: no error, every pass ran once', async () => {
    vi.spyOn(RatingService.prototype, 'flagSuspiciousRatings').mockResolvedValue(1);
    vi.spyOn(RatingService.prototype, 'releaseDoubleBlind').mockResolvedValue(4);
    const outbox = vi.spyOn(RatingService.prototype, 'processRatingOutbox').mockResolvedValue({ processed: 1, failed: 0 });
    await expect(runFlagRatingsSweep(ctx, () => undefined)).resolves.toEqual({ flagged: 1, released: 4, outbox: { processed: 1, failed: 0 } });
    expect(outbox).toHaveBeenCalledTimes(1);
  });
});
