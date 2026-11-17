CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE resources (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) > 0)
);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES resources(id),
  request_key uuid NOT NULL UNIQUE,
  starts_at timestamptz(3) NOT NULL,
  ends_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  cancelled_at timestamptz(3),
  CONSTRAINT bookings_valid_window CHECK (isfinite(starts_at) AND isfinite(ends_at) AND starts_at < ends_at),
  CONSTRAINT bookings_no_active_overlap EXCLUDE USING gist (
    resource_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (cancelled_at IS NULL)
);

INSERT INTO resources (id, name) VALUES
  ('10000000-0000-4000-8000-000000000001', 'Cedar room'),
  ('10000000-0000-4000-8000-000000000002', 'Birch room');
