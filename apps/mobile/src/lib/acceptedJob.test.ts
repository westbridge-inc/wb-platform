import { describe, expect, it } from 'vitest';
import { acceptedJobParams, awaitingAcceptedJob, jobAnswerIsOver } from './acceptedJob';

// [APP-SPEED 6 · 7 Nov 2026] The pure rules behind landing on the job at the accept's answer and leaving it at
// the completion's answer (screens: MoverHome.acceptLanding / ActiveJobScreen.acceptedLanding navigation tests).
describe('[APP-SPEED 6] the accepted job', () => {
  it('the route params carry the accepted order and the moment of the answer', () => {
    expect(acceptedJobParams('ride-1', 42)).toEqual({ acceptedOrderId: 'ride-1', acceptedAt: 42 });
  });

  it('loading only while the first read made after the accept is on its way', () => {
    const at = { acceptedAt: 1000 };
    expect(awaitingAcceptedJob(at, { isFetching: true, dataUpdatedAt: 999 })).toBe(true);
    expect(awaitingAcceptedJob(at, { isFetching: false, dataUpdatedAt: 999 }), 'a read that is not on its way never hangs the screen').toBe(false);
    expect(awaitingAcceptedJob(at, { isFetching: true, dataUpdatedAt: 1000 }), 'a read from after the accept is the answer').toBe(false);
    expect(awaitingAcceptedJob(undefined, { isFetching: true, dataUpdatedAt: 0 }), 'no accept: never').toBe(false);
    expect(awaitingAcceptedJob({ acceptedAt: 'soon' }, { isFetching: true, dataUpdatedAt: 0 })).toBe(false);
    expect(awaitingAcceptedJob({ acceptedAt: Number.NaN }, { isFetching: true, dataUpdatedAt: 0 })).toBe(false);
  });

  it('an answer says the job is over only with a finished status, in words', () => {
    for (const status of ['DELIVERED', 'COMPLETED', 'FAILED', 'CANCELLED', 'RETURNED', 'REFUNDED']) expect(jobAnswerIsOver({ status })).toBe(true);
    for (const status of ['RETURNING', 'ARRIVED', 'PICKED_UP', 'RIDE_IN_PROGRESS', '', 42, null]) expect(jobAnswerIsOver({ status })).toBe(false);
    expect(jobAnswerIsOver(null)).toBe(false);
    expect(jobAnswerIsOver(undefined)).toBe(false);
  });
});
