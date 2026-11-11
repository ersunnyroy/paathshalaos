/**
 * M9.4 and M9.5 — the import pipeline, and AC-9.
 *
 * AC-9: 5,000 rows with 12 defects — nothing written during validation, and the
 * preview matches the apply exactly.
 *
 * The counting in this file is deliberate and a little tedious. "Nothing was
 * written" is only meaningful against a number taken immediately before, and
 * "the preview matched" is only meaningful if the preview's numbers are captured
 * and compared rather than eyeballed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicStructure,
  OWNER_URL, type TenantFixture, type UserFixture,
} from './fixtures.ts';
import { importService, type Mapping } from '../src/modules/import/import.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

let tenant: TenantFixture;
let admin: UserFixture;
let guardianUser: UserFixture;
let struct: Awaited<ReturnType<typeof createAcademicStructure>>;

const PASSWORD = 'correct-horse-battery';
const PREFIX = `IMP${Date.now().toString().slice(-6)}`;

beforeAll(async () => {
  await purgeTestData('%@imp-test.example');
  tenant = await createTenant('IMP');
  admin = await createUser('admin@imp-test.example', PASSWORD);
  guardianUser = await createUser('parent@imp-test.example', PASSWORD);
  await grantRole(tenant.orgId, admin.userId, 'ORG_OWNER', 'organization', null);
  await grantRole(tenant.orgId, guardianUser.userId, 'GUARDIAN', 'self', tenant.campusId);
  struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
}, 60_000);

afterAll(async () => {
  await destroyUsers([admin.userId, guardianUser.userId]);
  await destroyTenants([tenant.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
});

const admin_ = () => ({ tenantId: tenant.orgId, actorId: admin.userId });
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

async function countRows(table: string): Promise<number> {
  return asOwner(async (c) => {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE tenant_id = $1`, [tenant.orgId]);
    return Number(r.rows[0]!.n);
  });
}

const MAPPINGS: Mapping[] = [
  { sourceColumn: 'Adm No', targetField: 'admission_no', transform: 'trim' },
  { sourceColumn: 'First Name', targetField: 'given_name', transform: 'trim' },
  { sourceColumn: 'Last Name', targetField: 'family_name', transform: 'trim' },
  { sourceColumn: 'DOB', targetField: 'date_of_birth', transform: 'date_dmy' },
  { sourceColumn: 'Mobile', targetField: 'guardian_phone', transform: 'phone_in' },
];

/**
 * 5,000 rows carrying exactly twelve defects, of the kinds that actually turn up
 * in a school's spreadsheet.
 */
function aRosterOf5000(): {
  rows: Array<Record<string, string>>; defectRows: number[];
} {
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i <= 5000; i++) {
    rows.push({
      'Adm No': `${PREFIX}-${String(i).padStart(4, '0')}`,
      'First Name': `Learner${i}`,
      'Last Name': 'Kumar',
      DOB: `0${(i % 9) + 1}/0${(i % 9) + 1}/2014`,
      Mobile: `98765${String(10000 + (i % 80000)).padStart(5, '0')}`,
    });
  }

  const defectRows: number[] = [];
  const spoil = (rowNo: number, change: Record<string, string>) => {
    Object.assign(rows[rowNo - 1]!, change);
    defectRows.push(rowNo);
  };

  // 1–2: dates that are not dates.
  spoil(101, { DOB: '31/02/2014' });          // impossible
  spoil(202, { DOB: 'not a date' });          // unparseable
  // 3–5: phone numbers Excel has ruined, or that are simply wrong.
  spoil(303, { Mobile: '9.8765E+09' });       // scientific notation
  spoil(404, { Mobile: '12345' });            // too short
  spoil(505, { Mobile: '1234567890' });       // does not start 6-9
  // 6–8: required fields missing.
  spoil(606, { 'First Name': '' });
  spoil(707, { 'Adm No': '' });
  spoil(808, { 'First Name': '   ' });        // whitespace is not a name
  // 9–10: duplicate admission numbers WITHIN the file.
  spoil(909, { 'Adm No': `${PREFIX}-0001` });
  spoil(1010, { 'Adm No': `${PREFIX}-0002` });
  // 11–12: two more date failures, deeper in the file.
  spoil(2500, { DOB: '13/13/2014' });
  spoil(4999, { DOB: '2014-05-06' });         // ISO in a dd/mm/yyyy column

  return { rows, defectRows };
}

describe('AC-9 — 5,000 rows with 12 defects', () => {
  let batchId: string;
  let previewDigest: string;
  let previewCounts: { total: number; create: number; update: number; skip: number; invalid: number };
  let peopleBefore: number;
  let studentsBefore: number;
  let roster: ReturnType<typeof aRosterOf5000>;

  it('stages the file without touching a domain table', async () => {
    roster = aRosterOf5000();
    peopleBefore = await countRows('person');
    studentsBefore = await countRows('student');

    const batch = await importService.createBatch(admin_(), {
      entity: 'learner_roster', originalFilename: 'roster.xlsx',
      campusId: tenant.campusId, uploadedByStaffId: struct.staffId,
    });
    batchId = batch.id;

    await importService.stageRows(admin_(), { batchId, rows: roster.rows });
    await importService.setMapping(admin_(), { batchId, mappings: MAPPINGS });

    expect(await countRows('person')).toBe(peopleBefore);
    expect(await countRows('student')).toBe(studentsBefore);
  }, 60_000);

  it('VALIDATION WRITES NOTHING', async () => {
    // The half-applied import — 3,000 learners in, one bad row, nobody knows
    // what state the school is in — is the failure that loses a customer in
    // week one.
    const result = await importService.validate(admin_(), batchId);

    expect(await countRows('person')).toBe(peopleBefore);
    expect(await countRows('student')).toBe(studentsBefore);

    // Twelve defects: ten that make a row invalid, two that make it a duplicate.
    expect(result.invalid + result.duplicate).toBe(12);
    expect(result.duplicate).toBe(2);
    expect(result.valid).toBe(5000 - 12);
  }, 60_000);

  it('names every defective row and what is wrong with it', async () => {
    const bad = await withTenant(admin_(), (db) =>
      importService.rowsWithErrors(db, batchId));
    expect(bad.map((b) => b.row_no).sort((a, b) => a - b))
      .toEqual([...roster.defectRows].sort((a, b) => a - b));
    expect(bad.every((b) => b.errors.length > 0)).toBe(true);

    const codes = new Set(bad.flatMap((b) => b.errors.map((e) => e.code)));
    expect(codes).toContain('date_impossible');
    expect(codes).toContain('date_unparseable');
    expect(codes).toContain('phone_lost_to_excel');
    expect(codes).toContain('phone_invalid');
    expect(codes).toContain('required');
    expect(codes).toContain('duplicate_in_file');

    // The Excel message tells the person how to fix it, because "invalid phone"
    // sends them looking at the phone number, which is fine in the source file.
    const excel = bad.find((b) => b.row_no === 303)!;
    expect(excel.errors[0]!.message).toMatch(/format the column as text/i);
  });

  it('previews without writing anything either', async () => {
    const { counts, digest } = await importService.preview(admin_(), batchId);
    previewCounts = counts;
    previewDigest = digest;

    expect(await countRows('person')).toBe(peopleBefore);
    expect(await countRows('student')).toBe(studentsBefore);

    expect(counts.total).toBe(5000);
    expect(counts.create).toBe(4988);
    expect(counts.update).toBe(0);
    expect(counts.skip).toBe(12);
  }, 60_000);

  it('THE PREVIEW MATCHES THE APPLY EXACTLY', async () => {
    const result = await importService.apply(admin_(), {
      batchId, appliedByStaffId: struct.staffId,
    });

    // Not "close to". The same numbers.
    expect(result.counts).toEqual(previewCounts);
    expect(result.created).toBe(previewCounts.create);
    expect(result.updated).toBe(previewCounts.update);

    // And the domain agrees with both.
    expect(await countRows('student')).toBe(studentsBefore + 4988);
    expect(await countRows('person')).toBe(peopleBefore + 4988);
  }, 120_000);

  it('the recorded counts are what the office was shown', async () => {
    const batch = await withTenant(admin_(), (db) => importService.batch(db, batchId));
    expect(batch!.status).toBe('applied');
    expect(batch!.preview_counts).toEqual(previewCounts);
    expect(batch!.plan_digest).toBe(previewDigest);
  });

  it('applied the valid rows and skipped exactly the defective ones', async () => {
    const applied = await asOwner(async (c) => {
      const r = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM import_row
          WHERE import_batch_id = $1 AND status = 'applied'`, [batchId]);
      return Number(r.rows[0]!.n);
    });
    expect(applied).toBe(4988);

    // The duplicate rows' admission numbers exist ONCE, from the original row.
    const dupes = await asOwner(async (c) => {
      const r = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM student
          WHERE tenant_id = $1 AND admission_no = $2`, [tenant.orgId, `${PREFIX}-0001`]);
      return Number(r.rows[0]!.n);
    });
    expect(dupes).toBe(1);
  });

  it('cannot be applied twice', async () => {
    await expect(
      importService.apply(admin_(), { batchId, appliedByStaffId: struct.staffId }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('the plan is refused when the data moves underneath it', () => {
  let batchId: string;

  beforeAll(async () => {
    const batch = await importService.createBatch(admin_(), {
      entity: 'learner_roster', uploadedByStaffId: struct.staffId,
    });
    batchId = batch.id;
    await importService.stageRows(admin_(), {
      batchId,
      rows: [
        { 'Adm No': `${PREFIX}-M1`, 'First Name': 'Moving', 'Last Name': 'Target',
          DOB: '01/01/2014', Mobile: '9876500001' },
      ],
    });
    await importService.setMapping(admin_(), { batchId, mappings: MAPPINGS });
    await importService.validate(admin_(), batchId);
    await importService.preview(admin_(), batchId);
  });

  it('refuses the apply when a matching learner appears after the preview', async () => {
    // The preview said "create". Somebody else creates that learner. Applying
    // now would either duplicate them or silently become an update — neither is
    // what was approved.
    await asOwner(async (c) => {
      const p = await c.query<{ id: string }>(
        `INSERT INTO person (tenant_id, given_name) VALUES ($1, 'Raced') RETURNING id`,
        [tenant.orgId]);
      await c.query(
        `INSERT INTO student (tenant_id, person_id, admission_no) VALUES ($1, $2, $3)`,
        [tenant.orgId, p.rows[0]!.id, `${PREFIX}-M1`]);
    });

    const err = await importService
      .apply(admin_(), { batchId, appliedByStaffId: struct.staffId })
      .catch((e) => e);
    expect((err as { getResponse(): { error: { code: string } } })
      .getResponse().error.code).toBe('plan_changed');
  });

  it('a fresh preview produces a plan that can be applied', async () => {
    const { counts } = await importService.preview(admin_(), batchId);
    // It is now an update, and the office sees that before agreeing to it.
    expect(counts.update).toBe(1);
    expect(counts.create).toBe(0);

    const result = await importService.apply(admin_(), {
      batchId, appliedByStaffId: struct.staffId,
    });
    expect(result.counts).toEqual(counts);
  });
});

describe('reversal', () => {
  let batchId: string;
  let studentsBefore: number;

  beforeAll(async () => {
    studentsBefore = await countRows('student');
    const batch = await importService.createBatch(admin_(), {
      entity: 'learner_roster', uploadedByStaffId: struct.staffId,
    });
    batchId = batch.id;
    await importService.stageRows(admin_(), {
      batchId,
      rows: [1, 2, 3].map((i) => ({
        'Adm No': `${PREFIX}-R${i}`, 'First Name': `Rev${i}`, 'Last Name': 'Ersible',
        DOB: '01/01/2014', Mobile: `987650000${i}`,
      })),
    });
    await importService.setMapping(admin_(), { batchId, mappings: MAPPINGS });
    await importService.validate(admin_(), batchId);
    await importService.preview(admin_(), batchId);
    await importService.apply(admin_(), { batchId, appliedByStaffId: struct.staffId });
  });

  it('takes the created rows back out', async () => {
    expect(await countRows('student')).toBe(studentsBefore + 3);
    const result = await importService.reverse(admin_(), {
      batchId, reason: 'Wrong file — this is last year\'s roster.',
      reversedByStaffId: struct.staffId,
    });
    expect(result.reversed).toBe(6); // a person and a student per row
    expect(await countRows('student')).toBe(studentsBefore);
  });

  it('a reversed import is final', async () => {
    await expect(
      importService.reverse(admin_(), {
        batchId, reason: 'Again.', reversedByStaffId: struct.staffId,
      }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      asOwner((c) => c.query(
        `UPDATE import_batch SET status = 'applied' WHERE id = $1`, [batchId])),
    ).rejects.toThrow(/final/i);
  });

  it('REFUSES to reverse a learner who has been used since', async () => {
    // An undo that deletes a learner who has since been enrolled, marked present
    // and invoiced is a second disaster, not a recovery.
    const batch = await importService.createBatch(admin_(), {
      entity: 'learner_roster', uploadedByStaffId: struct.staffId,
    });
    await importService.stageRows(admin_(), {
      batchId: batch.id,
      rows: [{ 'Adm No': `${PREFIX}-USED`, 'First Name': 'Used', 'Last Name': 'Since',
        DOB: '01/01/2014', Mobile: '9876512345' }],
    });
    await importService.setMapping(admin_(), { batchId: batch.id, mappings: MAPPINGS });
    await importService.validate(admin_(), batch.id);
    await importService.preview(admin_(), batch.id);
    await importService.apply(admin_(), {
      batchId: batch.id, appliedByStaffId: struct.staffId,
    });

    const studentId = await asOwner(async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM student WHERE tenant_id = $1 AND admission_no = $2`,
        [tenant.orgId, `${PREFIX}-USED`]);
      return r.rows[0]!.id;
    });
    const guardianPersonId = await asOwner(async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO person (tenant_id, given_name) VALUES ($1, 'Guardian') RETURNING id`,
        [tenant.orgId]);
      await c.query(
        `INSERT INTO guardian_link (tenant_id, student_id, guardian_person_id, relationship)
         VALUES ($1, $2, $3, 'mother')`,
        [tenant.orgId, studentId, r.rows[0]!.id]);
      return r.rows[0]!.id;
    });
    void guardianPersonId;

    const err = await importService.reverse(admin_(), {
      batchId: batch.id, reason: 'Undo.', reversedByStaffId: struct.staffId,
    }).catch((e) => e);
    const body = (err as { getResponse(): { error: { code: string; message: string } } })
      .getResponse().error;
    expect(body.code).toBe('reversal_blocked');
    // And it says WHICH rows and why, because "cannot reverse" sends the office
    // looking through five thousand rows.
    expect(body.message).toMatch(/has a guardian linked/i);

    // Nothing was removed.
    const still = await asOwner(async (c) => {
      const r = await c.query(
        `SELECT id FROM student WHERE tenant_id = $1 AND admission_no = $2`,
        [tenant.orgId, `${PREFIX}-USED`]);
      return r.rows.length;
    });
    expect(still).toBe(1);
  });

  it('restores the previous values of an updated row', async () => {
    const batch = await importService.createBatch(admin_(), {
      entity: 'learner_roster', uploadedByStaffId: struct.staffId,
    });
    await importService.stageRows(admin_(), {
      batchId: batch.id,
      rows: [{ 'Adm No': `${PREFIX}-M1`, 'First Name': 'Renamed', 'Last Name': 'Twice',
        DOB: '02/02/2014', Mobile: '9876500002' }],
    });
    await importService.setMapping(admin_(), { batchId: batch.id, mappings: MAPPINGS });
    await importService.validate(admin_(), batch.id);
    const { counts } = await importService.preview(admin_(), batch.id);
    expect(counts.update).toBe(1);

    const before = await asOwner(async (c) => {
      const r = await c.query<{ given_name: string }>(
        `SELECT p.given_name FROM person p JOIN student s ON s.person_id = p.id
          WHERE s.tenant_id = $1 AND s.admission_no = $2`,
        [tenant.orgId, `${PREFIX}-M1`]);
      return r.rows[0]!.given_name;
    });

    await importService.apply(admin_(), {
      batchId: batch.id, appliedByStaffId: struct.staffId,
    });
    await importService.reverse(admin_(), {
      batchId: batch.id, reason: 'Undo the rename.', reversedByStaffId: struct.staffId,
    });

    const after = await asOwner(async (c) => {
      const r = await c.query<{ given_name: string }>(
        `SELECT p.given_name FROM person p JOIN student s ON s.person_id = p.id
          WHERE s.tenant_id = $1 AND s.admission_no = $2`,
        [tenant.orgId, `${PREFIX}-M1`]);
      return r.rows[0]!.given_name;
    });
    expect(after).toBe(before);
    expect(after).not.toBe('Renamed');
  });
});

describe('mapping and transforms', () => {
  it('refuses a mapping that leaves a required field unmapped', async () => {
    // Refused once, here — rather than as 5,000 identical row errors, which is a
    // wall of red that hides the one actual problem.
    const batch = await importService.createBatch(admin_(), { entity: 'learner_roster' });
    const err = await importService.setMapping(admin_(), {
      batchId: batch.id,
      mappings: [{ sourceColumn: 'First Name', targetField: 'given_name' }],
    }).catch((e) => e);
    expect((err as { getResponse(): { error: { code: string } } })
      .getResponse().error.code).toBe('unmapped_required_field');
  });

  it('refuses a target that is not a field of the entity', async () => {
    const batch = await importService.createBatch(admin_(), { entity: 'learner_roster' });
    await expect(
      importService.setMapping(admin_(), {
        batchId: batch.id,
        mappings: [
          { sourceColumn: 'A', targetField: 'admission_no' },
          { sourceColumn: 'B', targetField: 'given_name' },
          { sourceColumn: 'C', targetField: 'password_hash' },
        ],
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('a two-digit year is resolved by a written-down rule', async () => {
    // Guessing is unavoidable for a two-digit year in a roster. Guessing
    // silently is not.
    const batch = await importService.createBatch(admin_(), { entity: 'learner_roster' });
    await importService.stageRows(admin_(), {
      batchId: batch.id,
      rows: [
        { 'Adm No': `${PREFIX}-Y1`, 'First Name': 'Young', DOB: '12/03/14' },
        { 'Adm No': `${PREFIX}-Y2`, 'First Name': 'Older', DOB: '12/03/98' },
      ],
    });
    await importService.setMapping(admin_(), {
      batchId: batch.id,
      mappings: [
        { sourceColumn: 'Adm No', targetField: 'admission_no' },
        { sourceColumn: 'First Name', targetField: 'given_name' },
        { sourceColumn: 'DOB', targetField: 'date_of_birth', transform: 'date_dmy' },
      ],
    });
    await importService.validate(admin_(), batch.id);

    const dates = await asOwner(async (c) => {
      const r = await c.query<{ normalised: { date_of_birth: string } }>(
        `SELECT normalised FROM import_row WHERE import_batch_id = $1 ORDER BY row_no`,
        [batch.id]);
      return r.rows.map((x) => x.normalised.date_of_birth);
    });
    expect(dates).toEqual(['2014-03-12', '1998-03-12']);
  });
});

describe('who can import', () => {
  it('a guardian cannot see or start an import', async () => {
    const seen = await withTenant(guardian(), async (db) => {
      const r = await db.query('SELECT id FROM import_batch');
      return r.rows.length;
    });
    expect(seen).toBe(0);

    await expect(
      importService.createBatch(guardian(), { entity: 'learner_roster' }),
    ).rejects.toThrow();
  });
});
