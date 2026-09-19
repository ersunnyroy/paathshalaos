-- 0031 — the coverage check in 0030 could never return true.
--
-- It cast range_agg's result back to a single numrange to test for a hole. In
-- Postgres 14+ range_agg returns a MULTIRANGE, whose text form is braced
-- ({[0,100)}), so the cast raised `malformed range literal` for a contiguous
-- scale exactly as it did for a gapped one — and the EXCEPTION handler turned
-- both into `false`. Every scale would have been unpublishable, and the reason
-- would have read like a data problem rather than a bug.
--
-- Multirange containment answers the question directly and says what is meant:
-- do the bands, taken together, cover 0 to 100 with no hole.
CREATE OR REPLACE FUNCTION grading_scale_is_covered(scale uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(range_agg(span) @> numrange(0, 100, '[)'), false)
    FROM grade_band WHERE grading_scale_id = scale;
$$;

COMMENT ON FUNCTION grading_scale_is_covered(uuid) IS
  'True when the scale''s bands cover [0,100) with no gap. A hole shows up as a '
  'blank grade on a report card the day it goes home, so publishing is gated on it.';
