ALTER TABLE event_outbox
  DROP CONSTRAINT event_outbox_type_check,
  ALTER COLUMN message_id DROP NOT NULL,
  ADD COLUMN recipient_member_id uuid,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN lease_token uuid,
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN last_error text CHECK (last_error IS NULL OR last_error='delivery_failed'),
  ADD CONSTRAINT talk_outbox_payload CHECK (
    (type='talk.message' AND message_id IS NOT NULL AND recipient_member_id IS NULL) OR
    (type='talk.new' AND message_id IS NULL AND recipient_member_id IS NULL) OR
    (type='talk.assigned' AND message_id IS NULL AND recipient_member_id IS NOT NULL)
  ),
  ADD CONSTRAINT talk_outbox_lease CHECK ((locked_until IS NULL)=(lease_token IS NULL));
CREATE INDEX talk_notification_delivery ON event_outbox(tenant_id,available_at,created_at,id)
  WHERE delivered_at IS NULL AND type IN ('talk.new','talk.assigned');

-- Future room producers cannot commit a room without its new-room occurrence.
-- This does not implement the visitor issuance/ownership policy or a public producer.
CREATE FUNCTION talk_room_created_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO event_outbox(tenant_id,id,room_id,type)
    VALUES (NEW.tenant_id,gen_random_uuid(),NEW.id,'talk.new');
  RETURN NEW;
END $$;
CREATE TRIGGER talk_room_created_notification AFTER INSERT ON rooms
  FOR EACH ROW EXECUTE FUNCTION talk_room_created_notification();
REVOKE ALL ON FUNCTION talk_room_created_notification() FROM PUBLIC;
