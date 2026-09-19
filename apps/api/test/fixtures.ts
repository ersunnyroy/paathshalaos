import pg from 'pg';
import { loadDotenv } from '../src/config/load-dotenv.ts';

loadDotenv();

export const OWNER_URL = process.env['DATABASE_OWNER_URL'] ?? '';
export const APP_URL = process.env['DATABASE_URL'] ?? '';

export interface TenantFixture {
  orgId: string;
  campusId: string;
  unitId: string;
  prefix: string;
}

/**
 * Fixtures are created with the OWNER role, deliberately. The app role cannot
 * insert an organization, and more importantly we want the fixtures to exist
 * independently of the policies we are about to test — otherwise a broken
 * policy could make the setup fail in a way that looks like a pass.
 */
export async function createTenant(prefix: string): Promise<TenantFixture> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    const org = await client.query<{ id: string }>(
      `INSERT INTO organization (legal_name, display_name) VALUES ($1, $1) RETURNING id`,
      [`${prefix} Trust`],
    );
    const orgId = org.rows[0]!.id;

    const campus = await client.query<{ id: string }>(
      `INSERT INTO campus (tenant_id, code, name, is_primary)
       VALUES ($1, $2, $3, true) RETURNING id`,
      [orgId, `${prefix}-MAIN`, `${prefix} Main Campus`],
    );
    const campusId = campus.rows[0]!.id;

    const unit = await client.query<{ id: string }>(
      `INSERT INTO academic_unit (tenant_id, campus_id, code, name, unit_type)
       VALUES ($1, $2, $3, $4, 'school') RETURNING id`,
      [orgId, campusId, `${prefix}-SR`, `${prefix} Senior School`],
    );

    return { orgId, campusId, unitId: unit.rows[0]!.id, prefix };
  } finally {
    await client.end();
  }
}

/**
 * Deletes a tenant and everything under it, in dependency order.
 *
 * Deliberately complete rather than minimal. An earlier version deleted only
 * the four tenancy tables, so every spec that created staff or a timetable had
 * to remember its own cleanup — and the one that forgot failed in afterAll,
 * which vitest reports as a failed *suite* while still printing "127 passed".
 * A teardown that misses a table is a test-suite bug that looks like a pass.
 *
 * TABLE_TEARDOWN_ORDER must gain any new tenant-scoped table. The isolation
 * suite's rls_coverage check lists them all if this drifts.
 */
const TABLE_TEARDOWN_ORDER = [
  'kb_article_version', 'kb_article',
  'ticket_event', 'ticket_message', 'support_ticket',
  'webhook_attempt', 'webhook_delivery', 'webhook_endpoint',
  'idempotency_key', 'api_key_secret', 'api_key', 'api_client',
  'import_applied_row', 'import_row', 'import_mapping', 'import_batch',
  'delivery_receipt', 'message_attempt', 'message_recipient', 'message_request',
  'message_template_version', 'message_template', 'communication_preference',
  'whatsapp_session',
  'report_card', 'report_card_template', 'result_line', 'result_run',
  'mark_correction', 'mark', 'assessment', 'grade_band', 'grading_scale',
  'settlement_line', 'settlement_batch', 'ledger_entry',
  'waiver', 'refund', 'receipt', 'payment_allocation', 'payment_attempt',
  'payment_webhook_event', 'payment', 'mandate',
  'invoice_line', 'invoice', 'installment', 'concession', 'fee_assignment',
  'fee_component', 'fee_plan',
  'attendance_correction', 'attendance_record', 'attendance_session',
  'leave_request', 'outbox_event',
  'subject_election', 'enrollment_event', 'enrollment',
  'admission_decision', 'application_document', 'application', 'enquiry', 'lead',
  'form_submission', 'form_definition',
  'schedule_slot', 'course_offering', 'section', 'class_group',
  'room', 'subject', 'term',
  'guardian_link', 'student', 'staff', 'programme',
  'role_grant', 'tenant_principal', 'contact_method', 'address',
  'impersonation_session', 'audit_checkpoint',
  'person',
  'file',
  'academic_year', 'academic_unit', 'campus',
] as const;

/**
 * Triggers that make a table append-only in production and therefore block
 * teardown. Disabled for the delete and re-enabled immediately.
 *
 * Note what this list proves: every one of these fired when teardown first tried
 * to delete from the table, which is a live demonstration that the protection is
 * on. Only the owner role can disable them — the application never can.
 */
const APPEND_ONLY_TRIGGERS: ReadonlyArray<readonly [string, string]> = [
  ['consent_record', 'consent_record_append_only'],
  ['enrollment_event', 'enrollment_event_no_update'],
  ['enrollment_event', 'enrollment_event_no_delete'],
  ['admission_decision', 'admission_decision_frozen'],
  ['notice_version', 'notice_version_frozen'],
  ['form_definition', 'form_definition_is_frozen'],
  ['attendance_correction', 'attendance_correction_append_only'],
  ['webhook_attempt', 'webhook_attempt_no_update'],
  ['ticket_message', 'ticket_message_frozen'],
  ['ticket_event', 'ticket_event_frozen'],
  ['kb_article_version', 'kb_article_version_frozen'],
  ['ledger_entry', 'ledger_entry_no_update'],
  ['ledger_entry', 'ledger_entry_no_delete'],
  ['invoice', 'invoice_frozen'],
  ['payment', 'payment_frozen'],
  ['receipt', 'receipt_frozen'],
  ['fee_plan', 'fee_plan_is_frozen'],
  ['fee_component', 'fee_component_follows_plan'],
  ['mark_correction', 'mark_correction_append_only'],
  ['result_line', 'result_line_frozen'],
  ['result_run', 'result_run_guarded'],
  ['report_card', 'report_card_guarded'],
  ['grading_scale', 'grading_scale_frozen'],
  ['grade_band', 'grade_band_frozen'],
  ['message_template_version', 'message_template_version_frozen'],
  ['import_batch', 'import_batch_guarded'],
  ['import_applied_row', 'import_applied_row_append_only'],
];

export async function destroyTenants(orgIds: string[]): Promise<void> {
  if (orgIds.length === 0) return;
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    for (const [table, trigger] of APPEND_ONLY_TRIGGERS) {
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    }
    try {
      await client.query('DELETE FROM consent_record WHERE tenant_id = ANY($1)', [orgIds]);
      for (const table of TABLE_TEARDOWN_ORDER) {
        await client.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [orgIds]);
      }
      await client.query('DELETE FROM organization WHERE id = ANY($1)', [orgIds]);
    } finally {
      for (const [table, trigger] of APPEND_ONLY_TRIGGERS) {
        await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      }
    }
  } finally {
    await client.end();
  }
}

// --- identity fixtures (M2) ---

export interface UserFixture {
  userId: string;
  email: string;
  password: string;
}

/**
 * Creates a login. Uses the owner connection so that a broken policy shows up
 * as a failing assertion rather than a failing setup.
 */
export async function createUser(
  email: string,
  password: string,
  opts: { status?: string } = {},
): Promise<UserFixture> {
  const { passwordService } = await import('../src/modules/auth/password.service.ts');
  const hash = await passwordService.hash(password);

  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO user_account (login_email, password_hash, status)
       VALUES ($1, $2, $3) RETURNING id`,
      [email, hash, opts.status ?? 'active'],
    );
    return { userId: rows[0]!.id, email, password };
  } finally {
    await client.end();
  }
}

export async function grantRole(
  tenantId: string,
  userId: string,
  role: string,
  scopeType = 'organization',
  scopeId: string | null = null,
): Promise<string> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO role_grant (tenant_id, user_account_id, role, scope_type, scope_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, userId, role, scopeType, scopeId],
    );
    return rows[0]!.id;
  } finally {
    await client.end();
  }
}

export async function revokeGrant(grantId: string): Promise<void> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    await client.query('UPDATE role_grant SET revoked_at = now() WHERE id = $1', [grantId]);
  } finally {
    await client.end();
  }
}

export async function destroyUsers(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    // No need to clear rows that merely attribute work to these accounts:
    // form_definition.created_by, form_submission.submitted_by and
    // file.uploaded_by are ON DELETE SET NULL, so the account goes and the
    // history stays.
    // Integration rows attribute themselves to the account that made them, so
    // they go before it does. The append-only trigger on webhook_attempt is
    // disabled around this for the same reason purgeTestData disables it.
    for (const [table, trigger] of APPEND_ONLY_TRIGGERS) {
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    }
    try {
      await client.query(
        `DELETE FROM webhook_attempt WHERE webhook_delivery_id IN (
           SELECT d.id FROM webhook_delivery d
            JOIN webhook_endpoint e ON e.id = d.webhook_endpoint_id
           WHERE e.created_by = ANY($1))`, [userIds]);
      await client.query(
        `DELETE FROM webhook_delivery WHERE webhook_endpoint_id IN (
           SELECT id FROM webhook_endpoint WHERE created_by = ANY($1))`, [userIds]);
      await client.query('DELETE FROM webhook_endpoint WHERE created_by = ANY($1)', [userIds]);
      await client.query(
        `DELETE FROM api_key_secret WHERE api_key_id IN (
           SELECT id FROM api_key WHERE created_by = ANY($1) OR revoked_by = ANY($1))`,
        [userIds]);
      await client.query(
        'DELETE FROM api_key WHERE created_by = ANY($1) OR revoked_by = ANY($1)', [userIds]);
      await client.query(
        `DELETE FROM idempotency_key WHERE api_client_id IN (
           SELECT id FROM api_client WHERE created_by = ANY($1))`, [userIds]);
      await client.query('DELETE FROM api_client WHERE created_by = ANY($1)', [userIds]);
      await client.query(
        `DELETE FROM kb_article_version WHERE kb_article_id IN (
           SELECT id FROM kb_article WHERE created_by = ANY($1))`, [userIds]);
      await client.query('DELETE FROM kb_article WHERE created_by = ANY($1)', [userIds]);
    } finally {
      for (const [table, trigger] of APPEND_ONLY_TRIGGERS) {
        await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      }
    }
    await client.query('DELETE FROM role_grant WHERE user_account_id = ANY($1)', [userIds]);
    await client.query('DELETE FROM user_account WHERE id = ANY($1)', [userIds]);
  } finally {
    await client.end();
  }
}

/**
 * A teacher, as the product actually models one: a person, a staff row, and the
 * sections they are responsible for.
 *
 * Before M12 the suites created a user with a TEACHER grant and stopped there,
 * because the policies only asked about the grant. That made every fixture
 * teacher a person-less staff-less principal who could nonetheless read the
 * whole school — and the day the policy started asking which sections they
 * teach, fifteen tests failed at once. The fixture was wrong all along; the
 * narrowing is what revealed it.
 */
export async function makeTeacher(
  tenantId: string,
  campusId: string,
  userId: string,
  opts: { givenName?: string; employeeCode?: string; classTeacherOf?: string[] } = {},
): Promise<{ personId: string; staffId: string }> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    const person = await client.query<{ id: string }>(
      `INSERT INTO person (tenant_id, given_name, family_name, user_account_id)
       VALUES ($1, $2, 'Teacher', $3) RETURNING id`,
      [tenantId, opts.givenName ?? 'Staff', userId]);
    const personId = person.rows[0]!.id;

    const staff = await client.query<{ id: string }>(
      `INSERT INTO staff (tenant_id, person_id, campus_id, employee_code,
                          designation, joined_on)
       VALUES ($1, $2, $3, $4, 'Teacher', CURRENT_DATE) RETURNING id`,
      [tenantId, personId, campusId,
       opts.employeeCode ?? `EMP-${Math.random().toString(36).slice(2, 8)}`]);
    const staffId = staff.rows[0]!.id;

    for (const sectionId of opts.classTeacherOf ?? []) {
      await client.query(
        'UPDATE section SET class_teacher_staff_id = $2 WHERE id = $1',
        [sectionId, staffId]);
    }
    return { personId, staffId };
  } finally {
    await client.end();
  }
}

/**
 * Timetables a staff member into a section.
 *
 * The other way a teacher legitimately reaches a class: not as its class
 * teacher but as somebody scheduled to be in the room. Also how relief cover is
 * expressible today — see the note in the attendance suite.
 */
export async function timetableInto(
  tenantId: string,
  structure: { programmeId: string; subjectId: string; roomId: string },
  sectionId: string,
  academicYearId: string,
  staffId: string,
): Promise<void> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    // Reuse an offering for this section's class group, or make one. A fixture
    // that requires the caller to have created an offering first is a fixture
    // people copy the setup for and get subtly wrong.
    const existing = await client.query<{ id: string }>(
      `SELECT co.id FROM course_offering co
         JOIN section s ON s.class_group_id = co.class_group_id
        WHERE s.id = $1 LIMIT 1`, [sectionId]);
    let offering = existing.rows[0]?.id;

    if (!offering) {
      const made = await client.query<{ id: string }>(
        `INSERT INTO course_offering (tenant_id, class_group_id, subject_id, term_id)
         SELECT $1, s.class_group_id, $2,
                (SELECT id FROM term WHERE academic_year_id = $3 ORDER BY starts_on LIMIT 1)
           FROM section s WHERE s.id = $4
         RETURNING id`,
        [tenantId, structure.subjectId, academicYearId, sectionId]);
      offering = made.rows[0]?.id;
    }
    if (!offering) throw new Error('Could not resolve a course offering for that section.');

    await client.query(
      `INSERT INTO schedule_slot
         (tenant_id, course_offering_id, section_id, room_id, staff_id,
          day_of_week, period_no, starts_at, ends_at, academic_year_id, effective_from)
       VALUES ($1, $2, $3, $4, $5, 1, 1, '09:00', '09:45', $6, CURRENT_DATE)`,
      [tenantId, offering, sectionId, structure.roomId, staffId, academicYearId]);
  } finally {
    await client.end();
  }
}

/** Puts an existing staff member in charge of another section. */
export async function assignClassTeacher(sectionId: string, staffId: string): Promise<void> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    await client.query('UPDATE section SET class_teacher_staff_id = $2 WHERE id = $1',
      [sectionId, staffId]);
  } finally {
    await client.end();
  }
}

// --- people fixtures (M3) ---

export interface LearnerFixture {
  studentId: string;
  personId: string;
  admissionNo: string;
}

/** Creates a person as the OWNER role, bypassing the policies under test. */
export async function createPersonRaw(
  tenantId: string,
  givenName: string,
  opts: { userAccountId?: string; familyName?: string; dob?: string } = {},
): Promise<string> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO person (tenant_id, given_name, family_name, date_of_birth, user_account_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, givenName, opts.familyName ?? null, opts.dob ?? null, opts.userAccountId ?? null],
    );
    return rows[0]!.id;
  } finally {
    await client.end();
  }
}

export async function createLearnerRaw(
  tenantId: string,
  givenName: string,
  admissionNo: string,
  sensitive: { medicalNote?: string; bloodGroup?: string } = {},
): Promise<LearnerFixture> {
  const personId = await createPersonRaw(tenantId, givenName, { familyName: 'Learner' });
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO student (tenant_id, person_id, admission_no, lifecycle_status,
                            medical_note, blood_group)
       VALUES ($1, $2, $3, 'enrolled', $4, $5) RETURNING id`,
      [tenantId, personId, admissionNo, sensitive.medicalNote ?? null, sensitive.bloodGroup ?? null],
    );
    return { studentId: rows[0]!.id, personId, admissionNo };
  } finally {
    await client.end();
  }
}

export async function linkGuardianRaw(
  tenantId: string,
  studentId: string,
  guardianPersonId: string,
  caps: Partial<{
    canViewAcademics: boolean; canViewFinance: boolean; canPay: boolean;
    canAuthorisePickup: boolean; canReceiveNotifications: boolean; isPrimary: boolean;
  }> = {},
): Promise<string> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO guardian_link
         (tenant_id, student_id, guardian_person_id, relationship, is_primary,
          can_view_academics, can_view_finance, can_pay,
          can_authorise_pickup, can_receive_notifications)
       VALUES ($1, $2, $3, 'mother', $4, $5, $6, $7, $8, $9) RETURNING id`,
      [tenantId, studentId, guardianPersonId, caps.isPrimary ?? false,
       caps.canViewAcademics ?? true, caps.canViewFinance ?? true, caps.canPay ?? true,
       caps.canAuthorisePickup ?? true, caps.canReceiveNotifications ?? true],
    );
    return rows[0]!.id;
  } finally {
    await client.end();
  }
}

export async function publishNotice(code: string): Promise<string> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO notice_version (code, version, title, body, published_at)
       VALUES ($1, 1, 'Privacy notice', 'The text people actually agreed to.', now())
       RETURNING id`,
      [code],
    );
    return rows[0]!.id;
  } finally {
    await client.end();
  }
}

export async function destroyPeople(tenantIds: string[]): Promise<void> {
  if (tenantIds.length === 0) return;
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    // consent_record blocks DELETE by trigger — drop it for teardown only.
    await client.query('ALTER TABLE consent_record DISABLE TRIGGER consent_record_append_only');
    await client.query('DELETE FROM consent_record WHERE tenant_id = ANY($1)', [tenantIds]);
    await client.query('ALTER TABLE consent_record ENABLE TRIGGER consent_record_append_only');
    await client.query('DELETE FROM guardian_link WHERE tenant_id = ANY($1)', [tenantIds]);
    await client.query('DELETE FROM student WHERE tenant_id = ANY($1)', [tenantIds]);
    await client.query('DELETE FROM staff WHERE tenant_id = ANY($1)', [tenantIds]);
    await client.query('DELETE FROM tenant_principal WHERE tenant_id = ANY($1)', [tenantIds]);
    await client.query('DELETE FROM person WHERE tenant_id = ANY($1)', [tenantIds]);
  } finally {
    await client.end();
  }
}

/**
 * Removes anything a previous run of this suite left behind.
 *
 * Needed because an interrupted run (a crash, a failed teardown, a deliberate
 * mutation that broke cleanup) otherwise poisons every later run with a
 * duplicate-key error in beforeAll — which shows up as "26 skipped" and looks
 * like a passing suite if you are not reading carefully.
 *
 * Scoped to the *-test.example email domain and the tenant prefixes the fixtures
 * use, so it cannot touch anything a developer created by hand.
 */
export async function purgeTestData(emailDomain = '%-test.example'): Promise<void> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM user_account WHERE login_email LIKE $1',
      [emailDomain],
    );
    const userIds = rows.map((r) => r.id);
    if (userIds.length === 0) return;

    const { rows: tenantRows } = await client.query<{ tenant_id: string }>(
      'SELECT DISTINCT tenant_id FROM role_grant WHERE user_account_id = ANY($1)',
      [userIds],
    );
    const tenantIds = tenantRows.map((r) => r.tenant_id);

    // Disabled for the whole purge, not only the tenant-scoped half. An
    // aborted run leaves accounts whose role_grant is already gone, so
    // tenantIds comes back empty while append-only rows attached to those
    // accounts remain — and the by-user deletes below then fail on a trigger
    // that was never switched off.
    for (const [table, trigger] of APPEND_ONLY_TRIGGERS) {
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    }

    if (tenantIds.length > 0) {
      await client.query('DELETE FROM consent_record WHERE tenant_id = ANY($1)', [tenantIds]);
      for (const t of ['kb_article_version', 'kb_article',
                       'ticket_event', 'ticket_message', 'support_ticket',
                       'webhook_attempt', 'webhook_delivery', 'webhook_endpoint',
                       'idempotency_key', 'api_key_secret', 'api_key', 'api_client',
                       'import_applied_row', 'import_row', 'import_mapping', 'import_batch',
                       'delivery_receipt', 'message_attempt', 'message_recipient',
                       'message_request', 'message_template_version', 'message_template',
                       'communication_preference', 'whatsapp_session',
                       'report_card', 'report_card_template', 'result_line', 'result_run',
                       'mark_correction', 'mark', 'assessment', 'grade_band', 'grading_scale',
                       'settlement_line', 'settlement_batch', 'ledger_entry',
                       'waiver', 'refund', 'receipt', 'payment_allocation', 'payment_attempt',
                       'payment_webhook_event', 'payment', 'mandate',
                       'invoice_line', 'invoice', 'installment', 'concession', 'fee_assignment',
                       'fee_component', 'fee_plan',
                       'attendance_correction', 'attendance_record', 'attendance_session',
                       'leave_request', 'outbox_event',
                       'subject_election', 'enrollment_event', 'enrollment',
                       'admission_decision', 'application_document', 'application',
                       'enquiry', 'lead', 'form_submission', 'form_definition']) {
        await client.query(`DELETE FROM ${t} WHERE tenant_id = ANY($1)`, [tenantIds]);
      }
      for (const [table, trigger] of APPEND_ONLY_TRIGGERS) {
        await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      }
      await client.query('DELETE FROM impersonation_session WHERE tenant_id = ANY($1)', [tenantIds]);
      for (const t of ['schedule_slot', 'course_offering', 'section', 'class_group',
                       'room', 'subject', 'term', 'programme']) {
        await client.query(`DELETE FROM ${t} WHERE tenant_id = ANY($1)`, [tenantIds]);
      }
      await client.query('DELETE FROM guardian_link WHERE tenant_id = ANY($1)', [tenantIds]);
      await client.query('DELETE FROM student WHERE tenant_id = ANY($1)', [tenantIds]);
      await client.query('DELETE FROM staff WHERE tenant_id = ANY($1)', [tenantIds]);
      await client.query('DELETE FROM tenant_principal WHERE tenant_id = ANY($1)', [tenantIds]);
      await client.query('DELETE FROM contact_method WHERE tenant_id = ANY($1)', [tenantIds]);
      await client.query('DELETE FROM address WHERE tenant_id = ANY($1)', [tenantIds]);
      await client.query('DELETE FROM person WHERE tenant_id = ANY($1)', [tenantIds]);
      await client.query('DELETE FROM file WHERE tenant_id = ANY($1)', [tenantIds]);
      await client.query('DELETE FROM audit_checkpoint WHERE tenant_id = ANY($1)', [tenantIds]);
    }

    // Rows referencing these accounts whose tenant was not discoverable, because
    // an earlier aborted run already removed the role_grant we derive from.
    // api_client and api_key carry created_by/revoked_by, so they go by user id
    // as well as by tenant above — a client left behind by an aborted run has no
    // discoverable tenant and would block the account delete for ever.
    await client.query(
      `DELETE FROM webhook_attempt WHERE webhook_delivery_id IN (
         SELECT d.id FROM webhook_delivery d
          JOIN webhook_endpoint e ON e.id = d.webhook_endpoint_id
         WHERE e.created_by = ANY($1))`, [userIds]);
    await client.query(
      `DELETE FROM webhook_delivery WHERE webhook_endpoint_id IN (
         SELECT id FROM webhook_endpoint WHERE created_by = ANY($1))`, [userIds]);
    await client.query('DELETE FROM webhook_endpoint WHERE created_by = ANY($1)', [userIds]);
    await client.query(
      `DELETE FROM api_key_secret WHERE api_key_id IN (
         SELECT id FROM api_key WHERE created_by = ANY($1) OR revoked_by = ANY($1))`, [userIds]);
    await client.query(
      'DELETE FROM api_key WHERE created_by = ANY($1) OR revoked_by = ANY($1)', [userIds]);
    await client.query(
      `DELETE FROM idempotency_key WHERE api_client_id IN (
         SELECT id FROM api_client WHERE created_by = ANY($1))`, [userIds]);
    await client.query('DELETE FROM api_client WHERE created_by = ANY($1)', [userIds]);
    await client.query('DELETE FROM form_submission WHERE submitted_by = ANY($1)', [userIds]);
    await client.query('DELETE FROM form_definition WHERE created_by = ANY($1)', [userIds]);
    await client.query('DELETE FROM role_grant WHERE user_account_id = ANY($1)', [userIds]);
    await client.query('DELETE FROM user_account WHERE id = ANY($1)', [userIds]);

    if (tenantIds.length > 0) {
      await client.query('DELETE FROM academic_year WHERE tenant_id = ANY($1)', [tenantIds]);
      await client.query('DELETE FROM academic_unit WHERE tenant_id = ANY($1)', [tenantIds]);
      await client.query('DELETE FROM campus WHERE tenant_id = ANY($1)', [tenantIds]);
      await client.query('DELETE FROM organization WHERE id = ANY($1)', [tenantIds]);
    }
  } finally {
    await client.end();
  }
}

// --- academic structure fixtures (M4) ---

export interface AcademicYearFixture {
  yearId: string;
  termIds: string[];
}

export async function createAcademicYear(
  tenantId: string,
  unitId: string,
  label: string,
  startYear: number,
  opts: { status?: string; terms?: number } = {},
): Promise<AcademicYearFixture> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO academic_year (tenant_id, academic_unit_id, label, starts_on, ends_on, status)
       VALUES ($1, $2, $3, make_date($4, 4, 1), make_date($4 + 1, 3, 31), $5)
       RETURNING id`,
      [tenantId, unitId, label, startYear, opts.status ?? 'planning'],
    );
    const yearId = rows[0]!.id;

    const termIds: string[] = [];
    for (let i = 1; i <= (opts.terms ?? 2); i++) {
      const t = await client.query<{ id: string }>(
        `INSERT INTO term (tenant_id, academic_year_id, label, sequence, starts_on, ends_on)
         VALUES ($1, $2, $3, $4,
                 make_date($5, 4, 1) + (($4 - 1) * 180)::int,
                 make_date($5, 4, 1) + (($4 * 180) - 1)::int)
         RETURNING id`,
        [tenantId, yearId, `Term ${i}`, i, startYear],
      );
      termIds.push(t.rows[0]!.id);
    }
    return { yearId, termIds };
  } finally {
    await client.end();
  }
}

export async function createAcademicStructure(
  tenantId: string,
  unitId: string,
  campusId: string,
): Promise<{ programmeId: string; subjectId: string; roomId: string; staffPersonId: string; staffId: string }> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    const prog = await client.query<{ id: string }>(
      `INSERT INTO programme (tenant_id, academic_unit_id, code, name, credential_type)
       VALUES ($1, $2, 'CBSE-SR', 'CBSE Senior Secondary', 'board_examination') RETURNING id`,
      [tenantId, unitId],
    );
    const subj = await client.query<{ id: string }>(
      `INSERT INTO subject (tenant_id, academic_unit_id, code, name, subject_type)
       VALUES ($1, $2, 'PHY', 'Physics', 'core') RETURNING id`,
      [tenantId, unitId],
    );
    const room = await client.query<{ id: string }>(
      `INSERT INTO room (tenant_id, campus_id, code, name, capacity)
       VALUES ($1, $2, 'R101', 'Room 101', 40) RETURNING id`,
      [tenantId, campusId],
    );
    const person = await client.query<{ id: string }>(
      `INSERT INTO person (tenant_id, given_name, family_name)
       VALUES ($1, 'Meera', 'Teacher') RETURNING id`,
      [tenantId],
    );
    const staff = await client.query<{ id: string }>(
      `INSERT INTO staff (tenant_id, person_id, campus_id, employee_code, designation, joined_on)
       VALUES ($1, $2, $3, 'EMP-001', 'Teacher', CURRENT_DATE) RETURNING id`,
      [tenantId, person.rows[0]!.id, campusId],
    );
    return {
      programmeId: prog.rows[0]!.id,
      subjectId: subj.rows[0]!.id,
      roomId: room.rows[0]!.id,
      staffPersonId: person.rows[0]!.id,
      staffId: staff.rows[0]!.id,
    };
  } finally {
    await client.end();
  }
}

/** A content hash of a row, so "was this touched" is answerable exactly. */
export async function rowHash(table: string, id: string): Promise<string> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ h: string }>(
      `SELECT md5(t::text) AS h FROM ${table} t WHERE t.id = $1`,
      [id],
    );
    return rows[0]?.h ?? 'MISSING';
  } finally {
    await client.end();
  }
}

export async function destroyAcademics(tenantIds: string[]): Promise<void> {
  if (tenantIds.length === 0) return;
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    for (const t of ['schedule_slot', 'course_offering', 'section', 'class_group',
                     'room', 'subject', 'term', 'programme']) {
      await client.query(`DELETE FROM ${t} WHERE tenant_id = ANY($1)`, [tenantIds]);
    }
  } finally {
    await client.end();
  }
}

// --- admissions fixtures (M5) ---

export async function createFile(
  tenantId: string,
  opts: { sha?: string; scanState?: string } = {},
): Promise<string> {
  const sha = opts.sha ?? Array.from({ length: 64 },
    () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO file (tenant_id, bucket, object_key, mime_type, size_bytes, sha256,
                         classification, virus_scan_state)
       VALUES ($1, 'paathshala-docs', 'docs/' || $2, 'application/pdf', 102400, $2,
               'RESTRICTED', $3)
       RETURNING id`,
      [tenantId, sha, opts.scanState ?? 'clean'],
    );
    return rows[0]!.id;
  } finally {
    await client.end();
  }
}

export async function createLeadAndEnquiry(
  tenantId: string,
  campusId: string,
  programmeId: string,
  academicYearId: string,
  name: string,
): Promise<{ leadId: string; enquiryId: string }> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    const lead = await client.query<{ id: string }>(
      `INSERT INTO lead (tenant_id, campus_id, source, name, phone)
       VALUES ($1, $2, 'website', $3, '9' || lpad((random() * 999999999)::bigint::text, 9, '0'))
       RETURNING id`,
      [tenantId, campusId, name],
    );
    const enq = await client.query<{ id: string }>(
      `INSERT INTO enquiry (tenant_id, lead_id, programme_id, academic_year_id, stage)
       VALUES ($1, $2, $3, $4, 'counselled') RETURNING id`,
      [tenantId, lead.rows[0]!.id, programmeId, academicYearId],
    );
    return { leadId: lead.rows[0]!.id, enquiryId: enq.rows[0]!.id };
  } finally {
    await client.end();
  }
}

export async function createSectionFor(
  tenantId: string,
  classGroupId: string,
  name: string,
): Promise<string> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO section (tenant_id, class_group_id, name) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, classGroupId, name],
    );
    return rows[0]!.id;
  } finally {
    await client.end();
  }
}

export async function createClassGroupRaw(
  tenantId: string,
  programmeId: string,
  academicYearId: string,
  name: string,
): Promise<string> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO class_group (tenant_id, programme_id, academic_year_id, name)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, programmeId, academicYearId, name],
    );
    return rows[0]!.id;
  } finally {
    await client.end();
  }
}

/** Backdates a decision so the retention purge has something to find. */
export async function backdateDecision(decisionId: string, days: number): Promise<void> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    // decided_at is frozen by the immutability trigger, so disable it here —
    // the production path can never do this, which is the point.
    await client.query('ALTER TABLE admission_decision DISABLE TRIGGER admission_decision_frozen');
    await client.query(
      `UPDATE admission_decision SET decided_at = now() - make_interval(days => $2::int)
        WHERE id = $1`,
      [decisionId, days],
    );
    await client.query('ALTER TABLE admission_decision ENABLE TRIGGER admission_decision_frozen');
  } finally {
    await client.end();
  }
}
