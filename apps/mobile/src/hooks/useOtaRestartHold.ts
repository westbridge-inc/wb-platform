import { useEffect } from 'react';
import { claimOtaRestingRoute, holdOtaRestart } from '../lib/otaCatchUp';

/** [OTA-CATCH-UP · REVIEW-1 S3-1/L1 on #2431] While `active`, the app never restarts into a downloaded update. */
export function useOtaRestartHold(active: boolean): void {
  useEffect(() => (active ? holdOtaRestart() : undefined), [active]);
}

/** [PROD-RIDER-TEST (b)3] While `resting`, the screen at `route` counts as a resting one: a downloaded update may
 *  restart the app there (inside a window, after the settle, with nothing busy). */
export function useOtaRestingRoute(route: string, resting: boolean): void {
  useEffect(() => (resting ? claimOtaRestingRoute(route) : undefined), [route, resting]);
}
