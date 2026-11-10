/**
 * Today, as the person at the desk means it.
 *
 * `new Date().toISOString().slice(0, 10)` is the date in UTC. India is five
 * and a half hours ahead, so from midnight until 5:30 a.m. that expression
 * says yesterday — and an invoice due "today" is shown as not yet due, a
 * register opens on the wrong day, an export is named for the day before.
 * Three pages did this. The date that matters is the one on the wall.
 */
export function localIsoDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * A key that stays the same for one intended action.
 *
 * Made when somebody decides what they are about to do — types the amount —
 * and reused for every press of the button after that, so a double click or a
 * retry after a timeout is one payment. A timestamp taken at the moment of the
 * click, which is what the fee desk used, is a new key per click and protects
 * against nothing.
 */
export function actionKey(prefix: string): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${random}`;
}
