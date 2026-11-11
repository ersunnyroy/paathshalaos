/**
 * A decimal rupee string with Indian grouping: "32300.00" → "32,300.00",
 * "1234567.5" → "12,34,567.50". String surgery; the figure never becomes a
 * float on its way into a sentence a family will read.
 */
export function inr(value: string): string {
  const [wholeRaw = '0', fractionRaw = ''] = value.split('.');
  const whole = wholeRaw.replace(/^0+(?=\d)/, '');
  const fraction = (fractionRaw + '00').slice(0, 2);
  const tail = whole.slice(-3);
  const head = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${head ? `${head},` : ''}${tail}.${fraction}`;
}
