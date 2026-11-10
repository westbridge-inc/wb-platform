import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { FREE_CANCEL_WINDOW_MIN } from '../modules/order/cancel-policy';
import { spawnSync } from 'node:child_process';
import { generateKeyPair, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeBootConfig, assertProductionData, assertWallLoginConfig, ORDER_HOLD_FLOOR_MIN } from '../utils/boot-config';
import { applySecretFiles } from '../utils/secret-files';
import { PUBLICATION_LEASE_MS, publicationHeartbeatMs, publicationLeaseMs } from '../modules/billing/settlement-publication-lease';
import { testControlIdentity } from '../modules/ops/test-control';
import { identitySalt } from '../modules/integrity/normalize';

// SWIFT-AUD-D9-02 / D3-01: production must refuse to boot without the two
// secrets that keep KYC documents private (envelope KEK + render HMAC), and
// without the OTP-bypass guard. Non-production is unaffected.

const KEK = Buffer.alloc(32, 7).toString('base64'); // valid 32-byte base64
// [22 Oct, COORD ruling] Production never sends MMG charge requests, so with MMG live the checkout
// page is the only MMG way to pay: production refuses MMG_DRIVER=live without MMG_CHECKOUT_ENABLED=1.
// The valid production base therefore carries a complete checkout configuration. The keys are
// synthetic, generated here; each PEM is written on one line with a literal \n, as an env file
// (and the preflight's candidate file) carries it.
const baseCheckoutKeys = generateKeyPairSync('rsa', { modulusLength: 4096 });
const oneLinePem = (pem: string) => pem.trim().replace(/\n/g, '\\n');
const baseCheckout: Record<string, string> = {
  MMG_CHECKOUT_ENABLED: '1',
  MMG_CHECKOUT_URL: 'https://checkout.example.test/mmg-pg/web/payments',
  MMG_CHECKOUT_MERCHANT_ID: '0000001',
  MMG_CHECKOUT_CLIENT_ID: 'client-test',
  MMG_CHECKOUT_MERCHANT_NAME: 'Swift Test',
  MMG_CHECKOUT_RETURN_ORIGIN: 'https://pay.example.test',
  MMG_CHECKOUT_SECRET_KEY: 'not-a-secret',
  MMG_CHECKOUT_PUBLIC_KEY: oneLinePem(baseCheckoutKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()),
  MMG_CHECKOUT_PRIVATE_KEY: oneLinePem(baseCheckoutKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
};
const messagingServiceSid = `MG${'c'.repeat(32)}`;
const good: Record<string, string | undefined> = {
  NODE_ENV: 'production',
  PLACES_PROVIDER: 'osm',
  PHOTON_URL: 'http://photon.test',
  // [ledger E08] The settled production posture ships the hold ON in both env
  // examples, so the valid production base carries it explicitly.
  LIFECYCLE_V2: '1',
  // [owner 30 Oct 2026] the store-order hold is one minute (was five).
  ORDER_HOLD_MINUTES: '1',
  MASTER_KEK: KEK,
  STORAGE_SIGNING_SECRET: 'a-managed-signing-secret-of-at-least-32-chars',
  STORAGE_PROVIDER: 's3',
  AWS_S3_BUCKET: 'synthetic-boot-bucket',
  NOTIFICATION_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_API_KEY_SID: `SK${'b'.repeat(32)}`,
  TWILIO_API_KEY_SECRET: 'test-key-secret',
  TWILIO_FROM: '+15550000000',
  PUSH_PROVIDER: 'expo',
  JWT_SECRET: 'test-jwt-secret-at-least-32-characters',
  KYC_PROVIDER: 'manual',
  // [CARDS-SWITCH-ON] Production boots with cards off until the owner's
  // go-cards ruling (OWNER-DECISIONS, dated at the go): the valid production base has cards off. The
  // live Stripe key stays so a case that switches the provider back on still
  // passes the provider's own checks and reaches the lock.
  PAYMENT_PROVIDER: 'disabled',
  CARD_RAIL_KILL: '1',
  STRIPE_SECRET_KEY: 'sk_live_boot_config_test',
  MMG_DRIVER: 'live',
  MMG_API_URL: 'https://api.mmg.gy/olive/publisher/v1',
  MMG_API_KEY: 'mmg-api-key',
  MMG_MERCHANT_ID: '5926000000',
  MMG_PASSWORD: 'mmg-password',
  MMG_MKEY: 'mmg-mkey',
  MMG_MSECRET: 'mmg-msecret',
  MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1',
  ...baseCheckout,
  // [PROD-PATH] Production pages a human for every unacknowledged SOS and
  // sends receipts and expiry notices by email: both are required to boot.
  OPS_ONCALL_PHONES: '+5926000001,+15550000002',
  EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '465',
  SMTP_USER: 'noreply@example.test',
  SMTP_PASS: 'smtp-password-of-the-sending-mailbox',
  EMAIL_FROM: 'Swift <noreply@example.test>',
  SCAN_IP_SALT: 'synthetic-scan-boot-salt',
  ATTRIB_SALT: 'synthetic-attribution-boot-salt',
  // [row 331 · CONFIG-GUARDS] The identity-signal HMAC key is a boot guard too.
  IDENTITY_SALT: 'synthetic-identity-boot-salt',
  // [PROD-PATH] Admin top-ups stay on hold in production (owner ruling, 8 Oct).
  BILLING_TOPUP_HOLD: '1',
};

const cardOff = {
  ...good,
  PAYMENT_PROVIDER: 'disabled',
  CARD_RAIL_KILL: '1',
  STRIPE_SECRET_KEY: undefined,
  PAYMENT_GATEWAY_KEY: undefined,
  PAYMENT_GATEWAY_SECRET: undefined,
  POWERTRANZ_API_URL: undefined,
};

const paddedTwilioIdentities = ([
  ['TWILIO_ACCOUNT_SID', good['TWILIO_ACCOUNT_SID']],
  ['TWILIO_API_KEY_SID', good['TWILIO_API_KEY_SID']],
  ['TWILIO_FROM', good['TWILIO_FROM']],
  ['TWILIO_MESSAGING_SERVICE_SID', messagingServiceSid],
] as const).flatMap(([name, valid]) => [' ', '\t', '\r', '\n'].flatMap((whitespace) => [
  { name, value: `${whitespace}${valid}`, position: 'leading', whitespace: JSON.stringify(whitespace) },
  { name, value: `${valid}${whitespace}`, position: 'trailing', whitespace: JSON.stringify(whitespace) },
]));

function runPreflight(candidate: Record<string, string | undefined>) {
  const directory = mkdtempSync(join(tmpdir(), 'swift-twilio-preflight-'));
  try {
    const candidatePath = join(directory, 'candidate.txt');
    writeFileSync(candidatePath, Object.entries(candidate)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => `${name}=${value}`).join('\n'));
    const tsx = join(process.cwd(), 'node_modules/.bin/tsx');
    const script = join(process.cwd(), '../../deploy/preflight.ts');
    return spawnSync(tsx, [script, candidatePath], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '' },
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

/** [CARD-STAGING-TEST 10 Nov 2026] The provider's settings a server running card rail v2 on its sandbox must be able to
 *  read (synthetic values; the credentials arrive as files on a real server). */
const SANDBOX_READY = {
  CARD_RAIL_ACCOUNT: 'swift-staging-sandbox', POWERTRANZ_ID: 'TESTID01', POWERTRANZ_PASSWORD: 'not-a-real-password-7Q',
  POWERTRANZ_PAGE_SET: 'PTZ/SWIFT', POWERTRANZ_PAGE_NAME: 'WeeklyFee',
};

describe('assertSafeBootConfig — fail-closed production secrets', () => {
  it.each([
    ['CONSENT_REQUIRED', '0'],
    ['ADMIN_CAPABILITY_MODE', 'shadow'],
    ['PREVIEW_MODE', '1'],
  ])('launch bypass %s=%s is refused by production', (name, value) => {
    expect(() => assertSafeBootConfig({ ...good, [name]: value })).toThrow(name);
  });

  it.each(['development', 'test'])('launch bypass fixtures remain available in %s', (mode) => {
    expect(() => assertSafeBootConfig({
      NODE_ENV: mode,
      CONSENT_REQUIRED: '0',
      ADMIN_CAPABILITY_MODE: 'shadow',
      PREVIEW_MODE: '1',
    })).not.toThrow();
  });

  it('launch bypass defaults keep production admission open', () => {
    expect(() => assertSafeBootConfig({
      ...good, CONSENT_REQUIRED: '1', ADMIN_CAPABILITY_MODE: 'enforce', PREVIEW_MODE: '0',
    })).not.toThrow();
    expect(() => assertSafeBootConfig(good)).not.toThrow();
  });

  it('boots with the card rail explicitly disabled and no card credentials', () => {
    expect(() => assertSafeBootConfig(cardOff)).not.toThrow();
  });

  it.each([undefined, '', '0', 'true', '01'])('refuses disabled cards with an ineffective kill switch (%s)', (kill) => {
    expect(() => assertSafeBootConfig({ ...cardOff, CARD_RAIL_KILL: kill })).toThrow(/CARD_RAIL_KILL/);
  });

  it.each([undefined, '', 'disable', 'DISABLED', 'disabled ', 'sandbox'])('does not infer card OFF from provider %s', (provider) => {
    expect(() => assertSafeBootConfig({ ...cardOff, PAYMENT_PROVIDER: provider })).toThrow(/PAYMENT_PROVIDER/);
  });

  it.each(['stripe', 'powertranz'])('still requires credentials for %s even with the kill switch on', (provider) => {
    expect(() => assertSafeBootConfig({ ...cardOff, PAYMENT_PROVIDER: provider })).toThrow(/STRIPE_SECRET_KEY|PAYMENT_GATEWAY_KEY/);
  });

  it.each(['MMG_DRIVER', 'MMG_API_URL', 'MMG_API_KEY', 'MMG_MERCHANT_ID', 'MMG_PASSWORD', 'MMG_MKEY', 'MMG_MSECRET'])(
    'still requires %s with cards OFF', (name) => {
      expect(() => assertSafeBootConfig({ ...cardOff, [name]: undefined })).toThrow(/MMG/);
    },
  );

  it('still rejects sandbox and UAT MMG with cards OFF', () => {
    expect(() => assertSafeBootConfig({ ...cardOff, MMG_DRIVER: 'sandbox' })).toThrow(/MMG_DRIVER/);
    expect(() => assertSafeBootConfig({ ...cardOff, MMG_API_URL: 'https://mwallet.mmgtest.net' })).toThrow(/non-UAT/);
  });

  it('preflight accepts explicit card OFF and rejects a reachable card charge rail', () => {
    const off = runPreflight(cardOff);
    expect(off.status, off.stdout + off.stderr).toBe(0);
    const reachable = runPreflight({ ...cardOff, CARD_RAIL_KILL: '0' });
    expect(reachable.status, reachable.stdout + reachable.stderr).toBe(1);
    expect(reachable.stdout).toContain('CARD_RAIL_KILL');
  });

  it('boots when every required secret is present', () => {
    expect(() => assertSafeBootConfig(good)).not.toThrow();
  });

  it('refuses to boot in production without MASTER_KEK (KYC would store plaintext)', () => {
    expect(() => assertSafeBootConfig({ ...good, MASTER_KEK: undefined })).toThrow(/MASTER_KEK/);
  });

  it('refuses a malformed (non-32-byte) MASTER_KEK', () => {
    expect(() => assertSafeBootConfig({ ...good, MASTER_KEK: 'too-short' })).toThrow(/32 bytes/);
  });

  it('refuses to boot in production without STORAGE_SIGNING_SECRET (render token forgeable)', () => {
    expect(() => assertSafeBootConfig({ ...good, STORAGE_SIGNING_SECRET: undefined })).toThrow(/STORAGE_SIGNING_SECRET/);
  });

  it('refuses the published default STORAGE_SIGNING_SECRET in production', () => {
    expect(() => assertSafeBootConfig({ ...good, STORAGE_SIGNING_SECRET: 'dev-signing-secret' })).toThrow(/STORAGE_SIGNING_SECRET/);
    // [M-37] Non-default is not enough: a short secret is a guessable one.
    expect(() => assertSafeBootConfig({ ...good, STORAGE_SIGNING_SECRET: 'short-but-not-default' })).toThrow(/32 characters/);
  });

  it('still refuses DEV_OTP_BYPASS=1 in production', () => {
    expect(() => assertSafeBootConfig({ ...good, DEV_OTP_BYPASS: '1' })).toThrow(/DEV_OTP_BYPASS/);
  });

  it('requires a strong keyed-HMAC secret for OTP records', () => {
    expect(() => assertSafeBootConfig({ ...good, JWT_SECRET: undefined })).toThrow(/OTP_HASH_SECRET|JWT_SECRET/);
    expect(() => assertSafeBootConfig({ ...good, JWT_SECRET: 'too-short' })).toThrow(/32 characters/);
    expect(() => assertSafeBootConfig({ ...good, JWT_SECRET: undefined, OTP_HASH_SECRET: 'dedicated-otp-secret-at-least-32-chars' })).not.toThrow();
  });

  it.each([undefined, 'didit', 'idanalyzer'])('preflight reports refused KYC %j once and continues to the next missing setting', (provider) => {
    const result = runPreflight({ ...good, KYC_PROVIDER: provider, PUSH_PROVIDER: undefined });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout.match(/✗ FATAL: KYC_PROVIDER/g)).toHaveLength(1);
    expect(result.stdout).toContain('✗ FATAL: PUSH_PROVIDER is dev');
    expect(result.stdout).not.toContain('stubbing changed nothing');
  });

  it.each(['didit', 'idanalyzer'])('refuses external KYC %s even with credentials in production', (provider) => {
    expect(() => assertSafeBootConfig({ ...good, KYC_PROVIDER: provider, DIDIT_API_KEY: 'synthetic-test-key', ID_ANALYZER_API_KEY: 'synthetic-test-key' })).toThrow(/KYC_PROVIDER/);
  });

  // [GUARDRAILS §8 · owner: face matching OFF, identity checks by a person only] The biometric switch
  // cannot be turned on in production: the boot guard refuses it, so no face-matching leg can run there.
  it('refuses production face matching (FEATURE_BIOMETRIC_FACE_MATCH=1) even on the human-review provider', () => {
    expect(() => assertSafeBootConfig({ ...good, FEATURE_BIOMETRIC_FACE_MATCH: '1' })).toThrow(/FEATURE_BIOMETRIC_FACE_MATCH/);
  });

  it.each([undefined, '', '0'])('boots with face matching off (FEATURE_BIOMETRIC_FACE_MATCH=%j)', (flag) => {
    expect(() => assertSafeBootConfig({ ...good, FEATURE_BIOMETRIC_FACE_MATCH: flag })).not.toThrow();
  });

  it('preflight reports production face matching once and continues to the next missing setting', () => {
    const result = runPreflight({ ...good, FEATURE_BIOMETRIC_FACE_MATCH: '1', PUSH_PROVIDER: undefined });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout.match(/✗ FATAL: FEATURE_BIOMETRIC_FACE_MATCH/g)).toHaveLength(1);
    expect(result.stdout).toContain('✗ FATAL: PUSH_PROVIDER is dev');
    expect(result.stdout).not.toContain('stubbing changed nothing');
  });

  it('refuses sandbox or unconfigured KYC in production', () => {
    expect(() => assertSafeBootConfig({ ...good, KYC_PROVIDER: undefined })).toThrow(/KYC_PROVIDER/);
    expect(() => assertSafeBootConfig({ ...good, KYC_PROVIDER: 'sandbox' })).toThrow(/KYC_PROVIDER/);
    expect(() => assertSafeBootConfig({ ...good, KYC_PROVIDER: 'didit', DIDIT_API_KEY: undefined })).toThrow(/KYC_PROVIDER/);
    expect(() => assertSafeBootConfig({ ...good, KYC_PROVIDER: 'idanalyzer', ID_ANALYZER_API_KEY: undefined })).toThrow(/KYC_PROVIDER/);
  });

  it('refuses sandbox/test subscription card processors in production', () => {
    expect(() => assertSafeBootConfig({ ...good, PAYMENT_PROVIDER: undefined })).toThrow(/PAYMENT_PROVIDER/);
    expect(() => assertSafeBootConfig({ ...good, PAYMENT_PROVIDER: 'sandbox' })).toThrow(/PAYMENT_PROVIDER/);
    expect(() => assertSafeBootConfig({ ...good, PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_not_money' })).toThrow(/live STRIPE_SECRET_KEY/);
    expect(() => assertSafeBootConfig({
      ...good,
      PAYMENT_PROVIDER: 'powertranz',
      PAYMENT_GATEWAY_KEY: 'id',
      PAYMENT_GATEWAY_SECRET: 'secret',
      POWERTRANZ_API_URL: 'https://staging.ptranz.com',
    })).toThrow(/non-staging/);
  });

  it('refuses sandbox, UAT, or incomplete MMG collection in production', () => {
    expect(() => assertSafeBootConfig({ ...good, MMG_DRIVER: undefined })).toThrow(/MMG_DRIVER/);
    expect(() => assertSafeBootConfig({ ...good, MMG_DRIVER: 'sandbox' })).toThrow(/MMG_DRIVER/);
    expect(() => assertSafeBootConfig({ ...good, MMG_MSECRET: undefined })).toThrow(/MMG_MSECRET/);
    expect(() => assertSafeBootConfig({ ...good, MMG_API_URL: 'https://mwallet.mmgtest.net/olive/publisher/v1' })).toThrow(/non-UAT/);
  });

  // [S1 · SWITCHES 21 Oct, Option A] Live MMG in production is the checkout page, its lookup and
  // reversals; the reference round-trip flag only proves the push rail, which production refuses.
  it.each([undefined, '', '0', 'yes', '1'])('boots live MMG whatever the round-trip flag says (%j): it is not a condition of the checkout', (verified) => {
    expect(() => assertSafeBootConfig({ ...good, MMG_REFERENCE_ROUNDTRIP_VERIFIED: verified })).not.toThrow();
  });

  it.each(['1', 'true', 'yes', 'on', ' 1', '01'])('refuses the MMG push rail switch in production (MMG_PUSH_RAIL_ON=%j), whatever the driver', (value) => {
    expect(() => assertSafeBootConfig({ ...good, MMG_PUSH_RAIL_ON: value })).toThrow(/MMG_PUSH_RAIL_ON/);
    expect(() => assertSafeBootConfig({ ...good, MMG_REFERENCE_ROUNDTRIP_VERIFIED: undefined, MMG_PUSH_RAIL_ON: value })).toThrow(/MMG_PUSH_RAIL_ON/);
    expect(() => assertSafeBootConfig({ ...cardOff, MMG_DRIVER: 'disabled', MMG_CHECKOUT_ENABLED: undefined, MMG_API_URL: undefined, MMG_API_KEY: undefined, MMG_MERCHANT_ID: undefined, MMG_PASSWORD: undefined, MMG_MKEY: undefined, MMG_MSECRET: undefined, MMG_PUSH_RAIL_ON: value })).toThrow(/MMG_PUSH_RAIL_ON/);
  });

  it.each([undefined, '', '0'])('boots with the MMG push rail switch off (%j)', (value) => {
    expect(() => assertSafeBootConfig({ ...good, MMG_PUSH_RAIL_ON: value })).not.toThrow();
  });

  it('SWIFT-012: refuses the dev (console) notification provider in production — OTP would never send', () => {
    expect(() => assertSafeBootConfig({ ...good, NOTIFICATION_PROVIDER: 'dev' })).toThrow(/NOTIFICATION_PROVIDER/);
    expect(() => assertSafeBootConfig({ ...good, NOTIFICATION_PROVIDER: undefined })).toThrow(/NOTIFICATION_PROVIDER/);
  });

  it('SWIFT-012: accepts a real notification provider (twilio)', () => {
    expect(() => assertSafeBootConfig({ ...good, NOTIFICATION_PROVIDER: 'twilio' })).not.toThrow();
  });

  it('refuses incomplete Twilio API-key configuration at production boot', () => {
    for (const name of ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_FROM'] as const) {
      expect(() => assertSafeBootConfig({ ...good, [name]: undefined }), name).toThrow(name);
      expect(() => assertSafeBootConfig({ ...good, [name]: '   ' }), name).toThrow(name);
    }
    expect(() => assertSafeBootConfig({ ...good, TWILIO_API_KEY_SECRET: undefined, TWILIO_AUTH_TOKEN: 'legacy-token' }))
      .toThrow(/TWILIO_API_KEY_SECRET/);
  });

  it('refuses nonempty malformed Twilio identifiers at production boot', () => {
    for (const [name, value] of [
      ['TWILIO_ACCOUNT_SID', 'not-an-account-sid'],
      ['TWILIO_ACCOUNT_SID', `AC${'g'.repeat(32)}`],
      ['TWILIO_API_KEY_SID', 'not-an-api-key-sid'],
      ['TWILIO_API_KEY_SID', `SK${'g'.repeat(32)}`],
      ['TWILIO_FROM', 'not-a-phone-number'],
    ] as const) {
      expect(() => assertSafeBootConfig({ ...good, [name]: value }), name).toThrow(name);
    }
  });

  it.each(paddedTwilioIdentities)('refuses literal $position $whitespace in $name at boot and preflight guard', ({ name, value }) => {
    expect(() => assertSafeBootConfig({ ...good, [name]: value })).toThrow(name);
  });

  it('accepts exact Twilio values in the value-free preflight CLI', () => {
    const result = runPreflight(good);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PASS — this configuration will not be refused at boot');
  });

  it('accepts TWILIO_MESSAGING_SERVICE_SID alone as the production sender', () => {
    expect(() => assertSafeBootConfig({
      ...good,
      TWILIO_FROM: undefined,
      TWILIO_MESSAGING_SERVICE_SID: messagingServiceSid,
    })).not.toThrow();
  });

  it('the value-free preflight accepts the Messaging Service SID alone', () => {
    const result = runPreflight({ ...good, TWILIO_FROM: undefined, TWILIO_MESSAGING_SERVICE_SID: messagingServiceSid });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PASS — this configuration will not be refused at boot');
  });

  it('refuses production boot when both Twilio senders are set', () => {
    expect(() => assertSafeBootConfig({ ...good, TWILIO_MESSAGING_SERVICE_SID: messagingServiceSid }))
      .toThrow(/TWILIO_FROM and TWILIO_MESSAGING_SERVICE_SID/);
  });

  it('refuses production boot when neither Twilio sender is set', () => {
    expect(() => assertSafeBootConfig({ ...good, TWILIO_FROM: undefined }))
      .toThrow(/TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID/);
  });

  it('refuses a malformed TWILIO_MESSAGING_SERVICE_SID at production boot', () => {
    // The owner-specified format is exactly ^MG[0-9a-f]{32}$: lowercase hex, 32 digits.
    for (const value of ['not-a-messaging-service-sid', `MG${'g'.repeat(32)}`, `MG${'C'.repeat(32)}`, `MG${'c'.repeat(31)}`, `MG${'c'.repeat(33)}`]) {
      expect(
        () => assertSafeBootConfig({ ...good, TWILIO_FROM: undefined, TWILIO_MESSAGING_SERVICE_SID: value }),
        value,
      ).toThrow(/TWILIO_MESSAGING_SERVICE_SID/);
    }
  });

  it('the sender refusals name the variables and never echo a configured Twilio value', () => {
    const malformedSid = `MG${'g'.repeat(32)}`;
    const cases: Array<[string, Record<string, string | undefined>]> = [
      ['both senders', { ...good, TWILIO_MESSAGING_SERVICE_SID: messagingServiceSid }],
      ['neither sender', { ...good, TWILIO_FROM: undefined }],
      ['malformed SID', { ...good, TWILIO_FROM: undefined, TWILIO_MESSAGING_SERVICE_SID: malformedSid }],
    ];
    const configuredValues = [good['TWILIO_ACCOUNT_SID'], good['TWILIO_API_KEY_SID'], good['TWILIO_API_KEY_SECRET'], good['TWILIO_FROM'], messagingServiceSid, malformedSid] as string[];
    for (const [label, env] of cases) {
      let message = '';
      try { assertSafeBootConfig(env); } catch (error) { message = (error as Error).message; }
      expect(message, label).toMatch(/^FATAL: TWILIO_/);
      for (const value of configuredValues) expect(message, `${label} echoes ${value}`).not.toContain(value);
    }
  });

  it('the value-free preflight refuses both senders once, lists the SID by name, and never prints its value', () => {
    const result = runPreflight({ ...good, TWILIO_MESSAGING_SERVICE_SID: messagingServiceSid });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('REFUSED');
    expect(result.stdout).toContain('TWILIO_FROM and TWILIO_MESSAGING_SERVICE_SID are both set');
    // A stub can only ADD a value, so the walkthrough cannot see past a
    // both-set refusal: it prints the problem once and says so, never 40 times.
    expect(result.stdout.match(/✗ FATAL: TWILIO_FROM and TWILIO_MESSAGING_SERVICE_SID/g)).toHaveLength(1);
    expect(result.stdout).toContain('the walkthrough stops here');
    expect(result.stdout).toContain('PRESENT  TWILIO_MESSAGING_SERVICE_SID');
    expect(result.stdout).not.toContain(messagingServiceSid);
  });

  it('the value-free preflight refuses neither sender and still walks on to the next problem', () => {
    const result = runPreflight({ ...good, TWILIO_FROM: undefined, PUSH_PROVIDER: undefined });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID is required');
    expect(result.stdout).toContain('✗ FATAL: PUSH_PROVIDER is dev');
    expect(result.stdout).toContain('MISSING  TWILIO_MESSAGING_SERVICE_SID');
  });

  it.each(paddedTwilioIdentities.filter(({ whitespace }) => whitespace === '" "' || whitespace === '"\\t"'))(
    'preflight CLI refuses unquoted $position $whitespace in $name', ({ name, value }) => {
      const result = runPreflight({ ...good, [name]: value });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain(`FATAL: ${name} is missing or malformed`);
    },
  );

  it.each(paddedTwilioIdentities.filter(({ whitespace }) => whitespace === '"\\r"' || whitespace === '"\\n"'))(
    'preflight CLI refuses quoted $position $whitespace in $name', ({ name, value }) => {
      const result = runPreflight({ ...good, [name]: `"${value}"` });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain(`FATAL: ${name} is missing or malformed`);
    },
  );

  it('refuses an unknown notification adapter at production boot', () => {
    expect(() => assertSafeBootConfig({ ...good, NOTIFICATION_PROVIDER: 'unknown' })).toThrow(/NOTIFICATION_PROVIDER/);
  });

  it('[NOC-A F1] refuses to boot production on the in-memory push provider', () => {
    // The same trap as NOTIFICATION_PROVIDER, one door over: PUSH_PROVIDER
    // also defaults to 'dev', whose provider appends to an array and reports
    // success — so production would swallow every order alert, dispatch offer
    // and safety ping while looking healthy.
    expect(() => assertSafeBootConfig({ ...good, PUSH_PROVIDER: 'dev' })).toThrow(/PUSH_PROVIDER/);
    expect(() => assertSafeBootConfig({ ...good, PUSH_PROVIDER: undefined })).toThrow(/PUSH_PROVIDER/);
    expect(() => assertSafeBootConfig({ ...good, PUSH_PROVIDER: 'expo' })).not.toThrow();
  });

  // SWIFT-AUD-D6-06: the default 'local' storage provider writes uploads/KYC
  // documents to one instance's disk — fragmenting on multi-instance deploys
  // and sitting outside the backup story. Production must pick a real
  // provider, or explicitly acknowledge a single-instance pilot.
  it('refuses to boot in production with STORAGE_PROVIDER unset (defaults to local disk)', () => {
    expect(() => assertSafeBootConfig({ ...good, STORAGE_PROVIDER: undefined })).toThrow(/STORAGE_PROVIDER/);
  });

  it('refuses local storage in production without the explicit acknowledgement', () => {
    expect(() => assertSafeBootConfig({ ...good, STORAGE_PROVIDER: 'local' })).toThrow(/STORAGE_PROVIDER/);
  });

  it('allows deliberate local storage only with an explicit root and separate backup obligation', () => {
    expect(() => assertSafeBootConfig({ ...good, STORAGE_PROVIDER: 'local', STORAGE_ALLOW_LOCAL: '1' })).toThrow(/UPLOAD_DIR/);
    expect(() => assertSafeBootConfig({ ...good, STORAGE_PROVIDER: 'local', STORAGE_ALLOW_LOCAL: '1', UPLOAD_DIR: '/srv/swift/uploads', STORAGE_LOCAL_BACKUP_ACK: '1' })).not.toThrow();
  });

  it('accepts the real object-storage providers', () => {
    expect(() => assertSafeBootConfig({ ...good, STORAGE_PROVIDER: 'r2' })).not.toThrow();
  });

  it('[TA-S1-007] refuses to boot on an UNSET or misspelled NODE_ENV — never a quiet development posture', () => {
    expect(() => assertSafeBootConfig({})).toThrow(/NODE_ENV must be exactly one of/);
    for (const bad of ['', 'prod', 'Production', 'productio', 'staging']) {
      expect(() => assertSafeBootConfig({ ...good, NODE_ENV: bad }), bad).toThrow(/NODE_ENV must be exactly one of/);
    }
    // And the guard cannot be waved through by mislabelling a live host.
    expect(() => assertSafeBootConfig({ ...good, NODE_ENV: 'prod', MASTER_KEK: undefined })).toThrow(/NODE_ENV/);
  });

  it('does NOT enforce any of this outside production (dev/test/loadtest boot freely)', () => {
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertSafeBootConfig({ NODE_ENV: 'loadtest' })).not.toThrow();
    expect(() => assertSafeBootConfig({ NODE_ENV: 'test', DEV_OTP_BYPASS: '1' })).not.toThrow();
  });
});

// [AX352] SETTLEMENT_PUBLICATION_LEASE_MS shortens the settlement publication
// lease so it can lapse inside a test or a drill. In production a short lease
// could lapse while a slow row replays, before any progress is written, and
// strand the unpaid tail of a settlement file: production refuses to boot with
// any override below the 5-minute default.
describe('[AX352] the settlement publication lease override is test and drill only', () => {
  it('refuses to boot production with the lease shortened: 1000 ms, anything under 5 minutes, or unreadable', () => {
    expect(PUBLICATION_LEASE_MS).toBe(5 * 60_000);
    expect(() => assertSafeBootConfig({ ...good, SETTLEMENT_PUBLICATION_LEASE_MS: '1000' }))
      .toThrow(/FATAL: SETTLEMENT_PUBLICATION_LEASE_MS .*Refusing to start/);
    for (const value of ['299999', '0', '-1', 'abc', ' ']) {
      expect(() => assertSafeBootConfig({ ...good, SETTLEMENT_PUBLICATION_LEASE_MS: value }), value)
        .toThrow(/SETTLEMENT_PUBLICATION_LEASE_MS/);
    }
  });

  it('boots production with the override unset, or no shorter than the default', () => {
    for (const value of [undefined, '', '300000', '600000']) {
      expect(() => assertSafeBootConfig({ ...good, SETTLEMENT_PUBLICATION_LEASE_MS: value }), String(value)).not.toThrow();
    }
  });

  it('allows the short lease in the test, drill and development postures', () => {
    for (const mode of ['test', 'loadtest', 'development']) {
      expect(() => assertSafeBootConfig({ NODE_ENV: mode, SETTLEMENT_PUBLICATION_LEASE_MS: '1000' }), mode).not.toThrow();
      expect(publicationLeaseMs({ NODE_ENV: mode, SETTLEMENT_PUBLICATION_LEASE_MS: '1000' }), mode).toBe(1000);
    }
  });

  it('[AX355] in production the lease read at call time ignores the override: an environment changed after boot never shortens it', () => {
    const env: Record<string, string | undefined> = { ...good };
    expect(() => assertSafeBootConfig(env)).not.toThrow(); // booted clean
    env['SETTLEMENT_PUBLICATION_LEASE_MS'] = '1000'; // changed after boot
    expect(publicationLeaseMs(env)).toBe(PUBLICATION_LEASE_MS);
    expect(publicationHeartbeatMs(env)).toBe(15_000);
    env['SETTLEMENT_PUBLICATION_LEASE_MS'] = '600000'; // even a longer one: production runs the default
    expect(publicationLeaseMs(env)).toBe(PUBLICATION_LEASE_MS);
  });
});

// [ledger E08] The order hold is the customer's free-cancel window: while it
// runs, the order is hidden from the vendor. holdWindowMs()/
// checkoutQueueTiming() treat a MISSING LIFECYCLE_V2 as hold OFF, so a deploy
// that omits the variable silently sends new orders straight to the vendor
// while the app still promises a free-cancel window. Production must choose
// explicitly — off is a choice, omission is not.
describe('[ledger E08] production must be explicit about the order hold', () => {
  it('refuses production when LIFECYCLE_V2 is missing — the hold would be silently OFF', () => {
    expect(() => assertSafeBootConfig({ ...good, LIFECYCLE_V2: undefined }))
      .toThrow(/FATAL: LIFECYCLE_V2/);
    expect(() => assertSafeBootConfig({ ...good, LIFECYCLE_V2: undefined }))
      .toThrow(/Refusing to start/);
  });

  it('refuses every LIFECYCLE_V2 value other than an explicit 1 or 0', () => {
    for (const value of [undefined, '', 'true', '01', 'on', '1 ']) {
      expect(() => assertSafeBootConfig({ ...good, LIFECYCLE_V2: value }), String(value))
        .toThrow(/LIFECYCLE_V2/);
    }
  });

  it('accepts an explicit hold-off choice (LIFECYCLE_V2=0)', () => {
    expect(() => assertSafeBootConfig({ ...good, LIFECYCLE_V2: '0' })).not.toThrow();
  });

  it('accepts the settled hold-on posture (LIFECYCLE_V2=1)', () => {
    expect(() => assertSafeBootConfig({ ...good, LIFECYCLE_V2: '1' })).not.toThrow();
  });

  // [CANCEL-WINDOW · owner 22 Oct 2026] The free-cancel window after acceptance became one minute; the hold
  // floor stayed five. [owner 30 Oct 2026, staging test: "the 5 minute wait time is still there, not 1 minute"]
  // The store-order hold itself is now ONE minute, so the floor is one minute (ORDER_HOLD_FLOOR_MIN): '1', '2' and
  // '4.99' are accepted now (below). Everything else stays refused — no hold, a broken value, or anything shorter
  // than one minute ('0.5', '0.99' are new pins of that floor).
  it.each(['abc', '0', '', '-1', 'Infinity', '  ', '0.05', '0.5', '0.99', 'NaN', '-Infinity'])(
    'refuses ORDER_HOLD_MINUTES=%j when LIFECYCLE_V2=1 — no hold, or a hold shorter than the one-minute hold',
    (minutes) => {
      expect(() => assertSafeBootConfig({ ...good, LIFECYCLE_V2: '1', ORDER_HOLD_MINUTES: minutes }))
        .toThrow(/ORDER_HOLD_MINUTES/);
    },
  );

  it('accepts the unset default and any hold of at least the owner\'s one minute (DS214 D1 · owner 30 Oct 2026)', () => {
    expect(FREE_CANCEL_WINDOW_MIN).toBe(1);
    expect(ORDER_HOLD_FLOOR_MIN).toBe(1);
    for (const minutes of [undefined, '1', '1.5', '2', '4.99', '5', '7', '10']) {
      expect(() => assertSafeBootConfig({ ...good, LIFECYCLE_V2: '1', ORDER_HOLD_MINUTES: minutes }), String(minutes))
        .not.toThrow();
    }
  });

  it('does not enforce the hold posture outside production', () => {
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', LIFECYCLE_V2: undefined, ORDER_HOLD_MINUTES: 'abc' }))
      .not.toThrow();
  });

  it('the value-free preflight inherits the refusal and the explicit-off acceptance', () => {
    const refused = runPreflight({ ...good, LIFECYCLE_V2: undefined });
    expect(refused.status, refused.stdout + refused.stderr).toBe(1);
    expect(refused.stdout).toContain('LIFECYCLE_V2');
    const off = runPreflight({ ...good, LIFECYCLE_V2: '0' });
    expect(off.status, off.stdout + off.stderr).toBe(0);
  });
});

// SWIFT-010: a production DB with no CountryConfig rows has no active market,
// so countryFromPhone rejects every signup — a healthy-looking but dead front
// door. The boot must refuse it. Uses a mock prisma so the guard is proven
// without a database.
const prismaWith = (n: number) => ({ countryConfig: { count: async () => n } });

describe('assertProductionData — fail-closed empty-market guard', () => {
  it('refuses to boot in production when zero CountryConfig rows exist', async () => {
    await expect(assertProductionData(prismaWith(0), { NODE_ENV: 'production' })).rejects.toThrow(/CountryConfig/);
  });

  it('boots in production once at least one CountryConfig (market) is seeded', async () => {
    await expect(assertProductionData(prismaWith(1), { NODE_ENV: 'production' })).resolves.toBeUndefined();
  });

  it('[TA-S1-007] refuses an unknown NODE_ENV before it ever queries', async () => {
    // A client that would betray any query: the refusal must come from the
    // mode parse, never from (or after) a database round-trip.
    const never = { countryConfig: { count: async () => { throw new Error('QUERIED'); } } } as never;
    await expect(assertProductionData(never, {})).rejects.toThrow(/NODE_ENV must be exactly one of/);
    await expect(assertProductionData(never, { NODE_ENV: 'prod' })).rejects.toThrow(/NODE_ENV must be exactly one of/);
  });

  it('does not query or block outside production, even on an empty DB', async () => {
    let queried = false;
    const spy = { countryConfig: { count: async () => { queried = true; return 0; } } };
    await expect(assertProductionData(spy, { NODE_ENV: 'test' })).resolves.toBeUndefined();
    await expect(assertProductionData(spy, { NODE_ENV: 'development' })).resolves.toBeUndefined();
    expect(queried).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [F-027-15] The refusal also lives at the HAZARD, not only at the boot gate.
//
// assertSafeBootConfig is called by exactly two entry points — the server and
// the worker. The repo also ships a production-targeted session-assurance
// cutover script that constructs Fastify and AuthService directly, so it
// selected DevPush in production with nothing to stop it, and any future
// script would have done the same. A guard you have to remember to call is a
// guard that eventually is not called.
//
// DevPush drops every notification on the floor while reporting success. In
// production that means no dispatch offers, no new-order alerts, no safety
// pings — and nothing in the logs to say so.
// ---------------------------------------------------------------------------
describe('[F-027-15] getPushProvider refuses the in-memory provider in production', () => {
  const restore = { env: process.env['NODE_ENV'], push: process.env['PUSH_PROVIDER'] };
  afterEach(() => {
    if (restore.env === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = restore.env;
    if (restore.push === undefined) delete process.env['PUSH_PROVIDER']; else process.env['PUSH_PROVIDER'] = restore.push;
  });

  it('throws when PUSH_PROVIDER is explicitly dev in production', async () => {
    const { getPushProvider } = await import('../providers/notifications/channels');
    process.env['NODE_ENV'] = 'production';
    process.env['PUSH_PROVIDER'] = 'dev';
    expect(() => getPushProvider()).toThrow(/PUSH_PROVIDER is dev/);
  });

  it('throws when PUSH_PROVIDER is UNSET in production — the default is the hazard', async () => {
    const { getPushProvider } = await import('../providers/notifications/channels');
    process.env['NODE_ENV'] = 'production';
    delete process.env['PUSH_PROVIDER'];
    expect(() => getPushProvider()).toThrow(/PUSH_PROVIDER is dev/);
  });

  it('still returns the real provider in production when it is configured', async () => {
    const { getPushProvider } = await import('../providers/notifications/channels');
    process.env['NODE_ENV'] = 'production';
    process.env['PUSH_PROVIDER'] = 'expo';
    expect(() => getPushProvider()).not.toThrow();
  });

  it('leaves dev and test alone — the in-memory provider is correct there', async () => {
    const { getPushProvider } = await import('../providers/notifications/channels');
    for (const env of ['development', 'test']) {
      process.env['NODE_ENV'] = env;
      process.env['PUSH_PROVIDER'] = 'dev';
      expect(() => getPushProvider(), env).not.toThrow();
    }
  });
});

// [R2 C2] The load-test control plane signs its leases with
// TEST_CONTROL_SECRET. Its fallback, 'test-control-dev-secret', is printed in
// this PUBLIC repository, so an internet-facing loadtest deployment with the
// secret unset would hand anyone a forgeable lease. Boot refuses that; the
// fallback survives only for the isolated `test` mode the suites run in.
describe('test-control lease secret [C2]', () => {
  const loadtest: Record<string, string | undefined> = { NODE_ENV: 'loadtest', TEST_CONTROL_ENABLED: '1' };
  const prismaDouble = { deploymentIdentity: { findUnique: async () => null } } as unknown as Parameters<typeof testControlIdentity>[0];

  it('refuses loadtest with test control enabled and no TEST_CONTROL_SECRET', () => {
    expect(() => assertSafeBootConfig(loadtest)).toThrow(/TEST_CONTROL_SECRET/);
  });

  it.each(['', 'short', 'x'.repeat(31), 'test-control-dev-secret'])('refuses a weak secret (%j)', (secret) => {
    expect(() => assertSafeBootConfig({ ...loadtest, TEST_CONTROL_SECRET: secret })).toThrow(/TEST_CONTROL_SECRET/);
  });

  it('accepts a 32+ character secret', () => {
    expect(() => assertSafeBootConfig({ ...loadtest, TEST_CONTROL_SECRET: 'x'.repeat(32) })).not.toThrow();
  });

  it('does not require the secret when test control is off', () => {
    expect(() => assertSafeBootConfig({ NODE_ENV: 'loadtest' })).not.toThrow();
    expect(() => assertSafeBootConfig({ NODE_ENV: 'loadtest', TEST_CONTROL_ENABLED: '0' })).not.toThrow();
  });

  it('production never registers test control, so the guard adds nothing there', () => {
    expect(() => assertSafeBootConfig({ ...good, TEST_CONTROL_ENABLED: '1' })).not.toThrow();
  });

  it('test mode keeps the repository fallback — suites run isolated', () => {
    expect(() => assertSafeBootConfig({ NODE_ENV: 'test', TEST_CONTROL_ENABLED: '1' })).not.toThrow();
  });

  it('the identity endpoint itself refuses to sign with the fallback outside test mode', async () => {
    await expect(testControlIdentity(prismaDouble, { NODE_ENV: 'loadtest', TEST_CONTROL_ENABLED: '1' })).rejects.toThrow(/TEST_CONTROL_SECRET/);
    const signed = await testControlIdentity(prismaDouble, { NODE_ENV: 'loadtest', TEST_CONTROL_ENABLED: '1', TEST_CONTROL_SECRET: 'y'.repeat(32) });
    expect(signed.lease.signature).toMatch(/^[0-9a-f]{64}$/);
    const inTest = await testControlIdentity(prismaDouble, { NODE_ENV: 'test', TEST_CONTROL_ENABLED: '1' });
    expect(inTest.lease.signature).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// [row 331 · CONFIG-GUARDS] IDENTITY_SALT keys every identity-signal hash (phone,
// document number, plate, device). Production used to find it missing only at
// the first identity capture, mid-signup, as a thrown 500. Now it refuses to
// start, in the qr-config salts' style: one contract for the boot guard and the
// hasher, and the value is never echoed.
// ---------------------------------------------------------------------------
describe('[row 331 · CONFIG-GUARDS] IDENTITY_SALT is checked at boot, not at the first identity capture', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', ' \t '],
  ] as const)('production refuses to start with IDENTITY_SALT %s', (_label, value) => {
    expect(() => assertSafeBootConfig({ ...good, IDENTITY_SALT: value })).toThrow(/FATAL: IDENTITY_SALT .*Refusing to start/);
  });

  it('production refuses the development default printed in this public repository, without echoing it', () => {
    let message = '';
    try {
      assertSafeBootConfig({ ...good, IDENTITY_SALT: 'dev-identity-salt' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/FATAL: IDENTITY_SALT .*Refusing to start/);
    expect(message).not.toContain('dev-identity-salt');
  });

  it('a configured salt boots, and development and test keep their fixed fallback', () => {
    expect(() => assertSafeBootConfig(good)).not.toThrow();
    for (const mode of ['development', 'test']) {
      expect(() => assertSafeBootConfig({ NODE_ENV: mode })).not.toThrow();
      expect(identitySalt({ NODE_ENV: mode })).toBe('dev-identity-salt');
      expect(identitySalt({ NODE_ENV: mode, IDENTITY_SALT: ' ' })).toBe('dev-identity-salt');
    }
  });

  it('the hasher keeps the same contract as the boot guard', () => {
    expect(identitySalt({ NODE_ENV: 'production', IDENTITY_SALT: 'synthetic-identity-boot-salt' })).toBe('synthetic-identity-boot-salt');
    for (const value of [undefined, '', ' \t ', 'dev-identity-salt']) {
      expect(() => identitySalt({ NODE_ENV: 'production', IDENTITY_SALT: value }), String(value)).toThrow(/IDENTITY_SALT/);
    }
  });

  it('the value-free preflight refuses a production file without it, and lists it by name only', () => {
    const missing = runPreflight({ ...good, IDENTITY_SALT: undefined });
    expect(missing.status, missing.stderr).toBe(1);
    expect(missing.stdout).toContain('MISSING  IDENTITY_SALT');
    expect(missing.stdout).toMatch(/REFUSED[\s\S]*IDENTITY_SALT/);
    const present = runPreflight(good);
    expect(present.status, present.stderr).toBe(0);
    expect(present.stdout).toContain('PRESENT  IDENTITY_SALT');
    expect(present.stdout).not.toContain('synthetic-identity-boot-salt');
  });
});

// ---------------------------------------------------------------------------
// [row 331 · CONFIG-GUARDS] A kill switch left ON is printed by the preflight
// before a deploy, in the SWITCHED OFF register, like any other capability that
// starts fine while off. The SOS escalation worker is the case that matters.
// ---------------------------------------------------------------------------
describe('[row 331 · CONFIG-GUARDS] the preflight names every kill switch left on', () => {
  const switchedOff = (stdout: string) => stdout.slice(stdout.indexOf('SWITCHED OFF'), stdout.indexOf('VERDICT'));

  it('SOS_ESCALATION_WORKER_KILL=1 is printed under SWITCHED OFF, and the file still passes', () => {
    const result = runPreflight({ ...good, SOS_ESCALATION_WORKER_KILL: '1', OPS_ALERT_ESCALATION_KILL: '1' });
    expect(result.status, result.stderr).toBe(0);
    expect(switchedOff(result.stdout)).toContain('[SOS_ESCALATION_WORKER_KILL=1]');
    expect(switchedOff(result.stdout)).toContain('[OPS_ALERT_ESCALATION_KILL=1]');
  });

  it('a kill switch at 0 or unset is not listed; the launch card lock (CARD_RAIL_KILL=1) always is', () => {
    const result = runPreflight({ ...good, SOS_ESCALATION_WORKER_KILL: '0' });
    expect(result.status, result.stderr).toBe(0);
    expect(switchedOff(result.stdout)).not.toContain('SOS_ESCALATION_WORKER_KILL');
    expect(switchedOff(result.stdout)).not.toContain('OPS_ALERT_ESCALATION_KILL');
    expect(switchedOff(result.stdout)).toContain('[CARD_RAIL_KILL=1]');
  });
});

// [V8] CONSENT_IP_PEPPER degrades silently (hashIp → null, attribution just
// stops). Boot must at least be LOUD about it — a warning, not a refusal,
// because the ledger's core evidence still writes without it.
describe('CONSENT_IP_PEPPER visibility [V8]', () => {
  it('warns at production boot when the pepper is missing or short', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      assertSafeBootConfig({ ...good });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('CONSENT_IP_PEPPER'));
      warn.mockClear();
      assertSafeBootConfig({ ...good, CONSENT_IP_PEPPER: 'short' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('CONSENT_IP_PEPPER'));
    } finally {
      warn.mockRestore();
    }
  });

  it('stays quiet when a 32+ character pepper is configured', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      assertSafeBootConfig({ ...good, CONSENT_IP_PEPPER: 'p'.repeat(32) });
      const pepperWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('CONSENT_IP_PEPPER'));
      expect(pepperWarnings).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// [R13 on current main → S1 · SWITCHES 21 Oct, Option A] #1272 lets a
// cash-only launch start with the card rail declared OFF. R13 used to keep
// live MMG off entirely until sandbox UAT proved the merchant reference round
// trip (MMG_REFERENCE_ROUNDTRIP_VERIFIED=1), but that same flag ARMED the
// unproven push rail. Now: live MMG boots for the checkout, its lookup and
// reversals without the flag; the push rail is a separate switch production
// refuses; the push factory the billing worker uses refuses in production
// whatever the flags say. Checked everywhere a booting server consults it:
// the boot guard, the value-free preflight, and the provider factories.
// ---------------------------------------------------------------------------
describe('[R13 → Option A] cash-only production boot: live MMG checkout, never the push rail', () => {
  const cashOnly: Record<string, string | undefined> = { ...cardOff, MMG_REFERENCE_ROUNDTRIP_VERIFIED: undefined };
  const flags = [undefined, '', '0', 'true', 'yes', '1 ', '1'];

  afterEach(() => vi.unstubAllEnvs());

  it.each(flags)('boots with cards OFF and live MMG whatever the round-trip flag says (%s)', (verified) => {
    expect(() => assertSafeBootConfig({ ...cashOnly, MMG_REFERENCE_ROUNDTRIP_VERIFIED: verified })).not.toThrow();
  });

  it('the value-free preflight gives the same verdicts: live boots without the flag, the push switch is held', () => {
    const pass = runPreflight(cashOnly);
    expect(pass.status, pass.stdout + pass.stderr).toBe(0);
    const held = runPreflight({ ...cashOnly, MMG_PUSH_RAIL_ON: '1' });
    expect(held.status, held.stdout + held.stderr).toBe(1);
    expect(held.stdout).toContain('MMG_PUSH_RAIL_ON');
  });

  it('the workers get a card rail that refuses locally, live MMG for the checkout lookup and reversals, and NO push rail', async () => {
    const { getPaymentProvider } = await import('../providers/payment/payment-provider');
    const { getMmgProvider, getMmgLookupProvider, getMmgReversalClient, mmgPushRailOn, LiveMmgProvider } = await import('../providers/mmg/mmg-provider');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('a boot check never contacts a provider'));
    try {
      for (const [name, value] of Object.entries(cashOnly)) vi.stubEnv(name, value);
      const cards = getPaymentProvider();
      await expect(cards.chargeToken({ token: 'synthetic', amount: 1, currencyCode: 'GYD', idempotencyKey: 'boot-check', description: 'boot check' }))
        .resolves.toMatchObject({ status: 'failed', code: 'CARD_RAIL_DISABLED' });
      expect(getMmgLookupProvider()).toBeInstanceOf(LiveMmgProvider);
      expect(getMmgReversalClient()).toBeInstanceOf(LiveMmgProvider);
      for (const verified of flags) {
        for (const push of [undefined, '1']) {
          vi.stubEnv('MMG_REFERENCE_ROUNDTRIP_VERIFIED', verified);
          vi.stubEnv('MMG_PUSH_RAIL_ON', push);
          expect(mmgPushRailOn(), `${verified}/${push}`).toBe(false);
          expect(() => getMmgProvider(), `${verified}/${push}`).toThrow(/MMG_PUSH_RAIL_ON|MMG_REFERENCE_ROUNDTRIP_VERIFIED/);
        }
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// MMG hosted checkout (providers/mmg/mmg-checkout.ts). The guard runs in EVERY
// mode — staging runs development mode against MMG UAT — so a half-configured
// checkout never starts anywhere, and production never runs the sandbox or a
// UAT page. Off (unset, or exactly 0) changes nothing.
// ---------------------------------------------------------------------------
describe('MMG hosted checkout — the boot guard, in every mode', () => {
  let pair: { publicKey: KeyObject; privateKey: KeyObject };
  beforeAll(async () => {
    pair = await new Promise((resolve, reject) => {
      generateKeyPair('rsa', { modulusLength: 4096 }, (err, publicKey, privateKey) => (err ? reject(err) : resolve({ publicKey, privateKey })));
    });
  }, 60_000);
  const checkoutOn = (): Record<string, string> => ({
    MMG_CHECKOUT_ENABLED: '1',
    MMG_CHECKOUT_URL: 'https://checkout.example.test/mmg-pg/web/payments',
    MMG_CHECKOUT_MERCHANT_ID: '0000001',
    MMG_CHECKOUT_CLIENT_ID: 'client-test',
    MMG_CHECKOUT_MERCHANT_NAME: 'Swift Test',
    MMG_CHECKOUT_RETURN_ORIGIN: 'https://pay.example.test',
    MMG_CHECKOUT_SECRET_KEY: 'not-a-secret',
    MMG_CHECKOUT_PUBLIC_KEY: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    MMG_CHECKOUT_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });

  it('off — unset or exactly 0 — changes nothing (with MMG off in production, and outside production)', () => {
    expect(() => assertSafeBootConfig(good)).not.toThrow();
    // [22 Oct] Live MMG in production now needs the checkout on (its own describe below); with MMG off, off changes nothing.
    expect(() => assertSafeBootConfig({ ...good, MMG_DRIVER: 'disabled', MMG_CHECKOUT_ENABLED: '0' })).not.toThrow();
    expect(() => assertSafeBootConfig({ ...good, MMG_DRIVER: 'disabled', MMG_CHECKOUT_ENABLED: undefined })).not.toThrow();
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('a misspelled switch refuses to start, in production and outside it', () => {
    expect(() => assertSafeBootConfig({ ...good, MMG_CHECKOUT_ENABLED: 'true' })).toThrow(/MMG_CHECKOUT_ENABLED must be exactly 0 or 1/);
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', MMG_CHECKOUT_ENABLED: 'yes' })).toThrow(/MMG_CHECKOUT_ENABLED must be exactly 0 or 1/);
    expect(() => assertSafeBootConfig({ ...good, ADS_MMG_CHECKOUT: 'true' })).toThrow(/ADS_MMG_CHECKOUT must be exactly 0 or 1/);
    for (const value of [undefined, '', '0', '1']) expect(() => assertSafeBootConfig({ ...good, ADS_MMG_CHECKOUT: value })).not.toThrow();
  });

  it('enabled on the live driver without its configuration refuses to start — development (staging) included', () => {
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', MMG_DRIVER: 'live', MMG_CHECKOUT_ENABLED: '1' }))
      .toThrow(/MMG_CHECKOUT_MERCHANT_ID is required/);
    expect(() => assertSafeBootConfig({ ...good, MMG_CHECKOUT_URL: undefined })).toThrow(/MMG_CHECKOUT_URL must be set explicitly in production/);
  });

  it('[DS632] MMG_CHECKOUT_CREATION_ZONE is exactly GUYANA_WALL_CLOCK or UTC, or unset: anything else refuses to start, in production and outside it, the checkout on or off', () => {
    for (const zone of ['guyana', 'utc', 'UTC ', 'America/Guyana']) {
      expect(() => assertSafeBootConfig({ ...good, MMG_CHECKOUT_CREATION_ZONE: zone }), zone).toThrow(/MMG_CHECKOUT_CREATION_ZONE must be exactly GUYANA_WALL_CLOCK or UTC/);
      expect(() => assertSafeBootConfig({ ...good, ...checkoutOn(), MMG_CHECKOUT_CREATION_ZONE: zone }), zone).toThrow(/MMG_CHECKOUT_CREATION_ZONE must be exactly/);
      expect(() => assertSafeBootConfig({ NODE_ENV: 'development', MMG_CHECKOUT_CREATION_ZONE: zone }), zone).toThrow(/MMG_CHECKOUT_CREATION_ZONE must be exactly/);
    }
    for (const zone of [undefined, '', 'GUYANA_WALL_CLOCK', 'UTC']) {
      expect(() => assertSafeBootConfig({ ...good, ...checkoutOn(), MMG_CHECKOUT_CREATION_ZONE: zone }), String(zone)).not.toThrow();
      expect(() => assertSafeBootConfig({ NODE_ENV: 'development', MMG_CHECKOUT_CREATION_ZONE: zone }), String(zone)).not.toThrow();
    }
  });

  it('production boots with a complete checkout configuration, and never with the UAT page', () => {
    expect(() => assertSafeBootConfig({ ...good, ...checkoutOn() })).not.toThrow();
    expect(() => assertSafeBootConfig({ ...good, ...checkoutOn(), MMG_CHECKOUT_URL: 'https://mmgpg.mmgtest.net/mmg-pg/web/payments' }))
      .toThrow(/non-UAT MMG_CHECKOUT_URL/);
  });
});

// [22 Oct, COORD ruling on REVIEW-M's note] Production never sends MMG charge
// requests (MMG_PUSH_RAIL_ON is refused), so with MMG live the checkout page is
// the only MMG way to pay. Live MMG with the checkout off would leave partners
// no way to pay with MMG: production refuses to boot it. (The fee pause holds
// in that state too: fee-pause-pay-path.test.ts.) Nothing else changes: MMG off
// boots with the checkout off, and outside production nothing new is refused.
// ---------------------------------------------------------------------------
describe('[22 Oct] production refuses live MMG without the MMG checkout', () => {
  const refusal = /MMG_DRIVER=live in production needs MMG_CHECKOUT_ENABLED=1/;

  it.each([undefined, '', '0'])('refuses MMG_DRIVER=live with MMG_CHECKOUT_ENABLED=%j, and names the way out', (flag) => {
    let message = '';
    try {
      assertSafeBootConfig({ ...good, MMG_CHECKOUT_ENABLED: flag });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(refusal);
    expect(message).toContain('MMG_DRIVER=disabled');
    expect(message).toMatch(/Refusing to start\.$/);
  });

  it('the control: the same base with the checkout on boots', () => {
    expect(() => assertSafeBootConfig(good)).not.toThrow();
  });

  it('outside production, live MMG without the checkout is not refused by this rule', () => {
    for (const mode of ['development', 'test']) {
      let message = '';
      try {
        assertSafeBootConfig({ NODE_ENV: mode, MMG_DRIVER: 'live', MMG_CHECKOUT_ENABLED: '0' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, mode).not.toMatch(refusal);
    }
  });

  it('the value-free preflight gives the same verdict', () => {
    const refused = runPreflight({ ...good, MMG_CHECKOUT_ENABLED: '0' });
    expect(refused.status, refused.stdout + refused.stderr).toBe(1);
    expect(refused.stdout).toContain('MMG_DRIVER=live in production needs MMG_CHECKOUT_ENABLED=1');
    const pass = runPreflight(good);
    expect(pass.status, pass.stdout + pass.stderr).toBe(0);
  });
});

// [PT-1 · C10] Card rail v2 in production. The card simulator is a test page
// with no real money, and this build has no production-capable v2 provider:
// production refuses both, loudly, at boot — never at a partner's first tap.
describe('[PT-1 · PT-4] card rail v2 in production: only the real provider set up for live cards, and the simulator never', () => {
  it('refuses the card simulator in production, whatever the flag says', () => {
    for (const flag of [undefined, '0', '1']) {
      expect(() => assertSafeBootConfig({ ...good, CARD_RAIL_PROVIDER: 'simulator', CARD_RAIL_V2: flag }), String(flag))
        .toThrow(/CARD_RAIL_PROVIDER=simulator/);
    }
  });

  it('refuses CARD_RAIL_V2=1 in production without the real card provider', () => {
    expect(() => assertSafeBootConfig({ ...good, CARD_RAIL_V2: '1' })).toThrow(/FATAL: CARD_RAIL_V2=1/);
  });

  // [PT-4] Production runs v2 only on the real provider, fully set up for LIVE cards.
  const liveCards = {
    CARD_RAIL_V2: '1', CARD_RAIL_PROVIDER: 'powertranz', CARD_RAIL_ENVIRONMENT: 'live', CARD_RAIL_ACCOUNT: 'swift-gy',
    POWERTRANZ_API_URL: 'https://gateway.ptranz.com', POWERTRANZ_ID: 'LIVEID01', POWERTRANZ_PASSWORD: 'not-a-real-password',
    POWERTRANZ_PAGE_SET: 'PTZ/Swift', POWERTRANZ_PAGE_NAME: 'Weekly', API_PUBLIC_URL: 'https://api.example.com',
  };
  // [CARDS-SWITCH-ON] The real provider fully set up for live cards passes
  // every PT-4 check: with the kill switch on (the base) it boots, paused; the
  // drain switch passes PT-4 too and only the kept lock refuses it — its own
  // message (never PT-4's "CARD_RAIL_V2_DRAIN=1 in production …") proves it.
  it('[PT-4] the real provider fully set up for live cards passes every card check and boots (kill switch on: paused); its drain passes them and only the kept lock refuses it', () => {
    expect(() => assertSafeBootConfig({ ...good, ...liveCards })).not.toThrow();
    expect(() => assertSafeBootConfig({ ...good, ...liveCards, CARD_RAIL_V2: '0', CARD_RAIL_V2_DRAIN: '1' })).toThrow(/^FATAL: CARD_RAIL_V2_DRAIN must be unset or 0 in production/);
  });
  it('[PT-4] refuses anything less: sandbox, a test URL, a missing credential or page, http — never echoing a value', () => {
    const cases: Array<[Record<string, string | undefined>, RegExp]> = [
      // A sandbox setup that is complete in itself (test root, test credentials) is still not for production.
      [{ CARD_RAIL_ENVIRONMENT: 'sandbox', POWERTRANZ_API_URL: 'https://staging.ptranz.com' }, /real cards only: CARD_RAIL_ENVIRONMENT must be live/],
      [{ POWERTRANZ_API_URL: 'https://staging.ptranz.com' }, /test system/],
      [{ POWERTRANZ_API_URL: undefined }, /POWERTRANZ_API_URL/],
      // [Review S4] The provider's API lives under ptranz.com (guide sec. 2.3): never another host.
      [{ POWERTRANZ_API_URL: 'https://gateway.example.com' }, /ptranz\.com/],
      [{ POWERTRANZ_ID: undefined }, /POWERTRANZ_ID/],
      [{ POWERTRANZ_PASSWORD: undefined }, /POWERTRANZ_PASSWORD/],
      [{ POWERTRANZ_PAGE_NAME: undefined }, /POWERTRANZ_PAGE_SET and POWERTRANZ_PAGE_NAME/],
      [{ API_PUBLIC_URL: 'http://api.example.com' }, /API_PUBLIC_URL/],
      [{ CARD_RAIL_PROVIDER: 'stripe' }, /CARD_RAIL_PROVIDER=powertranz/],
    ];
    for (const [patch, message] of cases) {
      let thrown: Error | undefined;
      try { assertSafeBootConfig({ ...good, ...liveCards, ...patch }); } catch (err) { thrown = err as Error; }
      expect(thrown?.message, JSON.stringify(patch)).toMatch(/^FATAL: CARD_RAIL_V2=1/);
      expect(thrown?.message).toMatch(message);
      expect(thrown?.message).not.toContain('not-a-real-password');
    }
  });

  it('the flag is 1 or 0 (or unset), never a guess', () => {
    for (const value of ['true', 'on', 'yes', '01', ' 1']) {
      expect(() => assertSafeBootConfig({ ...good, CARD_RAIL_V2: value }), value).toThrow(/CARD_RAIL_V2 must be 1 or 0/);
    }
  });

  it('OFF — 0 or unset — boots exactly as before', () => {
    expect(() => assertSafeBootConfig({ ...good, CARD_RAIL_V2: '0' })).not.toThrow();
    expect(() => assertSafeBootConfig({ ...good, CARD_RAIL_V2: undefined })).not.toThrow();
  });

  it('[PT-2] refuses the staging-only switch that lets the simulator show the card choice, whatever its value but 0', () => {
    for (const value of ['1', 'true', 'yes']) {
      expect(() => assertSafeBootConfig({ ...good, CARD_RAIL_SIMULATOR_LIVE: value }), value).toThrow(/CARD_RAIL_SIMULATOR_LIVE/);
    }
    expect(() => assertSafeBootConfig({ ...good, CARD_RAIL_SIMULATOR_LIVE: '0' })).not.toThrow();
    expect(() => assertSafeBootConfig({ ...good, CARD_RAIL_SIMULATOR_LIVE: undefined })).not.toThrow();
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', CARD_RAIL_V2: '1', CARD_RAIL_PROVIDER: 'simulator', CARD_RAIL_SIMULATOR_LIVE: '1', API_PUBLIC_URL: 'https://api-test.example.test' })).not.toThrow();
  });

  it('[review S2] in EVERY mode, the simulator and its test switch refuse to start on the public API host; the switch needs this test server\'s own address', () => {
    for (const env of [
      { NODE_ENV: 'development', CARD_RAIL_V2: '1', CARD_RAIL_PROVIDER: 'simulator', API_PUBLIC_URL: 'https://api.swiftgy.com' },
      { NODE_ENV: 'development', CARD_RAIL_V2: '0', CARD_RAIL_PROVIDER: 'simulator', API_PUBLIC_URL: 'https://API.swiftgy.com/' },
      { NODE_ENV: 'development', CARD_RAIL_SIMULATOR_LIVE: '1', API_PUBLIC_URL: 'https://api.swiftgy.com' },
    ]) {
      expect(() => assertSafeBootConfig(env), JSON.stringify(env)).toThrow(/public API host/);
    }
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', CARD_RAIL_V2: '1', CARD_RAIL_PROVIDER: 'simulator', CARD_RAIL_SIMULATOR_LIVE: '1' }))
      .toThrow(/CARD_RAIL_SIMULATOR_LIVE needs API_PUBLIC_URL/);
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', CARD_RAIL_V2: '1', CARD_RAIL_PROVIDER: 'simulator', CARD_RAIL_SIMULATOR_LIVE: '1', API_PUBLIC_URL: 'https://api-test.example.test' }))
      .not.toThrow();
  });

  it('[review S2-1] in EVERY mode, the provider\'s TEST system (its sandbox) refuses to start on the public API host — a trailing dot is the same host', () => {
    const sandbox = { CARD_RAIL_V2: '1', CARD_RAIL_PROVIDER: 'powertranz', CARD_RAIL_ENVIRONMENT: 'sandbox', ...SANDBOX_READY };
    for (const env of [
      { NODE_ENV: 'development', ...sandbox, API_PUBLIC_URL: 'https://api.swiftgy.com' },
      { NODE_ENV: 'development', ...sandbox, CARD_RAIL_V2: '0', API_PUBLIC_URL: 'https://API.swiftgy.com/' },
      { NODE_ENV: 'development', ...sandbox, CARD_RAIL_ENVIRONMENT: undefined, API_PUBLIC_URL: 'https://api.swiftgy.com' },
      { NODE_ENV: 'development', ...sandbox, API_PUBLIC_URL: 'https://api.swiftgy.com./' },
      { NODE_ENV: 'development', CARD_RAIL_PROVIDER: 'simulator', API_PUBLIC_URL: 'https://api.swiftgy.com.' },
    ]) {
      expect(() => assertSafeBootConfig(env), JSON.stringify(env)).toThrow(/public API host/);
    }
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', ...sandbox, API_PUBLIC_URL: 'https://api-test.example.test' })).not.toThrow();
  });

  // [GUARD-FIX] Production serves the API as api-live.swiftgy.com (and keeps that name after launch,
  // adding api.swiftgy.com beside it). A guard keyed on one public name alone never fired there.
  it('[GUARD-FIX] in EVERY mode, a TEST card system refuses to start on EITHER production public name, api.swiftgy.com or api-live.swiftgy.com', () => {
    const sandbox = { CARD_RAIL_V2: '1', CARD_RAIL_PROVIDER: 'powertranz', CARD_RAIL_ENVIRONMENT: 'sandbox', ...SANDBOX_READY };
    for (const env of [
      { NODE_ENV: 'development', CARD_RAIL_V2: '1', CARD_RAIL_PROVIDER: 'simulator', API_PUBLIC_URL: 'https://api-live.swiftgy.com' },
      { NODE_ENV: 'development', CARD_RAIL_V2: '0', CARD_RAIL_PROVIDER: 'simulator', API_PUBLIC_URL: 'https://API-LIVE.swiftgy.com/' },
      { NODE_ENV: 'development', CARD_RAIL_SIMULATOR_LIVE: '1', API_PUBLIC_URL: 'https://api-live.swiftgy.com' },
      { NODE_ENV: 'development', ...sandbox, API_PUBLIC_URL: 'https://api-live.swiftgy.com' },
      { NODE_ENV: 'development', ...sandbox, CARD_RAIL_ENVIRONMENT: undefined, API_PUBLIC_URL: 'https://api-live.swiftgy.com' },
      { NODE_ENV: 'development', ...sandbox, API_PUBLIC_URL: 'https://api-live.swiftgy.com./' },
      { NODE_ENV: 'test', ...sandbox, API_PUBLIC_URL: 'https://api-live.swiftgy.com' },
    ]) {
      expect(() => assertSafeBootConfig(env), JSON.stringify(env)).toThrow(/public API host api-live\.swiftgy\.com/);
    }
    // The original name still refuses, and names itself.
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', ...sandbox, API_PUBLIC_URL: 'https://api.swiftgy.com' })).toThrow(/public API host api\.swiftgy\.com /);
    // Staging and test servers keep their own names and boot exactly as before.
    for (const url of ['https://api-staging.swiftgy.com', 'https://api-test.example.test']) {
      expect(() => assertSafeBootConfig({ NODE_ENV: 'development', ...sandbox, API_PUBLIC_URL: url }), url).not.toThrow();
      expect(() => assertSafeBootConfig({ NODE_ENV: 'development', CARD_RAIL_V2: '1', CARD_RAIL_PROVIDER: 'simulator', CARD_RAIL_SIMULATOR_LIVE: '1', API_PUBLIC_URL: url }), url).not.toThrow();
    }
  });

  it('[GUARD-FIX] production refuses the provider\'s TEST system (its sandbox) whatever its public name, even with card rail v2 off', () => {
    for (const url of ['https://api-live.swiftgy.com', 'https://api.swiftgy.com', 'https://api.example.com', undefined]) {
      for (const environment of ['sandbox', undefined, '']) {
        const env = { ...good, CARD_RAIL_PROVIDER: 'powertranz', CARD_RAIL_ENVIRONMENT: environment, API_PUBLIC_URL: url };
        expect(() => assertSafeBootConfig(env), JSON.stringify({ url, environment })).toThrow(/^FATAL: a TEST card system/);
      }
    }
    // Live (real) cards with v2 off on production's own name are no test system: nothing here refuses them.
    expect(() => assertSafeBootConfig({ ...good, CARD_RAIL_PROVIDER: 'powertranz', CARD_RAIL_ENVIRONMENT: 'live', API_PUBLIC_URL: 'https://api-live.swiftgy.com' })).not.toThrow();
  });

  it('[review S3] in EVERY mode but production, live (real) cards refuse to start: a test server never charges real cards', () => {
    for (const mode of ['development', 'test']) {
      expect(() => assertSafeBootConfig({ NODE_ENV: mode, CARD_RAIL_PROVIDER: 'powertranz', CARD_RAIL_ENVIRONMENT: 'live', API_PUBLIC_URL: 'https://api-test.example.test' }), mode)
        .toThrow(/live \(real cards\) outside production/);
    }
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', CARD_RAIL_PROVIDER: 'powertranz', CARD_RAIL_ENVIRONMENT: 'sandbox', API_PUBLIC_URL: 'https://api-test.example.test' })).not.toThrow();
    // Production is the only mode whose card checks accept live cards (boot-config's card switches then decide).
    expect(() => assertSafeBootConfig({ ...good, ...liveCards })).not.toThrow();
  });

  // [CARD-STAGING-TEST 10 Nov 2026] Staging ran card rail v2 on the provider's sandbox with the credentials missing from
  // deploy/.env (no POWERTRANZ_*_FILE lines) and a page set without PTZ/: it booted, offered card payment, and every
  // payment failed. Outside production (production has its own, live-card refusal) such a server now refuses to start.
  it('[CARD-STAGING-TEST] in EVERY mode but production, card rail v2 (or its drain) on the real provider refuses to start unless this process can read the provider\'s settings — named, never a value', () => {
    const on = { NODE_ENV: 'development', CARD_RAIL_PROVIDER: 'powertranz', CARD_RAIL_ENVIRONMENT: 'sandbox', API_PUBLIC_URL: 'https://api-staging.swiftgy.com', ...SANDBOX_READY };
    for (const mode of ['development', 'test', 'loadtest']) {
      for (const which of [{ CARD_RAIL_V2: '1' }, { CARD_RAIL_V2: '0', CARD_RAIL_V2_DRAIN: '1' }]) {
        expect(() => assertSafeBootConfig({ ...on, ...which, NODE_ENV: mode }), `${mode} ${JSON.stringify(which)}`).not.toThrow();
        const cases: Array<[Record<string, string | undefined>, RegExp]> = [
          [{ POWERTRANZ_ID: undefined }, /POWERTRANZ_ID/],
          [{ POWERTRANZ_PASSWORD: undefined }, /POWERTRANZ_PASSWORD/],
          [{ POWERTRANZ_PAGE_SET: 'SWIFT' }, /POWERTRANZ_PAGE_SET must start with PTZ\//],
          [{ POWERTRANZ_PAGE_NAME: undefined }, /POWERTRANZ_PAGE_NAME/],
          [{ CARD_RAIL_ACCOUNT: undefined }, /CARD_RAIL_ACCOUNT/],
          [{ API_PUBLIC_URL: 'http://api-staging.swiftgy.com' }, /API_PUBLIC_URL/],
        ];
        for (const [patch, named] of cases) {
          let thrown: Error | undefined;
          try { assertSafeBootConfig({ ...on, ...which, NODE_ENV: mode, ...patch }); } catch (err) { thrown = err as Error; }
          expect(thrown?.message, `${mode} ${JSON.stringify(which)} ${JSON.stringify(patch)}`).toMatch(/^FATAL: CARD_RAIL_V2(_DRAIN)?=1 with CARD_RAIL_PROVIDER=powertranz, but this server cannot read the card provider's settings: /);
          expect(thrown?.message).toMatch(named);
          expect(thrown?.message).not.toContain(SANDBOX_READY.POWERTRANZ_PASSWORD);
        }
      }
    }
    // A missing credential names the store wiring to add; the kill switch does not excuse it (a killed rail still
    // confirms, sweeps, looks up and refunds what is in flight, all through the provider).
    for (const kill of ['0', '1']) {
      let thrown: Error | undefined;
      try { assertSafeBootConfig({ ...on, CARD_RAIL_V2: '1', CARD_RAIL_KILL: kill, POWERTRANZ_ID: undefined }); } catch (err) { thrown = err as Error; }
      expect(thrown?.message, kill).toContain('deploy/.env needs POWERTRANZ_ID_FILE=/run/secrets/POWERTRANZ_ID and POWERTRANZ_PASSWORD_FILE=/run/secrets/POWERTRANZ_PASSWORD');
    }
    // Off (neither switch), or another provider: nothing about the real provider is asked, as before.
    expect(() => assertSafeBootConfig({ ...on, POWERTRANZ_ID: undefined, CARD_RAIL_V2: '0' })).not.toThrow();
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', CARD_RAIL_V2: '1', CARD_RAIL_PROVIDER: 'simulator' })).not.toThrow();
  });

  it('outside production the simulator boots (staging runs NODE_ENV=development)', () => {
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', CARD_RAIL_V2: '1', CARD_RAIL_PROVIDER: 'simulator' })).not.toThrow();
  });

  // [AX297 F5] Draining v2 after a switch-off is its own switch, held to the same rules.
  it('CARD_RAIL_V2_DRAIN is 1 or 0 (or unset), and 1 in production only on the real provider', () => {
    expect(() => assertSafeBootConfig({ ...good, CARD_RAIL_V2_DRAIN: '1' })).toThrow(/FATAL: CARD_RAIL_V2_DRAIN=1/);
    for (const value of ['true', 'yes', '2', ' 1']) {
      expect(() => assertSafeBootConfig({ ...good, CARD_RAIL_V2_DRAIN: value }), value).toThrow(/CARD_RAIL_V2_DRAIN must be 1 or 0/);
    }
    expect(() => assertSafeBootConfig({ ...good, CARD_RAIL_V2_DRAIN: '0' })).not.toThrow();
    expect(() => assertSafeBootConfig({ ...good, CARD_RAIL_V2_DRAIN: undefined })).not.toThrow();
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', CARD_RAIL_V2: '0', CARD_RAIL_V2_DRAIN: '1', CARD_RAIL_PROVIDER: 'simulator' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// [PROD-PATH] Owner ruling, 4 Oct 2026: production may boot with MMG fully OFF
// until the live merchant keys arrive (before trial day 14). OFF is an
// explicit value, MMG_DRIVER=disabled, never an unset or misspelled one; the
// hosted checkout must be off with it; and every MMG feature then refuses
// explicitly (providers/mmg). The live path keeps every one of its gates.
// The same ruling makes two silent production failures loud at boot: no
// on-call phone for an unacknowledged SOS, and no email sender.
// ---------------------------------------------------------------------------
describe('[PROD-PATH] production with MMG fully off', () => {
  const mmgOff: Record<string, string | undefined> = {
    ...cardOff,
    ...Object.fromEntries(Object.keys(baseCheckout).map((name) => [name, undefined])),
    MMG_DRIVER: 'disabled',
    MMG_API_URL: undefined,
    MMG_API_KEY: undefined,
    MMG_MERCHANT_ID: undefined,
    MMG_PASSWORD: undefined,
    MMG_MKEY: undefined,
    MMG_MSECRET: undefined,
    MMG_REFERENCE_ROUNDTRIP_VERIFIED: undefined,
  };

  it('boots with MMG_DRIVER=disabled, the checkout off and no MMG credential', () => {
    expect(() => assertSafeBootConfig(mmgOff)).not.toThrow();
    expect(() => assertSafeBootConfig({ ...mmgOff, MMG_CHECKOUT_ENABLED: '0' })).not.toThrow();
  });

  it('refuses MMG off with the hosted checkout switched on, and names both switches', () => {
    expect(() => assertSafeBootConfig({ ...mmgOff, MMG_CHECKOUT_ENABLED: '1' })).toThrow(/MMG_CHECKOUT_ENABLED=1.*MMG_DRIVER=disabled/);
  });

  it.each([undefined, '', 'off', 'Disabled', 'disabled ', 'none', '0'])('never reads MMG_DRIVER=%j as off', (driver) => {
    expect(() => assertSafeBootConfig({ ...mmgOff, MMG_DRIVER: driver })).toThrow(/MMG_DRIVER/);
  });

  it('keeps every live gate: live is still refused without its credentials, and the push rail switch is refused', () => {
    expect(() => assertSafeBootConfig({ ...mmgOff, MMG_DRIVER: 'live' })).toThrow(/MMG_/);
    expect(() => assertSafeBootConfig({ ...good, MMG_PUSH_RAIL_ON: '1' })).toThrow(/MMG_PUSH_RAIL_ON/);
    expect(() => assertSafeBootConfig({ ...good, MMG_DRIVER: 'sandbox' })).toThrow(/MMG_DRIVER/);
  });

  it('the value-free preflight accepts MMG off and still refuses it with the checkout on', () => {
    const off = runPreflight(mmgOff);
    expect(off.status, off.stdout + off.stderr).toBe(0);
    const checkout = runPreflight({ ...mmgOff, MMG_CHECKOUT_ENABLED: '1' });
    expect(checkout.status, checkout.stdout + checkout.stderr).toBe(1);
    expect(checkout.stdout).toContain('MMG_DRIVER=disabled');
  });

  it('the billing provider factory hands back a refusing provider and never contacts MMG', async () => {
    const { getMmgProvider, MmgDisabledError } = await import('../providers/mmg/mmg-provider');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('MMG off never contacts MMG'));
    try {
      for (const [name, value] of Object.entries(mmgOff)) vi.stubEnv(name, value);
      const mmg = getMmgProvider();
      await expect(mmg.initiatePayment({ payerId: '5926000001', amountMinor: 100, currencyCode: 'GYD', reference: 'r' })).rejects.toBeInstanceOf(MmgDisabledError);
      await expect(mmg.authenticate()).rejects.toMatchObject({ code: 'MMG_DISABLED', statusCode: 503 });
      await expect(mmg.transactionLookup({ transactionId: 't' })).rejects.toMatchObject({ code: 'MMG_DISABLED', statusCode: 503 });
      await expect(mmg.transactionHistory({ from: new Date() })).rejects.toMatchObject({ code: 'MMG_DISABLED', statusCode: 503 });
      await expect(mmg.reverseTransaction({ transactionId: 't' })).rejects.toMatchObject({ code: 'MMG_DISABLED', statusCode: 503 });
      await expect(mmg.accountBalance()).rejects.toMatchObject({ code: 'MMG_DISABLED', statusCode: 503 });
      const { getMmgLookupProvider } = await import('../providers/mmg/mmg-provider');
      await expect(getMmgLookupProvider(mmgOff).transactionLookupDetail('t')).rejects.toMatchObject({ code: 'MMG_DISABLED', statusCode: 503 });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

// #1448 review (Opus S3-1): the owner's launch money rules held only in
// pilot-up.sh, so production started any other way (a hand-run compose, an old
// script) booted with admin top-ups live or the agent-cash webhook armed. The
// boot guard holds them too, whatever starts the API.
describe('[PROD-PATH] production keeps admin top-ups on hold and never arms the agent-cash webhook', () => {
  it.each([undefined, '', '0', 'true', 'yes', ' 1'])('refuses BILLING_TOPUP_HOLD=%j: admin top-ups stay on hold in production', (hold) => {
    expect(() => assertSafeBootConfig({ ...good, BILLING_TOPUP_HOLD: hold })).toThrow(/BILLING_TOPUP_HOLD=1/);
  });

  it('refuses an AGENT_CASH_WEBHOOK_SECRET in production, naming the setting, never its value', () => {
    const secret = 'agent-cash-secret-'.padEnd(40, 'z');
    let message = '';
    try { assertSafeBootConfig({ ...good, AGENT_CASH_WEBHOOK_SECRET: secret }); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/AGENT_CASH_WEBHOOK_SECRET/);
    expect(message).not.toContain(secret);
  });

  it('accepts the hold with no agent-cash secret (and an empty one), and asks nothing outside production', () => {
    expect(() => assertSafeBootConfig(good)).not.toThrow();
    expect(() => assertSafeBootConfig({ ...good, AGENT_CASH_WEBHOOK_SECRET: '' })).not.toThrow();
    expect(() => assertSafeBootConfig({ ...good, BILLING_TOPUP_HOLD: undefined, NODE_ENV: 'test', AGENT_CASH_WEBHOOK_SECRET: 'x'.repeat(32) })).not.toThrow();
  });
});

describe('[PROD-PATH] production needs an on-call phone and an email sender', () => {
  it.each([undefined, '', ' , '])('refuses OPS_ONCALL_PHONES=%j: an unacknowledged SOS would page nobody', (phones) => {
    expect(() => assertSafeBootConfig({ ...good, OPS_ONCALL_PHONES: phones })).toThrow(/OPS_ONCALL_PHONES/);
  });

  it.each(['5926000001', '+5926000001,0592600', '+5926000001;+15550000002', '+59260 00001'])(
    'refuses an entry that is not E.164 (it would be dropped silently): %j', (phones) => {
      expect(() => assertSafeBootConfig({ ...good, OPS_ONCALL_PHONES: phones })).toThrow(/OPS_ONCALL_PHONES/);
    },
  );

  it('accepts one or more E.164 phones, with spaces around the commas', () => {
    expect(() => assertSafeBootConfig({ ...good, OPS_ONCALL_PHONES: '+5926000001' })).not.toThrow();
    expect(() => assertSafeBootConfig({ ...good, OPS_ONCALL_PHONES: '+5926000001 , +15550000002' })).not.toThrow();
  });

  it('never echoes a configured phone in the refusal', () => {
    let message = '';
    try { assertSafeBootConfig({ ...good, OPS_ONCALL_PHONES: '+5926000001,59260012345' }); } catch (e) { message = String(e); }
    expect(message).toMatch(/OPS_ONCALL_PHONES/);
    expect(message).not.toContain('5926000001');
    expect(message).not.toContain('59260012345');
  });

  it.each([undefined, '', 'dev', 'sendgrid'])('refuses EMAIL_PROVIDER=%j: receipts and notices would never leave', (provider) => {
    expect(() => assertSafeBootConfig({ ...good, EMAIL_PROVIDER: provider })).toThrow(/EMAIL_PROVIDER/);
  });

  it.each(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'])('refuses smtp without %s, by name', (name) => {
    expect(() => assertSafeBootConfig({ ...good, [name]: undefined })).toThrow(new RegExp(name));
  });

  it.each(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'])('refuses a blank %s (spaces only), by name', (name) => {
    for (const blank of [' ', '   ', '\t']) {
      expect(() => assertSafeBootConfig({ ...good, [name]: blank }), JSON.stringify(blank)).toThrow(new RegExp(name));
    }
  });

  it('refuses a clear-text SMTP session in production and never echoes the password', () => {
    let message = '';
    try { assertSafeBootConfig({ ...good, SMTP_TLS: 'none' }); } catch (e) { message = String(e); }
    expect(message).toMatch(/SMTP_TLS/);
    expect(message).not.toContain(String(good['SMTP_PASS']));
  });

  // [EMAIL-HTTPS 27 Oct] The droplets cannot reach SMTP, so production may send
  // email over HTTPS through Resend instead. NOT a relaxation: a real sender is
  // still required (unset, dev and anything else stay refused, above and below),
  // and resend is held to its own whole configuration, by name, like smtp.
  const RESEND_KEY = 're_synthetic_boot_key_never_echoed';
  const resend = {
    ...good, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: RESEND_KEY, EMAIL_FROM: 'Swift <no-reply@swiftgy.com>',
    SMTP_HOST: undefined, SMTP_PORT: undefined, SMTP_USER: undefined, SMTP_PASS: undefined,
  };

  it('accepts smtp, and accepts resend with its key and a sender (no SMTP setting needed)', () => {
    expect(() => assertSafeBootConfig(good)).not.toThrow();
    expect(() => assertSafeBootConfig(resend)).not.toThrow();
    expect(() => assertSafeBootConfig({ ...resend, EMAIL_FROM: 'no-reply@swiftgy.com' })).not.toThrow();
  });

  it.each(['RESEND_API_KEY', 'EMAIL_FROM'])('refuses resend without %s (unset or blank), FATAL by name, never echoing the key', (name) => {
    for (const value of [undefined, '', '  ']) {
      let message = '';
      try { assertSafeBootConfig({ ...resend, [name]: value }); } catch (e) { message = String(e); }
      expect(message, JSON.stringify(value)).toMatch(new RegExp(`FATAL: EMAIL_PROVIDER=resend needs ${name}`));
      expect(message).toMatch(/Refusing to start/);
      expect(message).not.toContain(RESEND_KEY);
    }
  });

  it('refuses resend with a sender that is not an address, never echoing the key', () => {
    let message = '';
    try { assertSafeBootConfig({ ...resend, EMAIL_FROM: 'Swift' }); } catch (e) { message = String(e); }
    expect(message).toMatch(/FATAL: EMAIL_FROM must be an email address/);
    expect(message).not.toContain(RESEND_KEY);
  });

  it.each([undefined, '', 'dev', 'sendgrid', 'postmark', 'Resend', ' resend', 'smtp,resend'])('still refuses EMAIL_PROVIDER=%j with every resend setting present', (provider) => {
    expect(() => assertSafeBootConfig({ ...resend, EMAIL_PROVIDER: provider })).toThrow(/FATAL: EMAIL_PROVIDER must be smtp or resend in production/);
  });

  it('smtp is unchanged: a Resend key does not stand in for a missing SMTP setting', () => {
    expect(() => assertSafeBootConfig({ ...good, RESEND_API_KEY: RESEND_KEY, SMTP_PASS: undefined })).toThrow(/EMAIL_PROVIDER=smtp needs SMTP_PASS/);
  });

  it('outside production neither is required', () => {
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertSafeBootConfig({ NODE_ENV: 'loadtest' })).not.toThrow();
  });

  it('the value-free preflight names both and walks past them', () => {
    const result = runPreflight({ ...good, OPS_ONCALL_PHONES: undefined, EMAIL_PROVIDER: undefined });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('OPS_ONCALL_PHONES');
    expect(result.stdout).toContain('EMAIL_PROVIDER');
  });
});

describe('production address lookup is an explicit deployment choice', () => {
  it.each([undefined, 'local', '', 'unknown'])('refuses PLACES_PROVIDER=%s instead of silently limiting addresses', (provider) => {
    expect(() => assertSafeBootConfig({ ...cardOff, PLACES_PROVIDER: provider })).toThrow(/PLACES_PROVIDER/);
  });
  it('accepts an explicit configured Photon service, without making a network request', () => {
    expect(() => assertSafeBootConfig({ ...cardOff, PLACES_PROVIDER: 'osm', PHOTON_URL: 'http://photon.test' })).not.toThrow();
  });
  it('refuses explicit OSM without its Photon endpoint in preflight too', () => {
    expect(() => assertSafeBootConfig({ ...cardOff, PLACES_PROVIDER: 'osm', PHOTON_URL: undefined })).toThrow(/PHOTON_URL/);
  });
});

// ---------------------------------------------------------------------------
// [LAUNCH-LOCK → CARDS-SWITCH-ON] Production's card and ad switches.
//   - Owner ruling 13 Oct 2026 (#34): production refused to boot with the card
//     rail or ads on "until an attorney signs off".
//   - Owner ruling 15 Oct 2026 (GUARDRAILS §8) replaced the attorney gate:
//     Swift runs on the owner's documented answers, and what could be
//     criminal stays off until a lawyer confirms it. For cards that is
//     recurring card charges (saved cards); for ads, ads (owner 6 Nov: off at
//     launch).
//   - Cards ON rests on the owner's go-cards ruling (OWNER-DECISIONS, dated at
//     the go); owner ruling 7 Oct 2026 (option A) described this change's shape:
//     CARD_RAIL_KILL=0 with PAYMENT_PROVIDER=disabled ONLY when CARD_RAIL_V2=1 and
//     the live card setup is complete.
// So production boots cards OFF exactly as before, Pay now ON only on the real
// provider with real cards, and the rollback (the kill switch back to 1 with v2
// left on) — and still refuses saved cards, the drain switch, the legacy seam,
// every test system and ads. pilot-up.sh holds the same rule
// (deploy-prod-path.test.ts).
// ---------------------------------------------------------------------------
describe('[CARDS-SWITCH-ON] production card and ad switches: cards off by default, Pay now only with real cards, saved cards and ads never', () => {
  const liveStripe = { PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_live_boot_config_test' };
  const livePowerTranz = { PAYMENT_PROVIDER: 'powertranz', PAYMENT_GATEWAY_KEY: 'gateway-id', PAYMENT_GATEWAY_SECRET: 'gateway-secret', POWERTRANZ_API_URL: 'https://gateway.ptranz.com' };
  /** The real provider, completely set up for live cards, with no switch set. */
  const liveCardRail = {
    CARD_RAIL_PROVIDER: 'powertranz', CARD_RAIL_ENVIRONMENT: 'live', CARD_RAIL_ACCOUNT: 'swift-gy',
    POWERTRANZ_API_URL: 'https://gateway.ptranz.com', POWERTRANZ_ID: 'LIVEID01', POWERTRANZ_PASSWORD: 'not-a-real-password',
    POWERTRANZ_PAGE_SET: 'PTZ/Swift', POWERTRANZ_PAGE_NAME: 'Weekly', API_PUBLIC_URL: 'https://api.example.com',
  };
  /** The switch-on: Pay now by card on the provider's hosted page, real cards. */
  const cardsOn = { ...liveCardRail, CARD_RAIL_V2: '1', CARD_RAIL_KILL: '0' };
  /** The rollback: the kill switch back on; v2 stays on, so open card payments are still confirmed. */
  const cardsPaused = { ...liveCardRail, CARD_RAIL_V2: '1', CARD_RAIL_KILL: '1' };
  const refusal = (env: Record<string, string | undefined>): string => {
    try { assertSafeBootConfig(env); } catch (error) { return (error as Error).message; }
    return '';
  };

  it('UNCHANGED: production boots exactly as today with cards off and ads off (the locked switches unset, empty or 0)', () => {
    expect(() => assertSafeBootConfig(good)).not.toThrow();
    expect(() => assertSafeBootConfig(cardOff)).not.toThrow();
    for (const off of [undefined, '', '0']) {
      expect(() => assertSafeBootConfig({ ...good, CARD_RAIL_V2: off, CARD_RAIL_V2_DRAIN: off, CARD_RAIL_ENROLL: off, ADS_ENABLED: off }), String(off)).not.toThrow();
    }
  });

  it('LIFTED: Pay now by card boots — CARD_RAIL_KILL=0 with CARD_RAIL_V2=1 on the real provider, live cards, completely set up', () => {
    expect(refusal({ ...good, ...cardsOn })).toBe('');
    expect(refusal({ ...cardOff, ...cardsOn })).toBe('');
    // The kept switches spelled out as off change nothing.
    for (const off of ['', '0']) {
      expect(refusal({ ...good, ...cardsOn, CARD_RAIL_V2_DRAIN: off, CARD_RAIL_ENROLL: off, ADS_ENABLED: off, CARD_RAIL_SIMULATOR_LIVE: off }), JSON.stringify(off)).toBe('');
    }
    // The address PowerTranz wrote for production (its SPI path) is the same root.
    expect(refusal({ ...good, ...cardsOn, POWERTRANZ_API_URL: 'https://gateway.ptranz.com/api/spi/' })).toBe('');
  });

  it('LIFTED: the rollback boots — CARD_RAIL_KILL=1 with CARD_RAIL_V2=1 left on (no new card payment; open ones are still confirmed)', () => {
    expect(refusal({ ...good, ...cardsPaused })).toBe('');
  });

  it('KEPT: the kill switch is exactly 1 (cards off) or exactly 0 (cards on); no near miss is read as either', () => {
    for (const kill of [undefined, '', 'true', ' 1', '01', '00', '0 ', 'off', 'false']) {
      for (const [label, base] of [['cards off', good], ['the switch-on set', { ...good, ...cardsOn }]] as const) {
        expect(refusal({ ...base, CARD_RAIL_KILL: kill }), `${label} ${JSON.stringify(kill)}`).toMatch(/^FATAL: CARD_RAIL_KILL must be exactly 1 \(cards off\) or exactly 0 \(cards on\) in production/);
      }
    }
  });

  it('KEPT: the kill switch off needs card rail v2 on, on the real provider, with real cards', () => {
    const needs = /^FATAL: CARD_RAIL_KILL=0 \(cards on\) in production needs CARD_RAIL_V2=1, CARD_RAIL_PROVIDER=powertranz and CARD_RAIL_ENVIRONMENT=live/;
    const cases: Array<[string, Record<string, string | undefined>, RegExp]> = [
      ['kill off, v2 unset, nothing set up', { CARD_RAIL_KILL: '0' }, needs],
      ['kill off, v2 0, live setup', { ...cardsOn, CARD_RAIL_V2: '0' }, needs],
      ['kill off, v2 unset, live setup', { ...cardsOn, CARD_RAIL_V2: undefined }, needs],
      ['kill off, v2 empty, live setup', { ...cardsOn, CARD_RAIL_V2: '' }, needs],
      // PT-4 refuses these first (v2 on production is the real provider with live cards only).
      ['kill off, v2 on, the provider\'s sandbox', { ...cardsOn, CARD_RAIL_ENVIRONMENT: 'sandbox', POWERTRANZ_API_URL: 'https://staging.ptranz.com' }, /^FATAL: CARD_RAIL_V2=1 in production, but the card provider is not fully set up for live cards: .*real cards only/],
      ['kill off, v2 on, no environment', { ...cardsOn, CARD_RAIL_ENVIRONMENT: undefined }, /^FATAL: CARD_RAIL_V2=1 in production, but the card provider is not fully set up/],
      ['kill off, v2 on, the simulator', { ...cardsOn, CARD_RAIL_PROVIDER: 'simulator' }, /CARD_RAIL_PROVIDER=simulator/],
      ['kill off, v2 on, no provider', { ...cardsOn, CARD_RAIL_PROVIDER: undefined }, /^FATAL: CARD_RAIL_V2=1 in production needs CARD_RAIL_PROVIDER=powertranz/],
      ['kill off, v2 on, the simulator\'s test switch', { ...cardsOn, CARD_RAIL_SIMULATOR_LIVE: '1' }, /CARD_RAIL_SIMULATOR_LIVE/],
    ];
    for (const [label, env, message] of cases) {
      expect(refusal({ ...good, ...env }), label).toMatch(message);
    }
  });

  it('KEPT: with cards on, anything less than the complete live setup refuses to start, naming the setting, never a value', () => {
    const cases: Array<[Record<string, string | undefined>, RegExp]> = [
      [{ POWERTRANZ_API_URL: undefined }, /POWERTRANZ_API_URL/],
      [{ POWERTRANZ_API_URL: 'https://staging.ptranz.com' }, /test system/],
      [{ POWERTRANZ_API_URL: 'https://gateway.example.com' }, /ptranz\.com/],
      [{ POWERTRANZ_API_URL: 'https://gateway.ptranz.com/api/spi/sale' }, /POWERTRANZ_API_URL/],
      [{ POWERTRANZ_API_URL: 'http://gateway.ptranz.com' }, /POWERTRANZ_API_URL/],
      [{ POWERTRANZ_ID: undefined }, /POWERTRANZ_ID/],
      [{ POWERTRANZ_PASSWORD: undefined }, /POWERTRANZ_PASSWORD/],
      [{ POWERTRANZ_PAGE_SET: undefined }, /POWERTRANZ_PAGE_SET and POWERTRANZ_PAGE_NAME/],
      [{ CARD_RAIL_ACCOUNT: undefined }, /CARD_RAIL_ACCOUNT/],
      [{ API_PUBLIC_URL: 'http://api.example.com' }, /API_PUBLIC_URL/],
    ];
    for (const [patch, message] of cases) {
      const thrown = refusal({ ...good, ...cardsOn, ...patch });
      expect(thrown, JSON.stringify(patch)).toMatch(/^FATAL: CARD_RAIL_V2=1 in production, but the card provider is not fully set up/);
      expect(thrown).toMatch(message);
      expect(thrown).not.toContain('not-a-real-password');
    }
  });

  it('KEPT: saved cards and automatic weekly card charges (CARD_RAIL_ENROLL) stay refused — cards off, on or paused; no near miss either', () => {
    for (const [label, base] of [['cards off', good], ['cards on', { ...good, ...cardsOn }], ['cards paused', { ...good, ...cardsPaused }]] as const) {
      for (const value of ['1', 'true', 'yes', 'on', ' 1', '01']) {
        const thrown = refusal({ ...base, CARD_RAIL_ENROLL: value });
        expect(thrown, `${label} ${JSON.stringify(value)}`).toMatch(/^FATAL: CARD_RAIL_ENROLL must be unset or 0 in production/);
        expect(thrown).toMatch(/GUARDRAILS §8/);
      }
    }
  });

  it('KEPT: the drain switch stays refused — the rollback is the kill switch with v2 left on', () => {
    for (const [label, env] of [
      ['cards on', cardsOn],
      ['cards paused', cardsPaused],
      ['v2 off, the live setup present', { ...liveCardRail, CARD_RAIL_V2: '0' }],
    ] as const) {
      const thrown = refusal({ ...good, ...env, CARD_RAIL_V2_DRAIN: '1' });
      expect(thrown, label).toMatch(/^FATAL: CARD_RAIL_V2_DRAIN must be unset or 0 in production/);
      expect(thrown).toMatch(/CARD_RAIL_KILL=1/);
    }
  });

  it('KEPT: the legacy card seam (PAYMENT_PROVIDER) stays exactly disabled, cards off or on', () => {
    for (const [label, provider] of [['a live Stripe key', liveStripe], ['live legacy PowerTranz', livePowerTranz]] as const) {
      expect(refusal({ ...good, ...provider }), label).toMatch(/^FATAL: PAYMENT_PROVIDER must be exactly disabled in production/);
      expect(refusal({ ...good, ...cardsOn, ...provider }), `${label}, cards on`).toMatch(/^FATAL: PAYMENT_PROVIDER must be exactly disabled in production/);
    }
    for (const provider of [undefined, '', 'sandbox', 'Disabled', 'disabled ']) {
      expect(refusal({ ...good, ...cardsOn, PAYMENT_PROVIDER: provider }), String(provider)).toMatch(/^FATAL: PAYMENT_PROVIDER must be/);
    }
  });

  it('KEPT: ads stay refused, cards off or on; no near miss either', () => {
    for (const value of ['1', 'true', 'yes', 'on', ' 1', '01']) {
      for (const base of [good, { ...good, ...cardsOn }]) {
        expect(refusal({ ...base, ADS_ENABLED: value }), value).toMatch(/^FATAL: ADS_ENABLED must be unset or 0 in production/);
      }
    }
  });

  it('every refusal names the setting and the owner\'s ruling — never an attorney sign-off, never a credential', () => {
    const ruled = [
      refusal({ ...good, ...liveStripe }),
      refusal({ ...good, CARD_RAIL_KILL: '0' }),
      refusal({ ...good, CARD_RAIL_KILL: 'yes' }),
      refusal({ ...good, ...cardsOn, CARD_RAIL_ENROLL: '1' }),
      refusal({ ...good, ...cardsOn, ADS_ENABLED: '1' }),
    ];
    for (const message of [...ruled, refusal({ ...good, ...cardsOn, CARD_RAIL_V2_DRAIN: '1' })]) {
      expect(message).toMatch(/^FATAL: /);
      expect(message).toMatch(/reviewed code change/);
      expect(message).not.toMatch(/attorney/i);
      expect(message).not.toContain('not-a-real-password');
    }
    // [Review #2465-B B3] Cards ON cites the owner's go-cards ruling; saved cards and ads keep their own rulings.
    const GO_CARDS = /owner's go-cards ruling.*OWNER-DECISIONS, dated at the go/;
    for (const message of ruled.slice(0, 3)) expect(message).toMatch(GO_CARDS);
    for (const message of ruled) expect(message).not.toMatch(/7 Oct/);
    expect(refusal({ ...good, ...cardsOn, CARD_RAIL_ENROLL: '1' })).toMatch(/GUARDRAILS §8; owner rulings, 13 and 15 Oct/);
    expect(refusal({ ...good, ...cardsOn, ADS_ENABLED: '1' })).toMatch(/GUARDRAILS §8; owner rulings, 15 Oct and 6 Nov/);
  });

  // [Review #2465-A F2] The test-subscription list only ever names what a TEST card system may serve; production runs
  // none, so a listed id there could only let a test record be booked or refunded as a test.
  it('KEPT: production refuses a test-subscription list (CARD_RAIL_TEST_SUBSCRIPTIONS), cards off, on or paused', () => {
    for (const [label, base] of [['cards off', good], ['cards on', { ...good, ...cardsOn }], ['cards paused', { ...good, ...cardsPaused }]] as const) {
      for (const value of ['sub_1', 'sub_1,sub_2', ' ', ',']) {
        expect(refusal({ ...base, CARD_RAIL_TEST_SUBSCRIPTIONS: value }), `${label} ${JSON.stringify(value)}`).toMatch(/^FATAL: CARD_RAIL_TEST_SUBSCRIPTIONS must be empty in production/);
      }
      for (const empty of [undefined, '']) expect(refusal({ ...base, CARD_RAIL_TEST_SUBSCRIPTIONS: empty }), `${label} ${String(empty)}`).toBe('');
    }
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', CARD_RAIL_V2: '1', CARD_RAIL_PROVIDER: 'simulator', CARD_RAIL_TEST_SUBSCRIPTIONS: 'sub_1' })).not.toThrow();
  });

  // [Reviews #2465-A F1 / B-B4] pilot-up.sh runs THIS guard in the new image before the swap
  // (node dist/boot/boot-guard.js, as api and as worker): the entry prints the server's own refusal and exits 1, or
  // prints one OK line and exits 0. Run here as pilot-up runs it, as its own process with only the given settings.
  describe('the boot-guard entry (dist/boot/boot-guard.js) pilot-up runs before the swap', () => {
    const guard = (env: Record<string, string | undefined>) => spawnSync(join(process.cwd(), 'node_modules/.bin/tsx'), [join(process.cwd(), 'src/boot/boot-guard.ts')], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', ...Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)) },
    });

    it('passes production as it runs today, and the switch-on set: exit 0, one OK line', () => {
      for (const env of [good, { ...good, ...cardsOn }, { ...good, ...cardsPaused }]) {
        const run = guard(env);
        expect(run.status, run.stdout + run.stderr).toBe(0);
        expect(run.stdout.trim()).toBe('OK boot guard: this configuration starts');
      }
    });

    it('refuses what the API refuses (the settings pilot-up\'s shell checks never read included): exit 1, the server\'s own message, never a value', () => {
      const cases: Array<[string, Record<string, string | undefined>, RegExp]> = [
        ['the card simulator', { ...good, CARD_RAIL_PROVIDER: 'simulator' }, /CARD_RAIL_PROVIDER=simulator/],
        ['the simulator\'s test switch', { ...good, CARD_RAIL_SIMULATOR_LIVE: '1' }, /CARD_RAIL_SIMULATOR_LIVE/],
        ['PowerTranz not live, v2 off', { ...good, CARD_RAIL_PROVIDER: 'powertranz', CARD_RAIL_ENVIRONMENT: 'sandbox' }, /a TEST card system/],
        ['no page name', { ...good, ...cardsOn, POWERTRANZ_PAGE_NAME: undefined }, /POWERTRANZ_PAGE_NAME/],
        ['no account label', { ...good, ...cardsOn, CARD_RAIL_ACCOUNT: undefined }, /CARD_RAIL_ACCOUNT/],
        ['a malformed provider address', { ...good, ...cardsOn, POWERTRANZ_API_URL: 'gateway.ptranz.com/api/spi' }, /POWERTRANZ_API_URL/],
        ['a test-subscription list', { ...good, CARD_RAIL_TEST_SUBSCRIPTIONS: 'sub_1' }, /CARD_RAIL_TEST_SUBSCRIPTIONS/],
        ['saved cards', { ...good, ...cardsOn, CARD_RAIL_ENROLL: '1' }, /CARD_RAIL_ENROLL/],
        ['a non-card refusal (no on-call list)', { ...good, OPS_ONCALL_PHONES: undefined }, /OPS_ONCALL_PHONES/],
        ['a store secret that cannot be read', { ...good, ...cardsOn, POWERTRANZ_ID: undefined, POWERTRANZ_ID_FILE: '/nonexistent/POWERTRANZ_ID' }, /POWERTRANZ_ID_FILE/],
      ];
      for (const [label, env, named] of cases) {
        const run = guard(env);
        expect(run.status, `${label}: ${run.stdout}${run.stderr}`).toBe(1);
        expect(run.stderr, label).toMatch(/^FATAL/m);
        expect(run.stderr, label).toMatch(named);
        expect(run.stdout + run.stderr, label).not.toContain('not-a-real-password');
        expect(run.stdout, label).not.toContain('OK boot guard');
      }
    });
  });

  it('asks nothing outside production: staging and test servers keep their switches', () => {
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', ADS_ENABLED: '1', CARD_RAIL_ENROLL: '1', PAYMENT_PROVIDER: 'sandbox' })).not.toThrow();
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', CARD_RAIL_V2: '1', CARD_RAIL_PROVIDER: 'simulator' })).not.toThrow();
    expect(() => assertSafeBootConfig({ NODE_ENV: 'test', ADS_ENABLED: '1' })).not.toThrow();
  });

  it('the value-free preflight passes the switch-on set and names each kept lock', () => {
    const on = runPreflight({ ...good, ...cardsOn });
    expect(on.status, on.stdout + on.stderr).toBe(0);
    const result = runPreflight({ ...good, ...liveStripe, ADS_ENABLED: '1', CARD_RAIL_ENROLL: '1' });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('PAYMENT_PROVIDER must be exactly disabled');
    expect(result.stdout).toContain('CARD_RAIL_ENROLL must be unset or 0');
    expect(result.stdout).toContain('ADS_ENABLED must be unset or 0');
  });
});

// ---------------------------------------------------------------------------
// [CARDS-SWITCH-ON · CARD-STAGING-TEST, 10 Nov 2026] Staging ran card rail v2
// on PowerTranz, but deploy/.env had no POWERTRANZ_ID_FILE /
// POWERTRANZ_PASSWORD_FILE lines: the API and the worker could not read the
// credentials, and cards could not work, while every health check read green.
// Card rail v2 (or its drain) on PowerTranz now refuses to start, in every mode
// and WHATEVER THE KILL SWITCH (a killed rail still confirms, sweeps, looks up,
// voids and refunds through the provider: review #2466-B F2), unless the
// provider's whole setup reads — the credentials and the PTZ/ page set
// included — naming the store wiring to add, never a value. Production
// already refused v2 without the complete live setup (PT-4, any kill switch);
// its refusal names the same wiring (one helper).
// ---------------------------------------------------------------------------
describe('[CARDS-SWITCH-ON] card rail v2 (or its drain) on PowerTranz refuses to start without its credentials, whatever the kill switch, in every mode', () => {
  const sandboxOn = {
    PAYMENT_PROVIDER: 'disabled', CARD_RAIL_KILL: '0', CARD_RAIL_V2: '1', CARD_RAIL_PROVIDER: 'powertranz', CARD_RAIL_ENVIRONMENT: 'sandbox',
    CARD_RAIL_ACCOUNT: 'swift-gy-test', POWERTRANZ_PAGE_SET: 'PTZ/SWIFT', POWERTRANZ_PAGE_NAME: 'WeeklyFee', API_PUBLIC_URL: 'https://api-staging.example.test',
  };
  const creds = { POWERTRANZ_ID: 'TESTID01', POWERTRANZ_PASSWORD: 'not-a-real-password' };
  const refusal = (env: Record<string, string | undefined>): string => {
    try { assertSafeBootConfig(env); } catch (error) { return (error as Error).message; }
    return '';
  };
  const NOT_READ = /^FATAL: CARD_RAIL_V2(_DRAIN)?=1 with CARD_RAIL_PROVIDER=powertranz, but this server cannot read the card provider's settings: /;
  const WIRING = 'POWERTRANZ_ID_FILE=/run/secrets/POWERTRANZ_ID and POWERTRANZ_PASSWORD_FILE=/run/secrets/POWERTRANZ_PASSWORD';
  /** Every switch state that still reaches the provider: v2 on (killed or not, any kill value), or draining. */
  const reaching = [
    { CARD_RAIL_KILL: '0' }, { CARD_RAIL_KILL: '1' }, { CARD_RAIL_KILL: undefined }, { CARD_RAIL_KILL: 'true' },
    { CARD_RAIL_V2: '0', CARD_RAIL_V2_DRAIN: '1' }, { CARD_RAIL_V2: '0', CARD_RAIL_V2_DRAIN: '1', CARD_RAIL_KILL: '1' },
  ];

  it.each(['development', 'loadtest', 'test'])('%s: no credentials (no *_FILE lines) refuses, naming the store wiring — killed or not, v2 or drain', (mode) => {
    for (const over of reaching) {
      const thrown = refusal({ NODE_ENV: mode, ...sandboxOn, ...over });
      expect(thrown, JSON.stringify(over)).toMatch(NOT_READ);
      expect(thrown).toMatch(/POWERTRANZ_ID/);
      expect(thrown).toContain(WIRING);
      const noPassword = refusal({ NODE_ENV: mode, ...sandboxOn, ...over, POWERTRANZ_ID: 'TESTID01' });
      expect(noPassword, JSON.stringify(over)).toMatch(NOT_READ);
      expect(noPassword).toMatch(/POWERTRANZ_PASSWORD/);
      expect(noPassword).toContain(WIRING);
    }
  });

  it('any other missing piece of the setup refuses too, the PTZ/ page set included — killed or not — never echoing a value', () => {
    for (const over of reaching) {
      for (const [patch, message] of [
        [{ POWERTRANZ_PAGE_SET: 'SWIFT' }, /POWERTRANZ_PAGE_SET must start with PTZ\//],
        [{ POWERTRANZ_PAGE_NAME: undefined }, /POWERTRANZ_PAGE_SET and POWERTRANZ_PAGE_NAME|POWERTRANZ_PAGE_NAME/],
        [{ CARD_RAIL_ACCOUNT: undefined }, /CARD_RAIL_ACCOUNT/],
        [{ API_PUBLIC_URL: undefined }, /API_PUBLIC_URL/],
        [{ CARD_RAIL_ENVIRONMENT: undefined }, /CARD_RAIL_ENVIRONMENT/],
        [{ POWERTRANZ_API_URL: 'https://gateway.ptranz.com' }, /not a test system/],
      ] as const) {
        const thrown = refusal({ NODE_ENV: 'loadtest', ...sandboxOn, ...creds, ...over, ...patch });
        expect(thrown, `${JSON.stringify(over)} ${JSON.stringify(patch)}`).toMatch(NOT_READ);
        expect(thrown).toMatch(message);
        expect(thrown).not.toContain('not-a-real-password');
        expect(thrown).not.toContain(WIRING); // only a credential refusal names the store wiring
      }
    }
  });

  it('the credentials read from the store through the real *_FILE loader: boots (killed too)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swift-ptz-secrets-'));
    try {
      writeFileSync(join(dir, 'POWERTRANZ_ID'), 'TESTID01\n');
      writeFileSync(join(dir, 'POWERTRANZ_PASSWORD'), 'not-a-real-password\n');
      for (const kill of ['0', '1']) {
        const env: Record<string, string | undefined> = {
          NODE_ENV: 'loadtest', ...sandboxOn, CARD_RAIL_KILL: kill,
          POWERTRANZ_ID_FILE: join(dir, 'POWERTRANZ_ID'), POWERTRANZ_PASSWORD_FILE: join(dir, 'POWERTRANZ_PASSWORD'),
        };
        expect(refusal(env), kill).toMatch(NOT_READ); // the guard reads only what the loader put in the environment
        applySecretFiles(env);
        expect(refusal(env), kill).toBe('');
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('v2 and its drain both off, or another provider: nothing about PowerTranz is asked', () => {
    expect(refusal({ NODE_ENV: 'loadtest', ...sandboxOn, CARD_RAIL_V2: '0' })).toBe('');
    expect(refusal({ NODE_ENV: 'loadtest', ...sandboxOn, CARD_RAIL_V2: undefined, CARD_RAIL_KILL: '1' })).toBe('');
    expect(refusal({ NODE_ENV: 'loadtest', ...sandboxOn, CARD_RAIL_V2: '0', CARD_RAIL_V2_DRAIN: '0' })).toBe('');
    expect(refusal({ NODE_ENV: 'development', CARD_RAIL_V2: '1', CARD_RAIL_PROVIDER: 'simulator' })).toBe('');
    for (const over of reaching) expect(refusal({ NODE_ENV: 'loadtest', ...sandboxOn, ...creds, ...over }), JSON.stringify(over)).toBe('');
  });

  it('production: v2 without the credentials refuses (any kill switch), naming the same store wiring', () => {
    const liveOn = {
      ...sandboxOn, CARD_RAIL_ENVIRONMENT: 'live', CARD_RAIL_ACCOUNT: 'swift-gy-live', POWERTRANZ_API_URL: 'https://gateway.ptranz.com',
      API_PUBLIC_URL: 'https://api.example.com',
    };
    for (const kill of ['0', '1']) {
      for (const missing of ['POWERTRANZ_ID', 'POWERTRANZ_PASSWORD']) {
        const thrown = refusal({ ...good, ...liveOn, ...creds, CARD_RAIL_KILL: kill, [missing]: undefined });
        expect(thrown, `${kill} ${missing}`).toMatch(/^FATAL: CARD_RAIL_V2=1 in production, but the card provider is not fully set up for live cards: /);
        expect(thrown).toContain(WIRING);
        expect(thrown).not.toContain('not-a-real-password');
      }
      // The PTZ/ prefix too (powerTranzConfigFromEnv, for production as for staging).
      expect(refusal({ ...good, ...liveOn, ...creds, CARD_RAIL_KILL: kill, POWERTRANZ_PAGE_SET: 'SWIFT' }), kill).toMatch(/^FATAL: CARD_RAIL_V2=1 in production, but the card provider is not fully set up for live cards: .*PTZ\//);
    }
    expect(refusal({ ...good, ...liveOn, ...creds })).toBe('');
  });
});

describe('[TA-S0-003 · R3] the contract posture runs on the two least-privilege logins only', () => {
  const APP_URL = 'postgresql://swift_app_login:app-fixture-secret@postgres:5432/swift';
  const SYSTEM_URL = 'postgresql://swift_system_login:system-fixture-secret@postgres:5432/swift';
  const walled: Record<string, string | undefined> = {
    ...good, TENANT_RLS_BIND: '1', TENANT_UNSCOPED_ACCESS: 'deny', DATABASE_URL: APP_URL, SYSTEM_DATABASE_URL: SYSTEM_URL,
  };
  const refusal = (env: Record<string, string | undefined>) => {
    try {
      assertSafeBootConfig(env);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };

  it('boots on swift_app_login + swift_system_login with unscoped access denied', () => {
    expect(refusal(walled)).toBeNull();
  });

  it.each([
    ['unscoped access only counted', { TENANT_UNSCOPED_ACCESS: 'log' }, /TENANT_UNSCOPED_ACCESS is not deny/],
    ['unscoped access unset', { TENANT_UNSCOPED_ACCESS: undefined }, /TENANT_UNSCOPED_ACCESS is not deny/],
    ['the expand declaration riding along', { TENANT_WALL_EXPAND_ATTESTED: '1' }, /TENANT_WALL_EXPAND_ATTESTED is set/],
    ["the owner's password in the process", { POSTGRES_PASSWORD: 'owner-fixture-secret' }, /owner's password/],
    ['no request URL', { DATABASE_URL: undefined }, /DATABASE_URL is missing/],
    ['a request URL that is not a postgres URL', { DATABASE_URL: 'mysql://swift_app_login:x@postgres/swift' }, /DATABASE_URL is missing or not/],
    ['no system URL', { SYSTEM_DATABASE_URL: undefined }, /SYSTEM_DATABASE_URL is missing/],
    ['the owner as the request login', { DATABASE_URL: 'postgresql://swift:owner-fixture-secret@postgres:5432/swift' }, /DATABASE_URL does not sign in as swift_app_login/],
    ['postgres as the request login', { DATABASE_URL: 'postgresql://postgres:owner-fixture-secret@postgres:5432/swift' }, /does not sign in as swift_app_login/],
    ['the system login as the request login', { DATABASE_URL: SYSTEM_URL }, /does not sign in as swift_app_login/],
    ['the owner as the system login', { SYSTEM_DATABASE_URL: 'postgresql://swift:owner-fixture-secret@postgres:5432/swift' }, /SYSTEM_DATABASE_URL does not sign in as swift_system_login/],
    ['one login for both', { SYSTEM_DATABASE_URL: APP_URL }, /does not sign in as swift_system_login/],
    ['another database', { SYSTEM_DATABASE_URL: SYSTEM_URL.replace(':5432/swift', ':5432/other') }, /different databases/],
    ['another host', { SYSTEM_DATABASE_URL: SYSTEM_URL.replace('@postgres:', '@elsewhere:') }, /different databases/],
    ['another port', { SYSTEM_DATABASE_URL: SYSTEM_URL.replace(':5432/', ':5433/') }, /different databases/],
  ])('refuses %s, naming no value', (_label, change, pattern) => {
    const message = refusal({ ...walled, ...change });
    expect(message).toMatch(/^FATAL: TENANT_RLS_BIND=1 in production/);
    expect(message).toMatch(pattern);
    for (const value of ['fixture-secret', 'elsewhere', 'mysql://', '5433']) expect(message).not.toContain(value);
  });

  it('touches nothing without TENANT_RLS_BIND=1, and nothing outside production', () => {
    // Today's expand posture (staging, production before Phase C) is unchanged.
    expect(refusal({ ...good, TENANT_WALL_EXPAND_ATTESTED: '1', DATABASE_URL: 'postgresql://swift:owner-fixture-secret@postgres:5432/swift' })).toBeNull();
    expect(refusal({ ...good, TENANT_RLS_BIND: '0', DATABASE_URL: 'postgresql://swift:o@postgres:5432/swift' })).toBeNull();
    for (const NODE_ENV of ['development', 'test']) {
      expect(() => assertWallLoginConfig({ NODE_ENV, TENANT_RLS_BIND: '1', DATABASE_URL: 'postgresql://swift:o@postgres:5432/swift' })).not.toThrow();
    }
  });

  it('the deploy preflight mirrors the compose overlay when it reads the store', () => {
    // The store after Phase C holds the owner's password (postgres and migrate
    // still use it) AND the two runtime URLs. The overlay hands the API only the
    // URLs; without it the API gets only the owner's parts.
    const directory = mkdtempSync(join(tmpdir(), 'swift-wall-preflight-'));
    try {
      const secrets = join(directory, 'secrets');
      mkdirSync(secrets);
      writeFileSync(join(secrets, 'POSTGRES_PASSWORD'), 'owner-fixture-secret');
      writeFileSync(join(secrets, 'DATABASE_URL'), APP_URL);
      writeFileSync(join(secrets, 'SYSTEM_DATABASE_URL'), SYSTEM_URL);
      const run = (candidate: Record<string, string | undefined>) => {
        const file = join(directory, 'candidate.txt');
        writeFileSync(file, Object.entries(candidate).filter((e): e is [string, string] => e[1] !== undefined)
          .map(([name, value]) => `${name}=${value}`).join('\n'));
        return spawnSync(join(process.cwd(), 'node_modules/.bin/tsx'), [join(process.cwd(), '../../deploy/preflight.ts'), file, '--secrets-dir', secrets],
          { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
      };
      // The overlay hands the two URLs over as files from the store, never as settings.
      const walledSettings = Object.fromEntries(Object.entries(walled)
        .filter(([name]) => name !== 'DATABASE_URL' && name !== 'SYSTEM_DATABASE_URL'));
      const contract = run(walledSettings);
      expect(contract.stdout + contract.stderr).not.toMatch(/both set/);
      expect(contract.stdout).toMatch(/PASS/);
      const expand = run({ ...good, TENANT_WALL_EXPAND_ATTESTED: '1', POSTGRES_HOST: 'postgres', POSTGRES_USER: 'swift', POSTGRES_DB: 'swift' });
      expect(expand.stdout + expand.stderr).not.toMatch(/both set/);
      expect(expand.stdout).toMatch(/PASS/);
      for (const output of [contract, expand]) expect(output.stdout + output.stderr).not.toContain('fixture-secret');
    } finally {
      rmSync(directory, { recursive: true });
    }
  }, 60_000);
});
