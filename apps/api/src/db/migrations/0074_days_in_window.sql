-- 0074 — how many days of an absence fall inside a payroll month.
--
-- A helper rather than an expression repeated in three places. The rule is
-- small and the ways to get it wrong are not:
--
--   - A fortnight straddling a month end belongs to TWO payrolls, split at the
--     boundary. Counting the absence's own length would pay for the same
--     fortnight twice.
--   - The count is inclusive at both ends. An absence from the 3rd to the 3rd
--     is one day, not zero.
--   - An absence entirely outside the window is zero, not negative. Subtracting
--     dates without a floor gives a negative number that then reduces somebody
--     else's total when it is summed.
--   - A half day is half a day, and only when it is inside the window.
--
-- IMMUTABLE so it can be used in an index later if the payroll report ever
-- needs one; it depends on nothing but its arguments.

CREATE OR REPLACE FUNCTION days_in_window(
  p_starts_on date, p_ends_on date,
  p_from date, p_to date,
  p_half_day boolean DEFAULT false
) RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_starts_on > p_to OR p_ends_on < p_from THEN 0
    WHEN p_half_day THEN 0.5
    ELSE GREATEST(0, (LEAST(p_ends_on, p_to) - GREATEST(p_starts_on, p_from)) + 1)
  END::numeric
$$;

REVOKE ALL ON FUNCTION days_in_window(date, date, date, date, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION days_in_window(date, date, date, date, boolean)
  TO paathshala_app, paathshala_platform;

COMMENT ON FUNCTION days_in_window(date, date, date, date, boolean) IS
  'Inclusive overlap in days, floored at zero. A fortnight straddling a month '
  'end belongs to two payrolls; counting the absence''s own length would pay '
  'for it twice.';
