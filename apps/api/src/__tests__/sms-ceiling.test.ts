import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Redis from 'ioredis';
import { setSmsCeilingStore, withSmsCeiling, billedParts, SmsCeilingReachedError } from '../providers/notifications/sms-ceiling';
import { guyanaDayKey } from '../utils/guyana-day';
import { sealSms } from '../providers/notifications/review-seal';
import type { SmsOptions } from '../providers/notifications/channels';

// [AUDIT-20261113 FABLE-03 S3-6] One last-resort daily ceiling on every paid text, counted in parts. Past it a
// text is refused — never a life-safety text (SOS to a contact, an on-call page) — and a failed send gives
// its parts back.
describe('[AUDIT-20261113 S3-6] the daily paid-SMS ceiling', () => {
  let redis: Redis;
  const key = `sms_parts_day:${guyanaDayKey(new Date())}`;
  const sent: Array<{ to: string; options?: SmsOptions }> = [];
  const inner = { sendSms: async (to: string, _body: string, options?: SmsOptions) => { sent.push({ to, options }); return { ref: 'ok' }; } };
  beforeAll(() => { redis = new Redis(process.env['REDIS_URL'] || 'redis://localhost:6382'); setSmsCeilingStore(redis); });
  afterEach(async () => { delete process.env['SMS_DAILY_PARTS_CEILING']; sent.length = 0; await redis.del(key); });
  afterAll(async () => { setSmsCeilingStore(null); await redis.quit(); });

  it('past the ceiling an ordinary text is refused and nothing is sent; a life-safety text still goes, uncounted', async () => {
    process.env['SMS_DAILY_PARTS_CEILING'] = '2';
    await redis.del(key);
    const sms = withSmsCeiling(inner);
    await sms.sendSms('+5926000001', 'one');
    await sms.sendSms('+5926000002', 'two');
    await expect(sms.sendSms('+5926000003', 'three')).rejects.toBeInstanceOf(SmsCeilingReachedError);
    expect(sent.map((s) => s.to)).toEqual(['+5926000001', '+5926000002']);
    await sms.sendSms('+5926000004', 'SOS', { lifeSafety: true });
    expect(sent.map((s) => s.to)).toContain('+5926000004');
    expect(Number(await redis.get(key))).toBe(2);
  });

  // [REVIEW-2499-A S2-2] A sign-in, step-up, solo or seed code has its own daily budget: the ceiling never refuses
  // it (or the console would be locked out exactly when the budgets were built to keep it open), nor counts it.
  it('past the ceiling a budgeted code still goes, and is not counted', async () => {
    process.env['SMS_DAILY_PARTS_CEILING'] = '1';
    await redis.del(key);
    const sms = withSmsCeiling(inner);
    await sms.sendSms('+5926000010', 'ordinary');
    await expect(sms.sendSms('+5926000011', 'ordinary again')).rejects.toBeInstanceOf(SmsCeilingReachedError);
    await sms.sendSms('+5926000012', 'Your Swift verification code is: 123456', { budgeted: true });
    expect(sent.map((s) => s.to)).toContain('+5926000012');
    expect(Number(await redis.get(key))).toBe(1);
  });

  it('every code sender and every life-safety sender carries its mark (text census)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');
    expect(src('modules/auth/auth.service.ts')).toMatch(/`Your Swift verification code is: \$\{otp\}`,\n[^\n]*\n\s*\{ budgeted: true \}/);
    expect(src('modules/auth/step-up.ts')).toContain('Swift will never ask you for it.`, { budgeted: true });');
    expect(src('modules/admin/solo-approval.ts')).toContain('sendSms(to, body.slice(0, 480), { budgeted: true })');
    expect(src('modules/ops/seed-plan.ts')).toContain('do not share the code.`, { budgeted: true });');
    expect(src('modules/admin/phone-change.ts')).toContain('to nobody else.`, { budgeted: true });');
    expect(src('modules/safety/ops-alert.ts')).toContain('sms.sendSms(phone, text.slice(0, 480), { lifeSafety: true })');
    expect(src('modules/safety/sos-escalation.ts')).toContain('sosContactText(authority.who, where), { lifeSafety: true })');
    expect(src('modules/safety/sos.service.ts')).toContain('sms.sendSms(c.phoneE164, body, { lifeSafety: true })');
  });

  it('counts parts, and a send the provider fails gives its parts back', async () => {
    await redis.del(key);
    expect(billedParts('a'.repeat(161))).toBe(2);
    const failing = withSmsCeiling({ sendSms: async () => { throw new Error('provider down'); } });
    await expect(failing.sendSms('+5926000005', 'x')).rejects.toThrow('provider down');
    expect(Number(await redis.get(key) ?? 0)).toBe(0);
    await withSmsCeiling(inner).sendSms('+5926000006', 'a'.repeat(161));
    expect(Number(await redis.get(key))).toBe(2);
  });

  it('the life-safety and budgeted marks cross the review seal', async () => {
    await sealSms(inner).sendSms('+5926000007', 'page', { lifeSafety: true });
    expect(sent.at(-1)?.options).toEqual({ lifeSafety: true });
    await sealSms(inner).sendSms('+5926000008', 'code', { budgeted: true });
    expect(sent.at(-1)?.options).toEqual({ budgeted: true });
  });
});
