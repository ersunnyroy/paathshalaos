/**
 * M7 — money arithmetic, with property-based tests.
 *
 * These are the cheapest tests in the project and guard the most expensive
 * class of bug: an error of one paise per invoice is thousands of rupees a term
 * and destroys an accountant's trust in everything else.
 */
import { describe, it, expect } from 'vitest';
import { Money, MoneyError, type Paise } from '../src/modules/billing/money.ts';

/** A deterministic PRNG, so a failure is reproducible from the seed alone. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('parsing and formatting', () => {
  it('round-trips what Postgres numeric returns', () => {
    for (const value of ['0.00', '1.00', '12500.00', '0.01', '99999999.99', '-250.50']) {
      expect(Money.toDecimalString(Money.fromDecimalString(value))).toBe(value);
    }
  });

  it('accepts a bare integer string', () => {
    expect(Money.toDecimalString(Money.fromDecimalString('500'))).toBe('500.00');
  });

  it('rejects anything that is not a money value', () => {
    for (const bad of ['1.234', 'abc', '', '1e5', '1.2.3', ' 1,000.00']) {
      expect(() => Money.fromDecimalString(bad)).toThrow(MoneyError);
    }
  });

  it('refuses a fractional rupee, because that caller already has a float', () => {
    expect(() => Money.fromRupees(12.5)).toThrow(MoneyError);
    expect(Money.toDecimalString(Money.fromRupees(12))).toBe('12.00');
  });

  it('has no floating point error where JS famously does', () => {
    const a = Money.fromDecimalString('0.10');
    const b = Money.fromDecimalString('0.20');
    expect(Money.toDecimalString(Money.add(a, b))).toBe('0.30');
    // The same sum in floats.
    expect(0.1 + 0.2).not.toBe(0.3);
  });
});

describe('percentage', () => {
  it('computes a plain case exactly', () => {
    const fee = Money.fromDecimalString('12500.00');
    expect(Money.toDecimalString(Money.percentage(fee, 10))).toBe('1250.00');
  });

  it('rounds half-up, matching the printed receipt', () => {
    // 1000.05 at 50% is 500.025, which shows as 500.03 on a receipt.
    expect(Money.toDecimalString(Money.percentage(Money.fromDecimalString('1000.05'), 50)))
      .toBe('500.03');
  });

  it('handles fractional percentages', () => {
    expect(Money.toDecimalString(Money.percentage(Money.fromDecimalString('10000.00'), 12.5)))
      .toBe('1250.00');
    expect(Money.toDecimalString(Money.percentage(Money.fromDecimalString('33333.33'), 7.5)))
      .toBe('2500.00');
  });

  it('rejects an out-of-range percentage', () => {
    const fee = Money.fromRupees(100);
    expect(() => Money.percentage(fee, -1)).toThrow(MoneyError);
    expect(() => Money.percentage(fee, 101)).toThrow(MoneyError);
    expect(() => Money.percentage(fee, NaN)).toThrow(MoneyError);
  });

  it('property: a percentage never exceeds the amount', () => {
    const rand = prng(20260918);
    for (let i = 0; i < 2000; i++) {
      const amount = Money.fromPaise(Math.floor(rand() * 100_000_000));
      const percent = rand() * 100;
      const part = Money.percentage(amount, percent);
      expect(part <= amount).toBe(true);
      expect(part >= 0n).toBe(true);
    }
  });

  it('property: 100% is the whole and 0% is nothing', () => {
    const rand = prng(7);
    for (let i = 0; i < 500; i++) {
      const amount = Money.fromPaise(Math.floor(rand() * 100_000_000));
      expect(Money.percentage(amount, 100)).toBe(amount);
      expect(Money.percentage(amount, 0)).toBe(0n);
    }
  });
});

describe('split into instalments', () => {
  it('splits evenly when it divides', () => {
    const parts = Money.split(Money.fromDecimalString('12000.00'), 4);
    expect(parts.map(Money.toDecimalString)).toEqual(['3000.00', '3000.00', '3000.00', '3000.00']);
  });

  it('distributes the remainder instead of losing it', () => {
    // The naive version gives three instalments of 3333.33, totalling 9999.99 —
    // one paise short, every term, for every learner on this plan.
    const total = Money.fromDecimalString('10000.00');
    const parts = Money.split(total, 3);
    expect(parts.map(Money.toDecimalString)).toEqual(['3333.34', '3333.33', '3333.33']);
    expect(Money.sum(parts)).toBe(total);
  });

  it('property: the parts always sum to the total, exactly', () => {
    const rand = prng(1337);
    for (let i = 0; i < 5000; i++) {
      const total = Money.fromPaise(Math.floor(rand() * 10_000_000));
      const parts = 1 + Math.floor(rand() * 12);
      const split = Money.split(total, parts);

      expect(split).toHaveLength(parts);
      expect(Money.sum(split)).toBe(total);
    }
  });

  it('property: no two instalments differ by more than a paise', () => {
    const rand = prng(42);
    for (let i = 0; i < 2000; i++) {
      const total = Money.fromPaise(Math.floor(rand() * 10_000_000));
      const split = Money.split(total, 1 + Math.floor(rand() * 12));
      const min = split.reduce((a, b) => (a < b ? a : b));
      const max = split.reduce((a, b) => (a > b ? a : b));
      expect(max - min <= 1n).toBe(true);
    }
  });

  it('handles a negative total, which is a credit note', () => {
    const parts = Money.split(Money.fromDecimalString('-100.00'), 3);
    expect(Money.sum(parts)).toBe(Money.fromDecimalString('-100.00'));
    expect(parts.every((p) => p < 0n)).toBe(true);
  });

  it('rejects a nonsensical number of parts', () => {
    expect(() => Money.split(Money.fromRupees(100), 0)).toThrow(MoneyError);
    expect(() => Money.split(Money.fromRupees(100), -1)).toThrow(MoneyError);
    expect(() => Money.split(Money.fromRupees(100), 1.5)).toThrow(MoneyError);
  });
});

describe('allocation across invoices', () => {
  it('pays oldest first and stops when the money runs out', () => {
    const allocated = Money.allocate(Money.fromDecimalString('5000.00'), [
      Money.fromDecimalString('3000.00'),
      Money.fromDecimalString('3000.00'),
      Money.fromDecimalString('1000.00'),
    ]);
    expect(allocated.map(Money.toDecimalString)).toEqual(['3000.00', '2000.00', '0.00']);
  });

  it('never allocates more than was paid', () => {
    const rand = prng(99);
    for (let i = 0; i < 2000; i++) {
      const payment = Money.fromPaise(Math.floor(rand() * 1_000_000));
      const outstanding: Paise[] = Array.from(
        { length: 1 + Math.floor(rand() * 6) },
        () => Money.fromPaise(Math.floor(rand() * 500_000)),
      );
      const allocated = Money.allocate(payment, outstanding);

      expect(Money.sum(allocated) <= payment).toBe(true);
      // And never more than each invoice was owed.
      allocated.forEach((a, idx) => expect(a <= outstanding[idx]!).toBe(true));
    }
  });

  it('allocates nothing against a settled invoice', () => {
    const allocated = Money.allocate(Money.fromRupees(500), [0n, Money.fromRupees(200)]);
    expect(allocated.map(Money.toDecimalString)).toEqual(['0.00', '200.00']);
  });
});
