import { describe, it, expect, afterEach } from 'vitest';
import { localIsoDate, actionKey } from '../src/lib/dates.ts';

describe('today, on the wall', () => {
  const original = process.env['TZ'];
  afterEach(() => { if (original === undefined) delete process.env['TZ']; else process.env['TZ'] = original; });

  it('is the local date in India in the small hours, when UTC still says yesterday', () => {
    process.env['TZ'] = 'Asia/Kolkata';
    // 20:30 UTC on the 10th is 02:00 on the 11th in India.
    const instant = new Date('2026-11-10T20:30:00Z');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-11-10');   // the bug
    expect(localIsoDate(instant)).toBe('2026-11-11');
  });

  it('agrees with UTC once the two calendars line up again', () => {
    process.env['TZ'] = 'Asia/Kolkata';
    expect(localIsoDate(new Date('2026-11-10T06:00:00Z'))).toBe('2026-11-10');
  });

  it('pads single-digit months and days', () => {
    process.env['TZ'] = 'Asia/Kolkata';
    expect(localIsoDate(new Date('2027-01-04T06:00:00Z'))).toBe('2027-01-04');
  });
});

describe('a key for one intended action', () => {
  it('carries its prefix and is different each time one is made', () => {
    const a = actionKey('web-pay');
    const b = actionKey('web-pay');
    expect(a.startsWith('web-pay-')).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(16);
  });
});
