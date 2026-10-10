-- DBA-managed example schema for MySQL 8+. DATETIME values represent UTC.
CREATE TABLE production.mass_readings (
  tag varchar(200) NOT NULL,
  reading double NOT NULL CHECK (reading >= 0),
  recorded_at datetime(3) NOT NULL,
  INDEX mass_readings_tag_time (tag, recorded_at)
) ENGINE = InnoDB;

CREATE TABLE production.reconciliation_results (
  run_id varchar(128) NOT NULL,
  model_id varchar(128) NOT NULL,
  model_name varchar(200) NOT NULL,
  published_version int NULL,
  item_id varchar(128) NOT NULL,
  item_type varchar(16) NOT NULL,
  source_name varchar(200) NOT NULL,
  metric varchar(32) NOT NULL,
  value_kg double NOT NULL,
  raw_kg double NULL,
  correction_kg double NULL,
  uncertainty_kg double NULL,
  status varchar(32) NOT NULL,
  batch_start datetime(3) NOT NULL,
  batch_end datetime(3) NOT NULL,
  finished_at datetime(3) NOT NULL,
  PRIMARY KEY (run_id, item_type, item_id, metric),
  CHECK (batch_end > batch_start),
  CHECK (value_kg >= 0 OR (item_type = 'unit' AND metric = 'accumulation')),
  CHECK ((item_type = 'stream' AND metric = 'mass' AND status IN ('measured', 'estimated'))
    OR (item_type = 'unit' AND metric IN ('incoming_mass', 'outgoing_mass', 'opening_inventory', 'closing_inventory', 'accumulation') AND status = 'reconciled'))
) ENGINE = InnoDB;
-- Use a least-privilege account with SELECT on both tables (for tests), INSERT
-- on results only. Use InnoDB to guarantee output transaction rollback.
