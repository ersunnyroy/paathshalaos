-- 0059: plans, subscriptions and entitlements (M16.1–M16.3).
--
-- Three things are usually one table and should be three.
--
--   **What a plan costs** is a contract with the schools already on it. Editing a
--   price in place silently reprices every one of them, and the school finds out
--   at renewal. So a plan has VERSIONS, a published version is frozen by a
--   trigger, and a subscription points at a version rather than at a plan.
--
--   **What a plan permits** is two different things that look alike. Learners,
--   staff, campuses, messages and storage are NUMBERS with an included allowance
--   and a cap. Transport, HR, the public API are FLAGS. They are enforced in
--   different places and they fail for different reasons, so "you have too many
--   learners" and "you do not have the transport module" must not arrive as the
--   same error — the first is a conversation about upgrading, the second is a
--   conversation about buying something else.
--
--   **What happens at the edge** is the whole design, and most of it is a refusal
--   to do the obvious thing. Over the allowance, it works and is metered. Over
--   the cap, NEW records of that kind are refused and existing ones keep working.
--   Overdue, the school goes read-only. Never: no deletion, no lockout, no
--   withheld export. A school locked out of its attendance register on a Monday
--   morning is a school that never renews and tells every other school in the
--   district.
--
-- The catalogue tables carry no tenant_id. They are the same for everybody and a
-- school reading its own plan is reading public pricing.

-- ---------------------------------------------------------------------------
-- The catalogue
-- ---------------------------------------------------------------------------

CREATE TABLE plan (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable across versions. This is what a sales conversation names.
  code        text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name        text NOT NULL,
  -- A private plan is a negotiated one. It exists, it is not on the pricing page.
  is_public   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_version (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id        uuid NOT NULL REFERENCES plan (id),
  version        integer NOT NULL CHECK (version > 0),

  -- Paise, as every other amount in this system. numeric, never a float, and
  -- never a rupee figure that has been through a double.
  price_monthly  numeric(14,2) NOT NULL CHECK (price_monthly >= 0),
  price_annual   numeric(14,2) NOT NULL CHECK (price_annual >= 0),
  currency       character(3) NOT NULL DEFAULT 'INR',

  -- draft is editable; published is frozen; retired cannot take new subscribers
  -- but every existing one stays on it, which is the entire point of versioning.
  status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'published', 'retired')),

  note           text,
  created_by     uuid REFERENCES user_account (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  retired_at     timestamptz,

  CONSTRAINT plan_version_once UNIQUE (plan_id, version),
  CONSTRAINT plan_version_published_has_timestamp
    CHECK ((status = 'draft') = (published_at IS NULL))
);

CREATE INDEX plan_version_live_idx
  ON plan_version (plan_id, version DESC) WHERE status = 'published';

-- What a version permits, as numbers.
--
-- `included` is what the price covers. `hard_cap` is where new records stop;
-- NULL means there is no cap, which is a real product position and not a
-- missing value — it is how an enterprise plan says "as many as you like".
CREATE TABLE plan_limit (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id  uuid NOT NULL REFERENCES plan_version (id) ON DELETE CASCADE,
  metric           text NOT NULL
                     CHECK (metric IN ('learners', 'staff', 'campuses',
                                       'messages_per_month', 'storage_mb')),
  included         integer NOT NULL CHECK (included >= 0),
  hard_cap         integer CHECK (hard_cap IS NULL OR hard_cap >= 0),

  CONSTRAINT plan_limit_once UNIQUE (plan_version_id, metric),
  -- A cap below the allowance would mean the plan refuses what it sold.
  CONSTRAINT plan_limit_cap_above_included
    CHECK (hard_cap IS NULL OR hard_cap >= included)
);

-- What a version permits, as flags. A module is on or it is not; there is no
-- "three quarters of transport".
CREATE TABLE plan_feature (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id  uuid NOT NULL REFERENCES plan_version (id) ON DELETE CASCADE,
  feature          text NOT NULL
                     CHECK (feature IN ('transport', 'hr', 'lms', 'public_api',
                                        'whatsapp', 'advanced_reports')),
  enabled          boolean NOT NULL DEFAULT true,

  CONSTRAINT plan_feature_once UNIQUE (plan_version_id, feature)
);

-- ---------------------------------------------------------------------------
-- A published version is frozen
-- ---------------------------------------------------------------------------
--
-- This trigger is the difference between "editing creates a version" as a
-- convention somebody follows and as a fact. Without it the rule lives in one
-- service, and the second code path to touch these tables — a script, an
-- import, a well-meaning fix in production — reprices every school on the plan
-- with no record that it happened.
--
-- Retiring is the one permitted transition, because it changes what new
-- subscribers can choose and nothing about what existing ones pay.

CREATE OR REPLACE FUNCTION plan_version_is_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'plan version %.% is published and cannot be deleted; retire it instead',
        OLD.plan_id, OLD.version USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' THEN RETURN NEW; END IF;

  -- Published or retired: only the retirement fields may move.
  IF NEW.price_monthly IS DISTINCT FROM OLD.price_monthly
     OR NEW.price_annual IS DISTINCT FROM OLD.price_annual
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION
      'plan version %.% is published; create a new version instead of changing this one',
      OLD.plan_id, OLD.version USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'a retired plan version cannot be brought back; publish a new one'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER plan_version_frozen
  BEFORE UPDATE OR DELETE ON plan_version
  FOR EACH ROW EXECUTE FUNCTION plan_version_is_frozen();

-- The limits and flags are where the price actually lives, so freezing the
-- version row alone would leave the door wide open: change the learner cap from
-- 500 to 50 and every school on that plan is over it tomorrow morning.
CREATE OR REPLACE FUNCTION plan_terms_follow_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_id     uuid;
  v_status text;
BEGIN
  v_id := COALESCE(NEW.plan_version_id, OLD.plan_version_id);
  SELECT status INTO v_status FROM plan_version WHERE id = v_id;

  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION
      'the terms of a published plan version cannot be changed; create a new version'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER plan_limit_follows_version
  BEFORE INSERT OR UPDATE OR DELETE ON plan_limit
  FOR EACH ROW EXECUTE FUNCTION plan_terms_follow_version();

CREATE TRIGGER plan_feature_follows_version
  BEFORE INSERT OR UPDATE OR DELETE ON plan_feature
  FOR EACH ROW EXECUTE FUNCTION plan_terms_follow_version();

-- ---------------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------------
--
-- Points at a VERSION. A school moves between versions only when somebody
-- decides to move it, and that decision leaves a row in subscription_event.

CREATE TABLE subscription (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES organization (id),
  plan_version_id  uuid NOT NULL REFERENCES plan_version (id),

  -- trialing  — full access, ends on a date
  -- active    — paying
  -- past_due  — payment missed; still writable during the grace window
  -- read_only — the end of the ladder. Everything readable and exportable;
  --             nothing new written. NOT "suspended", because the word people
  --             reach for next is "delete" and this state is not that.
  status           text NOT NULL DEFAULT 'trialing'
                     CHECK (status IN ('trialing', 'active', 'past_due', 'read_only', 'ended')),

  billing_period   text NOT NULL DEFAULT 'monthly'
                     CHECK (billing_period IN ('monthly', 'annual')),

  trial_ends_on    date,
  period_start     date NOT NULL DEFAULT CURRENT_DATE,
  period_end       date,
  -- When past_due began. The grace window is measured from here, so a school
  -- cannot be dropped to read-only the instant a card fails on a Sunday.
  past_due_since   date,

  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,

  CONSTRAINT subscription_trialing_has_end
    CHECK (status <> 'trialing' OR trial_ends_on IS NOT NULL),
  CONSTRAINT subscription_past_due_has_date
    CHECK (status NOT IN ('past_due', 'read_only') OR past_due_since IS NOT NULL)
);

-- One live subscription per school. Two would make "what may this school do"
-- a question with two answers, and the code would pick whichever came first.
CREATE UNIQUE INDEX subscription_one_live_per_tenant
  ON subscription (tenant_id) WHERE ended_at IS NULL;

CREATE INDEX subscription_version_idx ON subscription (plan_version_id);

-- Append-only. What a school was on, and when, is the record that settles a
-- billing disagreement — which makes it exactly the table somebody would want
-- to tidy up afterwards.
CREATE TABLE subscription_event (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES organization (id),
  subscription_id  uuid NOT NULL REFERENCES subscription (id),
  kind             text NOT NULL
                     CHECK (kind IN ('created', 'version_changed', 'status_changed',
                                     'trial_extended', 'period_rolled', 'ended')),
  before           jsonb,
  after            jsonb,
  reason           text,
  actor_user_id    uuid REFERENCES user_account (id),
  occurred_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX subscription_event_tenant_idx
  ON subscription_event (tenant_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION subscription_event_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'subscription_event is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER subscription_event_no_update BEFORE UPDATE ON subscription_event
  FOR EACH STATEMENT EXECUTE FUNCTION subscription_event_is_append_only();
CREATE TRIGGER subscription_event_no_delete BEFORE DELETE ON subscription_event
  FOR EACH STATEMENT EXECUTE FUNCTION subscription_event_is_append_only();

-- ---------------------------------------------------------------------------
-- One place that answers "what may this school do" (M16.3)
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER because the answer must be identical for every caller, and
-- because the app role holds no grant on the subscription tables — entitlement
-- is not something a tenant query should be able to read around.
--
-- All three read the CURRENT tenant from the transaction setting rather than
-- taking it as an argument. A function that takes a tenant id is a function
-- somebody eventually calls with the wrong one.

CREATE OR REPLACE FUNCTION app_tenant_subscription()
RETURNS TABLE (
  subscription_id uuid, plan_version_id uuid, plan_code text,
  status text, trial_ends_on date, past_due_since date
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.plan_version_id, p.code, s.status, s.trial_ends_on, s.past_due_since
    FROM subscription s
    JOIN plan_version pv ON pv.id = s.plan_version_id
    JOIN plan p ON p.id = pv.plan_id
   WHERE s.tenant_id = app_current_tenant_id()
     AND s.ended_at IS NULL
$$;

-- A school with no subscription row gets TRUE.
--
-- Deliberate, and the opposite of what a security reflex suggests. Every school
-- that existed before this milestone has no row, and defaulting to "no features"
-- would switch off transport for all of them the moment this deploys. Billing
-- state is not an authorisation boundary — the authorisation boundary is RLS,
-- and it does not consult this function. An unbilled school is a sales problem,
-- not a breach.
CREATE OR REPLACE FUNCTION app_tenant_has_feature(p_feature text)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT pf.enabled
       FROM subscription s
       JOIN plan_feature pf ON pf.plan_version_id = s.plan_version_id
      WHERE s.tenant_id = app_current_tenant_id()
        AND s.ended_at IS NULL
        AND pf.feature = p_feature),
    -- No plan_feature row for this feature on this version means the version
    -- does not mention it, which is not the same as switching it off.
    true)
$$;

CREATE OR REPLACE FUNCTION app_tenant_limit(p_metric text)
RETURNS TABLE (included integer, hard_cap integer)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT pl.included, pl.hard_cap
    FROM subscription s
    JOIN plan_limit pl ON pl.plan_version_id = s.plan_version_id
   WHERE s.tenant_id = app_current_tenant_id()
     AND s.ended_at IS NULL
     AND pl.metric = p_metric
$$;

-- The bottom of the ladder, as one question.
CREATE OR REPLACE FUNCTION app_tenant_is_read_only()
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM subscription
     WHERE tenant_id = app_current_tenant_id()
       AND ended_at IS NULL
       AND status = 'read_only')
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

-- The catalogue is public pricing; a school may read it and may not write it.
GRANT SELECT ON plan, plan_version, plan_limit, plan_feature TO paathshala_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON plan_version, plan_limit, plan_feature
  TO paathshala_platform;
GRANT SELECT, INSERT, UPDATE ON plan TO paathshala_platform;

-- A school reads its own subscription and never writes one. There is no
-- self-serve upgrade endpoint here, and if there is one later it goes through
-- the platform role rather than by widening this grant.
GRANT SELECT ON subscription, subscription_event TO paathshala_app;
GRANT SELECT, INSERT, UPDATE ON subscription TO paathshala_platform;
GRANT SELECT, INSERT ON subscription_event TO paathshala_platform;

REVOKE ALL ON FUNCTION app_tenant_subscription() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_tenant_has_feature(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_tenant_limit(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_tenant_is_read_only() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_tenant_subscription() TO paathshala_app, paathshala_platform;
GRANT EXECUTE ON FUNCTION app_tenant_has_feature(text) TO paathshala_app;
GRANT EXECUTE ON FUNCTION app_tenant_limit(text) TO paathshala_app;
GRANT EXECUTE ON FUNCTION app_tenant_is_read_only() TO paathshala_app;

ALTER TABLE subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription FORCE  ROW LEVEL SECURITY;
ALTER TABLE subscription_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_event FORCE  ROW LEVEL SECURITY;

-- WITH CHECK (false) is a second line, not the enforcing one. The app role has
-- no INSERT, UPDATE or DELETE grant on this table, so a write is refused before
-- any policy is consulted — which means relaxing this clause changes nothing and
-- a test asserting the refusal is really asserting the grant. Said plainly here
-- because a mutation proved it: see the privilege assertion in plans.spec.ts.
CREATE POLICY tenant_isolation ON subscription
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (false);

CREATE POLICY tenant_isolation ON subscription_event
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (false);

-- The console sees every school's subscription. Note what it still cannot see:
-- nothing here reaches a learner, an invoice or an attendance record.
CREATE POLICY platform_all ON subscription
  FOR ALL TO paathshala_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_all ON subscription_event
  FOR ALL TO paathshala_platform USING (true) WITH CHECK (true);

COMMENT ON FUNCTION app_tenant_has_feature(text) IS
  'Whether a module is enabled for the current tenant. Returns true when the '
  'school has no subscription or the version does not mention the feature: '
  'billing state is not an authorisation boundary, and RLS never consults this.';
COMMENT ON TABLE subscription_event IS
  'Append-only history of every subscription change. Settles billing '
  'disagreements, which is why it cannot be tidied up afterwards.';
