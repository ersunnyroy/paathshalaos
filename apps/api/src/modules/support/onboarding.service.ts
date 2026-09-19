/**
 * Guided setup.
 *
 * There is no checklist table. Nothing here is ticked, stored, or reset — each
 * step asks the database whether the thing exists, every time.
 *
 * That is the entire design decision and it is worth defending, because the
 * stored-boolean version is easier and ships sooner. It also rots within a term:
 * somebody ticks "fee structure configured", the plan is later voided, and the
 * setup page keeps saying the school is ready while the fees screen is empty.
 * The institute then stops trusting the page, which makes it worse than absent —
 * an onboarding checklist that lies teaches people to skip onboarding.
 *
 * Derived state cannot drift from reality because it IS reality. The price is a
 * handful of EXISTS queries on a page nobody loads more than a few times.
 *
 * The other rule: a step is DONE or NOT DONE, with no partial credit and no
 * percentage padding. "You're 60% set up!" when no learner exists is a
 * motivational lie, and the person reading it has a school to open.
 */
import { withTenant, type TenantScope } from '../../db/tenant.ts';

export interface SetupStep {
  key: string;
  title: string;
  /** What this unlocks, in the institute's terms rather than the schema's. */
  why: string;
  done: boolean;
  count: number;
  /** Where to go and do it. Null when the step has no screen yet. */
  href: string | null;
  /** Steps that must come first. Order on screen follows this, not the array. */
  needs: string[];
}

/**
 * One query, not eleven round trips. Each step is a scalar subquery, so the page
 * costs a single statement however long the list grows.
 *
 * Counts, not booleans, because "3 of your 4 campuses have no fee plan" is a
 * different sentence from "fees: not done", and the count is what makes the
 * next action obvious.
 */
const STEP_SQL = `
  SELECT
    (SELECT count(*) FROM campus WHERE deleted_at IS NULL)              AS campuses,
    (SELECT count(*) FROM academic_year WHERE deleted_at IS NULL)       AS years,
    (SELECT count(*) FROM programme)                                    AS programmes,
    (SELECT count(*) FROM class_group)                                  AS class_groups,
    (SELECT count(*) FROM section)                                      AS sections,
    (SELECT count(*) FROM staff WHERE deleted_at IS NULL)               AS staff,
    (SELECT count(*) FROM student WHERE deleted_at IS NULL)             AS learners,
    (SELECT count(*) FROM enrollment WHERE status = 'active')           AS enrollments,
    (SELECT count(*) FROM fee_plan)                                     AS fee_plans,
    (SELECT count(*) FROM invoice WHERE status <> 'void')               AS invoices,
    (SELECT count(*) FROM attendance_session)                           AS sessions,
    (SELECT count(*) FROM message_template)                             AS templates,
    (SELECT count(*) FROM grading_scale)                                AS scales
`;

interface Counts {
  campuses: number; years: number; programmes: number; class_groups: number;
  sections: number; staff: number; learners: number; enrollments: number;
  fee_plans: number; invoices: number; sessions: number; templates: number;
  scales: number;
}

export const onboardingService = {
  async steps(scope: TenantScope): Promise<{
    steps: SetupStep[]; done: number; total: number; ready: boolean;
  }> {
    const counts = await withTenant(scope, async (db) => {
      const { rows } = await db.query<Record<keyof Counts, string>>(STEP_SQL);
      const raw = rows[0]!;
      return Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [k, Number(v)])) as unknown as Counts;
    });

    const steps: SetupStep[] = [
      {
        key: 'campus', title: 'Add your campus',
        why: 'Everything else hangs off a campus — staff, learners, fees and receipts.',
        done: counts.campuses > 0, count: counts.campuses, href: null, needs: [],
      },
      {
        key: 'year', title: 'Open an academic year',
        why: 'Attendance, results and fees are all recorded against a year.',
        done: counts.years > 0, count: counts.years, href: null, needs: ['campus'],
      },
      {
        key: 'structure', title: 'Set up classes and sections',
        why: 'A learner is enrolled into a section, and a teacher marks a section.',
        done: counts.sections > 0, count: counts.sections, href: null,
        needs: ['year'],
      },
      {
        key: 'staff', title: 'Add your staff',
        why: 'Teachers need accounts before they can mark attendance on their phones.',
        done: counts.staff > 0, count: counts.staff, href: null, needs: ['campus'],
      },
      {
        key: 'learners', title: 'Import your learners',
        why: 'Bring last year\'s register in as a spreadsheet rather than typing it.',
        done: counts.learners > 0, count: counts.learners, href: '/students',
        needs: ['structure'],
      },
      {
        key: 'enrollment', title: 'Enrol learners into sections',
        why: 'An imported learner with no section appears on nobody\'s register.',
        done: counts.enrollments > 0, count: counts.enrollments, href: '/students',
        needs: ['learners'],
      },
      {
        key: 'fees', title: 'Build your fee structure',
        why: 'Until a fee plan exists there is nothing to invoice against.',
        done: counts.fee_plans > 0, count: counts.fee_plans, href: '/fees',
        needs: ['year'],
      },
      {
        key: 'invoices', title: 'Issue your first invoices',
        why: 'This is the step that starts the money working — and the one to do '
             + 'on a small group first.',
        done: counts.invoices > 0, count: counts.invoices, href: '/fees',
        needs: ['fees', 'enrollment'],
      },
      {
        key: 'attendance', title: 'Mark attendance once',
        why: 'One session proves the whole chain works before a Monday morning does.',
        done: counts.sessions > 0, count: counts.sessions, href: '/attendance',
        needs: ['enrollment'],
      },
      {
        key: 'messaging', title: 'Add a message template',
        why: 'Parent notifications go out against a registered template, not free text.',
        done: counts.templates > 0, count: counts.templates, href: null,
        needs: ['campus'],
      },
      {
        key: 'grading', title: 'Define a grading scale',
        why: 'Results cannot be computed until marks have a scale to land on.',
        done: counts.scales > 0, count: counts.scales, href: null, needs: ['year'],
      },
    ];

    const done = steps.filter((s) => s.done).length;
    return {
      steps,
      done,
      total: steps.length,
      // "Ready" is the subset that lets a school actually operate: learners
      // enrolled, fees billable, a register markable. The rest is worth doing
      // and is not worth blocking on.
      ready: ['campus', 'year', 'structure', 'learners', 'enrollment', 'fees']
        .every((key) => steps.find((s) => s.key === key)?.done === true),
    };
  },

  /**
   * The next thing to do.
   *
   * The first step that is not done, in list order — and the list order IS the
   * dependency order, which `stepsAreInDependencyOrder` below asserts and a test
   * enforces.
   *
   * An earlier version also filtered on `needs` here, which read as belt and
   * braces and was in fact dead code: every `needs` entry already appears
   * earlier in the array, so the filter could never change the answer. A
   * mutation that deleted it changed no behaviour and failed no test, which is
   * how it was found. Dead code that looks like a safety check is worse than no
   * check, because it is the one people stop reading. The invariant is now
   * stated once, in the ordering, and tested directly.
   */
  async nextStep(scope: TenantScope): Promise<SetupStep | null> {
    const { steps } = await this.steps(scope);
    return steps.find((s) => !s.done) ?? null;
  },
};

/**
 * True when every step's prerequisites appear before it.
 *
 * Exported so a test can assert it. This is what makes `nextStep` correct: get
 * the order wrong and a fresh school is told to "import your learners" before it
 * has a section to put them in — advice that produces an error, not progress.
 */
export function stepsAreInDependencyOrder(steps: SetupStep[]): boolean {
  const seen = new Set<string>();
  for (const step of steps) {
    if (!step.needs.every((k) => seen.has(k))) return false;
    seen.add(step.key);
  }
  return true;
}
