-- 0034 — how an approved correction gets past the lock.
--
-- The service first tried `ALTER TABLE mark DISABLE TRIGGER`, which is wrong on
-- two counts: it needs table ownership (the app role has none, so it would fail
-- in production and pass nowhere), and a disabled trigger is disabled for every
-- concurrent transaction on the connection, not just the one correcting a mark.
--
-- Instead the trigger itself knows about corrections. A write to a locked
-- assessment is permitted only when BOTH hold:
--
--   * the transaction has set `app.applying_correction` to the correction's id,
--     which only the approve path does; and
--   * that correction actually exists, is still pending, and names this mark or
--     this assessment-and-enrollment.
--
-- The second condition is what makes this a real gate rather than a flag. A
-- caller who sets the GUC to a uuid of their choosing still cannot write,
-- because no pending correction matches it. The ceiling and the
-- exactly-one-of-three rule continue to apply in every case: a correction is
-- permission to change a mark, never permission to store an impossible one.

CREATE OR REPLACE FUNCTION mark_within_bounds() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  a          record;
  correction uuid;
  permitted  boolean := false;
BEGIN
  SELECT max_marks, status INTO a FROM assessment WHERE id = NEW.assessment_id;
  IF a IS NULL THEN
    RAISE EXCEPTION 'assessment % does not exist', NEW.assessment_id;
  END IF;

  -- Applies to everyone, always. A correction does not license a mark of 105.
  IF NEW.marks_obtained IS NOT NULL AND NEW.marks_obtained > a.max_marks THEN
    RAISE EXCEPTION 'mark % exceeds the maximum of % for this assessment',
      NEW.marks_obtained, a.max_marks
      USING ERRCODE = 'check_violation';
  END IF;

  IF a.status = 'draft' THEN
    RAISE EXCEPTION 'marks cannot be entered against a draft assessment'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF a.status = 'cancelled' THEN
    RAISE EXCEPTION 'this assessment was cancelled'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF a.status = 'locked' THEN
    correction := NULLIF(current_setting('app.applying_correction', true), '')::uuid;
    IF correction IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM mark_correction c
         WHERE c.id = correction
           AND c.status = 'pending'
           AND (c.mark_id = NEW.id
                OR (c.assessment_id = NEW.assessment_id
                    AND c.enrollment_id = NEW.enrollment_id))
      ) INTO permitted;
    END IF;

    IF NOT permitted THEN
      RAISE EXCEPTION 'this assessment is locked; record a correction instead'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION mark_within_bounds() IS
  'Enforces the mark ceiling always, and the assessment lock except for a write '
  'carrying a matching pending mark_correction id in app.applying_correction.';
