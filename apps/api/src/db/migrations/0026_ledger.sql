-- 0026: the double-entry ledger, and settlement reconciliation.
--
-- Every money movement writes a BALANCED GROUP of entries. The check cannot be
-- per-row — a single row is never balanced — so it is a DEFERRED CONSTRAINT
-- TRIGGER evaluated at COMMIT, by which time the whole group is present.
--
-- That timing is the point. A statement-level check would fire after the first
-- insert and reject a group that was about to balance; an application-level
-- check would be skipped by the one code path that forgot to call it. At commit,
-- the database refuses to record an unbalanced transaction at all.

CREATE TABLE ledger_entry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES organization (id),
  campus_id      uuid REFERENCES campus (id),

  -- Every row in one group belongs to one money movement.
  entry_group_id uuid NOT NULL,

  account_code   text NOT NULL,
  debit          numeric(14,2) NOT NULL DEFAULT 0,
  credit         numeric(14,2) NOT NULL DEFAULT 0,
  currency       char(3) NOT NULL DEFAULT 'INR',
  occurred_on    date NOT NULL DEFAULT CURRENT_DATE,

  source_type    text NOT NULL,
  source_id      uuid,
  narration      text,

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ledger_entry_amounts_not_negative CHECK (debit >= 0 AND credit >= 0),
  -- A row is a debit or a credit, never both and never neither.
  CONSTRAINT ledger_entry_is_one_sided
    CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);

CREATE INDEX ledger_entry_group_idx ON ledger_entry (entry_group_id);
CREATE INDEX ledger_entry_account_idx ON ledger_entry (tenant_id, account_code, occurred_on);
CREATE INDEX ledger_entry_source_idx ON ledger_entry (tenant_id, source_type, source_id);
CREATE INDEX ledger_entry_date_idx ON ledger_entry (tenant_id, occurred_on);

CREATE OR REPLACE FUNCTION ledger_group_must_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_debits  numeric(14,2);
  v_credits numeric(14,2);
BEGIN
  SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0)
    INTO v_debits, v_credits
    FROM ledger_entry
   WHERE entry_group_id = COALESCE(NEW.entry_group_id, OLD.entry_group_id);

  IF v_debits <> v_credits THEN
    RAISE EXCEPTION
      'ledger group % does not balance: debits %, credits %',
      COALESCE(NEW.entry_group_id, OLD.entry_group_id), v_debits, v_credits
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;

-- DEFERRABLE INITIALLY DEFERRED: checked once, at commit, when both sides exist.
CREATE CONSTRAINT TRIGGER ledger_entry_group_balances
  AFTER INSERT OR UPDATE OR DELETE ON ledger_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_group_must_balance();

-- Append-only, and enforced at the privilege level as well as by a trigger:
-- the application role is granted INSERT and SELECT only, so a stray ORM update
-- fails before any trigger runs.
CREATE OR REPLACE FUNCTION ledger_entry_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entry is append-only: % is not permitted; post a reversing entry', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_entry_no_update BEFORE UPDATE ON ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entry_is_append_only();
CREATE TRIGGER ledger_entry_no_delete BEFORE DELETE ON ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entry_is_append_only();

-- What the gateway actually paid into the bank, which is rarely what the day's
-- payments add up to: fees are deducted, refunds are netted off, and some
-- payments settle a day later.
CREATE TABLE settlement_batch (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES organization (id),
  provider           text NOT NULL,
  utr                text NOT NULL,
  settled_on         date NOT NULL,
  gross_amount       numeric(14,2) NOT NULL,
  fee_amount         numeric(14,2) NOT NULL DEFAULT 0,
  tax_amount         numeric(14,2) NOT NULL DEFAULT 0,
  net_amount         numeric(14,2) NOT NULL,
  statement_file_id  uuid REFERENCES file (id),
  imported_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_net_is_consistent
    CHECK (net_amount = gross_amount - fee_amount - tax_amount)
);

CREATE UNIQUE INDEX settlement_batch_utr_key ON settlement_batch (provider, utr);
CREATE INDEX settlement_batch_date_idx ON settlement_batch (tenant_id, settled_on);

CREATE TABLE settlement_line (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES organization (id),
  settlement_batch_id  uuid NOT NULL REFERENCES settlement_batch (id) ON DELETE CASCADE,
  payment_id           uuid REFERENCES payment (id),
  provider_payment_id  text NOT NULL,
  amount               numeric(14,2) NOT NULL,
  provider_fee         numeric(14,2) NOT NULL DEFAULT 0,
  -- 'unmatched' is a first-class screen, not an error log. A line the system
  -- cannot match is money in the bank nobody has attributed, and somebody has
  -- to look at it.
  match_state          text NOT NULL DEFAULT 'unmatched'
                         CHECK (match_state IN ('matched', 'unmatched', 'disputed', 'ignored')),
  matched_at           timestamptz,
  note                 text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX settlement_line_key
  ON settlement_line (tenant_id, settlement_batch_id, provider_payment_id);
CREATE INDEX settlement_line_unmatched_idx
  ON settlement_line (tenant_id, match_state) WHERE match_state = 'unmatched';
CREATE INDEX settlement_line_payment_idx ON settlement_line (tenant_id, payment_id);
