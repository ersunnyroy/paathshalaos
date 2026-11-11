-- 0078: a receipt names the person who took the money.
--
-- Found by M32.3, wiring the fee surface. `recordOfflinePayment` has required
-- `receivedByStaffId` since M7 and never written it anywhere: the parameter is
-- accepted, typed, and dropped on the floor. Every cash receipt this system
-- has ever issued is attributed to nobody.
--
-- That is not a tidiness problem. Cash at a school counter is the one place
-- money can quietly not arrive, and the control is that a named person is
-- answerable for each receipt. An audit_log entry is not enough on its own —
-- it records that an ACCOUNT recorded a payment, and the answerable party is
-- the member of staff, which is the same distinction M27 drew between a login
-- and a person.
--
-- Nullable, because the rows that already exist genuinely do not know. A NOT
-- NULL with a backfilled default would invent an answer, and the honest state
-- of a historical receipt is "not recorded".
ALTER TABLE payment
  ADD COLUMN received_by uuid REFERENCES staff (id);

COMMENT ON COLUMN payment.received_by IS
  'The member of staff who took the money, for an offline payment. NULL on a '
  'gateway payment, which has no cashier, and on any row written before 0078.';

CREATE INDEX payment_received_by_idx ON payment (tenant_id, received_by)
  WHERE received_by IS NOT NULL;
