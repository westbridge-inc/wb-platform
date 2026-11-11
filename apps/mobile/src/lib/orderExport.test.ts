import { describe, expect, it } from 'vitest';
import { ORDER_EXPORT_PHONE_MAX_CHARS, ORDER_EXPORT_TOO_LARGE, guyanaDay, orderExportAllLabel, orderExportDays, orderExportRefusal, orderExportShareable, orderExportTitle } from './orderExport';

// [ORDER-EXPORT] The phone's export presets are Guyana days, end today, and never exceed the server's 366 days.
const span = (d: { from: string; to: string }) => (Date.parse(`${d.to}T00:00:00Z`) - Date.parse(`${d.from}T00:00:00Z`)) / 864e5 + 1;

describe('orderExportDays', () => {
  // 01:30 UTC on 1 Nov is still 31 Oct (21:30) in Guyana.
  const lateEvening = new Date('2026-11-01T01:30:00.000Z');

  it('uses the Guyana day, not the UTC day', () => {
    expect(guyanaDay(lateEvening)).toBe('2026-10-31');
    expect(orderExportDays('this-month', lateEvening)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('last month is the whole previous calendar month, across a year end', () => {
    expect(orderExportDays('last-month', new Date('2026-11-11T12:00:00Z'))).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(orderExportDays('last-month', new Date('2027-01-05T12:00:00Z'))).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(orderExportDays('last-month', new Date('2028-03-02T12:00:00Z'))).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('30 days and 12 months end today and stay inside the 366-day limit', () => {
    const now = new Date('2026-11-11T12:00:00Z');
    expect(orderExportDays('30d', now)).toEqual({ from: '2026-10-13', to: '2026-11-11' });
    expect(span(orderExportDays('30d', now))).toBe(30);
    expect(span(orderExportDays('365d', now))).toBe(365);
    expect(span(orderExportDays('365d', new Date('2028-12-31T12:00:00Z')))).toBeLessThanOrEqual(366);
  });

  it('names the file by its days and branches', () => {
    expect(orderExportTitle({ from: '2026-10-01', to: '2026-10-31' }, true)).toBe('Swift orders (all branches) 2026-10-01 to 2026-10-31');
    expect(orderExportTitle({ from: '2026-10-01', to: '2026-10-31' }, false)).toBe('Swift orders 2026-10-01 to 2026-10-31');
  });
});

describe('orderExportRefusal', () => {
  it('reads the server\'s message from a text body, and nothing else', () => {
    const body = JSON.stringify({ success: false, error: { code: 'STAFF_FORBIDDEN', message: 'This needs a manager' } });
    expect(orderExportRefusal({ response: { data: body } })).toBe('This needs a manager');
    expect(orderExportRefusal({ response: { data: 'not json' } })).toBeNull();
    expect(orderExportRefusal(new Error('network'))).toBeNull();
  });
});

describe('[REVIEW-2485-B S2-2] the phone share size guard', () => {
  it('stays well under Android\'s ~1 MB share limit (text travels as UTF-16)', () => {
    expect(ORDER_EXPORT_PHONE_MAX_CHARS * 2).toBeLessThanOrEqual(500_000);
  });

  it('shares a small file and refuses a large one with the website advice', () => {
    expect(orderExportShareable('a'.repeat(ORDER_EXPORT_PHONE_MAX_CHARS))).toBe(true);
    expect(orderExportShareable('a'.repeat(ORDER_EXPORT_PHONE_MAX_CHARS + 1))).toBe(false);
    expect(ORDER_EXPORT_TOO_LARGE).toBe('Too large to share from the phone. Use the website (Insights, Export orders) or choose a shorter range.');
  });

  it('a manager is offered the branches they manage, an owner all branches', () => {
    expect(orderExportAllLabel('manager')).toBe('All branches you manage');
    expect(orderExportAllLabel('owner')).toBe('All branches');
  });
});
