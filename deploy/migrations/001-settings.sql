CREATE TABLE allowed_origins (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  origin text NOT NULL CHECK (length(origin) BETWEEN 1 AND 2048),
  PRIMARY KEY (tenant_id, origin)
);
CREATE TABLE widget_keys (
  tenant_id text PRIMARY KEY CHECK (tenant_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  current_key text NOT NULL CHECK (current_key ~ '^[A-Za-z0-9_-]{43}$'),
  previous_key text CHECK (previous_key ~ '^[A-Za-z0-9_-]{43}$'),
  rotated_at timestamptz NOT NULL DEFAULT now(),
  previous_valid_until timestamptz,
  CHECK ((previous_key IS NULL) = (previous_valid_until IS NULL))
);
REVOKE ALL ON allowed_origins, widget_keys FROM PUBLIC;
