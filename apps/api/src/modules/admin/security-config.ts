import { AppError } from '../../utils/errors';
import { runtimeMode } from '../../utils/runtime-mode';

/**
 * [money review on #2499 · coordinator ruling, 13 Nov 2026] THE GENERIC CONFIG ROUTE WRITES ONLY WHAT THE CONSOLE EDITS.
 *
 * `PUT /config/:key` used to write ANY key, so a person could move a security control (the solo-approval cool-off,
 * `approvals.solo.cooloff_hours`), a machine-owned state (billing pauses, the reaper's heartbeat, ops pages,
 * document retention) or anything added later. It is now an ALLOWLIST: exactly the keys Mission Control's Config page
 * edits (apps/admin/src/app/config/page.tsx; a test keeps the two equal). Everything else is refused before the
 * two-person gate stores an ask, and on every write; such a setting changes through its own route or an owner-signed
 * seed. Tests and local development may also write `test.*` keys (never in production or loadtest).
 */
export const CONSOLE_WRITABLE_CONFIG_KEYS: readonly string[] = ['order_auto_reject_minutes', 'app_min_build_ios', 'app_min_build_android'];
export const TEST_CONFIG_PREFIX = 'test.';

export function isGenericConfigWritable(key: string, env: Record<string, string | undefined> = process.env): boolean {
  if (CONSOLE_WRITABLE_CONFIG_KEYS.includes(key)) return true;
  if (!key.startsWith(TEST_CONFIG_PREFIX)) return false;
  try {
    const mode = runtimeMode(env);
    return mode === 'test' || mode === 'development';
  } catch {
    return false;
  }
}

export function assertGenericConfigWritable(key: unknown): void {
  if (typeof key !== 'string' || !isGenericConfigWritable(key)) {
    throw new AppError(409, 'CONFIG_KEY_NOT_WRITABLE', 'This setting cannot be changed here. Only the settings on the Config page can; others change through their own screen or a reviewed, owner-signed change.');
  }
}
