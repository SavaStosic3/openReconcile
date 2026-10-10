-- DBA-managed example schema. All datetime2 values are UTC.
CREATE TABLE dbo.mass_readings (
  tag nvarchar(200) NOT NULL,
  reading float NOT NULL CHECK (reading >= 0),
  recorded_at datetime2(3) NOT NULL
);
CREATE INDEX mass_readings_tag_time ON dbo.mass_readings (tag, recorded_at);

CREATE TABLE dbo.reconciliation_results (
  run_id nvarchar(128) NOT NULL,
  model_id nvarchar(128) NOT NULL,
  model_name nvarchar(200) NOT NULL,
  published_version int NULL,
  item_id nvarchar(128) NOT NULL,
  item_type nvarchar(16) NOT NULL,
  source_name nvarchar(200) NOT NULL,
  metric nvarchar(32) NOT NULL,
  value_kg float NOT NULL,
  raw_kg float NULL,
  correction_kg float NULL,
  uncertainty_kg float NULL,
  status nvarchar(32) NOT NULL,
  batch_start datetime2(3) NOT NULL,
  batch_end datetime2(3) NOT NULL,
  finished_at datetime2(3) NOT NULL,
  PRIMARY KEY (run_id, item_type, item_id, metric),
  CHECK (batch_end > batch_start),
  CHECK (value_kg >= 0 OR (item_type = 'unit' AND metric = 'accumulation')),
  CHECK ((item_type = 'stream' AND metric = 'mass' AND status IN ('measured', 'estimated'))
    OR (item_type = 'unit' AND metric IN ('incoming_mass', 'outgoing_mass', 'opening_inventory', 'closing_inventory', 'accumulation') AND status = 'reconciled'))
);
-- Grant SELECT on both tables (including output schema tests), INSERT only
-- on results; no DDL, UPDATE, or DELETE. Use encrypted TCP SQL authentication.
