/**
 * M4 — academic structure, timetable clash prevention, and AC-3.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure, destroyAcademics, rowHash,
  OWNER_URL, type TenantFixture, type UserFixture, type AcademicYearFixture,
} from './fixtures.ts';
import { academicsRepository } from '../src/modules/academics/academics.repository.ts';
import { rolloverService } from '../src/modules/academics/rollover.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

let tenant: TenantFixture;
let staffUser: UserFixture;
let guardianUser: UserFixture;
let y2025: AcademicYearFixture;
let y2026: AcademicYearFixture;
let struct: Awaited<ReturnType<typeof createAcademicStructure>>;

const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  await purgeTestData('%@acad-test.example');
  tenant = await createTenant('ACAD');

  staffUser = await createUser('admin@acad-test.example', PASSWORD);
  guardianUser = await createUser('parent@acad-test.example', PASSWORD);
  await grantRole(tenant.orgId, staffUser.userId, 'CAMPUS_ADMIN', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, guardianUser.userId, 'GUARDIAN', 'self', tenant.campusId);

  struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  y2025 = await createAcademicYear(tenant.orgId, tenant.unitId, '2025-26', 2025, { status: 'active' });
  y2026 = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026);
});

afterAll(async () => {
  await destroyAcademics([tenant.orgId]);
  await destroyUsers([staffUser.userId, guardianUser.userId]);
  await destroyTenants([tenant.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
});

const staff = () => ({ tenantId: tenant.orgId, actorId: staffUser.userId });
const guardian = () => ({ tenantId: tenant.orgId, actorId: guardianUser.userId });

async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe('terms may not overlap within a year', () => {
  it('rejects a term overlapping an existing one', async () => {
    await expect(
      asOwner((c) =>
        c.query(
          `INSERT INTO term (tenant_id, academic_year_id, label, sequence, starts_on, ends_on)
           VALUES ($1, $2, 'Overlapping', 9, make_date(2025, 5, 1), make_date(2025, 8, 1))`,
          [tenant.orgId, y2025.yearId],
        ),
      ),
    ).rejects.toThrow(/term_no_overlap_within_year|exclusion constraint/i);
  });

  it('allows the same dates in a different year', async () => {
    // Two institutes, or two years, legitimately run April to March.
    await expect(
      asOwner((c) =>
        c.query(
          `INSERT INTO term (tenant_id, academic_year_id, label, sequence, starts_on, ends_on)
           VALUES ($1, $2, 'Same window, later year', 9, make_date(2025, 5, 1), make_date(2025, 8, 1))`,
          [tenant.orgId, y2026.yearId],
        ),
      ),
    ).resolves.toBeTruthy();
    await asOwner((c) => c.query(`DELETE FROM term WHERE sequence = 9 AND academic_year_id = $1`,
      [y2026.yearId]));
  });

  it('rejects two active years overlapping in one academic unit', async () => {
    await expect(
      asOwner((c) =>
        c.query(
          `INSERT INTO academic_year (tenant_id, academic_unit_id, label, starts_on, ends_on, status)
           VALUES ($1, $2, 'Clash', make_date(2025, 6, 1), make_date(2026, 1, 1), 'active')`,
          [tenant.orgId, tenant.unitId],
        ),
      ),
    ).rejects.toThrow(/academic_year_no_overlapping_active|exclusion constraint/i);
  });
});

describe('the timetable makes a clash impossible, not merely detected', () => {
  let offeringA: string;
  let offeringB: string;
  let sectionA: string;

  beforeAll(async () => {
    const group = await academicsRepository.createClassGroup(staff(), {
      programmeId: struct.programmeId, academicYearId: y2025.yearId,
      name: 'Class XI', levelSequence: 11,
    });
    const created = await asOwner(async (c) => {
      const sec = await c.query<{ id: string }>(
        `INSERT INTO section (tenant_id, class_group_id, name) VALUES ($1, $2, 'A') RETURNING id`,
        [tenant.orgId, group.id],
      );
      const secB = await c.query<{ id: string }>(
        `INSERT INTO section (tenant_id, class_group_id, name) VALUES ($1, $2, 'B') RETURNING id`,
        [tenant.orgId, group.id],
      );
      const coA = await c.query<{ id: string }>(
        `INSERT INTO course_offering
           (tenant_id, class_group_id, section_id, subject_id, term_id, primary_teacher_staff_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [tenant.orgId, group.id, sec.rows[0]!.id, struct.subjectId, y2025.termIds[0], struct.staffId],
      );
      const coB = await c.query<{ id: string }>(
        `INSERT INTO course_offering
           (tenant_id, class_group_id, section_id, subject_id, term_id, primary_teacher_staff_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [tenant.orgId, group.id, secB.rows[0]!.id, struct.subjectId, y2025.termIds[0], struct.staffId],
      );
      return { sectionA: sec.rows[0]!.id, offeringA: coA.rows[0]!.id, offeringB: coB.rows[0]!.id };
    });
    sectionA = created.sectionA;
    offeringA = created.offeringA;
    offeringB = created.offeringB;
  });

  it('books the first slot', async () => {
    const slot = await academicsRepository.addScheduleSlot(staff(), {
      courseOfferingId: offeringA, sectionId: sectionA, roomId: struct.roomId,
      staffId: struct.staffId, dayOfWeek: 1, startsAt: '09:15', endsAt: '10:05',
      effectiveFrom: '2025-04-01',
    });
    expect(slot.day_of_week).toBe(1);
  });

  it('refuses to double-book the room', async () => {
    const err = await academicsRepository
      .addScheduleSlot(staff(), {
        courseOfferingId: offeringB, roomId: struct.roomId,
        dayOfWeek: 1, startsAt: '09:45', endsAt: '10:35', effectiveFrom: '2025-04-01',
      })
      .catch((e) => e);
    expect(err.getResponse().error.code).toBe('timetable_room_clash');
  });

  it('refuses to double-book the teacher', async () => {
    const err = await academicsRepository
      .addScheduleSlot(staff(), {
        courseOfferingId: offeringB, staffId: struct.staffId,
        dayOfWeek: 1, startsAt: '09:00', endsAt: '09:30', effectiveFrom: '2025-04-01',
      })
      .catch((e) => e);
    expect(err.getResponse().error.code).toBe('timetable_teacher_clash');
  });

  it('refuses to put a section in two lessons at once', async () => {
    const err = await academicsRepository
      .addScheduleSlot(staff(), {
        courseOfferingId: offeringB, sectionId: sectionA,
        dayOfWeek: 1, startsAt: '09:30', endsAt: '10:00', effectiveFrom: '2025-04-01',
      })
      .catch((e) => e);
    expect(err.getResponse().error.code).toBe('timetable_section_clash');
  });

  it('allows a back-to-back slot that only touches at the boundary', async () => {
    // [09:15,10:05) and [10:05,10:55) do not overlap: the range is half-open, so
    // a lesson ending exactly when the next begins is not a clash.
    await expect(
      academicsRepository.addScheduleSlot(staff(), {
        courseOfferingId: offeringB, roomId: struct.roomId, staffId: struct.staffId,
        dayOfWeek: 1, startsAt: '10:05', endsAt: '10:55', effectiveFrom: '2025-04-01',
      }),
    ).resolves.toBeTruthy();
  });

  it('allows the same room and time on a different weekday', async () => {
    await expect(
      academicsRepository.addScheduleSlot(staff(), {
        courseOfferingId: offeringB, roomId: struct.roomId, staffId: struct.staffId,
        dayOfWeek: 2, startsAt: '09:15', endsAt: '10:05', effectiveFrom: '2025-04-01',
      }),
    ).resolves.toBeTruthy();
  });

  it('allows the same room and time once the earlier slot has ended', async () => {
    // A slot valid Apr-Jun and one valid Jul onwards share a weekday and a time
    // but not a date range, which is how a mid-year timetable change works.
    await asOwner((c) =>
      c.query(
        `UPDATE schedule_slot SET effective_to = make_date(2025, 6, 30)
          WHERE course_offering_id = $1 AND day_of_week = 1 AND starts_at = '09:15'`,
        [offeringA],
      ),
    );
    await expect(
      academicsRepository.addScheduleSlot(staff(), {
        courseOfferingId: offeringB, roomId: struct.roomId,
        dayOfWeek: 1, startsAt: '09:15', endsAt: '10:05', effectiveFrom: '2025-07-01',
      }),
    ).resolves.toBeTruthy();
  });

  it('holds under concurrent writes, which an application check cannot', async () => {
    // Two admins editing the timetable at the same moment. Both read "free",
    // both write. Exactly one must survive, and the database is the only place
    // that can guarantee it.
    const attempt = (offset: string) =>
      academicsRepository
        .addScheduleSlot(staff(), {
          courseOfferingId: offeringB, roomId: struct.roomId,
          dayOfWeek: 5, startsAt: offset, endsAt: '15:00', effectiveFrom: '2025-04-01',
        })
        .then(() => 'ok' as const)
        .catch(() => 'rejected' as const);

    const results = await Promise.all([attempt('14:00'), attempt('14:30')]);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'rejected')).toHaveLength(1);
  });
});

describe('the structure is readable by a guardian and writable only by staff', () => {
  it('a guardian can read the class list', async () => {
    const groups = await academicsRepository.listClassGroups(guardian(), y2025.yearId);
    expect(groups.length).toBeGreaterThan(0);
  });

  it('a guardian cannot create a class', async () => {
    await expect(
      academicsRepository.createClassGroup(guardian(), {
        programmeId: struct.programmeId, academicYearId: y2025.yearId, name: 'Fake Class',
      }),
    ).rejects.toThrow(/row-level security|staff/i);
  });

  it('a guardian cannot rename a class', async () => {
    const affected = await withTenant(guardian(), async (db) => {
      const r = await db.query(`UPDATE class_group SET name = 'Renamed by a parent'`);
      return r.rowCount;
    });
    expect(affected).toBe(0);
  });

  it('a guardian cannot move a lesson', async () => {
    const affected = await withTenant(guardian(), async (db) => {
      const r = await db.query(`UPDATE schedule_slot SET starts_at = '07:00'`);
      return r.rowCount;
    });
    expect(affected).toBe(0);
  });
});

describe('AC-3 — changing the structure does not break history', () => {
  it('rolls over into the new year without touching a single prior-year row', async () => {
    const before = await academicsRepository.listClassGroups(staff(), y2025.yearId);
    expect(before.length).toBeGreaterThan(0);

    // Hash every prior-year row we are about to leave alone.
    const hashesBefore = new Map<string, string>();
    for (const g of before) hashesBefore.set(g.id, await rowHash('class_group', g.id));

    const priorSections = await asOwner(async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT s.id FROM section s
           JOIN class_group cg ON cg.id = s.class_group_id
          WHERE cg.academic_year_id = $1`,
        [y2025.yearId],
      );
      return r.rows.map((x) => x.id);
    });
    const sectionHashesBefore = new Map<string, string>();
    for (const id of priorSections) sectionHashesBefore.set(id, await rowHash('section', id));

    const result = await rolloverService.rollover(staff(), {
      fromAcademicYearId: y2025.yearId,
      toAcademicYearId: y2026.yearId,
      includeTimetable: true,
    });

    expect(result.created.classGroups).toBe(before.length);
    expect(result.created.sections).toBeGreaterThan(0);
    // The target year already had its terms defined by staff, so rollover
    // created none and reused theirs. Their dates beat a mechanical +1 year.
    expect(result.created.terms).toBe(0);
    expect(result.created.scheduleSlots).toBeGreaterThan(0);

    // Every prior-year row is byte-identical. Not "looks the same" — identical.
    for (const [id, h] of hashesBefore) {
      expect(await rowHash('class_group', id)).toBe(h);
    }
    for (const [id, h] of sectionHashesBefore) {
      expect(await rowHash('section', id)).toBe(h);
    }
  });

  it('renaming next year class cannot alter last year record', async () => {
    const oldGroups = await academicsRepository.listClassGroups(staff(), y2025.yearId);
    const oldClass = oldGroups.find((g) => g.name === 'Class XI')!;
    const oldHash = await rowHash('class_group', oldClass.id);

    const newGroups = await academicsRepository.listClassGroups(staff(), y2026.yearId);
    const newClass = newGroups.find((g) => g.name === 'Class XI')!;
    expect(newClass.id).not.toBe(oldClass.id);

    // The rename an institute actually performs.
    await withTenant(staff(), (db) =>
      db.query(`UPDATE class_group SET name = 'Grade 11' WHERE id = $1`, [newClass.id]),
    );

    // Last year is untouched, by name and by content hash. This is the property
    // that will keep last year's report cards correct when they exist in M8.
    const afterRename = await academicsRepository.listClassGroups(staff(), y2025.yearId);
    expect(afterRename.find((g) => g.id === oldClass.id)?.name).toBe('Class XI');
    expect(await rowHash('class_group', oldClass.id)).toBe(oldHash);
  });

  it('prior-year offerings still point at prior-year structures', async () => {
    const stillCorrect = await asOwner(async (c) => {
      const r = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM course_offering co
           JOIN class_group cg ON cg.id = co.class_group_id
           JOIN term t ON t.id = co.term_id
          WHERE cg.academic_year_id = $1
            AND t.academic_year_id = $1`,
        [y2025.yearId],
      );
      return Number(r.rows[0]!.n);
    });
    // Nothing was repointed at the new year's term or class rows.
    expect(stillCorrect).toBeGreaterThan(0);

    const crossed = await asOwner(async (c) => {
      const r = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM course_offering co
           JOIN class_group cg ON cg.id = co.class_group_id
           JOIN term t ON t.id = co.term_id
          WHERE cg.academic_year_id <> t.academic_year_id`,
      );
      return Number(r.rows[0]!.n);
    });
    expect(crossed).toBe(0);
  });

  it('creates the terms when the target year has none', async () => {
    const fresh = await createAcademicYear(tenant.orgId, tenant.unitId, '2027-28', 2027, { terms: 0 });
    const source = await createAcademicYear(tenant.orgId, tenant.unitId, '2024-25', 2024, { terms: 3 });

    const group = await academicsRepository.createClassGroup(staff(), {
      programmeId: struct.programmeId, academicYearId: source.yearId, name: 'Class IX',
    });
    expect(group.id).toBeTruthy();

    const result = await rolloverService.rollover(staff(), {
      fromAcademicYearId: source.yearId, toAcademicYearId: fresh.yearId,
    });
    expect(result.created.terms).toBe(3);
    expect(result.created.classGroups).toBe(1);
  });

  it('fills only the missing terms when the target is partly set up', async () => {
    const source = await createAcademicYear(tenant.orgId, tenant.unitId, '2023-24', 2023, { terms: 4 });
    const target = await createAcademicYear(tenant.orgId, tenant.unitId, '2028-29', 2028, { terms: 1 });
    await academicsRepository.createClassGroup(staff(), {
      programmeId: struct.programmeId, academicYearId: source.yearId, name: 'Class VIII',
    });

    const result = await rolloverService.rollover(staff(), {
      fromAcademicYearId: source.yearId, toAcademicYearId: target.yearId,
    });
    // Sequence 1 was already there; 2, 3 and 4 were created. Composing with a
    // partly-configured year beats refusing to touch it.
    expect(result.created.terms).toBe(3);
  });

  it('refuses when a term sequence cannot be created at all', async () => {
    const source = await createAcademicYear(tenant.orgId, tenant.unitId, '2022-23', 2022, { terms: 2 });
    const target = await createAcademicYear(tenant.orgId, tenant.unitId, '2029-30', 2029, { terms: 0 });
    await academicsRepository.createClassGroup(staff(), {
      programmeId: struct.programmeId, academicYearId: source.yearId, name: 'Class VII',
    });

    // Staff renumbered: the target's only term carries the LABEL "Term 2" at
    // sequence 1. Copying source sequence 1 hits the sequence constraint and
    // copying sequence 2 hits the label constraint, so sequence 2 can never
    // exist. Offerings would land on a NULL term, so rollover refuses instead
    // of writing them.
    await asOwner((c) =>
      c.query(
        `INSERT INTO term (tenant_id, academic_year_id, label, sequence, starts_on, ends_on)
         VALUES ($1, $2, 'Term 2', 1, make_date(2029, 4, 1), make_date(2029, 9, 30))`,
        [tenant.orgId, target.yearId],
      ),
    );

    const err = await rolloverService
      .rollover(staff(), {
        fromAcademicYearId: source.yearId, toAcademicYearId: target.yearId,
      })
      .catch((e) => e);
    expect(err.getResponse().error.code).toBe('term_sequence_missing');

    // And nothing was written: the whole rollover is one transaction.
    const groups = await academicsRepository.listClassGroups(staff(), target.yearId);
    expect(groups).toHaveLength(0);
  });

  it('refuses to run twice', async () => {
    await expect(
      rolloverService.rollover(staff(), {
        fromAcademicYearId: y2025.yearId, toAcademicYearId: y2026.yearId,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to roll over across academic units', async () => {
    const otherUnit = await asOwner(async (c) => {
      const u = await c.query<{ id: string }>(
        `INSERT INTO academic_unit (tenant_id, campus_id, code, name, unit_type)
         VALUES ($1, $2, 'JR', 'Junior School', 'school') RETURNING id`,
        [tenant.orgId, tenant.campusId],
      );
      return u.rows[0]!.id;
    });
    const foreignYear = await createAcademicYear(tenant.orgId, otherUnit, '2026-27 JR', 2026);

    await expect(
      rolloverService.rollover(staff(), {
        fromAcademicYearId: y2025.yearId, toAcademicYearId: foreignYear.yearId,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('records the rollover in the audit log', async () => {
    const rows = await withTenant(staff(), async (db) => {
      const r = await db.query<{ action: string }>(
        `SELECT action FROM audit_log WHERE action = 'academic_year.rolled_over'`,
      );
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
  });
});
