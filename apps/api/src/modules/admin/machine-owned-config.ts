import { AppError } from '../../utils/errors';
import { FEE_PAUSE_OPEN_KEY, FEE_PAUSE_REPAIR_PREFIX, MMG_PAUSE_CLOCKS_KEY, MMG_REACTIVATED_PREFIX } from '../billing/mmg-pause';
import { FEE_RISE_PREFIX } from '../billing/fee-rise-notice';
import { PROVIDER_IDENTITY_BACKFILL_KEY } from '../billing/provider-identity-backfill';
import { HIRE_SPLIT_STARTED_KEY } from '../verification/hire-permit-grace';
import { LAST_REAPER_RUN_KEY } from '../ops/reaper-freshness';
import { HOME_NOTICE_KEY } from '../ops/home-notice';

/**
 * [AUDIT C2-2 · 13 Nov 2026] Config rows the server writes for itself, never a person through the generic
 * `PUT /config/:key`. `billing.mmg_pause.open` written with an old date while a pay path is live would pause every due
 * clock from that date and forgive arrears fleet-wide; the others are a billing state, a one-time marker or a setting
 * with its own validated route (agent cash's rail). Matched without regard to case.
 */
const MACHINE_OWNED_PREFIXES: readonly string[] = [
  // 'billing.retier_lower:' is billing.service's RETIER_LOWER_PREFIX (spelled here so this gate never imports the
  // billing engine; a test pins the two together).
  'billing.mmg_pause.', FEE_PAUSE_REPAIR_PREFIX, MMG_REACTIVATED_PREFIX, FEE_RISE_PREFIX, 'billing.retier_lower:', 'system:',
];
const MACHINE_OWNED_KEYS: readonly string[] = [
  FEE_PAUSE_OPEN_KEY, MMG_PAUSE_CLOCKS_KEY, PROVIDER_IDENTITY_BACKFILL_KEY, HIRE_SPLIT_STARTED_KEY, LAST_REAPER_RUN_KEY,
  // Its own route checks the webhook is configured before promising webhook speed.
  'billing.mmg_agent.ingestion_mode',
  // [HOME-NOTICE] Its own routes check the words and make turning it off immediate (ops/home-notice.ts).
  HOME_NOTICE_KEY,
];

export function isMachineOwnedConfigKey(key: string): boolean {
  const k = key.toLowerCase();
  return MACHINE_OWNED_KEYS.some((owned) => owned.toLowerCase() === k)
    || MACHINE_OWNED_PREFIXES.some((prefix) => k.startsWith(prefix.toLowerCase()));
}

export function assertConfigKeyWritable(key: unknown): void {
  if (typeof key === 'string' && isMachineOwnedConfigKey(key)) {
    throw new AppError(409, 'CONFIG_KEY_MACHINE_OWNED', 'Swift writes this setting itself, so it cannot be changed here. Use the screen that owns it, or ask for a reviewed change.');
  }
}
