CREATE TABLE visitor_credentials (
  tenant_id text NOT NULL,
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  visitor_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id,token_hash),
  FOREIGN KEY (tenant_id,visitor_id) REFERENCES visitors(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX visitor_credential_owner ON visitor_credentials(tenant_id,visitor_id);
CREATE TABLE visitor_rate_limits (
  tenant_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('issue','message')),
  subject text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count>0),
  PRIMARY KEY (tenant_id,kind,subject)
);
ALTER TABLE messages ALTER COLUMN sender_member_id DROP NOT NULL;
ALTER TABLE messages ADD COLUMN sender_visitor_id uuid;
ALTER TABLE messages ADD CONSTRAINT talk_message_sender CHECK (
  (sender_member_id IS NULL)<>(sender_visitor_id IS NULL)
);
ALTER TABLE messages ADD FOREIGN KEY (tenant_id,sender_visitor_id) REFERENCES visitors(tenant_id,id);
CREATE UNIQUE INDEX visitor_message_request ON messages(tenant_id,sender_visitor_id,request_id)
  WHERE sender_visitor_id IS NOT NULL;
ALTER TABLE event_outbox ADD COLUMN sequence bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX talk_event_sequence ON event_outbox(sequence);
-- Identity allocation happens before commit. Serialize writers per tenant and
-- allocate the final position inside the transaction lock so sync cannot skip
-- an earlier uncommitted occurrence when another room commits first.
CREATE FUNCTION talk_stream_commit_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id || ':talk-stream-order',0));
  NEW.sequence := nextval(pg_get_serial_sequence('event_outbox','sequence'));
  RETURN NEW;
END $$;
CREATE TRIGGER talk_stream_commit_order BEFORE INSERT ON event_outbox
  FOR EACH ROW EXECUTE FUNCTION talk_stream_commit_order();
REVOKE ALL ON FUNCTION talk_stream_commit_order() FROM PUBLIC;
ALTER TABLE event_outbox DROP CONSTRAINT talk_outbox_payload;
ALTER TABLE event_outbox ADD CONSTRAINT talk_outbox_payload CHECK (
  (type='talk.message' AND message_id IS NOT NULL AND recipient_member_id IS NULL) OR
  (type IN ('talk.new','talk.closed') AND message_id IS NULL AND recipient_member_id IS NULL) OR
  (type='talk.assigned' AND message_id IS NULL AND recipient_member_id IS NOT NULL)
);
CREATE TABLE realtime_cursor_keys (
  tenant_id text PRIMARY KEY,
  secret bytea NOT NULL CHECK (octet_length(secret)=32)
);
REVOKE ALL ON visitor_credentials,visitor_rate_limits,realtime_cursor_keys FROM PUBLIC;
