/**
 * Exact money arithmetic in minor units.
 *
 * Every amount is a bigint count of paise. There is no floating point anywhere
 * in this module, because 0.1 + 0.2 !== 0.3 in IEEE-754 and a fee ledger that
 * is wrong by a paise per invoice is wrong by thousands of rupees a term — and
 * the accountant who finds it will not trust anything else in the system again.
 *
 * Postgres numeric(14,2) is also exact, and where an operation can be done in
 * SQL it is. This exists for the arithmetic that genuinely belongs in
 * application code: splitting a total into instalments, applying a percentage
 * concession, and proving the parts add back to the whole.
 */

export type Paise = bigint;

const SCALE = 100n;

export class MoneyError extends Error {}

export const Money = {
  /** Parses "12500.00" or "12500" as it comes back from Postgres numeric. */
  fromDecimalString(value: string): Paise {
    const trimmed = value.trim();
    if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) {
      throw new MoneyError(`Not a money value: ${value}`);
    }
    const negative = trimmed.startsWith('-');
    const [whole, frac = ''] = trimmed.replace('-', '').split('.');
    const paise = BigInt(whole!) * SCALE + BigInt(frac.padEnd(2, '0'));
    return negative ? -paise : paise;
  },

  fromRupees(rupees: number): Paise {
    if (!Number.isInteger(rupees)) {
      // A caller with a fractional rupee has a float already, which is the bug
      // this module exists to prevent. Make them say paise.
      throw new MoneyError('fromRupees takes whole rupees; use fromPaise for anything finer.');
    }
    return BigInt(rupees) * SCALE;
  },

  fromPaise(paise: number | bigint): Paise {
    return BigInt(paise);
  },

  /** For binding into SQL numeric columns. */
  toDecimalString(paise: Paise): string {
    const negative = paise < 0n;
    const abs = negative ? -paise : paise;
    const whole = abs / SCALE;
    const frac = abs % SCALE;
    return `${negative ? '-' : ''}${whole}.${frac.toString().padStart(2, '0')}`;
  },

  add: (a: Paise, b: Paise): Paise => a + b,
  subtract: (a: Paise, b: Paise): Paise => a - b,
  sum: (values: readonly Paise[]): Paise => values.reduce((a, b) => a + b, 0n),
  isZero: (a: Paise): boolean => a === 0n,
  isNegative: (a: Paise): boolean => a < 0n,
  compare: (a: Paise, b: Paise): number => (a < b ? -1 : a > b ? 1 : 0),

  /**
   * A percentage of an amount, rounded half-up to the paise.
   *
   * Half-up rather than banker's rounding because that is what an Indian fee
   * receipt shows and what a parent checks it against. Consistency with the
   * printed artefact beats statistical neutrality here.
   */
  percentage(amount: Paise, percent: number): Paise {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new MoneyError(`Percentage out of range: ${percent}`);
    }
    // Scale the percent to an integer basis-point-like value so the whole
    // computation stays in bigint.
    const scaledPercent = BigInt(Math.round(percent * 10_000));
    const numerator = amount * scaledPercent;
    const denominator = 1_000_000n;
    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    return remainder * 2n >= denominator ? quotient + 1n : quotient;
  },

  /**
   * Splits an amount into n instalments that ADD BACK TO THE TOTAL EXACTLY.
   *
   * The naive version divides and rounds each part, and 10000/3 becomes three
   * instalments of 3333.33 totalling 9999.99 — one paise short, every term, for
   * every learner on a three-instalment plan. Here the remainder is distributed
   * one paise at a time across the earliest instalments, so the parts are equal
   * to within a paise and the sum is exact by construction.
   */
  split(total: Paise, parts: number): Paise[] {
    if (!Number.isInteger(parts) || parts < 1) {
      throw new MoneyError(`Cannot split into ${parts} parts.`);
    }
    const n = BigInt(parts);
    const negative = total < 0n;
    const abs = negative ? -total : total;

    const base = abs / n;
    const remainder = abs % n;

    const result: Paise[] = [];
    for (let i = 0n; i < n; i++) {
      const amount = base + (i < remainder ? 1n : 0n);
      result.push(negative ? -amount : amount);
    }
    return result;
  },

  /**
   * Allocates a payment across invoices oldest-first, never over-allocating.
   * Returns what each invoice receives, in the order given.
   */
  allocate(payment: Paise, outstanding: readonly Paise[]): Paise[] {
    let left = payment;
    return outstanding.map((due) => {
      if (left <= 0n || due <= 0n) return 0n;
      const take = left < due ? left : due;
      left -= take;
      return take;
    });
  },
};
