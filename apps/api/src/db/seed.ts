/**
 * A demo school, so the app has something real to show.
 *
 * Deliberately NOT a fixture: this runs as the owner and writes the same shapes
 * the product does, so what you see on screen is what the services would have
 * produced. The one thing it does differently is create users and role grants
 * directly, because there is no self-service signup yet.
 *
 * Idempotent: running it twice leaves one school, not two. `npm run db:seed`
 * after every migration is meant to be a habit, and a habit that duplicates data
 * gets abandoned.
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { loadDotenv } from '../config/load-dotenv.ts';

loadDotenv();

const OWNER_URL = process.env['DATABASE_OWNER_URL'];
if (!OWNER_URL) {
  console.error('DATABASE_OWNER_URL is not set.');
  process.exit(1);
}

const PASSWORD = 'demo-password-1234';
const ORG_NAME = 'Demo Vidyalaya';

async function main(): Promise<void> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();

  try {
    await c.query('BEGIN');

    const existing = await c.query<{ id: string }>(
      'SELECT id FROM organization WHERE display_name = $1', [ORG_NAME],
    );
    if (existing.rows[0]) {
      console.log(`${ORG_NAME} already exists. Nothing to do.`);
      console.log(`  tenantId: ${existing.rows[0].id}`);
      await printLogins(c, existing.rows[0].id);
      await c.query('COMMIT');
      return;
    }

    const org = await one<{ id: string }>(c,
      `INSERT INTO organization (legal_name, display_name, country)
       VALUES ('Demo Vidyalaya Trust', $1, 'IN') RETURNING id`,
      [ORG_NAME]);
    const tenantId = org.id;

    const campus = await one<{ id: string }>(c,
      `INSERT INTO campus (tenant_id, code, name, is_primary)
       VALUES ($1, 'MAIN', 'Main Campus', true) RETURNING id`, [tenantId]);
    const unit = await one<{ id: string }>(c,
      `INSERT INTO academic_unit (tenant_id, campus_id, code, name, unit_type)
       VALUES ($1, $2, 'SCHOOL', 'Senior School', 'school') RETURNING id`,
      [tenantId, campus.id]);

    const year = await one<{ id: string }>(c,
      `INSERT INTO academic_year (tenant_id, academic_unit_id, label, starts_on, ends_on, status)
       VALUES ($1, $2, '2026-27', '2026-04-01', '2027-03-31', 'active') RETURNING id`,
      [tenantId, unit.id]);
    const term1 = await one<{ id: string }>(c,
      `INSERT INTO term (tenant_id, academic_year_id, label, sequence, starts_on, ends_on)
       VALUES ($1, $2, 'Term 1', 1, '2026-04-01', '2026-09-30') RETURNING id`,
      [tenantId, year.id]);
    await c.query(
      `INSERT INTO term (tenant_id, academic_year_id, label, sequence, starts_on, ends_on)
       VALUES ($1, $2, 'Term 2', 2, '2026-10-01', '2027-03-31')`,
      [tenantId, year.id]);

    const programme = await one<{ id: string }>(c,
      `INSERT INTO programme (tenant_id, academic_unit_id, code, name, credential_type)
       VALUES ($1, $2, 'CBSE-SR', 'CBSE Senior Secondary', 'board_examination') RETURNING id`,
      [tenantId, unit.id]);
    const subject = await one<{ id: string }>(c,
      `INSERT INTO subject (tenant_id, academic_unit_id, code, name, subject_type)
       VALUES ($1, $2, 'MATH', 'Mathematics', 'core') RETURNING id`, [tenantId, unit.id]);

    // Two class groups, two sections each — enough for a dashboard to look like
    // a school rather than a unit test.
    const sections: Array<{ id: string; label: string }> = [];
    const offerings: Array<{ id: string; className: string; termId: string }> = [];
    for (const className of ['Class IX', 'Class X']) {
      const cg = await one<{ id: string }>(c,
        `INSERT INTO class_group (tenant_id, programme_id, academic_year_id, name, level_sequence)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tenantId, programme.id, year.id, className,
         className === 'Class IX' ? 9 : 10]);
      for (const sectionName of ['A', 'B']) {
        const sec = await one<{ id: string }>(c,
          `INSERT INTO section (tenant_id, class_group_id, name, capacity)
           VALUES ($1, $2, $3, 40) RETURNING id`,
          [tenantId, cg.id, sectionName]);
        sections.push({ id: sec.id, label: `${className} ${sectionName}` });
      }
      const offering = await one<{ id: string }>(c,
        `INSERT INTO course_offering
           (tenant_id, class_group_id, subject_id, term_id) VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [tenantId, cg.id, subject.id, term1.id]);
      offerings.push({ id: offering.id, className, termId: term1.id });
    }

    // Staff.
    const teacherPerson = await one<{ id: string }>(c,
      `INSERT INTO person (tenant_id, given_name, family_name)
       VALUES ($1, 'Meera', 'Nair') RETURNING id`, [tenantId]);
    const teacherStaff = await one<{ id: string }>(c,
      `INSERT INTO staff (tenant_id, person_id, campus_id, employee_code, designation, joined_on)
       VALUES ($1, $2, $3, 'EMP-001', 'Class Teacher', '2020-06-01') RETURNING id`,
      [tenantId, teacherPerson.id, campus.id]);
    const bursarPerson = await one<{ id: string }>(c,
      `INSERT INTO person (tenant_id, given_name, family_name)
       VALUES ($1, 'Raj', 'Sharma') RETURNING id`, [tenantId]);
    await c.query(
      `INSERT INTO staff (tenant_id, person_id, campus_id, employee_code, designation, joined_on)
       VALUES ($1, $2, $3, 'EMP-002', 'Accountant', '2021-04-01')`,
      [tenantId, bursarPerson.id, campus.id]);

    // Learners, spread across the sections, each with a guardian.
    // Names that read as names. The index used to be appended to the given
    // name — "Aarav1 Kumar" — which is fine until a demo screenshot shows a
    // support thread and the parent looks like a database artefact. Uniqueness
    // comes from the admission number, which is where it belongs.
    const givenNames = ['Aarav', 'Diya', 'Kabir', 'Ishaan', 'Anaya', 'Vihaan',
      'Myra', 'Reyansh', 'Saanvi', 'Arjun', 'Aadhya', 'Vivaan'];
    const familyNames = ['Kumar', 'Sharma', 'Nair', 'Reddy', 'Iyer', 'Banerjee',
      'Patel', 'Joshi', 'Rao', 'Gupta'];
    const guardianNames = ['Sunita', 'Rajesh', 'Lakshmi', 'Manoj', 'Fatima',
      'Deepak', 'Kavita', 'Imran', 'Shalini', 'Arun', 'Nisha'];
    const enrollments: Array<{ id: string; sectionId: string }> = [];
    const studentIds: string[] = [];

    for (let i = 0; i < 40; i++) {
      const section = sections[i % sections.length]!;
      const person = await one<{ id: string }>(c,
        `INSERT INTO person (tenant_id, given_name, family_name, date_of_birth)
         VALUES ($1, $2, $3, $4::date) RETURNING id`,
        [tenantId, givenNames[i % givenNames.length],
         familyNames[(i * 7) % familyNames.length],
         `201${(i % 4) + 1}-0${(i % 9) + 1}-1${i % 9}`]);
      // lifecycle_status, explicitly. The column defaults to 'enquiry' — right
      // for the admissions funnel, wrong for forty children who are in sections
      // with attendance and invoices. The demo ran for ten milestones with every
      // learner sitting in 'enquiry', which nothing read until M16 started
      // metering billable learners and M20 filtered a bus manifest by it: the
      // school metered as zero learners and the driver's list came back empty.
      const student = await one<{ id: string }>(c,
        `INSERT INTO student (tenant_id, person_id, admission_no, lifecycle_status)
         VALUES ($1, $2, $3, 'enrolled') RETURNING id`,
        [tenantId, person.id, `DEMO-${String(i + 1).padStart(4, '0')}`]);
      const enrollment = await one<{ id: string }>(c,
        `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId, student.id, section.id, year.id]);
      enrollments.push({ id: enrollment.id, sectionId: section.id });
      studentIds.push(student.id);

      // The guardian shares the learner's family name, as a parent usually
      // does. "Guardian1 Kumar" was the same index-suffix artefact the learner
      // names had, and it shows up on the messages screen where the whole point
      // is that a real person was or was not written to.
      const guardianPerson = await one<{ id: string }>(c,
        `INSERT INTO person (tenant_id, given_name, family_name)
         VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, guardianNames[i % guardianNames.length],
         familyNames[(i * 7) % familyNames.length]]);
      await c.query(
        `INSERT INTO guardian_link (tenant_id, student_id, guardian_person_id, relationship,
                                    is_primary, can_view_academics, can_view_finance, can_pay)
         VALUES ($1, $2, $3, 'mother', true, true, true, true)`,
        [tenantId, student.id, guardianPerson.id]);
      await c.query(
        `INSERT INTO contact_method (tenant_id, person_id, kind, value, is_primary, opt_in_state)
         VALUES ($1, $2, 'phone', $3, true, 'opted_in')`,
        [tenantId, guardianPerson.id, `+9198765${String(10000 + i).padStart(5, '0')}`]);
    }

    // Attendance for the last four school weeks, not just today. A sparkline
    // drawn over one data point is a dot, and a dashboard that only ever has
    // today's figure cannot show a trend — which is most of what a principal
    // opens it for.
    const firstSection = sections[0]!;
    const sectionRoll = enrollments.filter((x) => x.sectionId === firstSection.id);
    const days: string[] = [];
    for (let back = 27; back >= 0; back--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - back);
      // Sunday is a holiday; Saturday is a half day in most Indian schools and
      // still has a register.
      if (d.getUTCDay() === 0) continue;
      days.push(d.toISOString().slice(0, 10));
    }

    for (const [index, day] of days.entries()) {
      const session = await one<{ id: string }>(c,
        `INSERT INTO attendance_session
           (tenant_id, section_id, academic_year_id, session_date, mode, status,
            submitted_at, marked_by_staff_id)
         VALUES ($1, $2, $3, $4::date, 'day', 'submitted', now(), $5) RETURNING id`,
        [tenantId, firstSection.id, year.id, day, teacherStaff.id]);

      for (const [seat, e] of sectionRoll.entries()) {
        // A deterministic pattern rather than random: re-running the seed on a
        // colleague's machine should produce the same chart, or "it looks
        // different on mine" becomes a bug report.
        const absent = (seat + index * 3) % 11 === 0;
        const late = !absent && (seat + index * 5) % 17 === 0;
        await c.query(
          `INSERT INTO attendance_record
             (tenant_id, attendance_session_id, enrollment_id, state, minutes_late,
              client_event_id, recorded_by_staff_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [tenantId, session.id, e.id,
           absent ? 'absent' : late ? 'late' : 'present',
           late ? 10 : null, randomUUID(), teacherStaff.id]);
      }
    }

    // Fees: one plan, assigned to everyone, one instalment invoiced. A couple
    // are paid so the dashboard shows collection as well as billing.
    // Draft first, components, THEN publish — the order the product enforces. A
    // published plan's components are frozen, so seeding it the other way round
    // is refused by the same trigger that protects a real school's fees.
    const plan = await one<{ id: string }>(c,
      `INSERT INTO fee_plan (tenant_id, academic_unit_id, academic_year_id, name)
       VALUES ($1, $2, $3, 'Annual fees 2026-27') RETURNING id`,
      [tenantId, unit.id, year.id]);
    await c.query(
      `INSERT INTO fee_component (tenant_id, fee_plan_id, code, name, amount, frequency)
       VALUES ($1, $2, 'TUITION', 'Tuition', 30000.00, 'annual'),
              ($1, $2, 'LAB', 'Laboratory', 3000.00, 'annual')`,
      [tenantId, plan.id]);
    await c.query(
      `UPDATE fee_plan SET status = 'published', published_at = now(), published_by = $2
        WHERE id = $1`,
      [plan.id, teacherStaff.id]);

    let invoiceNo = 0;
    for (const e of enrollments.slice(0, 24)) {
      const assignment = await one<{ id: string }>(c,
        `INSERT INTO fee_assignment (tenant_id, enrollment_id, fee_plan_id)
         VALUES ($1, $2, $3) RETURNING id`, [tenantId, e.id, plan.id]);
      const instalment = await one<{ id: string }>(c,
        `INSERT INTO installment
           (tenant_id, fee_assignment_id, sequence, due_on, gross_amount,
            concession_amount, net_amount, status)
         VALUES ($1, $2, 1, '2026-06-10', 33000.00, 0, 33000.00, 'invoiced')
         RETURNING id`, [tenantId, assignment.id]);
      invoiceNo += 1;
      const invoice = await one<{ id: string }>(c,
        `INSERT INTO invoice
           (tenant_id, campus_id, installment_id, enrollment_id, invoice_no, financial_year,
            due_on, subtotal, discount_total, tax_total, total)
         VALUES ($1, $2, $3, $4, $5, '2026-27', '2026-06-10',
                 33000.00, 0, 0, 33000.00)
         RETURNING id`,
        [tenantId, campus.id, instalment.id, e.id,
         `INV-${String(invoiceNo).padStart(6, '0')}`]);

      if (invoiceNo % 3 === 0) {
        await c.query(
          `UPDATE invoice SET amount_paid = 33000.00, status = 'paid' WHERE id = $1`,
          [invoice.id]);

        // A payment and a receipt, dated across the window, so "collected" has a
        // shape over time rather than a single spike on the day of the seed.
        const paidOn = days[(invoiceNo * 5) % days.length] ?? days[0]!;
        const payment = await one<{ id: string }>(c,
          `INSERT INTO payment
             (tenant_id, campus_id, method, amount, received_on, status,
              idempotency_key, target_invoice_id)
           VALUES ($1, $2, 'cash', 33000.00, $3::date, 'succeeded', $4, $5)
           RETURNING id`,
          [tenantId, campus.id, paidOn, `seed-${invoiceNo}`, invoice.id]);
        await c.query(
          `INSERT INTO payment_allocation (tenant_id, payment_id, invoice_id, amount)
           VALUES ($1, $2, $3, 33000.00)`,
          [tenantId, payment.id, invoice.id]);
        await c.query(
          `INSERT INTO receipt
             (tenant_id, campus_id, payment_id, receipt_no, financial_year, amount, issued_on)
           VALUES ($1, $2, $3, $4, '2026-27', 33000.00, $5::date)`,
          [tenantId, campus.id, payment.id,
           `RCP-${String(invoiceNo).padStart(6, '0')}`, paidOn]);
      }
    }

    // Users. Passwords are hashed with the same algorithm the login path uses,
    // so these accounts go through the real authentication rather than a bypass.
    // The product's own hasher, not a local copy of the parameters: a seeded
    // account that cannot log in through the real path is worse than no seed.
    let demoCredential = '';
    const { passwordService } = await import('../modules/auth/password.service.ts');
    const passwordHash = await passwordService.hash(PASSWORD);
    const users: Array<[string, string, string, string | null]> = [
      ['principal@demo.school', 'ORG_OWNER', 'organization', null],
      ['teacher@demo.school', 'TEACHER', 'campus', campus.id],
      ['accounts@demo.school', 'ACCOUNTANT', 'campus', campus.id],
      // The driver is here because M20's whole claim is that this account sees
      // the children on their route and nothing else. A demo that cannot sign
      // in as the driver cannot show it.
      ['driver@demo.school', 'TRANSPORT', 'campus', campus.id],
      // And a parent, for the same reason. M21 built a whole app for an
      // account type that had no way to sign in to the demo, which is a
      // feature nobody can look at.
      ['parent@demo.school', 'GUARDIAN', 'self', campus.id],
    ];
    let driverUserId = '';
    let parentUserId = '';
    let ownerUserId = '';
    // The staff row behind teacher@demo.school, not Meera's. M28's screens all
    // key on `app_current_staff_id()`, so classwork seeded against a teacher
    // nobody can sign in as is classwork nobody can look at — the same mistake
    // the driver login was added to fix in M20.
    let signedInTeacherStaffId = '';
    for (const [email, role, scopeType, scopeId] of users) {
      const user = await one<{ id: string }>(c,
        `INSERT INTO user_account (login_email, password_hash, status)
         VALUES ($1, $2, 'active') RETURNING id`, [email, passwordHash]);
      if (role === 'ORG_OWNER') ownerUserId = user.id;
      if (role === 'TRANSPORT') driverUserId = user.id;
      if (role === 'GUARDIAN') parentUserId = user.id;
      await c.query(
        `INSERT INTO role_grant (tenant_id, user_account_id, role, scope_type, scope_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, user.id, role, scopeType, scopeId]);

      // A parent is not staff, so the person and the links are made further
      // down with the guardian links, not here. The grant above still happens:
      // skipping it — which the first version of this did — produced an
      // account that existed and could not sign in, because login resolves a
      // role in the tenant and there was none.
      if (role === 'GUARDIAN') continue;

      // Every login is a PERSON as well as an account.
      //
      // An earlier seed created these three accounts with no person row, and
      // everything worked until a support reply — which is attributed to a
      // person, because a ticket thread is a conversation between people rather
      // than between rows in an auth table. The staff member then got "this
      // account is not linked to a person" on a screen that had shown them the
      // ticket perfectly well. The schema was right; the seed was not.
      const person = await one<{ id: string }>(c,
        `INSERT INTO person (tenant_id, given_name, family_name, user_account_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId,
         role === 'ORG_OWNER' ? 'Anjali' : role === 'TEACHER' ? 'Suresh'
           : role === 'TRANSPORT' ? 'Ramesh' : 'Priya',
         role === 'ORG_OWNER' ? 'Menon' : role === 'TEACHER' ? 'Iyer'
           : role === 'TRANSPORT' ? 'Yadav' : 'Desai',
         user.id]);
      const staffRow = await one<{ id: string }>(c,
        `INSERT INTO staff (tenant_id, person_id, campus_id, employee_code,
                            designation, joined_on)
         VALUES ($1, $2, $3, $4, $5, '2021-04-01') RETURNING id`,
        [tenantId, person.id, campus.id,
         `EMP-1${role === 'ORG_OWNER' ? '01' : role === 'TEACHER' ? '02'
           : role === 'TRANSPORT' ? '04' : '03'}`,
         role === 'ORG_OWNER' ? 'Principal' : role === 'TEACHER' ? 'Teacher'
           : role === 'TRANSPORT' ? 'Driver' : 'Accountant']);
      if (role === 'TEACHER') signedInTeacherStaffId = staffRow.id;
    }

    // The demo parent becomes the guardian of the first two learners, so the
    // parent app has a family with more than one child in it.
    //
    // Here rather than further down, and that ordering is load-bearing: the
    // message seeding below reads guardian_link to pick recipients, so a
    // parent created after it is a parent nothing was ever sent to — and the
    // parent app's messages tab is then permanently empty in the one place
    // anybody looks at it.
    const demoParentPerson = await one<{ id: string }>(c,
      `INSERT INTO person (tenant_id, given_name, family_name, user_account_id)
       VALUES ($1, 'Kavita', 'Kumar', $2) RETURNING id`,
      [tenantId, parentUserId]);
    await c.query(
      `INSERT INTO contact_method (tenant_id, person_id, kind, value, is_primary,
                                   opt_in_state)
       VALUES ($1, $2, 'phone', '+919845000100', true, 'opted_in')`,
      [tenantId, demoParentPerson.id]);
    for (const [i, studentId] of studentIds.slice(0, 2).entries()) {
      await c.query(
        `INSERT INTO guardian_link (tenant_id, student_id, guardian_person_id,
                                    relationship, is_primary, can_view_academics,
                                    can_view_finance, can_pay)
         VALUES ($1, $2, $3, 'mother', false, true, $4, $4)`,
        // Not primary: each child already has a primary guardian from the loop
        // above, and a child has one. This is the second parent — which is the
        // more interesting account anyway, because finance is on for the first
        // child and off for the second. The permission is per link, and a demo
        // where both are the same proves nothing about that.
        [tenantId, studentId, demoParentPerson.id, i === 0]);
    }

    // --- an integration, so the Integrations screen has something real on it ---
    // The credential is printed at the end; it exists nowhere else afterwards.
    //
    // The endpoint points at a documentation-range address that will never
    // answer, which is the point: the delivery log is most useful when it shows
    // a FAILURE, and a seed where everything succeeded teaches nobody what the
    // screen is for.
    const client = await one<{ id: string }>(c,
      `INSERT INTO api_client (tenant_id, name, description, scopes, created_by)
       VALUES ($1, 'Accounting sync', 'Reads invoices into the accounts package',
               ARRAY['invoices:read','payments:read','students:read']::text[], $2)
       RETURNING id`, [tenantId, ownerUserId]);

    // Issued through the real function, with the tenant and actor set the way a
    // request sets them. A seed that hand-inserted the rows would not prove the
    // issuing path works, and this is the one credential anybody will actually
    // try to curl with.
    await c.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    await c.query('SELECT set_config($1, $2, true)', ['app.actor_id', ownerUserId]);
    const issued = await one<{ prefix: string; secret: string }>(c,
      `SELECT prefix, secret FROM api_key_issue($1, 'Seeded demo key', NULL, false)`,
      [client.id]);
    demoCredential = `${issued.prefix}.${issued.secret}`;

    const endpoint = await one<{ id: string }>(c,
      `INSERT INTO webhook_endpoint
         (tenant_id, url, description, event_types, signing_secret, created_by)
       VALUES ($1, 'https://203.0.113.10/paathshala-hook',
               'Demo receiver (never answers, on purpose)',
               ARRAY['invoice.issued','payment.received']::text[],
               'whsec_' || encode(gen_random_bytes(32), 'hex'), $2)
       RETURNING id`, [tenantId, ownerUserId]);

    for (const [type, payload] of [
      ['invoice.issued', { invoice_no: 'DEMO/2026/0001', total: '12500.00' }],
      ['payment.received', { receipt_no: 'RCPT/2026/0001', amount: '12500.00' }],
    ] as const) {
      const event = await one<{ id: string }>(c,
        `INSERT INTO outbox_event (tenant_id, event_type, aggregate_type, payload, published_at)
         VALUES ($1, $2, 'demo', $3::jsonb, now()) RETURNING id`,
        [tenantId, type, JSON.stringify(payload)]);
      const delivery = await one<{ id: string }>(c,
        `INSERT INTO webhook_delivery
           (tenant_id, webhook_endpoint_id, outbox_event_id, event_type, payload,
            status, attempt_count, last_error)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'dead', 8, 'HTTP no response')
         RETURNING id`,
        [tenantId, endpoint.id, event.id, type,
         JSON.stringify({ type, data: payload })]);
      for (let n = 1; n <= 8; n += 1) {
        await c.query(
          `INSERT INTO webhook_attempt
             (tenant_id, webhook_delivery_id, attempt_no, duration_ms, error)
           VALUES ($1, $2, $3, 10000, 'The operation was aborted due to timeout')`,
          [tenantId, delivery.id, n]);
      }
    }

    // --- help articles and one live ticket -------------------------------
    //
    // Two articles and a ticket that is awaiting a reply, so the support
    // screens show a queue rather than an empty state. The ticket is
    // deliberately past its first-response deadline: an empty support inbox
    // teaches nobody what the breach column is for.
    const parentPerson = await one<{ id: string }>(c,
      `SELECT p.id FROM person p JOIN student s ON s.person_id = p.id
        WHERE p.tenant_id = $1 LIMIT 1`, [tenantId]);

    for (const [slug, title, audience, body] of [
      ['paying-fees-online', 'Paying fees online', 'guardians',
       'Open **Fees**, choose the invoice, then **Pay now**. '
       + 'A receipt is issued the moment the payment settles — you do not need '
       + 'to send us the screenshot.'],
      ['marking-attendance', 'Marking attendance on your phone', 'staff',
       'Open **Attendance**, pick your section, mark the register and press '
       + '**Submit**. It works offline; marks sync when you are back on a '
       + 'network, and the time recorded is the time you marked, not the time '
       + 'it synced.'],
      ['voiding-an-invoice', 'Voiding an invoice', 'staff',
       'An issued invoice is never deleted — it is voided, with a reason, and '
       + 'the number stays in the sequence. An auditor asks about gaps.'],
    ] as const) {
      const art = await one<{ id: string }>(c,
        `INSERT INTO kb_article (tenant_id, slug, title, audience, status,
                                 published_version, created_by)
         VALUES ($1, $2, $3, $4, 'published', 1, $5) RETURNING id`,
        [tenantId, slug, title, audience, ownerUserId]);
      await c.query(
        `INSERT INTO kb_article_version
           (tenant_id, kb_article_id, version, title, body, written_by)
         VALUES ($1, $2, 1, $3, $4, $5)`,
        [tenantId, art.id, title, body, ownerUserId]);
    }

    const ticket = await one<{ id: string }>(c,
      `INSERT INTO support_ticket
         (tenant_id, reference, raised_by_person_id, subject, category, priority,
          first_response_due_at, resolution_due_at, created_at)
       VALUES ($1, 'TKT-' || to_char(now(), 'YYYY') || '-00001', $2,
               'Fee receipt not received', 'fees_and_payments', 'high',
               now() - interval '2 hours', now() + interval '46 hours',
               now() - interval '10 hours')
       RETURNING id`, [tenantId, parentPerson.id]);
    await c.query(
      `INSERT INTO ticket_message (tenant_id, ticket_id, author_person_id, body, created_at)
       VALUES ($1, $2, $3, 'I paid on the 3rd by UPI but no receipt has arrived.',
               now() - interval '10 hours')`,
      [tenantId, ticket.id, parentPerson.id]);
    await c.query(
      `INSERT INTO ticket_event (tenant_id, ticket_id, actor_person_id, kind, occurred_at)
       VALUES ($1, $2, $3, 'created', now() - interval '10 hours')`,
      [tenantId, ticket.id, parentPerson.id]);

    // --- results, messages and imports ------------------------------------
    //
    // Three milestones' worth of backend that had no screen until M13, and
    // therefore no seed data. Each of these is shaped to show the thing the
    // feature exists for rather than a happy path: a result run that is
    // computed but NOT published, messages that were deliberately withheld with
    // their reasons, and an import whose preview and apply agree.

    // These columns reference `staff`, not `user_account` — a scale is
    // published by a member of staff, and the two ids are not interchangeable.
    const ownerStaff = await one<{ id: string }>(c,
      `SELECT st.id FROM staff st
         JOIN person p ON p.id = st.person_id
        WHERE p.user_account_id = $1 AND st.tenant_id = $2 LIMIT 1`,
      [ownerUserId, tenantId]);

    const scale = await one<{ id: string }>(c,
      `INSERT INTO grading_scale (tenant_id, academic_unit_id, name, kind,
                                  is_published, published_at, published_by)
       VALUES ($1, $2, 'CBSE 2026-27', 'percentage', true, now(), $3) RETURNING id`,
      [tenantId, unit.id, ownerStaff.id]);

    const resultSection = sections[0]!;
    const run = await one<{ id: string }>(c,
      `INSERT INTO result_run
         (tenant_id, academic_year_id, term_id, section_id, grading_scale_id,
          inputs_digest, status, computed_at, computed_by)
       VALUES ($1, $2, $3, $4, $5,
               encode(digest('demo-seed-inputs', 'sha256'), 'hex'),
               'computed', now() - interval '2 hours', $6)
       RETURNING id`,
      [tenantId, year.id, term1.id, resultSection.id, scale.id, ownerStaff.id]);

    const sectionEnrollments = enrollments
      .filter((e) => e.sectionId === resultSection.id).slice(0, 10);
    for (const [i, enrollment] of sectionEnrollments.entries()) {
      // One learner has no marks at all. That row exists and says why, because
      // a missing row is indistinguishable from a learner nobody noticed.
      const absent = i === 3;
      const pct = 42 + ((i * 7) % 55);
      await c.query(
        `INSERT INTO result_line
           (tenant_id, result_run_id, enrollment_id, obtained, maximum,
            percentage, grade_label, grade_point, is_pass, not_graded_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [tenantId, run.id, enrollment.id,
         absent ? null : pct, absent ? null : 100,
         absent ? null : pct,
         absent ? null : pct >= 90 ? 'A1' : pct >= 75 ? 'B1' : pct >= 60 ? 'C1' : pct >= 33 ? 'D' : 'E',
         absent ? null : Math.max(1, Math.round(pct / 10)),
         absent ? null : pct >= 33,
         absent ? 'No marks recorded — absent for the assessment' : null]);
    }

    const template = await one<{ id: string }>(c,
      `INSERT INTO message_template (tenant_id, code, name, purpose)
       VALUES ($1, 'ATT_ABSENT_V1', 'Absence notice', 'attendance_notifications')
       RETURNING id`, [tenantId]);

    const request = await one<{ id: string }>(c,
      `INSERT INTO message_request
         (tenant_id, campus_id, message_template_id, purpose, source_type,
          idempotency_key, status, requested_by, created_at)
       VALUES ($1, $2, $3, 'attendance_notifications', 'attendance_session',
               'demo-seed-' || gen_random_uuid(), 'completed', $4,
               now() - interval '5 hours')
       RETURNING id`, [tenantId, campus.id, template.id, ownerStaff.id]);

    // The demo parent first, deliberately. They are the only guardian who can
    // sign in, so a list that happened to exclude them would leave the parent
    // app's messages tab permanently empty in the one place anybody looks at
    // it — a screen that is only ever seen blank is a screen nobody reviews.
    // DISTINCT on the person, not on the link. The demo parent is guardian to
    // two children, so the un-distinct version returned them twice and the
    // second insert collided on message_recipient_one_per_subject — a
    // constraint doing exactly its job, which is to stop one announcement
    // reaching one person twice.
    const guardianPeople = await c.query<{ id: string; given_name: string }>(
      `SELECT DISTINCT ON (p.id) p.id, p.given_name,
              (p.user_account_id IS NOT NULL) AS signs_in, p.created_at
         FROM guardian_link gl JOIN person p ON p.id = gl.guardian_person_id
        WHERE gl.tenant_id = $1
        ORDER BY p.id`, [tenantId]);
    // The parent who can actually sign in goes first, so the app's messages
    // tab has something on it in the one place anybody reviews it.
    guardianPeople.rows.sort((a, b) =>
      Number((b as unknown as { signs_in: boolean }).signs_in)
      - Number((a as unknown as { signs_in: boolean }).signs_in));
    guardianPeople.rows = guardianPeople.rows.slice(0, 6);

    // A spread that shows the screen's point: most delivered, one failed, and
    // two withheld for different reasons — which is what AC-8 is about.
    const outcomes: Array<[string, string | null, string | null]> = [
      ['delivered', null, 'whatsapp'],
      ['delivered', null, 'whatsapp'],
      ['sent', null, 'sms'],
      ['failed', null, 'sms'],
      ['suppressed', 'no_consent_for_purpose', null],
      ['suppressed', 'no_contact_for_channel', null],
    ];
    for (const [i, person] of guardianPeople.rows.entries()) {
      const [status, reason, channel] = outcomes[i % outcomes.length]!;
      await c.query(
        `INSERT INTO message_recipient
           (tenant_id, message_request_id, person_id, channel, locale,
            rendered_body, status, suppression_reason, created_at)
         VALUES ($1, $2, $3, $4, 'en-IN', $5, $6, $7, now() - interval '5 hours')`,
        [tenantId, request.id, person.id, channel,
         status === 'suppressed'
           ? null
           : 'Your child was marked absent today. Please contact the school office.',
         status, reason]);
    }

    await c.query(
      `INSERT INTO import_batch
         (tenant_id, campus_id, entity, original_filename, source_sha256,
          status, plan_digest, preview_counts, applied_counts,
          uploaded_by, applied_by, created_at, validated_at, previewed_at, applied_at)
       VALUES ($1, $2, 'learner_roster', 'class-9-roster.csv',
               encode(digest('demo-roster', 'sha256'), 'hex'),
               'applied', encode(digest('demo-plan', 'sha256'), 'hex'),
               '{"total": 41, "valid": 40, "invalid": 1}'::jsonb,
               '{"created": 40, "updated": 0, "skipped": 1}'::jsonb,
               $3, $3, now() - interval '3 days', now() - interval '3 days',
               now() - interval '3 days', now() - interval '3 days')`,
      [tenantId, campus.id, ownerStaff.id]);

    // --- an address and a brand ---------------------------------------------
    //
    // M19 made the web app resolve the school from the host it was reached on
    // and deleted NEXT_PUBLIC_TENANT_ID. This seed was not updated with it, so
    // a fresh clone reached a sign-in screen that said "no school is registered
    // at this address" and stopped there — the whole demo, unreachable, because
    // the school existed and its address did not.
    //
    // Verified immediately, unlike a custom domain: a managed subdomain is ours
    // to allocate, so there is nothing to prove.
    await c.query(
      `INSERT INTO tenant_domain (tenant_id, host, kind, is_primary, verified_at)
       VALUES ($1, $2, 'managed', true, now())`,
      [tenantId, `demo.${process.env['PAATHSHALA_DOMAIN'] ?? 'paathshala.app'}`]);

    // Deliberately NOT our teal. A demo that renders in the vendor's colours
    // proves nothing about white-labelling; this one is recognisably somebody
    // else's school.
    await c.query(
      `INSERT INTO tenant_branding (tenant_id, app_name, primary_colour, ink_colour,
                                    support_email, support_phone)
       VALUES ($1, 'Demo Vidyalaya', '#B45309', '#1C1917',
               'office@demo.school', '+91 80 4000 1234')`,
      [tenantId]);

    // --- transport ---------------------------------------------------------
    //
    // Shaped to show what M20 is about rather than a happy path: two routes, so
    // "only your route" has something to fail against; a bus whose insurance
    // has already lapsed, because the compliance screen exists for the day
    // somebody has stopped noticing; and one child marked as not at their stop,
    // which is the row a transport office actually acts on.

    const driverPerson = await one<{ id: string }>(c,
      `SELECT id FROM person WHERE user_account_id = $1 AND tenant_id = $2`,
      [driverUserId, tenantId]);

    const demoDriver = await one<{ id: string }>(c,
      `INSERT INTO driver (tenant_id, person_id, licence_number, licence_expires_on,
                           background_checked_on)
       VALUES ($1, $2, 'KA-2019-0044821', CURRENT_DATE + 380, CURRENT_DATE - 300)
       RETURNING id`, [tenantId, driverPerson.id]);

    const busOne = await one<{ id: string }>(c,
      `INSERT INTO vehicle (tenant_id, campus_id, registration, display_name, capacity,
                            fitness_expires_on, insurance_expires_on, permit_expires_on)
       VALUES ($1, $2, 'KA 01 MJ 4412', 'Bus 1', 42,
               CURRENT_DATE + 26, CURRENT_DATE - 4, CURRENT_DATE + 190)
       RETURNING id`, [tenantId, campus.id]);

    const busTwo = await one<{ id: string }>(c,
      `INSERT INTO vehicle (tenant_id, campus_id, registration, display_name, capacity,
                            fitness_expires_on, insurance_expires_on, permit_expires_on)
       VALUES ($1, $2, 'KA 01 MJ 7719', 'Bus 2', 36,
               CURRENT_DATE + 220, CURRENT_DATE + 150, CURRENT_DATE + 300)
       RETURNING id`, [tenantId, campus.id]);

    const routes: Array<{ id: string; stops: string[] }> = [];
    const routePlan: Array<[string, string, string[][]]> = [
      ['R1', 'Jayanagar loop',
        [['4th Block', '07:05', '15:45'], ['9th Main', '07:18', '15:32'],
         ['Ashoka Pillar', '07:31', '15:19']]],
      ['R2', 'Whitefield loop',
        [['ITPL gate', '06:52', '16:08'], ['Hope Farm', '07:09', '15:51']]],
    ];
    for (const [code, name, stops] of routePlan) {
      const route = await one<{ id: string }>(c,
        `INSERT INTO route (tenant_id, campus_id, code, name, direction)
         VALUES ($1, $2, $3, $4, 'both') RETURNING id`,
        [tenantId, campus.id, code, name]);
      const stopIds: string[] = [];
      for (const [i, stop] of stops.entries()) {
        const row = await one<{ id: string }>(c,
          `INSERT INTO route_stop (tenant_id, route_id, name, sequence_no,
                                   pickup_time, drop_time)
           VALUES ($1, $2, $3, $4, $5::time, $6::time) RETURNING id`,
          [tenantId, route.id, stop[0], i + 1, stop[1], stop[2]]);
        stopIds.push(row.id);
      }
      routes.push({ id: route.id, stops: stopIds });
    }

    // Only route 1 has a crew. Route 2 shows what an unassigned route looks
    // like on the screen, which is a state a transport office is often in.
    await c.query(
      `INSERT INTO route_assignment (tenant_id, route_id, vehicle_id, driver_id,
                                     effective_from)
       VALUES ($1, $2, $3, $4, CURRENT_DATE - 45)`,
      [tenantId, routes[0]!.id, busOne.id, demoDriver.id]);
    void busTwo;

    // Twelve of the forty ride a bus, which is about the real proportion.
    const riders = studentIds.slice(0, 12);
    for (const [i, studentId] of riders.entries()) {
      const route = routes[i < 8 ? 0 : 1]!;
      const stopId = route.stops[i % route.stops.length]!;
      await c.query(
        `INSERT INTO transport_enrolment
           (tenant_id, student_id, route_id, stop_id, direction, effective_from)
         VALUES ($1, $2, $3, $4, 'both', CURRENT_DATE - 40)`,
        [tenantId, studentId, route.id, stopId]);
    }

    // This morning's run on route 1, recorded the way the device would: an
    // event id per child, minted once. Six boarded, one was not at the stop.
    for (const [i, studentId] of riders.slice(0, 7).entries()) {
      await c.query(
        `INSERT INTO boarding_event
           (tenant_id, student_id, route_id, vehicle_id, on_date, direction, kind,
            client_event_id, device_recorded_at, recorded_by)
         VALUES ($1, $2, $3, $4, CURRENT_DATE, 'pickup', $5, $6,
                 CURRENT_DATE + time '07:14', $7)`,
        [tenantId, studentId, routes[0]!.id, busOne.id,
         i === 6 ? 'no_show' : 'boarded', randomUUID(), driverUserId]);
    }

    // ------------------------------------------------------------------- HR
    //
    // M27's tables, populated, because M32 gave them a screen and a screen
    // with nothing on it demonstrates nothing. The shape is the one an office
    // actually has on a Tuesday: a request nobody has decided, somebody
    // already away, and one of those two with no cover — which is the number
    // the Staff page is built around.
    const leaveTypes: Array<{ id: string; code: string }> = [];
    for (const [code, name, paid, days] of [
      ['CL', 'Casual leave', true, 12],
      ['SL', 'Sick leave', true, 10],
      ['LWP', 'Leave without pay', false, 0],
    ] as Array<[string, string, boolean, number]>) {
      const lt = await one<{ id: string }>(c,
        `INSERT INTO leave_type (tenant_id, code, name, is_paid, annual_entitlement)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tenantId, code, name, paid, days]);
      leaveTypes.push({ id: lt.id, code });
    }

    const allStaff = await c.query<{ id: string }>(
      `SELECT id FROM staff WHERE tenant_id = $1 ORDER BY employee_code`, [tenantId]);

    for (const st of allStaff.rows) {
      await c.query(
        `INSERT INTO staff_contract (tenant_id, staff_id, kind, weekly_hours, starts_on)
         VALUES ($1, $2, 'permanent', 40, '2021-04-01')`, [tenantId, st.id]);
      for (const lt of leaveTypes.filter((l) => l.code !== 'LWP')) {
        await c.query(
          `INSERT INTO leave_balance
             (tenant_id, staff_id, leave_type_id, year_label, opening, taken)
           VALUES ($1, $2, $3, '2026-27', $4, 0)`,
          [tenantId, st.id, lt.id, lt.code === 'CL' ? 12 : 10]);
      }
    }

    if (signedInTeacherStaffId && allStaff.rows.length > 1) {
      const casual = leaveTypes.find((l) => l.code === 'CL')!;
      const sick = leaveTypes.find((l) => l.code === 'SL')!;

      // Awaiting a decision.
      await c.query(
        `INSERT INTO staff_absence
           (tenant_id, staff_id, leave_type_id, starts_on, ends_on, reason)
         VALUES ($1, $2, $3, CURRENT_DATE + 9, CURRENT_DATE + 10,
                 'Sister''s wedding in Trichy')`,
        [tenantId, signedInTeacherStaffId, casual.id]);

      // Already away, today, with nobody covering — the gap the screen shouts
      // about. Approved directly because somebody rang in at eight; that is an
      // absence before it is a form, which is why `fileAbsence` allows it.
      const other = allStaff.rows.find((r) => r.id !== signedInTeacherStaffId)!;
      await c.query(
        `INSERT INTO staff_absence
           (tenant_id, staff_id, leave_type_id, starts_on, ends_on, status,
            decided_at, reason)
         VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE, 'approved', now(),
                 'Rang in with a fever')`,
        [tenantId, other.id, sick.id]);
      // And the balance, in the same breath — because that is what
      // `decideAbsence` does, and a demo where an approved absence has not
      // moved anybody's balance quietly contradicts the one promise that
      // service makes. Inserting the row raw skips the service; it must not
      // skip the consequence.
      await c.query(
        `UPDATE leave_balance SET taken = taken + 1, updated_at = now()
          WHERE tenant_id = $1 AND staff_id = $2 AND leave_type_id = $3`,
        [tenantId, other.id, sick.id]);
    }

    // ------------------------------------------------------------ classwork
    //
    // M28, in the demo, for the reason the driver and the parent logins exist:
    // a feature nobody can sign in and look at is a feature nobody checks.
    //
    // Three assignments, deliberately not three of a kind, because the
    // difference between them IS the design: one graded and marked, one graded
    // and still waiting, one that carries no marks at all. The first two have
    // an `assessment` behind them and their marks are in `mark`, where the
    // result run can see them; the third has neither and never will.
    const ninth = offerings.find((o) => o.className === 'Class IX');
    if (ninth && signedInTeacherStaffId) {
      await c.query(
        `UPDATE course_offering SET primary_teacher_staff_id = $2 WHERE id = $1`,
        [ninth.id, signedInTeacherStaffId]);

      for (const [i, [title, summary]] of ([
        ['Forces and motion', 'Newton\u2019s three laws, with the trolley demonstration'],
        ['Work, energy and power', 'Where the joule comes from'],
      ] as Array<[string, string]>).entries()) {
        await c.query(
          `INSERT INTO lesson (tenant_id, course_offering_id, academic_year_id,
                               title, summary, sequence_no, taught_on,
                               status, published_at, created_by_staff_id)
           VALUES ($1, $2, '00000000-0000-0000-0000-000000000000'::uuid,
                   $3, $4, $5, CURRENT_DATE - $6::int, 'published', now(), $7)`,
          [tenantId, ninth.id, title, summary, i + 1, (2 - i) * 7,
           signedInTeacherStaffId]);
      }

      // Class IX only. `enrollments` runs across all four sections, so taking
      // the first ten of it put Class X learners in a Class IX assignment —
      // rows the teacher of that class cannot see, which showed up on screen
      // as "4 handed in" under an assignment seeded with eight.
      const ninthSectionIds = new Set(
        sections.filter((sec) => sec.label.startsWith('Class IX')).map((sec) => sec.id));
      const ninthEnrolments = enrollments
        .filter((e) => ninthSectionIds.has(e.sectionId))
        .slice(0, 10);

      const assignmentsToSeed: Array<{
        title: string; instructions: string; dueDays: number;
        maxMarks: number | null; marked: boolean;
      }> = [
        { title: 'Newton II problem set', instructions: 'Questions 1 to 8, page 74.',
          dueDays: -6, maxMarks: 20, marked: true },
        { title: 'Energy conversions worksheet', instructions: 'One worked example each.',
          dueDays: 2, maxMarks: 15, marked: false },
        { title: 'Read chapter 5 before Friday', instructions: 'No submission needed.',
          dueDays: 4, maxMarks: null, marked: false },
      ];

      for (const spec of assignmentsToSeed) {
        let assessmentId: string | null = null;
        if (spec.maxMarks !== null) {
          const assessment = await one<{ id: string }>(c,
            `INSERT INTO assessment
               (tenant_id, course_offering_id, term_id, academic_year_id, name,
                kind, max_marks, weight_percent, status)
             VALUES ($1, $2, $3, '00000000-0000-0000-0000-000000000000'::uuid,
                     $4, 'assignment', $5, 5, 'open') RETURNING id`,
            [tenantId, ninth.id, ninth.termId, spec.title, spec.maxMarks]);
          assessmentId = assessment.id;
        }

        const assignment = await one<{ id: string }>(c,
          `INSERT INTO assignment
             (tenant_id, course_offering_id, academic_year_id, assessment_id,
              title, instructions, due_at, submission_kind, status, published_at,
              created_by_staff_id)
           VALUES ($1, $2, '00000000-0000-0000-0000-000000000000'::uuid, $3,
                   $4, $5, now() + ($6 || ' days')::interval, 'either',
                   'published', now(), $7) RETURNING id`,
          [tenantId, ninth.id, assessmentId, spec.title, spec.instructions,
           String(spec.dueDays), signedInTeacherStaffId]);

        if (spec.maxMarks === null) continue;

        // Eight of ten have handed it in. The two who have not are the whole
        // point of the parent's screen and of the teacher's waiting count.
        for (const [i, enrolment] of ninthEnrolments.slice(0, 8).entries()) {
          if (spec.marked) {
            await c.query(
              `INSERT INTO mark (tenant_id, assessment_id, enrollment_id,
                                 marks_obtained, entered_by_staff_id)
               VALUES ($1, $2, $3, $4::numeric, $5)`,
              [tenantId, assessmentId, enrolment.id,
               (spec.maxMarks - (i % 5)).toFixed(2), signedInTeacherStaffId]);
          }
          await c.query(
            `INSERT INTO submission
               (tenant_id, assignment_id, enrollment_id, student_id,
                course_offering_id, body_text, submitted_at, status,
                feedback, returned_at, returned_by_staff_id)
             VALUES ($1, $2, $3,
                     '00000000-0000-0000-0000-000000000000'::uuid,
                     '00000000-0000-0000-0000-000000000000'::uuid,
                     $4, now() - ($5 || ' days')::interval, $6, $7,
                     CASE WHEN $6 = 'returned' THEN now() END,
                     CASE WHEN $6 = 'returned' THEN $8::uuid END)`,
            [tenantId, assignment.id, enrolment.id,
             'Submitted through the parent app.', String(spec.marked ? 7 : 1),
             spec.marked ? 'returned' : 'submitted',
             spec.marked ? 'Show your working for question 6.' : null,
             signedInTeacherStaffId]);
        }
      }
    }

    await c.query('COMMIT');

    console.log('\nSeeded a demo school.\n');
    console.log(`  API key (test, shown once): ${demoCredential}`);
    console.log(`  tenantId: ${tenantId}`);
    console.log(`  40 learners, 4 sections, 24 invoices, today's attendance for one section`);
    console.log(`  2 bus routes, 12 riders, this morning's run recorded`);
    console.log(`  2 lessons and 3 assignments in Class IX, one already marked`);
    console.log(`  3 leave types, one request awaiting a decision, one teacher away\n`);
    await printLogins(c, tenantId);
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    await c.end();
  }
}

async function printLogins(c: pg.Client, tenantId: string): Promise<void> {
  console.log('  Sign in with:');
  for (const email of ['principal@demo.school', 'teacher@demo.school',
                       'accounts@demo.school', 'driver@demo.school',
                       'parent@demo.school']) {
    console.log(`    ${email.padEnd(24)} ${PASSWORD}`);
  }
  console.log(`\n  The web app finds the school by host. For local work, put this in`);
  console.log(`  apps/web/.env.local:\n`);
  console.log(`    NEXT_PUBLIC_BRAND_HOST=demo.${process.env['PAATHSHALA_DOMAIN'] ?? 'paathshala.app'}\n`);
  void tenantId;
}

async function one<T extends pg.QueryResultRow>(
  c: pg.Client, sql: string, params: unknown[],
): Promise<T> {
  const { rows } = await c.query<T>(sql, params);
  if (!rows[0]) throw new Error(`Expected a row from: ${sql.slice(0, 60)}...`);
  return rows[0];
}

main().catch((error: unknown) => {
  console.error('seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
