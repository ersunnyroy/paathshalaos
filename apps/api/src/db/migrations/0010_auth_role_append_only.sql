-- 0010: the auth role appends to the audit log and cannot read it back.
--
-- Migration 0007 granted it SELECT as well as INSERT. Row-level security meant
-- it saw nothing anyway, since no policy grants it reads — but a privilege
-- nothing needs is a privilege that will eventually be used by accident. The
-- login path writes audit rows; it has no business reading a tenant's trail.

REVOKE SELECT ON audit_log FROM paathshala_auth;
