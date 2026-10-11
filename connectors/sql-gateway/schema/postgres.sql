-- DBA-managed example schema. The gateway never creates tables.
CREATE TABLE public.mass_readings (
  tag varchar(200) NOT NULL,
  reading double precision NOT NULL CHECK (reading >= 0),
  recorded_at timestamptz NOT NULL
);
CREATE INDEX mass_readings_tag_time ON public.mass_readings (tag, recorded_at);

CREATE TABLE public.reconciliation_results (
  run_id varchar(128) COLLATE "C" NOT NULL,
  model_id varchar(128) COLLATE "C" NOT NULL,
  model_name varchar(200) NOT NULL,
  published_version integer NULL,
  item_id varchar(128) COLLATE "C" NOT NULL,
  item_type varchar(16) NOT NULL,
  source_name varchar(200) NOT NULL,
  metric varchar(32) NOT NULL,
  value_kg double precision NOT NULL,
  raw_kg double precision NULL,
  correction_kg double precision NULL,
  uncertainty_kg double precision NULL,
  status varchar(32) NOT NULL,
  batch_start timestamptz NOT NULL,
  batch_end timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, item_type, item_id, metric),
  CHECK (batch_end > batch_start),
  CHECK (value_kg >= 0 OR (item_type = 'unit' AND metric = 'accumulation')),
  CHECK ((item_type = 'stream' AND metric = 'mass' AND status IN ('measured', 'estimated', 'measured_questionable', 'estimated_questionable'))
    OR (item_type = 'unit' AND metric IN ('incoming_mass', 'outgoing_mass', 'opening_inventory', 'closing_inventory', 'accumulation') AND status IN ('reconciled', 'reconciled_questionable')))
);
-- Use a least-privilege account: SELECT on mass_readings/results (for tests),
-- INSERT on reconciliation_results. No DDL, UPDATE, or DELETE permissions.
