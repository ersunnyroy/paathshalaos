-- 0077: a teacher of IX-B is not thereby a teacher of IX-A.
--
-- Found by M28, in a test that expected a teacher with no connection to a
-- class to see none of its homework and watched them see all of it.
--
-- `app_actor_section_ids()` has, since 0045, granted a staff member every
-- section of a class group whenever they are primary teacher of ANY offering
-- in that group. `course_offering.section_id` exists precisely to say which
-- section an offering is taught to — NULL meaning the whole group takes it
-- together — and the branch ignored it.
--
-- The blast radius is larger than the milestone that found it. This function
-- is what `app_may_see_student` is built on, which is what `app_student_visible`
-- is built on, which is the single rule 0049 put under the policies on
-- `student` (including the health role's, so the RESTRICTED medical columns),
-- `mark`, attendance, transport and now submissions. A Class IX with four
-- sections and four subject teachers gave each of them all four sections'
-- children rather than their own.
--
-- Two narrowings, both about the offering rather than the teacher:
--
--   * respect `section_id` — a section-specific offering grants that section,
--     a whole-group offering (NULL) grants the group, as it always should have;
--   * respect `deleted_at` — offerings are soft-deleted, so withdrawing a
--     teacher from a class left their access exactly where it was. Every other
--     query in this schema filters it; this one never did.
--
-- And one on the timetable branch, for the same reason M20 cared about the
-- driver who ran the route until yesterday: a schedule slot that has ended is
-- a room the teacher no longer stands in.
--
-- Deliberately NOT narrowed: the class teacher branch and the relief cover
-- branch. A class teacher is responsible for the whole section by definition,
-- and 0073's cover window is already a single day.

CREATE OR REPLACE FUNCTION app_actor_section_ids() RETURNS uuid[]
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(array_agg(DISTINCT s.id), ARRAY[]::uuid[])
    FROM section s
    LEFT JOIN class_group cg ON cg.id = s.class_group_id
   WHERE s.tenant_id = app_current_tenant_id()
     AND EXISTS (
       SELECT 1 FROM staff st
        WHERE st.tenant_id = s.tenant_id
          AND st.deleted_at IS NULL
          AND st.person_id = app_current_person_id()
          AND (
            s.class_teacher_staff_id = st.id
            OR EXISTS (SELECT 1 FROM course_offering co
                        WHERE co.class_group_id = cg.id
                          AND co.primary_teacher_staff_id = st.id
                          AND co.deleted_at IS NULL
                          -- The whole point of the column.
                          AND (co.section_id IS NULL OR co.section_id = s.id))
            OR EXISTS (SELECT 1 FROM schedule_slot sl
                        WHERE sl.section_id = s.id AND sl.staff_id = st.id
                          AND (sl.effective_to IS NULL
                               OR sl.effective_to >= CURRENT_DATE))
            -- Relief cover, for today only. See 0073's header for why this
            -- exists at all: without it, the teacher standing in front of the
            -- class cannot mark its register, and somebody in the office
            -- marks it instead from what they were told.
            OR EXISTS (SELECT 1 FROM cover_assignment ca
                        WHERE ca.section_id = s.id
                          AND ca.tenant_id = s.tenant_id
                          AND ca.covering_staff_id = st.id
                          AND ca.on_date = CURRENT_DATE)))
$$;

COMMENT ON FUNCTION app_actor_section_ids() IS
  'Sections this staff member teaches, is class teacher of, is timetabled '
  'into today, or is covering today. Empty for somebody who teaches nothing — '
  'closed by default. 0077: an offering taught to ONE section grants that '
  'section, not every section of its class group.';
