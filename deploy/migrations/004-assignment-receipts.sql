CREATE TABLE assignment_receipts (
 tenant_id text NOT NULL,
 nonce uuid NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY (tenant_id,nonce)
);
CREATE INDEX assignment_receipts_expiry ON assignment_receipts(tenant_id,expires_at);
REVOKE ALL ON assignment_receipts FROM PUBLIC;
