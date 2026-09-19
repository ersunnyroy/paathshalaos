/**
 * M9.6 — AC-2: group totals reconcile to campus figures to the paisa.
 *
 * The way this breaks in real products is not arithmetic. It is that the group
 * figure and the campus figure are two queries written months apart — one
 * excludes voided invoices, the other does not — and they drift by an amount
 * nobody can explain. So the test asserts the STRUCTURE as well as the numbers:
 * the group total must equal the sum of the campus rows, exactly, in paise, with
 * a void invoice and a second campus in play to make the two ways of being wrong
 * observable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure, createLearnerRaw,
  createClassGroupRaw, createSectionFor,
  OWNER_URL, type TenantFixture, type UserFixture, type AcademicYearFixture,
} from './fixtures.ts';
import { dashboardService } from '../src/modules/reporting/dashboard.service.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

let tenant: TenantFixture;
let owner: UserFixture;
let teacherUser: UserFixture;
let year: AcademicYearFixture;
let struct: Awaited<ReturnType<typeof createAcademicStructure>>;
let secondCampusId: string;

const PASSWORD = 'correct-horse-battery';
const ON = '2026-09-18';

beforeAll(async () => {
  await purgeTestData('%@dash-test.example');
  tenant = await createTenant('DASH');
  owner = await createUser('owner@dash-test.example', PASSWORD);
  teacherUser = await createUser('teacher@dash-test.example', PASSWORD);
  await grantRole(tenant.orgId, owner.userId, 'ORG_OWNER', 'organization', null);
  await grantRole(tenant.orgId, teacherUser.userId, 'TEACHER', 'campus', tenant.campusId);

  struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  year = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026,
    { status: 'active' });

  // A second campus with its own academic unit and programme, so "group" means
  // something. With one campus, a group total that double-counts and one that
  // sums correctly are the same number.
  secondCampusId = await asOwner(async (c) => {
    const campus = await c.query<{ id: string }>(
      `INSERT INTO campus (tenant_id, code, name) VALUES ($1, 'DASH-2', 'Second Campus')
       RETURNING id`, [tenant.orgId]);
    return campus.rows[0]!.id;
  });

  const cgOne = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId, 'IX');
  const sectionOne = await createSectionFor(tenant.orgId, cgOne, 'A');

  const { sectionTwo } = await asOwner(async (c) => {
    const unit = await c.query<{ id: string }>(
      `INSERT INTO academic_unit (tenant_id, campus_id, code, name, unit_type)
       VALUES ($1, $2, 'DASH-U2', 'Second School', 'school') RETURNING id`,
      [tenant.orgId, secondCampusId]);
    const programme = await c.query<{ id: string }>(
      `INSERT INTO programme (tenant_id, academic_unit_id, code, name, credential_type)
       VALUES ($1, $2, 'P2', 'Programme Two', 'board_examination') RETURNING id`,
      [tenant.orgId, unit.rows[0]!.id]);
    const cg = await c.query<{ id: string }>(
      `INSERT INTO class_group (tenant_id, programme_id, academic_year_id, name, level_sequence)
       VALUES ($1, $2, $3, 'X', 10) RETURNING id`,
      [tenant.orgId, programme.rows[0]!.id, year.yearId]);
    const section = await c.query<{ id: string }>(
      `INSERT INTO section (tenant_id, class_group_id, name, capacity)
       VALUES ($1, $2, 'A', 40) RETURNING id`,
      [tenant.orgId, cg.rows[0]!.id]);
    return { sectionTwo: section.rows[0]!.id };
  });

  // Three learners on campus one, two on campus two.
  const enrollments: Array<{ id: string; campus: 1 | 2 }> = [];
  for (let i = 0; i < 5; i++) {
    const onFirst = i < 3;
    const learner = await createLearnerRaw(tenant.orgId, `Dash${i}`, `DASH-000${i}`);
    const id = await asOwner(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenant.orgId, learner.studentId, onFirst ? sectionOne : sectionTwo, year.yearId]);
      return rows[0]!.id;
    });
    enrollments.push({ id, campus: onFirst ? 1 : 2 });
  }

  // Invoices with awkward amounts, one of them VOID. A void invoice must leave
  // both billed and outstanding — dropping it from one only is the classic drift.
  await asOwner(async (c) => {
    let no = 0;
    for (const e of enrollments) {
      no += 1;
      await c.query(
        `INSERT INTO invoice
           (tenant_id, campus_id, enrollment_id, invoice_no, financial_year, due_on,
            subtotal, discount_total, tax_total, total, amount_paid, status,
            void_reason, voided_at)
         VALUES ($1, $2, $3, $4, '2026-27', '2026-06-10',
                 $5::numeric, 0, 0, $5::numeric, $6::numeric, $7,
                 $8::text, $9::timestamptz)`,
        [tenant.orgId, e.campus === 1 ? tenant.campusId : secondCampusId, e.id,
         `DASH-INV-${no}`,
         // Deliberately not round: 3333.33 three times is where a rupee goes
         // missing if anything on this path becomes a float.
         '3333.33', no === 1 ? '1111.11' : '0',
         no === 5 ? 'void' : 'issued',
         // A void invoice carries its reason from the start; the CHECK in 0025
         // refuses one without.
         no === 5 ? 'Raised in error.' : null,
         no === 5 ? new Date().toISOString() : null],
      );
    }
  });
});

afterAll(async () => {
  await destroyUsers([owner.userId, teacherUser.userId]);
  await destroyTenants([tenant.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
});

const asScope = () => ({ tenantId: tenant.orgId, actorId: owner.userId });
const asTeacher = () => ({ tenantId: tenant.orgId, actorId: teacherUser.userId });

async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe('AC-2 — group totals reconcile to campus figures', () => {
  it('every group figure is exactly the sum of its campuses', async () => {
    const group = await dashboardService.groupFigures(asScope(), ON);
    expect(group.campuses.length).toBeGreaterThan(1);

    const sum = (pick: (c: (typeof group.campuses)[number]) => string) =>
      group.campuses.reduce((total, c) => total + BigInt(pick(c)), 0n).toString();

    // To the paisa, as strings: a `toBeCloseTo` here would pass on the exact
    // drift this test exists to catch.
    expect(group.billed).toBe(sum((c) => c.billed));
    expect(group.collected).toBe(sum((c) => c.collected));
    expect(group.outstanding).toBe(sum((c) => c.outstanding));
    expect(group.learners).toBe(
      group.campuses.reduce((t, c) => t + c.learners, 0));
  });

  it('billed minus collected equals outstanding, per campus and overall', async () => {
    const group = await dashboardService.groupFigures(asScope(), ON);
    for (const campus of group.campuses) {
      expect(BigInt(campus.billed) - BigInt(campus.collected))
        .toBe(BigInt(campus.outstanding));
    }
    expect(BigInt(group.billed) - BigInt(group.collected)).toBe(BigInt(group.outstanding));
  });

  it('a voided invoice leaves BOTH billed and outstanding', async () => {
    // Excluding it from one and not the other is the drift that makes a
    // dashboard irreconcilable with a campus report.
    const group = await dashboardService.groupFigures(asScope(), ON);
    // Four live invoices at 3,333.33 = 13,333.32, i.e. 1,333,332 paise.
    expect(group.billed).toBe('1333332');
    expect(group.collected).toBe('111111');
    expect(group.outstanding).toBe('1222221');
  });

  it('the figures cross the boundary as integer strings', async () => {
    // Not "never a float": at numeric(14,2) every paise value fits a float64
    // exactly, so this cannot detect one. What it does assert is the CONTRACT —
    // a string of digits — which is what stops the next caller doing arithmetic
    // on a JSON number.
    const group = await dashboardService.groupFigures(asScope(), ON);
    for (const value of [group.billed, group.collected, group.outstanding]) {
      expect(typeof value).toBe('string');
      expect(value).toMatch(/^-?\d+$/);
    }
  });

  it('a learner enrolled in two years is counted once', async () => {
    // The learner count does not filter by academic year, and the one-active
    // -enrollment index is per YEAR — so a learner who has rolled over has two
    // active enrollments and would be counted twice without the DISTINCT. This
    // is the test that makes that line load-bearing rather than decorative.
    const before = await dashboardService.groupFigures(asScope(), ON);

    await asOwner(async (c) => {
      const nextYear = await c.query<{ id: string }>(
        `INSERT INTO academic_year (tenant_id, academic_unit_id, label, starts_on, ends_on, status)
         VALUES ($1, $2, '2027-28', '2027-04-01', '2028-03-31', 'planning') RETURNING id`,
        [tenant.orgId, tenant.unitId]);
      const cg = await c.query<{ id: string }>(
        `INSERT INTO class_group (tenant_id, programme_id, academic_year_id, name, level_sequence)
         VALUES ($1, $2, $3, 'X next', 10) RETURNING id`,
        [tenant.orgId, struct.programmeId, nextYear.rows[0]!.id]);
      const section = await c.query<{ id: string }>(
        `INSERT INTO section (tenant_id, class_group_id, name, capacity)
         VALUES ($1, $2, 'A', 40) RETURNING id`, [tenant.orgId, cg.rows[0]!.id]);
      const student = await c.query<{ student_id: string }>(
        `SELECT student_id FROM enrollment e
           JOIN section s ON s.id = e.section_id
          WHERE e.tenant_id = $1 LIMIT 1`, [tenant.orgId]);
      await c.query(
        `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
         VALUES ($1, $2, $3, $4)`,
        [tenant.orgId, student.rows[0]!.student_id, section.rows[0]!.id,
         nextYear.rows[0]!.id]);
    });

    const after = await dashboardService.groupFigures(asScope(), ON);
    expect(after.learners).toBe(before.learners);
  });

  it('learners are counted once even when a campus has several sections', async () => {
    const group = await dashboardService.groupFigures(asScope(), ON);
    expect(group.learners).toBe(5);
    expect(group.campuses.find((c) => c.campus_id === tenant.campusId)!.learners).toBe(3);
    expect(group.campuses.find((c) => c.campus_id === secondCampusId)!.learners).toBe(2);
  });

  it('a teacher sees no money on the dashboard', async () => {
    // The same endpoint, the same query. The zeroes come from the finance-scope
    // policy in 0029, not from a branch in the dashboard code.
    const group = await dashboardService.groupFigures(asTeacher(), ON);
    expect(group.billed).toBe('0');
    expect(group.collected).toBe('0');
    expect(group.outstanding).toBe('0');
  });
});
