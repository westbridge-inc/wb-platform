import { useEffect } from 'react';
import { holdOtaRestart } from '../lib/otaCatchUp';

/** [OTA-CATCH-UP · REVIEW-1 S3-1/L1 on #2431] While `active`, the app never restarts into a downloaded update. */
export function useOtaRestartHold(active: boolean): void {
  useEffect(() => (active ? holdOtaRestart() : undefined), [active]);
}
