import { describe, expect, it } from 'vitest';
import { acceptedJobParams, acceptedJobState, jobAnswerIsOver } from './acceptedJob';

// [APP-SPEED 6 · 7 Nov 2026] The pure rules behind landing on the job at the accept's answer and leaving it at
// the completion's answer (screens: MoverHome.acceptLanding / ActiveJobScreen.acceptedLanding navigation tests).
describe('[APP-SPEED 6] the accepted job', () => {
  it('the route params carry the accepted order and the moment of the answer', () => {
    expect(acceptedJobParams('ride-1', 42)).toEqual({ acceptedOrderId: 'ride-1', acceptedAt: 42 });
  });

  it('waiting until a read made after the accept lands; failed (never "none") when that read failed', () => {
    const at = { acceptedAt: 1000 };
    expect(acceptedJobState(at, { isFetching: true, isError: false, dataUpdatedAt: 999 })).toBe('waiting');
    expect(acceptedJobState(at, { isFetching: false, isError: false, dataUpdatedAt: 999 }), 'no read after the accept yet: still waiting').toBe('waiting');
    expect(acceptedJobState(at, { isFetching: true, isError: true, dataUpdatedAt: 999 }), 'an older failure while a read is on its way').toBe('waiting');
    expect(acceptedJobState(at, { isFetching: false, isError: true, dataUpdatedAt: 999 }), 'the read after the accept failed, every retry spent').toBe('failed');
    expect(acceptedJobState(at, { isFetching: true, isError: true, dataUpdatedAt: 999, errorUpdatedAt: 1500 }), '[review S3] a poll or Try again on its way after that failure: still failed, no flicker').toBe('failed');
    expect(acceptedJobState(at, { isFetching: true, isError: true, dataUpdatedAt: 999, errorUpdatedAt: 500 }), 'a failure from before the accept, a read on its way').toBe('waiting');
    expect(acceptedJobState(at, { isFetching: false, isError: false, dataUpdatedAt: 1000 }), 'a read from after the accept is the answer').toBe('answered');
    expect(acceptedJobState(undefined, { isFetching: true, isError: false, dataUpdatedAt: 0 }), 'no accept').toBe('answered');
    expect(acceptedJobState({ acceptedAt: 'soon' }, { isFetching: true, isError: false, dataUpdatedAt: 0 })).toBe('answered');
    expect(acceptedJobState({ acceptedAt: Number.NaN }, { isFetching: true, isError: false, dataUpdatedAt: 0 })).toBe('answered');
  });

  it('an answer says the job is over only with a finished status, in words', () => {
    for (const status of ['DELIVERED', 'COMPLETED', 'FAILED', 'CANCELLED', 'RETURNED', 'REFUNDED']) expect(jobAnswerIsOver({ status })).toBe(true);
    for (const status of ['RETURNING', 'ARRIVED', 'PICKED_UP', 'RIDE_IN_PROGRESS', '', 42, null]) expect(jobAnswerIsOver({ status })).toBe(false);
    expect(jobAnswerIsOver(null)).toBe(false);
    expect(jobAnswerIsOver(undefined)).toBe(false);
  });
});
