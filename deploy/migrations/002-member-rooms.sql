CREATE TABLE visitors (
  tenant_id text NOT NULL,
  id uuid NOT NULL,
  guest_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);
CREATE TABLE rooms (
  tenant_id text NOT NULL,
  id uuid NOT NULL,
  visitor_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','in_progress','closed')),
  assigned_member_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,visitor_id) REFERENCES visitors(tenant_id,id),
  CHECK ((status='waiting' AND assigned_member_id IS NULL) OR (status='in_progress' AND assigned_member_id IS NOT NULL) OR status='closed'),
  CHECK ((status='closed') = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_open_room_per_visitor ON rooms(tenant_id,visitor_id) WHERE status <> 'closed';
CREATE TABLE messages (
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id text NOT NULL,
  id uuid NOT NULL,
  room_id uuid NOT NULL,
  sender_member_id uuid NOT NULL,
  request_id uuid NOT NULL,
  text text NOT NULL CHECK (octet_length(text) BETWEEN 1 AND 4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,room_id,sender_member_id,request_id),
  FOREIGN KEY (tenant_id,room_id) REFERENCES rooms(tenant_id,id)
);
CREATE TABLE event_outbox (
  tenant_id text NOT NULL,
  id uuid NOT NULL,
  room_id uuid NOT NULL,
  message_id uuid NOT NULL,
  type text NOT NULL CHECK (type='talk.message'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,message_id),
  FOREIGN KEY (tenant_id,room_id) REFERENCES rooms(tenant_id,id),
  FOREIGN KEY (tenant_id,message_id) REFERENCES messages(tenant_id,id)
);
REVOKE ALL ON visitors,rooms,messages,event_outbox FROM PUBLIC;
