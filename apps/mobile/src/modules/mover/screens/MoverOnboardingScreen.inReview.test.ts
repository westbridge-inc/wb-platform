import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MOVER_IN_REVIEW } from '../../../components/onboarding/documentChecklistPresentation';

// [FOLLOWUPS 11 Nov 2026 · REVIEW-2490 S4-3] "This screen updates by itself" must be true both ways. An approval
// arrives through the root's polled read (MoverStack MoverRoot). A paper sent back is read by this screen's own
// vehicle read, which did not poll, so the in-review header could stay until the screen was opened again. That read
// now polls while the papers are in review (and only then).
const screen = readFileSync(new URL('./MoverOnboardingScreen.tsx', import.meta.url), 'utf8');

describe('[REVIEW-2490 S4-3] the in-review words are true', () => {
  it('the vehicle read polls while in review', () => {
    expect(screen).toContain("useVerificationStatus<any>('MOVER', vt, { poll: pollInReview })");
    expect(screen).toContain('useEffect(() => { setPollInReview(inReview); }, [inReview]);');
  });

  it('the words promise only what happens: an approval or a paper sent back shows by itself', () => {
    expect(MOVER_IN_REVIEW.body).toContain('This screen updates by itself: when they are approved, or if one is sent back.');
    expect(MOVER_IN_REVIEW.body).not.toMatch(/we.ll (let you know|notify|text)/i);
  });
});
