import { describe, it, expect } from 'vitest';
import { inr } from '../src/modules/messaging/inr.ts';

describe('an amount as a family reads it', () => {
  it.each([
    ['0', '0.00'], ['5', '5.00'], ['500.00', '500.00'], ['999.9', '999.90'],
    ['1000', '1,000.00'], ['32300.00', '32,300.00'], ['100000', '1,00,000.00'],
    ['1234567.5', '12,34,567.50'], ['123456789.99', '12,34,56,789.99'],
    ['007.10', '7.10'], ['12.345', '12.34'],
  ])('%s → %s', (given, shown) => { expect(inr(given)).toBe(shown); });
});
