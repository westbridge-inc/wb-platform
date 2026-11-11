/**
 * [PROD-RIDER-TEST 11 Nov 2026 · COORD ruling (b)3] When the rider's (or driver's) home may take a downloaded update:
 * only when nothing on it can be cut. The job read must have answered (an unknown is never "no job"), with no live
 * job and no run, and no offer card may be up or waiting behind another. Pure: the screen wires it to
 * useOtaRestingRoute('MoverRoot', …) (lib/otaCatchUp claimOtaRestingRoute).
 */
export interface MoverHomeRestingInput {
  kind: string | null | undefined;
  /** The active-job read answered (react-query isSuccess). */
  jobKnown: boolean;
  activeJob: unknown;
  run: unknown;
  offer: unknown;
  queuedBehind: number;
}

export function moverHomeResting(input: MoverHomeRestingInput): boolean {
  return !!input.kind
    && input.jobKnown
    && !input.activeJob
    && !input.run
    && !input.offer
    && input.queuedBehind === 0;
}
