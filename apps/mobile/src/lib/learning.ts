/**
 * Homework, for a parent (M28.3).
 *
 * The screen's whole job is to answer "is anything outstanding?" before the
 * parent has read anything, so the sorting and the grouping are here, tested,
 * rather than inline in a component where they would be neither.
 *
 * A deliberate omission: there is no "submit" on this screen. A parent can see
 * what is set and what came back; handing work in is the learner's account,
 * and a parent app that submits homework is a parent app that does homework.
 */

export interface Work {
  assignment_id: string;
  title: string;
  subject_name: string;
  due_at: string | null;
  status: 'draft' | 'published' | 'closed';
  submission_kind: 'text' | 'file' | 'either' | 'offline';
  submitted_at: string | null;
  is_late: boolean | null;
  submission_status: 'submitted' | 'returned' | null;
  feedback: string | null;
  marks_obtained: string | null;
  max_marks: string | null;
}

export type Bucket = 'overdue' | 'today' | 'soon' | 'done';

/**
 * Which pile a piece of work is in.
 *
 * Anything handed in is `done` whatever its deadline — including late work.
 * The alternative shows a parent "overdue" for something their child handed in
 * on Tuesday, which teaches them to ignore the list.
 */
export function bucketOf(w: Work, now = Date.now()): Bucket {
  if (w.submitted_at) return 'done';
  if (!w.due_at) return 'soon';
  const ms = new Date(w.due_at).getTime() - now;
  if (ms < 0) return 'overdue';
  // Today means before midnight tonight, not "within 24 hours". A parent
  // reading this at 9pm wants tonight's homework, not tomorrow evening's.
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return new Date(w.due_at).getTime() <= end.getTime() ? 'today' : 'soon';
}

/**
 * Whole days between two instants, counted on the calendar rather than the
 * clock.
 *
 * Tomorrow at six is tomorrow, even though it is 32 hours away and dividing
 * elapsed milliseconds calls that two days. A parent reads "due in 2 days" as
 * "not tonight's problem" — which is how the first version of this told them
 * to ignore tomorrow's homework. Rounded, not truncated, so an hour of drift
 * never shifts the answer by a day.
 */
function calendarDaysBetween(from: number, to: number): number {
  const midnight = (t: number): number => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  return Math.round((midnight(to) - midnight(from)) / 86_400_000);
}

/** Overdue first, then today, then the rest, each by deadline. */
export function sortWork(rows: Work[], now = Date.now()): Work[] {
  const rank: Record<Bucket, number> = { overdue: 0, today: 1, soon: 2, done: 3 };
  return [...rows].sort((a, b) => {
    const d = rank[bucketOf(a, now)] - rank[bucketOf(b, now)];
    if (d !== 0) return d;
    // No deadline sorts last within its group rather than first, which is what
    // an empty string would have done.
    const at = a.due_at ? new Date(a.due_at).getTime() : Number.MAX_SAFE_INTEGER;
    const bt = b.due_at ? new Date(b.due_at).getTime() : Number.MAX_SAFE_INTEGER;
    return at - bt;
  });
}

/** How many pieces of work are actually waiting on this child. */
export function outstanding(rows: Work[], now = Date.now()): number {
  return rows.filter((w) => bucketOf(w, now) !== 'done').length;
}

/**
 * The one line under the title.
 *
 * A returned mark is shown as it was awarded — `17.5 / 20`, from the strings
 * the API sent. It is not turned into a percentage here: a teacher who marked
 * out of 3 did not mean 66.7%, and a parent comparing two subjects on
 * percentages the school never published is being handed a number nobody
 * stands behind.
 */
export function workLine(w: Work, now = Date.now()): string {
  if (w.submission_status === 'returned') {
    if (w.marks_obtained && w.max_marks) return `Marked · ${w.marks_obtained} / ${w.max_marks}`;
    return 'Marked';
  }
  if (w.submitted_at) return w.is_late ? 'Handed in late' : 'Handed in';

  const bucket = bucketOf(w, now);
  if (bucket === 'overdue') return 'Overdue';
  if (bucket === 'today') return 'Due today';
  if (!w.due_at) return 'No deadline';
  const days = calendarDaysBetween(now, new Date(w.due_at).getTime());
  return days === 1 ? 'Due tomorrow' : `Due in ${days} days`;
}
