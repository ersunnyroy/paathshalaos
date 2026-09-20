-- 0085: let the console make a task due, and nothing else (M33.3).
--
-- 0082 granted the platform role SELECT on `scheduled_task`, which was right
-- for the read-only view it was written for and wrong the moment "run this now"
-- existed. The endpoint answered 500 with `permission denied for table
-- scheduled_task` — found by an HTTP test, which is the only kind that could
-- have found it: the query is correct, the service is correct, and the grant is
-- what is missing.
--
-- Granted per COLUMN rather than per table. The console may move a task's
-- `next_run_at` forward and clear a stale `running_since`; it may not disable a
-- task, change its interval, or rewrite what it last reported. Those are the
-- three ways a console account could make a compliance job stop running while
-- the row still looks healthy, and none of them is something an operator needs
-- to do from a web page.

GRANT UPDATE (next_run_at, running_since) ON scheduled_task TO paathshala_platform;

CREATE POLICY platform_may_requeue ON scheduled_task
  FOR UPDATE TO paathshala_platform
  USING (true) WITH CHECK (true);
