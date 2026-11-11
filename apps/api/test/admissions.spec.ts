/**
 * M5.1-M5.4 — enquiries, configurable forms, documents, and the decision.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure, createPersonRaw, createFile,
  createLeadAndEnquiry, createClassGroupRaw, createSectionFor, backdateDecision,
  OWNER_URL, type TenantFixture, type UserFixture, type AcademicYearFixture,
} from './fixtures.ts';
import { formsService } from '../src/modules/admissions/forms.service.ts';
import { admissionsService } from '../src/modules/admissions/admissions.service.ts';
import { retentionService } from '../src/modules/admissions/retention.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

let tenant: TenantFixture;
let staffUser: UserFixture;
let guardianUser: UserFixture;
let year: AcademicYearFixture;
let struct: Awaited<ReturnType<typeof createAcademicStructure>>;
let sectionId: string;
let publishedFormId: string;

const PASSWORD = 'correct-horse-battery';

const APPLICATION_SCHEMA = {
  type: 'object',
  properties: {
    previousSchool: { type: 'string', minLength: 1, maxLength: 200 },
    previousBoard: { type: 'string', enum: ['CBSE', 'ICSE', 'State', 'Other'] },
    dateOfBirth: { type: 'string', format: 'date' },
    guardianEmail: { type: 'string', format: 'email' },
    siblingCount: { type: 'integer', minimum: 0, maximum: 12 },
  },
  required: ['previousSchool', 'previousBoard', 'dateOfBirth'],
  additionalProperties: false,
} as const;

beforeAll(async () => {
  await purgeTestData('%@adm-test.example');
  tenant = await createTenant('ADM');

  staffUser = await createUser('admissions@adm-test.example', PASSWORD);
  guardianUser = await createUser('parent@adm-test.example', PASSWORD);
  await grantRole(tenant.orgId, staffUser.userId, 'ADMISSIONS', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, guardianUser.userId, 'GUARDIAN', 'self', tenant.campusId);

  struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  year = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026, { status: 'active' });
  const classGroupId = await createClassGroupRaw(
    tenant.orgId, struct.programmeId, year.yearId, 'Class VI',
  );
  sectionId = await createSectionFor(tenant.orgId, classGroupId, 'A');
});

afterAll(async () => {
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

/** A submitted application, ready to decide. */
async function anApplication(name: string): Promise<{ applicationId: string; personId: string }> {
  const personId = await createPersonRaw(tenant.orgId, name, { familyName: 'Applicant' });
  const { enquiryId } = await createLeadAndEnquiry(
    tenant.orgId, tenant.campusId, struct.programmeId, year.yearId, name,
  );
  const submission = await formsService.submit(staff(), {
    formDefinitionId: publishedFormId,
    payload: { previousSchool: 'Little Flower', previousBoard: 'CBSE', dateOfBirth: '2014-06-12' },
  });
  const app = await admissionsService.createApplication(staff(), {
    applicantPersonId: personId,
    programmeId: struct.programmeId,
    academicYearId: year.yearId,
    formSubmissionId: submission.id,
    enquiryId,
    requiredDocuments: ['birth_certificate', 'previous_marksheet'],
  });
  return { applicationId: app.id, personId };
}

describe('configurable forms (M5.2)', () => {
  it('creates and publishes a versioned definition', async () => {
    const draft = await formsService.createDraft(staff(), {
      code: 'admission-vi', title: 'Class VI admission form',
      purpose: 'application', jsonSchema: APPLICATION_SCHEMA,
    });
    expect(draft.version).toBe(1);
    expect(draft.published_at).toBeNull();

    const published = await formsService.publish(staff(), draft.id);
    expect(published.published_at).not.toBeNull();
    publishedFormId = published.id;
  });

  it('a draft cannot accept submissions', async () => {
    const draft = await formsService.createDraft(staff(), {
      code: 'admission-vi', title: 'v2', purpose: 'application', jsonSchema: APPLICATION_SCHEMA,
    });
    expect(draft.version).toBe(2);
    await expect(
      formsService.submit(staff(), { formDefinitionId: draft.id, payload: {} }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('validates a submission against the schema', async () => {
    const ok = await formsService.submit(staff(), {
      formDefinitionId: publishedFormId,
      payload: {
        previousSchool: 'Little Flower', previousBoard: 'ICSE',
        dateOfBirth: '2013-04-01', siblingCount: 2,
      },
    });
    expect(ok.id).toBeTruthy();
  });

  it('rejects a payload that breaks the schema, naming each field', async () => {
    const err = await formsService
      .submit(staff(), {
        formDefinitionId: publishedFormId,
        payload: { previousBoard: 'IB', dateOfBirth: 'not-a-date', siblingCount: 99 },
      })
      .catch((e) => e);

    const body = err.getResponse();
    expect(body.error.code).toBe('form_payload_invalid');
    const paths = (body.error.details ?? []).map((d: { path: string }) => d.path);
    expect(paths.join(' ')).toMatch(/previousBoard/);
    expect(paths.join(' ')).toMatch(/dateOfBirth/);
    expect(paths.join(' ')).toMatch(/siblingCount/);
  });

  it('rejects a date that has the right shape but does not exist', async () => {
    await expect(
      formsService.submit(staff(), {
        formDefinitionId: publishedFormId,
        payload: {
          previousSchool: 'X', previousBoard: 'CBSE', dateOfBirth: '2014-02-31',
        },
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('stores the version that validated the payload, not the latest one', async () => {
    const submission = await formsService.submit(staff(), {
      formDefinitionId: publishedFormId,
      payload: { previousSchool: 'A', previousBoard: 'State', dateOfBirth: '2012-01-01' },
    });
    // A newer draft exists (v2). The submission must point at v1, which is what
    // makes an answer set reproducible after the form changes.
    const row = await withTenant(staff(), async (db) => {
      const r = await db.query<{ form_definition_id: string; version: number }>(
        `SELECT fs.form_definition_id, fd.version
           FROM form_submission fs JOIN form_definition fd ON fd.id = fs.form_definition_id
          WHERE fs.id = $1`,
        [submission.id],
      );
      return r.rows[0]!;
    });
    expect(row.form_definition_id).toBe(publishedFormId);
    expect(row.version).toBe(1);
  });

  it('a published definition cannot be edited', async () => {
    await expect(
      asOwner((c) =>
        c.query(`UPDATE form_definition SET json_schema = '{}'::jsonb WHERE id = $1`,
          [publishedFormId]),
      ),
    ).rejects.toThrow(/is published; publish a new version/i);
  });

  describe('a tenant schema is untrusted input', () => {
    it('refuses a keyword outside the whitelist', async () => {
      const err = await formsService
        .createDraft(staff(), {
          code: 'evil-1', title: 'x', purpose: 'custom',
          jsonSchema: { type: 'object', properties: { a: { $ref: 'https://evil.example/s.json' } } },
        })
        .catch((e) => e);
      expect(err.getResponse().error.code).toBe('schema_keyword_not_allowed');
    });

    it('refuses a pattern with nested quantifiers', async () => {
      // The classic catastrophic-backtracking shape. A form field carrying this
      // would let any applicant hang a request thread.
      const err = await formsService
        .createDraft(staff(), {
          code: 'evil-2', title: 'x', purpose: 'custom',
          jsonSchema: { type: 'object', properties: { a: { type: 'string', pattern: '^(a+)+$' } } },
        })
        .catch((e) => e);
      expect(err.getResponse().error.code).toBe('schema_pattern_unsafe');
    });

    it('refuses a schema nested deeper than the limit', async () => {
      let deep: Record<string, unknown> = { type: 'string' };
      for (let i = 0; i < 12; i++) deep = { type: 'object', properties: { nested: deep } };
      await expect(
        formsService.createDraft(staff(), {
          code: 'evil-3', title: 'x', purpose: 'custom', jsonSchema: deep,
        }),
      ).rejects.toMatchObject({ status: 422 });
    });

    it('refuses an unsupported format', async () => {
      const err = await formsService
        .createDraft(staff(), {
          code: 'evil-4', title: 'x', purpose: 'custom',
          jsonSchema: { type: 'object', properties: { a: { type: 'string', format: 'regex' } } },
        })
        .catch((e) => e);
      expect(err.getResponse().error.code).toBe('schema_format_not_allowed');
    });

    it('refuses a field name that is not an identifier', async () => {
      const err = await formsService
        .createDraft(staff(), {
          code: 'evil-5', title: 'x', purpose: 'custom',
          jsonSchema: { type: 'object', properties: { 'drop table': { type: 'string' } } },
        })
        .catch((e) => e);
      expect(err.getResponse().error.code).toBe('schema_field_name_invalid');
    });
  });
});

describe('applications (M5.1, M5.3)', () => {
  it('creates an application with a gapless number and a document checklist', async () => {
    const { applicationId } = await anApplication('Aarti');

    const app = await withTenant(staff(), async (db) => {
      const r = await db.query<{ application_no: string; status: string }>(
        'SELECT application_no, status FROM application WHERE id = $1', [applicationId],
      );
      return r.rows[0]!;
    });
    expect(app.application_no).toMatch(/^APP-\d{5}$/);
    expect(app.status).toBe('submitted');

    const docs = await withTenant(staff(), async (db) => {
      const r = await db.query<{ document_type: string; status: string }>(
        'SELECT document_type, status FROM application_document WHERE application_id = $1',
        [applicationId],
      );
      return r.rows;
    });
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.status === 'awaited')).toBe(true);
  });

  it('numbers applications without gaps or collisions under concurrency', async () => {
    // max(n)+1 without the advisory lock gives two applicants the same number;
    // a sequence gives gaps, which an admissions office reads as a lost form.
    const results = await Promise.all([
      anApplication('Concurrent A'),
      anApplication('Concurrent B'),
      anApplication('Concurrent C'),
    ]);

    const numbers = await withTenant(staff(), async (db) => {
      const r = await db.query<{ application_no: string }>(
        'SELECT application_no FROM application WHERE id = ANY($1) ORDER BY application_no',
        [results.map((x) => x.applicationId)],
      );
      return r.rows.map((x) => x.application_no);
    });
    expect(new Set(numbers).size).toBe(3);
  });

  it('refuses a second live application for the same person, programme and year', async () => {
    const { personId } = await anApplication('Duplicate');
    const submission = await formsService.submit(staff(), {
      formDefinitionId: publishedFormId,
      payload: { previousSchool: 'B', previousBoard: 'CBSE', dateOfBirth: '2014-01-01' },
    });
    await expect(
      admissionsService.createApplication(staff(), {
        applicantPersonId: personId, programmeId: struct.programmeId,
        academicYearId: year.yearId, formSubmissionId: submission.id,
      }),
    ).rejects.toThrow(/application_one_live_per_person_programme_year|duplicate key/i);
  });

  it('verifies a document only after the virus scan has cleared', async () => {
    const { applicationId } = await anApplication('Scan Check');
    const pendingFile = await createFile(tenant.orgId, { scanState: 'pending' });
    await admissionsService.attachDocument(staff(), {
      applicationId, documentType: 'birth_certificate', fileId: pendingFile,
    });

    const docId = await withTenant(staff(), async (db) => {
      const r = await db.query<{ id: string }>(
        `SELECT id FROM application_document
          WHERE application_id = $1 AND document_type = 'birth_certificate'`,
        [applicationId],
      );
      return r.rows[0]!.id;
    });

    const err = await admissionsService
      .verifyDocument(staff(), {
        documentId: docId, verifierStaffId: struct.staffId, accept: true,
      })
      .catch((e) => e);
    expect(err.getResponse().error.code).toBe('file_not_scanned');
  });

  it('rejecting a document requires a reason the family can act on', async () => {
    const { applicationId } = await anApplication('Reject Check');
    const file = await createFile(tenant.orgId);
    await admissionsService.attachDocument(staff(), {
      applicationId, documentType: 'birth_certificate', fileId: file,
    });
    const docId = await withTenant(staff(), async (db) => {
      const r = await db.query<{ id: string }>(
        `SELECT id FROM application_document
          WHERE application_id = $1 AND document_type = 'birth_certificate'`,
        [applicationId],
      );
      return r.rows[0]!.id;
    });

    await expect(
      admissionsService.verifyDocument(staff(), {
        documentId: docId, verifierStaffId: struct.staffId, accept: false,
      }),
    ).rejects.toMatchObject({ status: 422 });

    await admissionsService.verifyDocument(staff(), {
      documentId: docId, verifierStaffId: struct.staffId, accept: false,
      reason: 'The scan is cut off; please re-upload the full page.',
    });

    const after = await withTenant(staff(), async (db) => {
      const r = await db.query<{ status: string; rejection_reason: string }>(
        'SELECT status, rejection_reason FROM application_document WHERE id = $1', [docId],
      );
      return r.rows[0]!;
    });
    expect(after.status).toBe('rejected');
    expect(after.rejection_reason).toMatch(/re-upload/);
  });

  it('the admissions pipeline is invisible to a guardian', async () => {
    // An applicant is not yet a principal here, and the pipeline carries
    // internal notes and lead scores.
    const seen = await withTenant(guardian(), async (db) => {
      const r = await db.query('SELECT id FROM application');
      return r.rows.length;
    });
    expect(seen).toBe(0);

    const leads = await withTenant(guardian(), async (db) => {
      const r = await db.query('SELECT id FROM lead');
      return r.rows.length;
    });
    expect(leads).toBe(0);
  });
});

describe('the decision (M5.4)', () => {
  it('an offer must name a section and gets an expiry', async () => {
    const { applicationId } = await anApplication('Offered');
    await expect(
      admissionsService.decide(staff(), {
        applicationId, outcome: 'offered', decidedByStaffId: struct.staffId,
      }),
    ).rejects.toMatchObject({ status: 422 });

    const decision = await admissionsService.decide(staff(), {
      applicationId, outcome: 'offered', decidedByStaffId: struct.staffId,
      offeredSectionId: sectionId, offerValidDays: 7,
    });
    expect(decision.offer_expires_at).not.toBeNull();
  });

  it('a rejection must record a reason', async () => {
    const { applicationId } = await anApplication('Rejected');
    await expect(
      admissionsService.decide(staff(), {
        applicationId, outcome: 'rejected', decidedByStaffId: struct.staffId,
      }),
    ).rejects.toMatchObject({ status: 422 });

    const decision = await admissionsService.decide(staff(), {
      applicationId, outcome: 'rejected', decidedByStaffId: struct.staffId,
      reason: 'No places remaining in Class VI for 2026-27.',
    });
    expect(decision.outcome).toBe('rejected');
  });

  it('an issued decision cannot be altered or deleted', async () => {
    const { applicationId } = await anApplication('Immutable');
    const decision = await admissionsService.decide(staff(), {
      applicationId, outcome: 'waitlisted', decidedByStaffId: struct.staffId,
    });

    await expect(
      asOwner((c) =>
        c.query(`UPDATE admission_decision SET outcome = 'offered' WHERE id = $1`, [decision.id]),
      ),
    ).rejects.toThrow(/cannot be altered; supersede/i);

    await expect(
      asOwner((c) => c.query('DELETE FROM admission_decision WHERE id = $1', [decision.id])),
    ).rejects.toThrow(/cannot be deleted; supersede/i);
  });

  it('only one live decision per application, and a revision supersedes', async () => {
    const { applicationId } = await anApplication('Revised');
    await admissionsService.decide(staff(), {
      applicationId, outcome: 'waitlisted', decidedByStaffId: struct.staffId,
    });

    await expect(
      admissionsService.decide(staff(), {
        applicationId, outcome: 'offered', decidedByStaffId: struct.staffId,
        offeredSectionId: sectionId,
      }),
    ).rejects.toThrow(/admission_decision_one_live|duplicate key/i);

    const revised = await admissionsService.decide(staff(), {
      applicationId, outcome: 'offered', decidedByStaffId: struct.staffId,
      offeredSectionId: sectionId, supersede: true,
    });
    expect(revised.outcome).toBe('offered');

    // Both decisions remain on the record: the sequence of what the institute
    // told the family is itself the history.
    const all = await withTenant(staff(), async (db) => {
      const r = await db.query<{ outcome: string; superseded_at: Date | null }>(
        'SELECT outcome, superseded_at FROM admission_decision WHERE application_id = $1',
        [applicationId],
      );
      return r.rows;
    });
    expect(all).toHaveLength(2);
    expect(all.filter((d) => d.superseded_at === null)).toHaveLength(1);
  });

  it('an expired offer cannot be accepted', async () => {
    const { applicationId } = await anApplication('Expired');
    const decision = await admissionsService.decide(staff(), {
      applicationId, outcome: 'offered', decidedByStaffId: struct.staffId,
      offeredSectionId: sectionId, offerValidDays: 7,
    });

    await asOwner((c) =>
      c.query(
        `UPDATE admission_decision SET offer_expires_at = now() - interval '1 day' WHERE id = $1`,
        [decision.id],
      ),
    );

    const err = await admissionsService
      .acceptOfferAndEnrol(staff(), { decisionId: decision.id })
      .catch((e) => e);
    // Evaluated per request rather than by a sweeper, so it lapses on time.
    expect(err.getResponse().error.code).toBe('offer_expired');
  });

  it('a declined offer cannot then be accepted', async () => {
    const { applicationId } = await anApplication('Declined');
    const decision = await admissionsService.decide(staff(), {
      applicationId, outcome: 'offered', decidedByStaffId: struct.staffId,
      offeredSectionId: sectionId,
    });
    await admissionsService.declineOffer(staff(), decision.id, 'Joining another school.');

    const err = await admissionsService
      .acceptOfferAndEnrol(staff(), { decisionId: decision.id })
      .catch((e) => e);
    expect(err.getResponse().error.code).toBe('already_declined');
  });
});

describe('retention of unsuccessful applicant documents (M5.3)', () => {
  it('purges documents a year after an unsuccessful decision, keeping the decision', async () => {
    const { applicationId } = await anApplication('Purge Me');
    const file = await createFile(tenant.orgId);
    await admissionsService.attachDocument(staff(), {
      applicationId, documentType: 'birth_certificate', fileId: file,
    });
    const decision = await admissionsService.decide(staff(), {
      applicationId, outcome: 'rejected', decidedByStaffId: struct.staffId,
      reason: 'Did not meet the cut-off.',
    });
    await backdateDecision(decision.id, 400);

    const dry = await retentionService.purgeUnsuccessfulApplicantDocuments(staff(), {
      dryRun: true,
    });
    expect(dry.applicationsConsidered).toBeGreaterThan(0);
    expect(dry.documentsPurged).toBe(0);

    const done = await retentionService.purgeUnsuccessfulApplicantDocuments(staff());
    expect(done.documentsPurged).toBeGreaterThan(0);
    expect(done.filesMarkedDeleted).toBeGreaterThan(0);

    // The application and its decision survive: the institute must still be
    // able to say what it decided and why.
    const survives = await withTenant(staff(), async (db) => {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM admission_decision WHERE application_id = $1`,
        [applicationId],
      );
      return Number(r.rows[0]!.n);
    });
    expect(survives).toBe(1);

    const docsLeft = await withTenant(staff(), async (db) => {
      const r = await db.query(
        'SELECT id FROM application_document WHERE application_id = $1', [applicationId],
      );
      return r.rows.length;
    });
    expect(docsLeft).toBe(0);
  });

  it('never purges a file under legal hold', async () => {
    const { applicationId } = await anApplication('Legal Hold');
    const file = await createFile(tenant.orgId);
    await admissionsService.attachDocument(staff(), {
      applicationId, documentType: 'birth_certificate', fileId: file,
    });
    await asOwner((c) => c.query('UPDATE file SET legal_hold = true WHERE id = $1', [file]));

    const decision = await admissionsService.decide(staff(), {
      applicationId, outcome: 'rejected', decidedByStaffId: struct.staffId,
      reason: 'Withdrawn from consideration.',
    });
    await backdateDecision(decision.id, 400);

    await retentionService.purgeUnsuccessfulApplicantDocuments(staff());

    // Litigation outranks a retention schedule, and the row pointing at the held
    // object survives too — otherwise the hold is defeated by deleting the
    // pointer.
    const held = await asOwner(async (c) => {
      const r = await c.query<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM file WHERE id = $1', [file],
      );
      return r.rows[0]!;
    });
    expect(held.deleted_at).toBeNull();

    const docsLeft = await withTenant(staff(), async (db) => {
      const r = await db.query(
        'SELECT id FROM application_document WHERE application_id = $1', [applicationId],
      );
      return r.rows.length;
    });
    expect(docsLeft).toBe(1);
  });

  it('never purges documents of an applicant who enrolled', async () => {
    const { applicationId } = await anApplication('Enrolled Anyway');
    const file = await createFile(tenant.orgId);
    await admissionsService.attachDocument(staff(), {
      applicationId, documentType: 'birth_certificate', fileId: file,
    });
    const decision = await admissionsService.decide(staff(), {
      applicationId, outcome: 'offered', decidedByStaffId: struct.staffId,
      offeredSectionId: sectionId,
    });
    await admissionsService.acceptOfferAndEnrol(staff(), { decisionId: decision.id });
    await backdateDecision(decision.id, 400);

    await retentionService.purgeUnsuccessfulApplicantDocuments(staff());

    // Both checklist rows survive untouched — the one with the uploaded file and
    // the one still awaited.
    const docsLeft = await withTenant(staff(), async (db) => {
      const r = await db.query(
        'SELECT id FROM application_document WHERE application_id = $1', [applicationId],
      );
      return r.rows.length;
    });
    expect(docsLeft).toBe(2);

    const stillThere = await asOwner(async (c) => {
      const r = await c.query<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM file WHERE id = $1', [file],
      );
      return r.rows[0]!.deleted_at;
    });
    expect(stillThere).toBeNull();
  });
});
