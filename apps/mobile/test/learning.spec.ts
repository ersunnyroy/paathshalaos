/**
 * The parent's homework list (M28.3).
 *
 * Every assertion here is about a sentence a parent reads and acts on, which
 * is why the grouping is tested rather than the rendering: "overdue" shown for
 * work that was handed in on Tuesday is the failure that makes a parent stop
 * opening the app.
 */
import { describe, it, expect } from 'vitest';
import { bucketOf, sortWork, outstanding, workLine, type Work } from '../src/lib/learning.ts';

const NOW = new Date('2027-07-15T10:00:00+05:30').getTime();
const at = (iso: string) => new Date(iso).toISOString();

function work(over: Partial<Work> = {}): Work {
  return {
    assignment_id: Math.random().toString(36).slice(2),
    title: 'Homework', subject_name: 'Physics',
    due_at: at('2027-07-16T18:00:00+05:30'),
    status: 'published', submission_kind: 'either',
    submitted_at: null, is_late: null, submission_status: null,
    feedback: null, marks_obtained: null, max_marks: null,
    ...over,
  };
}

describe('which pile a piece of work is in', () => {
  it('calls a past deadline overdue', () => {
    expect(bucketOf(work({ due_at: at('2027-07-14T18:00:00+05:30') }), NOW)).toBe('overdue');
  });

  it('counts anything before midnight tonight as today', () => {
    // 9pm tonight is today's homework. Measuring 24 hours from now would call
    // it tomorrow's and a parent reading this at 10am would not chase it.
    expect(bucketOf(work({ due_at: at('2027-07-15T21:00:00+05:30') }), NOW)).toBe('today');
    expect(bucketOf(work({ due_at: at('2027-07-16T00:30:00+05:30') }), NOW)).toBe('soon');
  });

  it('calls handed-in work done even when it went in late', () => {
    const late = work({
      due_at: at('2027-07-10T18:00:00+05:30'),
      submitted_at: at('2027-07-12T20:00:00+05:30'),
      is_late: true,
    });
    expect(bucketOf(late, NOW)).toBe('done');
    expect(workLine(late, NOW)).toBe('Handed in late');
  });

  it('does not treat work with no deadline as overdue', () => {
    expect(bucketOf(work({ due_at: null }), NOW)).toBe('soon');
    expect(workLine(work({ due_at: null }), NOW)).toBe('No deadline');
  });
});

describe('the order the list comes in', () => {
  it('puts what is late first and what is finished last', () => {
    const rows = [
      work({ title: 'done', submitted_at: at('2027-07-14T09:00:00+05:30') }),
      work({ title: 'next week', due_at: at('2027-07-22T18:00:00+05:30') }),
      work({ title: 'overdue', due_at: at('2027-07-11T18:00:00+05:30') }),
      work({ title: 'tonight', due_at: at('2027-07-15T20:00:00+05:30') }),
    ];
    expect(sortWork(rows, NOW).map((w) => w.title))
      .toEqual(['overdue', 'tonight', 'next week', 'done']);
  });

  it('sorts undated work to the end of its own group, not the front', () => {
    const rows = [
      work({ title: 'undated', due_at: null }),
      work({ title: 'friday', due_at: at('2027-07-17T18:00:00+05:30') }),
    ];
    expect(sortWork(rows, NOW).map((w) => w.title)).toEqual(['friday', 'undated']);
  });

  it('counts only what is still waiting', () => {
    const rows = [
      work({ submitted_at: at('2027-07-14T09:00:00+05:30') }),
      work({ due_at: at('2027-07-11T18:00:00+05:30') }),
      work({ due_at: at('2027-07-20T18:00:00+05:30') }),
    ];
    expect(outstanding(rows, NOW)).toBe(2);
  });
});

describe('the line under the title', () => {
  it('shows a mark the way the teacher awarded it', () => {
    const marked = work({
      submitted_at: at('2027-07-14T09:00:00+05:30'),
      submission_status: 'returned', marks_obtained: '17.50', max_marks: '20.00',
    });
    expect(workLine(marked, NOW)).toBe('Marked · 17.50 / 20.00');
  });

  it('does not invent a percentage', () => {
    // Out of three. 66.7% is a number the school never published.
    const marked = work({
      submitted_at: at('2027-07-14T09:00:00+05:30'),
      submission_status: 'returned', marks_obtained: '2.00', max_marks: '3.00',
    });
    expect(workLine(marked, NOW)).not.toMatch(/%/);
  });

  it('says marked even when the work carried no marks', () => {
    const marked = work({
      submitted_at: at('2027-07-14T09:00:00+05:30'), submission_status: 'returned',
    });
    expect(workLine(marked, NOW)).toBe('Marked');
  });

  it('counts the days to a deadline inclusively', () => {
    expect(workLine(work({ due_at: at('2027-07-16T18:00:00+05:30') }), NOW))
      .toBe('Due tomorrow');
    expect(workLine(work({ due_at: at('2027-07-18T18:00:00+05:30') }), NOW))
      .toBe('Due in 3 days');
  });
});
