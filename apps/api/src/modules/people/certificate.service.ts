/**
 * Issuing a certificate onto the register (M47.6).
 *
 * The server writes the words. The page shows a preview built from the same
 * function (`certificate-text.ts` is the web's `lib/certificate.ts`, kept
 * identical by a test), but what is stored and printed is composed here, from
 * the record as the database holds it at that moment — so nobody can put a
 * sentence on the school's paper by editing a request.
 */
import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { auditService } from '../audit/audit.service.ts';
import { ApiError } from '../../common/errors.ts';
import { certificate, type CertificateKind } from './certificate-text.ts';
import { certificateNo } from './certificate-number.ts';

export interface IssuedCertificate {
  id: string; kind: CertificateKind; certificate_no: string;
  issued_on: string; purpose: string | null;
  title: string; paragraphs: string[];
  issued_by_name: string | null;
}

const ISSUED = `
  SELECT c.id, c.kind, c.certificate_no, c.issued_on::text, c.purpose,
         c.title, c.paragraphs,
         ip.given_name || COALESCE(' ' || ip.family_name, '') AS issued_by_name
    FROM certificate_issue c
    LEFT JOIN staff ist ON ist.id = c.issued_by
    LEFT JOIN person ip ON ip.id = ist.person_id`;

export const certificateService = {
  async listFor(scope: TenantScope, studentId: string): Promise<IssuedCertificate[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<IssuedCertificate>(
        `${ISSUED} WHERE c.student_id = $1 ORDER BY c.created_at DESC LIMIT 100`, [studentId]);
      return rows;
    });
  },

  async issue(scope: TenantScope, input: {
    studentId: string; kind: CertificateKind; purpose?: string | undefined;
  }): Promise<IssuedCertificate> {
    const issued = await withTenant(scope, async (db) => {
      const may = await db.query<{ ok: boolean; staff_id: string | null }>(
        `SELECT app_actor_may_issue_certificates() AS ok,
                app_current_staff_id() AS staff_id`);
      if (!may.rows[0]?.ok) {
        throw ApiError.make('permission_error', 'not_office',
          'Certificates are issued by the school office: the owner, an '
          + 'administrator or admissions.');
      }

      const found = await db.query<{
        given_name: string; family_name: string | null; date_of_birth: string | null;
        admission_no: string; lifecycle_status: string;
        class_name: string | null; section_name: string | null; year_label: string | null;
        guardian: string | null; school: string; today: string;
      }>(
        `SELECT p.given_name, p.family_name, p.date_of_birth::text AS date_of_birth,
                st.admission_no, st.lifecycle_status,
                place.class_name, place.section_name, place.year_label,
                (SELECT gp.given_name || COALESCE(' ' || gp.family_name, '')
                   FROM guardian_link gl JOIN person gp ON gp.id = gl.guardian_person_id
                  WHERE gl.student_id = st.id AND gl.effective_to IS NULL
                  ORDER BY gl.is_primary DESC, gl.relationship, gl.id LIMIT 1) AS guardian,
                o.display_name AS school,
                -- The school's day, not the server's: a certificate dated
                -- yesterday because it was issued before 5:30 a.m. UTC+5:30
                -- is a certificate with the wrong date on it.
                (now() AT TIME ZONE o.timezone)::date::text AS today
           FROM student st
           JOIN person p ON p.id = st.person_id
           JOIN organization o ON o.id = st.tenant_id
           LEFT JOIN LATERAL (
             SELECT cg.name AS class_name, sec.name AS section_name, ay.label AS year_label
               FROM enrollment e
               JOIN section sec ON sec.id = e.section_id
               LEFT JOIN class_group cg ON cg.id = sec.class_group_id
               JOIN academic_year ay ON ay.id = e.academic_year_id
              WHERE e.student_id = st.id
              -- Where they are now; failing that, where they last were.
              ORDER BY (e.status = 'active') DESC, e.enrolled_on DESC LIMIT 1
           ) place ON true
          WHERE st.id = $1`, [input.studentId]);
      const row = found.rows[0];
      if (!row) throw ApiError.make('not_found', 'student_not_found', 'Learner not found.');

      const doc = certificate({
        kind: input.kind,
        learnerName: [row.given_name, row.family_name].filter(Boolean).join(' '),
        admissionNo: row.admission_no,
        className: row.class_name, sectionName: row.section_name,
        dateOfBirth: row.date_of_birth, guardianName: row.guardian,
        yearLabel: row.year_label, schoolName: row.school,
        purpose: input.purpose ?? '', issuedOn: row.today,
        enrolled: row.lifecycle_status === 'enrolled',
      });
      if (doc.problems.length > 0) {
        throw ApiError.make('validation_error', 'certificate_cannot_be_issued',
          doc.problems.join(' '));
      }

      const yearLabel = row.year_label ?? row.today.slice(0, 4);
      const purpose = (input.purpose ?? '').replace(/\s+/g, ' ').trim() || null;

      // max + 1 under the unique index. Two clerks issuing at the same moment
      // collide on the index; the loser tries the next number.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await db.query('SAVEPOINT certificate_serial');
        try {
          const next = await db.query<{ serial: number }>(
            `SELECT COALESCE(max(serial_no), 0) + 1 AS serial FROM certificate_issue
              WHERE kind = $1 AND year_label = $2`, [input.kind, yearLabel]);
          const serial = next.rows[0]!.serial;
          const inserted = await db.query<{ id: string }>(
            `INSERT INTO certificate_issue
               (tenant_id, student_id, kind, year_label, serial_no, certificate_no,
                issued_on, purpose, title, paragraphs, issued_by, issued_by_user)
             VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5, $6::date, $7, $8,
                     $9::jsonb, $10, $11)
             RETURNING id`,
            [input.studentId, input.kind, yearLabel, serial,
             certificateNo(input.kind, yearLabel, serial), row.today, purpose,
             doc.title, JSON.stringify(doc.paragraphs),
             may.rows[0].staff_id, scope.actorId ?? null]);
          await db.query('RELEASE SAVEPOINT certificate_serial');
          const { rows } = await db.query<IssuedCertificate>(
            `${ISSUED} WHERE c.id = $1`, [inserted.rows[0]!.id]);
          return rows[0]!;
        } catch (error) {
          await db.query('ROLLBACK TO SAVEPOINT certificate_serial');
          if ((error as { code?: string }).code !== '23505') throw error;
        }
      }
      throw ApiError.make('conflict', 'certificate_number_busy',
        'Several certificates were being issued at once. Try again.');
    });

    await auditService.record({
      tenantId: scope.tenantId, actorUserId: scope.actorId,
      action: 'certificate.issued', resourceType: 'certificate_issue',
      resourceId: issued.id, classification: 'SENSITIVE',
      after: { student_id: input.studentId, kind: input.kind,
               certificate_no: issued.certificate_no },
    });
    return issued;
  },
};
