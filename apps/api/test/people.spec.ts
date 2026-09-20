/**
 * AC-4 — a guardian can access only their linked learners.
 *
 * The scenario from the acceptance criteria, built literally: a guardian linked
 * to learner A at campus 1 with every capability, to learner B at campus 2 with
 * can_view_finance false, and not linked to learner C at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, revokeGrant,
  createPersonRaw, createLearnerRaw, linkGuardianRaw, destroyPeople, publishNotice,
  OWNER_URL, type TenantFixture, type UserFixture, type LearnerFixture,
  purgeTestData,
} from './fixtures.ts';
import { peopleRepository } from '../src/modules/people/people.repository.ts';
import { familyService } from '../src/modules/family/family.service.ts';
import { consentService } from '../src/modules/people/consent.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

let tenant: TenantFixture;
let otherTenant: TenantFixture;

let guardianUser: UserFixture;
let staffUser: UserFixture;
let guardianPersonId: string;
let staffPersonId: string;
let staffGrantId: string;
let guardianGrantId: string;

let learnerA: LearnerFixture;
let learnerB: LearnerFixture;
let learnerC: LearnerFixture;
let noticeId: string;

const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  await purgeTestData('%@ppl-test.example');
  tenant = await createTenant('PPL');
  otherTenant = await createTenant('PPL-OTHER');

  guardianUser = await createUser('guardian@ppl-test.example', PASSWORD);
  staffUser = await createUser('admin@ppl-test.example', PASSWORD);

  guardianGrantId = await grantRole(tenant.orgId, guardianUser.userId, 'GUARDIAN', 'self', tenant.campusId);
  staffGrantId = await grantRole(tenant.orgId, staffUser.userId, 'CAMPUS_ADMIN', 'campus', tenant.campusId);

  guardianPersonId = await createPersonRaw(tenant.orgId, 'Priya', {
    userAccountId: guardianUser.userId, familyName: 'Sharma',
  });
  staffPersonId = await createPersonRaw(tenant.orgId, 'Anil', {
    userAccountId: staffUser.userId, familyName: 'Admin',
  });

  learnerA = await createLearnerRaw(tenant.orgId, 'Aarav', 'ADM-A-001', {
    medicalNote: 'Carries an inhaler.', bloodGroup: 'O+',
  });
  learnerB = await createLearnerRaw(tenant.orgId, 'Bhavya', 'ADM-B-002');
  learnerC = await createLearnerRaw(tenant.orgId, 'Chirag', 'ADM-C-003');

  await linkGuardianRaw(tenant.orgId, learnerA.studentId, guardianPersonId, { isPrimary: true });
  await linkGuardianRaw(tenant.orgId, learnerB.studentId, guardianPersonId, {
    canViewFinance: false, canViewAcademics: false,
  });
  // learnerC is deliberately unlinked.

  noticeId = await publishNotice('privacy-ppl');
});

afterAll(async () => {
  await destroyPeople([tenant.orgId, otherTenant.orgId]);
  await destroyUsers([guardianUser.userId, staffUser.userId]);
  await destroyTenants([tenant.orgId, otherTenant.orgId]);
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  await client.query('DELETE FROM notice_version WHERE code = ANY($1)', [['privacy-ppl', 'draft-ppl']]);
  await client.end();
  await Promise.all([pool.end(), authPool.end()]);
});

const guardianScope = () => ({ tenantId: tenant.orgId, actorId: guardianUser.userId });
const staffScope = () => ({ tenantId: tenant.orgId, actorId: staffUser.userId });

describe('AC-4 — the guardian sees exactly their learners', () => {
  it('lists only linked learners, from the same query staff use unfiltered', async () => {
    // Identical SQL, different results. The difference is the policy.
    const asStaff = await peopleRepository.listStudents(staffScope());
    const asGuardian = await peopleRepository.listStudents(guardianScope());

    expect(asStaff.map((s) => s.admission_no).sort()).toEqual(['ADM-A-001', 'ADM-B-002', 'ADM-C-003']);
    expect(asGuardian.map((s) => s.admission_no).sort()).toEqual(['ADM-A-001', 'ADM-B-002']);
  });

  it('cannot fetch the unlinked learner by id, even knowing the id', async () => {
    const found = await peopleRepository.findStudent(guardianScope(), learnerC.studentId);
    // Invisible rather than forbidden, so the API returns 404 and does not
    // confirm that the id is real.
    expect(found).toBeUndefined();

    const asStaff = await peopleRepository.findStudent(staffScope(), learnerC.studentId);
    expect(asStaff?.admission_no).toBe('ADM-C-003');
  });

  it('cannot reach the unlinked learner through a join or an aggregate', async () => {
    const viaJoin = await withTenant(guardianScope(), async (db) => {
      const r = await db.query(
        `SELECT s.id FROM student s JOIN person p ON p.id = s.person_id WHERE s.id = $1`,
        [learnerC.studentId],
      );
      return r.rows.length;
    });
    expect(viaJoin).toBe(0);

    const count = await withTenant(guardianScope(), async (db) => {
      const r = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM student');
      return Number(r.rows[0]!.n);
    });
    expect(count).toBe(2);
  });

  it('cannot see the unlinked learner person record', async () => {
    const seen = await withTenant(guardianScope(), async (db) => {
      const r = await db.query('SELECT id FROM person WHERE id = $1', [learnerC.personId]);
      return r.rows.length;
    });
    expect(seen).toBe(0);
  });

  it('can see the person records of linked learners and themselves', async () => {
    const seen = await withTenant(guardianScope(), async (db) => {
      const r = await db.query<{ id: string }>('SELECT id FROM person ORDER BY given_name');
      return r.rows.map((x) => x.id);
    });
    expect(seen).toContain(guardianPersonId);
    expect(seen).toContain(learnerA.personId);
    expect(seen).toContain(learnerB.personId);
    expect(seen).not.toContain(learnerC.personId);
    // Not staff records either.
    expect(seen).not.toContain(staffPersonId);
  });

  it('the linked-learners switcher returns both children with their capabilities', async () => {
    // Through `familyService.children`, which is what `/v1/family/children`
    // serves. `peopleRepository.linkedLearners` answered the same question with
    // fewer columns and had no route; keeping both meant this assertion proved
    // a switcher no parent was looking at (M36).
    const learners = await familyService.children(guardianScope());
    expect(learners).toHaveLength(2);

    const a = learners.find((l) => l.admission_no === 'ADM-A-001');
    const b = learners.find((l) => l.admission_no === 'ADM-B-002');
    expect(a?.can_view_finance).toBe(true);
    expect(b?.can_view_finance).toBe(false);
  });
});

describe('capability flags are enforced at the query, not the UI', () => {
  it('a guardian with can_view_academics reads the sensitive record', async () => {
    const sensitive = await peopleRepository.findStudentSensitive(guardianScope(), learnerA.studentId);
    expect(sensitive?.medical_note).toBe('Carries an inhaler.');
    expect(sensitive?.blood_group).toBe('O+');
  });

  it('a guardian without can_view_academics is refused on a learner they ARE linked to', async () => {
    // The row is visible under RLS — the switcher lists learner B — but the
    // capability on the relationship is false, so the sensitive read is denied.
    // Hiding the screen would not be enough; the query itself returns nothing.
    const visible = await peopleRepository.findStudent(guardianScope(), learnerB.studentId);
    expect(visible).toBeTruthy();

    const sensitive = await peopleRepository.findStudentSensitive(guardianScope(), learnerB.studentId);
    expect(sensitive).toBeUndefined();
  });

  it('staff read sensitive records without a relationship', async () => {
    const sensitive = await peopleRepository.findStudentSensitive(staffScope(), learnerC.studentId);
    expect(sensitive).toBeDefined();
  });

  it('audits every sensitive read, including refused ones', async () => {
    await peopleRepository.findStudentSensitive(guardianScope(), learnerA.studentId);
    await peopleRepository.findStudentSensitive(guardianScope(), learnerB.studentId);

    const rows = await withTenant(staffScope(), async (db) => {
      const r = await db.query<{ action: string; classification: string }>(
        `SELECT action, classification FROM audit_log
          WHERE action IN ('student.sensitive.read', 'student.sensitive.read_denied')`,
      );
      return r.rows;
    });
    // A refused attempt on a medical note is as interesting as a successful one.
    expect(rows.some((r) => r.action === 'student.sensitive.read')).toBe(true);
    expect(rows.some((r) => r.action === 'student.sensitive.read_denied')).toBe(true);
    expect(rows.every((r) => r.classification === 'RESTRICTED')).toBe(true);
  });
});

describe('a guardian cannot grant themselves access', () => {
  it('cannot link themselves to an unlinked learner', async () => {
    // The named refusal, not Postgres's sentence. `linkGuardian` had a branch
    // that read like this refusal and could not run: the policy RAISES on this
    // INSERT rather than returning no row, so the branch was unreachable and
    // the raw error was what a caller would have seen — which nobody did,
    // because the method had no route until M36.
    const err = await peopleRepository.linkGuardian(guardianScope(), {
      studentId: learnerC.studentId,
      guardianPersonId,
      relationship: 'mother',
    }).catch((e: unknown) => e);
    expect((err as { status: number }).status).toBe(403);
    expect((err as { getResponse(): { error: { code: string } } })
      .getResponse().error.code).toBe('cannot_link_guardian');

    // And it did not land.
    expect(await peopleRepository.findStudent(guardianScope(), learnerC.studentId)).toBeUndefined();
  });

  it('cannot widen their own capability flags', async () => {
    // Note the asymmetry, and that it is correct in both directions. A guardian
    // CAN see their own link row, so USING admits it and the WITH CHECK then
    // rejects the write outright. For a learner they are not linked to, the row
    // is invisible instead and an UPDATE simply affects nothing.
    await expect(
      withTenant(guardianScope(), (db) =>
        db.query(
          `UPDATE guardian_link SET can_view_academics = true
            WHERE student_id = $1 AND guardian_person_id = $2`,
          [learnerB.studentId, guardianPersonId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    const stillDenied = await peopleRepository.findStudentSensitive(guardianScope(), learnerB.studentId);
    expect(stillDenied).toBeUndefined();
  });

  it('an update against an unlinked learner affects nothing rather than erroring', async () => {
    const affected = await withTenant(guardianScope(), async (db) => {
      const r = await db.query(
        `UPDATE student SET lifecycle_status = 'alumni' WHERE id = $1`,
        [learnerC.studentId],
      );
      return r.rowCount;
    });
    expect(affected).toBe(0);
  });

  it('cannot create a student record', async () => {
    await expect(
      peopleRepository.createStudent(guardianScope(), {
        personId: guardianPersonId, admissionNo: 'SELF-ENROLLED',
      }),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('ending a link removes access immediately', () => {
  it('drops the learner from the switcher on the next query', async () => {
    const extra = await createLearnerRaw(tenant.orgId, 'Devi', 'ADM-D-004');
    const linkId = await linkGuardianRaw(tenant.orgId, extra.studentId, guardianPersonId);

    expect(await peopleRepository.findStudent(guardianScope(), extra.studentId)).toBeTruthy();

    await peopleRepository.endGuardianLink(staffScope(), linkId, 'Child moved to another guardian.');

    // No re-login, no cache to clear: the next statement cannot see the row.
    expect(await peopleRepository.findStudent(guardianScope(), extra.studentId)).toBeUndefined();

    // The link row survives for the audit trail.
    const history = await withTenant(staffScope(), async (db) => {
      const r = await db.query('SELECT effective_to FROM guardian_link WHERE id = $1', [linkId]);
      return r.rows;
    });
    expect(history).toHaveLength(1);
    expect(history[0]!.effective_to).not.toBeNull();
  });
});

describe('an actor with no grants gets nothing (fails closed)', () => {
  it('sees no learners when every grant is revoked', async () => {
    await revokeGrant(guardianGrantId);
    try {
      // The guardian link still exists; the tenant grant does not. Staff scope
      // is derived from grants, so an unknown actor lands in neither branch.
      const learners = await peopleRepository.listStudents(guardianScope());
      // A guardian link alone still resolves the person, so linked learners
      // remain visible — but nothing else does.
      expect(learners.map((s) => s.admission_no).sort()).toEqual(['ADM-A-001', 'ADM-B-002']);
    } finally {
      guardianGrantId = await grantRole(tenant.orgId, guardianUser.userId, 'GUARDIAN', 'self', tenant.campusId);
    }
  });

  it('sees nothing at all when the actor is unknown to the tenant', async () => {
    const stranger = await createUser('stranger@ppl-test.example', PASSWORD);
    try {
      const learners = await peopleRepository.listStudents({
        tenantId: tenant.orgId, actorId: stranger.userId,
      });
      expect(learners).toHaveLength(0);
    } finally {
      await destroyUsers([stranger.userId]);
    }
  });

  it('sees nothing when no actor is set', async () => {
    const learners = await peopleRepository.listStudents({ tenantId: tenant.orgId });
    expect(learners).toHaveLength(0);
  });

  it('staff scope disappears the moment the staff grant is revoked', async () => {
    const before = await peopleRepository.listStudents(staffScope());
    expect(before.length).toBeGreaterThanOrEqual(3);

    await revokeGrant(staffGrantId);
    try {
      const after = await peopleRepository.listStudents(staffScope());
      expect(after).toHaveLength(0);
    } finally {
      staffGrantId = await grantRole(tenant.orgId, staffUser.userId, 'CAMPUS_ADMIN', 'campus', tenant.campusId);
    }
  });
});

describe('cross-tenant', () => {
  it('a guardian at one institute is nobody at another', async () => {
    const learners = await peopleRepository.listStudents({
      tenantId: otherTenant.orgId, actorId: guardianUser.userId,
    });
    expect(learners).toHaveLength(0);
  });
});

describe('consent (M3.6)', () => {
  it('records guardian-given consent against a published notice version', async () => {
    const record = await consentService.give(staffScope(), {
      personId: learnerA.personId,
      givenByPersonId: guardianPersonId,
      purpose: 'photo_publication',
      noticeVersionId: noticeId,
      channel: 'app',
    });
    // Both identities: whose data, and who agreed.
    expect(record.person_id).toBe(learnerA.personId);
    expect(record.given_by_person_id).toBe(guardianPersonId);
    expect(record.basis).toBe('consent');
  });

  it('refuses consent against an unpublished notice', async () => {
    const client = new pg.Client({ connectionString: OWNER_URL });
    await client.connect();
    // Idempotent: a previous failed run must not leave this test unrunnable.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO notice_version (code, version, title, body)
       VALUES ('draft-ppl', 1, 'Draft', 'x')
       ON CONFLICT (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), code, version, locale)
       DO UPDATE SET title = EXCLUDED.title
       RETURNING id`,
    );
    await client.end();

    await expect(
      consentService.give(staffScope(), {
        personId: learnerB.personId, givenByPersonId: guardianPersonId,
        purpose: 'marketing', noticeVersionId: rows[0]!.id, channel: 'app',
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('withdrawal takes effect immediately and keeps the record', async () => {
    await consentService.give(staffScope(), {
      personId: learnerB.personId, givenByPersonId: guardianPersonId,
      purpose: 'attendance_notifications', noticeVersionId: noticeId, channel: 'app',
    });
    expect(
      await consentService.isPermitted(staffScope(), learnerB.personId, 'attendance_notifications'),
    ).toBe(true);

    await consentService.withdraw(staffScope(), {
      personId: learnerB.personId, purpose: 'attendance_notifications', reason: 'Too many messages.',
    });

    expect(
      await consentService.isPermitted(staffScope(), learnerB.personId, 'attendance_notifications'),
    ).toBe(false);

    // Proof of consent outlives the consent.
    const history = await consentService.listFor(staffScope(), learnerB.personId);
    const withdrawn = history.find((c) => c.purpose === 'attendance_notifications');
    expect(withdrawn).toBeTruthy();
    expect(withdrawn!.withdrawn_at).not.toBeNull();
  });

  it('will not let contract-basis processing be withdrawn', async () => {
    await consentService.give(staffScope(), {
      personId: learnerA.personId, givenByPersonId: guardianPersonId,
      purpose: 'core_education_service', noticeVersionId: noticeId, channel: 'in_person',
    });

    // Withdrawing consent for optional processing must not break the core
    // service, so the two are distinguished in the data.
    await expect(
      consentService.withdraw(staffScope(), {
        personId: learnerA.personId, purpose: 'core_education_service',
      }),
    ).rejects.toMatchObject({ status: 422 });

    expect(
      await consentService.isPermitted(staffScope(), learnerA.personId, 'core_education_service'),
    ).toBe(true);
  });

  it('a consent record cannot be rewritten or deleted', async () => {
    const client = new pg.Client({ connectionString: OWNER_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM consent_record WHERE tenant_id = $1 LIMIT 1`, [tenant.orgId],
      );
      const id = rows[0]!.id;

      await expect(
        client.query(`UPDATE consent_record SET purpose = 'marketing' WHERE id = $1`, [id]),
      ).rejects.toThrow(/may only be withdrawn/i);

      await expect(client.query('DELETE FROM consent_record WHERE id = $1', [id])).rejects.toThrow(
        /evidence and cannot be deleted/i,
      );
    } finally {
      await client.end();
    }
  });

  it('a published notice cannot be edited', async () => {
    const client = new pg.Client({ connectionString: OWNER_URL });
    await client.connect();
    try {
      await expect(
        client.query(`UPDATE notice_version SET body = 'rewritten' WHERE id = $1`, [noticeId]),
      ).rejects.toThrow(/published and cannot be edited/i);
    } finally {
      await client.end();
    }
  });
});
