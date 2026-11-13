import { AppError } from '../../utils/errors';
import { SOLO_COOLOFF_CONFIG_KEY } from './solo-approval';

/**
 * [money review on #2499 · coordinator, 13 Nov 2026] Config rows that are SECURITY CONTROLS, never moved through the
 * generic `PUT /config/:key`: the solo-approval cool-off (an admin could shorten the wait that is the only brake on a
 * one-person money act), backup freshness evidence, the upload scanner's state, and any future approvals / security /
 * auth / admin setting. They change through their own reviewed path (the owner-signed seed). Matched without regard to
 * case. (Billing-owned keys are refused the same way by machine-owned-config.ts.)
 */
const SECURITY_CONTROL_PREFIXES: readonly string[] = ['approvals.', 'security.', 'auth.', 'admin.', 'malware_scanner:', 'last_backup_'];
const SECURITY_CONTROL_KEYS: readonly string[] = [SOLO_COOLOFF_CONFIG_KEY];

export function isSecurityControlConfigKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECURITY_CONTROL_KEYS.some((c) => c.toLowerCase() === k) || SECURITY_CONTROL_PREFIXES.some((p) => k.startsWith(p));
}

export function assertNotSecurityControlConfigKey(key: unknown): void {
  if (typeof key === 'string' && isSecurityControlConfigKey(key)) {
    throw new AppError(409, 'CONFIG_KEY_SECURITY_CONTROL', 'This setting is a security control, so it cannot be changed here. It changes only through a reviewed, owner-signed change.');
  }
}
