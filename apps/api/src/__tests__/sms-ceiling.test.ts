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

  it('past the ceiling an ordinary text is refused and nothing is sent; a life-safety text still goes', async () => {
    process.env['SMS_DAILY_PARTS_CEILING'] = '2';
    await redis.del(key);
    const sms = withSmsCeiling(inner);
    await sms.sendSms('+5926000001', 'one');
    await sms.sendSms('+5926000002', 'two');
    await expect(sms.sendSms('+5926000003', 'three')).rejects.toBeInstanceOf(SmsCeilingReachedError);
    expect(sent.map((s) => s.to)).toEqual(['+5926000001', '+5926000002']);
    await sms.sendSms('+5926000004', 'SOS', { lifeSafety: true });
    expect(sent.map((s) => s.to)).toContain('+5926000004');
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

  it('the life-safety mark crosses the review seal', async () => {
    await sealSms(inner).sendSms('+5926000007', 'page', { lifeSafety: true });
    expect(sent.at(-1)?.options).toEqual({ lifeSafety: true });
  });
});
