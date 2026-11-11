/**
 * The day's collection as a cashier closes it (M47.5): totals by how it was
 * paid and by who took it, added up in paise.
 */
import { sumDecimals } from './console';
import { methodLabel, toPaise } from './receipt';

export interface CollectionRow {
  receipt_id: string; receipt_no: string; issued_on: string;
  invoice_id: string; invoice_no: string;
  learner: string; admission_no: string;
  class_name: string | null; section_name: string;
  method: string; amount: string;
  received_by: string | null; cancelled: boolean;
}

export interface Subtotal { key: string; label: string; receipts: number; amount: string }

export interface Closing {
  /** Rows that count: cancelled receipts are listed on the sheet, never added. */
  standing: CollectionRow[];
  cancelled: CollectionRow[];
  total: string;
  /** Distinct receipts, not rows: one receipt split over two invoices is one. */
  receipts: number;
  byMethod: Subtotal[];
  byCashier: Subtotal[];
  /** What should be in the drawer. */
  cash: string;
}

function subtotals(rows: readonly CollectionRow[], keyOf: (r: CollectionRow) => string,
  labelOf: (key: string) => string): Subtotal[] {
  const groups = new Map<string, CollectionRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({
      key, label: labelOf(key),
      receipts: new Set(list.map((r) => r.receipt_id)).size,
      amount: sumDecimals(list.map((r) => r.amount)),
    }))
    // Largest first; a tie goes by name so the sheet reads the same every time.
    .sort((a, b) => {
      const diff = toPaise(b.amount) - toPaise(a.amount);
      return diff > 0n ? 1 : diff < 0n ? -1 : a.label.localeCompare(b.label);
    });
}

export const NOBODY = 'Not recorded';

export function closing(rows: readonly CollectionRow[]): Closing {
  const standing = rows.filter((r) => !r.cancelled);
  const byMethod = subtotals(standing, (r) => r.method, methodLabel);
  return {
    standing,
    cancelled: rows.filter((r) => r.cancelled),
    total: sumDecimals(standing.map((r) => r.amount)),
    receipts: new Set(standing.map((r) => r.receipt_id)).size,
    byMethod,
    byCashier: subtotals(standing, (r) => (r.received_by ?? '').trim() || NOBODY, (k) => k),
    cash: byMethod.find((m) => m.key === 'cash')?.amount ?? '0.00',
  };
}

/** "Class IX A", or just the section when the class is not known. */
export const classOf = (row: Pick<CollectionRow, 'class_name' | 'section_name'>) =>
  [row.class_name, row.section_name].filter(Boolean).join(' ');
