/**
 * Telling the guardians of the children marked absent (M43.2).
 *
 * The register already knows who is absent, and `attendance.marked` has gone
 * into the outbox since M6 with nothing reading it. Until something does, this
 * is the direct path: the person who took the register asks for the notices
 * to go, and they go.
 *
 * ## What "already told" means
 *
 * A send for a register is a `message_request` whose source is that
 * attendance session. A guardian has been told about a child when a recipient
 * row exists for that pair under any such request and the message arrived.
 *
 * A guardian who muted these notices, or withdrew consent, is settled too:
 * the school tried, they have said no, and asking again every time the button
 * is pressed is how a refusal stops meaning anything.
 *
 * `no_consent` is different, and is NOT settled. Nobody has refused; nobody
 * has been asked. Those stay pending, are counted separately so the register
 * can say why nothing will go, and are sent the first time the button is
 * pressed after consent is recorded.
 *
 * That is what makes the button safe to press twice, and what lets a child
 * marked absent after the first send still get theirs — a single idempotency
 * key per register could do the first and not the second.
 */
import type { TenantClient } from '../../db/tenant.ts';
import type { Audience } from './dispatch.service.ts';

export const ABSENCE_SOURCE = 'attendance_session';
/** The purpose consent is checked against; the template sent must carry it. */
export const ABSENCE_PURPOSE = 'attendance_notifications';

export interface AbsenceNoticeStatus {
  /** Children marked absent in this register. */
  absent: number;
  /** Of those, how many have at least one guardian still to be told. */
  toTell: number;
  /** Of those, how many have no guardian linked at all. Nobody can be told. */
  noGuardian: number;
  /** Guardian–child notices that would go if sent now. */
  notices: number;
  /**
   * Of the children still to tell, how many cannot be told about yet because
   * no consent for attendance notices is on record for them.
   */
  noConsent: number;
}

/** One row per (guardian, absent child) not yet told. */
const PENDING = `
  SELECT gl.guardian_person_id, p.id AS subject_person_id, p.given_name AS child_name,
         to_char(s.session_date, 'FMDD Mon YYYY') AS day,
         may_message(p.id, gl.guardian_person_id, '${ABSENCE_PURPOSE}') AS permission
    FROM attendance_record r
    JOIN attendance_session s ON s.id = r.attendance_session_id
    JOIN enrollment e ON e.id = r.enrollment_id
    JOIN student st ON st.id = e.student_id
    JOIN person p ON p.id = st.person_id
    JOIN guardian_link gl ON gl.student_id = st.id
                         AND gl.effective_to IS NULL
                         AND gl.effective_from <= CURRENT_DATE
   WHERE r.attendance_session_id = $1::uuid
     AND r.state = 'absent'
     AND NOT EXISTS (
       SELECT 1
         FROM message_recipient mr
         JOIN message_request mq ON mq.id = mr.message_request_id
        WHERE mq.source_type = '${ABSENCE_SOURCE}'
          AND mq.source_id = $1::uuid
          AND mr.person_id = gl.guardian_person_id
          AND mr.subject_person_id = p.id
          AND (mr.status IN ('sent', 'delivered', 'read')
               OR (mr.status = 'suppressed'
                   AND mr.suppression_reason IN ('muted', 'consent_withdrawn')))
     )`;

export const absenceService = {
  /** Who would be messaged now, each about their own child. */
  async audience(db: TenantClient, sessionId: string): Promise<Audience[]> {
    const { rows } = await db.query<{
      guardian_person_id: string; subject_person_id: string;
      child_name: string; day: string;
    }>(`${PENDING} ORDER BY p.given_name, gl.guardian_person_id`, [sessionId]);
    return rows.map((r) => ({
      personId: r.guardian_person_id,
      subjectPersonId: r.subject_person_id,
      variables: { name: r.child_name, date: r.day },
    }));
  },

  async status(db: TenantClient, sessionId: string): Promise<AbsenceNoticeStatus> {
    const { rows } = await db.query<AbsenceNoticeStatus>(
      `WITH pending AS (${PENDING}),
            absentees AS (
              SELECT st.id AS student_id, st.person_id
                FROM attendance_record r
                JOIN enrollment e ON e.id = r.enrollment_id
                JOIN student st ON st.id = e.student_id
               WHERE r.attendance_session_id = $1::uuid AND r.state = 'absent')
       SELECT (SELECT count(*)::int FROM absentees) AS absent,
              (SELECT count(DISTINCT subject_person_id)::int FROM pending) AS "toTell",
              (SELECT count(*)::int FROM absentees a
                WHERE NOT EXISTS (
                  SELECT 1 FROM guardian_link gl
                   WHERE gl.student_id = a.student_id
                     AND gl.effective_to IS NULL
                     AND gl.effective_from <= CURRENT_DATE)) AS "noGuardian",
              (SELECT count(*)::int FROM pending WHERE permission = 'ok') AS notices,
              (SELECT count(DISTINCT subject_person_id)::int FROM pending p1
                WHERE permission = 'no_consent'
                  AND NOT EXISTS (SELECT 1 FROM pending p2
                                   WHERE p2.subject_person_id = p1.subject_person_id
                                     AND p2.permission = 'ok')) AS "noConsent"`,
      [sessionId]);
    return rows[0] ?? { absent: 0, toTell: 0, noGuardian: 0, notices: 0, noConsent: 0 };
  },
};
