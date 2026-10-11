# openReconcile SQL gateway

The gateway connects the hosted app to SQL Server, PostgreSQL, and MySQL through the standard Node drivers [`mssql`](https://github.com/tediousjs/node-mssql), [`pg`](https://node-postgres.com/), and [`mysql2`](https://sidorares.github.io/node-mysql2/docs). It runs beside the plant network or on a server that can reach the database. The hosted app calls its HTTP API; database passwords stay on the gateway server, never in model JSON or browser storage.

## Setup

1. Install Node.js 24.13 or later. Keep the repository directory structure, including `public/input-quality.js`, `public/identifiers.js`, and `public/export-quality.js` (shared with the app). In this directory, run `npm ci`.
2. Have a database administrator create a read source table and/or the result table. Example DDL is in `schema/postgres.sql`, `schema/sqlserver.sql`, and `schema/mysql.sql`; adapt the table names before executing it. The gateway performs no DDL.
3. Provision a least-privilege database account: `SELECT` on the allowlisted input tables; `SELECT` (for schema tests) and `INSERT` on the allowlisted result tables. MySQL output tables must use a transactional engine such as InnoDB.
4. Set `SQL_GATEWAY_TOKEN` to a randomly generated secret of 32–512 non-whitespace characters. Set `SQL_CONNECTIONS_JSON` to a JSON array matching `connections.example.json`, using real values from your secret manager. Do not commit the resulting credentials. `schema` is optional informational metadata; SQL table names are exact allowlist entries, never implicitly prefixed.
5. Run `npm start`. Defaults: `SQL_GATEWAY_HOST=127.0.0.1`, `SQL_GATEWAY_PORT=4180`.
6. Put an HTTPS reverse proxy in front of the gateway with a valid certificate, restricted network access, and a 2 MiB request limit. Configure the hosted app server's `SQL_GATEWAY_URL` and `SQL_GATEWAY_TOKEN` secrets. The token must match this gateway. The hosted app does not call plaintext production HTTP URLs.
7. An app administrator can discover the available connections and create input/output sources, then use the model's existing **Source Name** mappings. Test a source before selecting it for a run or schedule.

Each connection has `id`, `name`, `dialect` (`sqlserver`, `postgres`, or `mysql`), `host`, optional `port`, `database`, `user`, `password`, `readableTables`, and `writableTables`. Connection IDs start with an alphanumeric character and contain only letters, digits, `_`, and `-`; `constructor`, `prototype`, and `__proto__` are reserved. IDs are unique. Names are at most 160 characters. A gateway allows at most 32 connections and 100 tables per direction.

Table allowlists contain exact one- or two-part identifiers such as `dbo.mass_readings` or `public.reconciliation_results`. Names consist only of letters, digits, and underscores, beginning with a letter or underscore, with at most 64 characters per part. Select separate read-only and write-only connections when different database accounts are needed. An empty allowlist disables that direction.

TLS encryption and server certificate validation are enabled by default for all three drivers. For a private CA, set `tls: { "ca": "-----BEGIN CERTIFICATE-----\n..." }` in the connection's secret configuration. Generic TLS-disable/trust-certificate settings are rejected. `allowInsecureLocalDevelopment: true` is available only when the database host is exactly `localhost`, `127.0.0.1`, or `::1`, for a disposable local database; omit it for deployment. SQL Server uses TCP SQL authentication through the default Tedious driver; Windows integrated authentication is outside this initial connector.

## Input data

Input sources configure a table, tag column, numeric value column, timestamp column, and aggregation: `latest`, `sum`, `average`, `timeWeightedAverage`, or `totalizerDelta`. All three column names must be distinct; an optional historian quality column must also be distinct. Existing model **Source Name** values identify the tags; model names remain presentation labels. The source reading is interpreted in the mapped physical meter's configured unit and rate interval. Convert or reshape upstream data before it enters the table if its units differ. Virtual meters calculate after physical readings have been loaded.

Windows are ISO timestamps with an explicit timezone and use `[start, end)`: the start is included, the end excluded for ordinary aggregates. Weighted flow and totalizer reads additionally obtain the most recent timestamp per tag before the start (bounded by maximum reading age) and samples exactly at the end to support boundary calculations. All tied baseline records are retained so conflicting values fail. No post-period samples are fetched. A window must be nonempty and at most 366 days. Timestamp-without-timezone SQL Server/MySQL columns represent UTC; the drivers send and read UTC dates. PostgreSQL examples use `timestamptz`.

The gateway reads at most 10,001 ordered rows and rejects a batch exceeding 10,000 rows; use a smaller window or aggregate upstream. Each request supports at most 500 distinct tags of at most 200 characters. `latest` selects the newest timestamp per tag; different values tied at that timestamp fail. `sum` adds samples; `average` takes their arithmetic mean, without time weighting or integration. Both report the latest contributing timestamp. Missing tags, null/bool/blank/non-numeric/negative values, nonfinite results, invalid timestamps, and out-of-window rows fail the entire input request. Decimal and scientific-notation strings are accepted. The gateway does not silently substitute zero or partial data.

### Data-quality policy

Input sources can include the following `quality` object. New source configurations use these defaults; existing sources that omit it retain their original ordinary-aggregation behavior. The two advanced aggregations always apply quality defaults even if the object is omitted.

```json
{
  "maxAgeMinutes": 60,
  "minCoveragePercent": 100,
  "qualityColumn": null,
  "goodQualityValues": ["Good"],
  "badQualityPolicy": "reject",
  "interpolation": "step",
  "gapPolicy": "reject",
  "totalizerReset": "reject",
  "rolloverValue": null
}
```

Maximum reading age is greater than zero and at most 366 days; minimum coverage is 0–100%. Freshness compares the latest accepted timestamp with the **reporting period end**, so historical reruns do not become stale merely because they execute later. Coverage measures the fraction of period time supported by accepted readings, rather than a percentage of sample rows. Ordinary aggregates and step flow hold each accepted point only until the next point or its maximum age. Linear flow and counter intervals require consecutive accepted endpoints no farther apart than the maximum age.

If `qualityColumn` is configured, only the exact `goodQualityValues` whitelist is accepted. There are 1–32 distinct flags of at most 80 characters each. Finite integer SQL quality codes are converted to their text representation for matching (`192` matches a configured `"192"`); no vendor-specific interpretation is guessed. Missing or unfamiliar flags are bad. `badQualityPolicy: "reject"` fails the entire read; `"exclude"` retains the bad point as a gap barrier, so good samples on either side are never joined through it. An excluded bad-quality point may have an invalid numeric value; an accepted point must always have a valid nonnegative number. Conflicting values or acceptance states at any duplicate timestamp fail; identical quality-enabled records contribute once.

Every quality-enabled reading returns `quality: { coveragePercent, sampleCount, rejectedCount, latestTimestamp, resetCount, warnings }`. `sampleCount` counts unique accepted sample points including contributing boundary points; `rejectedCount` counts rejected raw records. Warnings record exclusion, extrapolation, boundary interpolation, and counter assumptions. Failed quality checks return a tag-specific safe error; they do not run reconciliation on partial readings.

### Time-weighted flow

`timeWeightedAverage` returns the mean flow rate over the reporting period. With duration `T`, its value is `integral(flow(t), start, end) / T`; the app converts the rate to period mass using the actual elapsed duration (including daylight-saving periods). Irregular sampling therefore changes time weights, not just the number of samples. `interpolation: "step"` uses bounded last-value hold; `"linear"` integrates straight-line segments with the trapezoidal rule, clipped to the period boundaries. Linear interpolation requires endpoint support; it does not extend the final reading indefinitely.

Flow gaps fail by default. To extrapolate, both set `gapPolicy: "scale"` and choose a minimum coverage that the period satisfies. The accepted time-weighted mean is then applied to the full period, and the uncovered percentage is recorded in a warning. The missing interval is an explicit estimation assumption, never an implicit zero or an unreported fill. This aggregation requires mapped physical meters configured as rates (`/h`). The advanced boundary query uses a common table expression; MySQL requires version 8 or later.

### Totalizer deltas

`totalizerDelta` sums increments of a cumulative quantity. Physical meters must use cumulative mass or volume units rather than rates; volume retains the model's configured density conversion. A valid start baseline and a reading exactly at the period end are required. A fresh sample before the start can bracket a later accepted sample to interpolate the starting counter value linearly; that assumption is recorded. Any missing or bad counter interval fails even when flow gap scaling is enabled, because a lost counter delta is unknown.

An observed decrease fails under `totalizerReset: "reject"`. Explicit `"restart"` assumes a reset to zero and counts the first value after the reset; any material accumulated between the previous sample and the reset remains unknown and is excluded, with an audit warning. Explicit `"rollover"` requires a positive `rolloverValue` (the modulus), requires counter values below it, and computes `modulus - previous + next` for each decrease. Its warning records the assumption of one wrap per observed decrease; multiple wraps or resets between samples cannot be detected. A decrease spanning an interpolated reporting boundary fails because its amount cannot be allocated to the period safely.

Upgrade the deployed gateway and app together when enabling quality or advanced aggregations. The gateway remains a separately operated plant-side service; publishing the app does not update it.

Exact SQL counter types reach aggregation as text before numeric coercion. Decimal/BIGINT strings are subtracted and summed with bounded decimal arithmetic before converting the transferred amount to a numeric model reading. For example, `9007199254740992` to `9007199254740993` transfers `1`, and a large decimal baseline can retain a small fractional transfer. Counters support at most 100 decimal digits/places and 256 source characters. Already rounded numeric counters outside the safe integer range, materially distorted fractional numeric deltas, and transferred amounts requiring unsupported numeric precision fail with `UNSUPPORTED_COUNTER_PRECISION`; they never return a successful zero. Interpolated start boundaries can produce repeating fractions using normal numeric precision, with an explicit interpolation warning.

Use exact database types such as BIGINT or DECIMAL for cumulative counters. Precision already lost in a FLOAT/REAL column cannot be recovered. PostgreSQL REAL/DOUBLE PRECISION and SQL Server REAL/FLOAT totalizer columns are explicitly rejected; MONEY values retain four decimal places. MySQL's driver preserves DECIMAL/BIGINT strings and returns approximate columns as native numbers, which must pass the numeric precision checks. If necessary, provide a database view with a deliberately defined exact decimal counter representation and verify its quantization against the instrument; the application cannot recover missing increments by casting. SQL Server MAX text types cannot be passed to `SQL_VARIANT_PROPERTY` and fail the query. Verify the intended column type with an input preview.

## Inventory boundary snapshots

The app automatically requests `inventoryBoundary` for measured storage endpoints, independently of the source's flow aggregation. A request has equal `start` and `end`, and the gateway queries exactly that timestamp with bound parameters. Opening reads the reporting-period start; closing reads its end. This special snapshot request does not permit an ordinary empty aggregation window.

Source values use the endpoint's configured mass, volume, or level unit. Opening and closing have separate mappings; the same tank sensor tag may serve both boundaries. The app rejects reuse of one inventory source across different storage units or physical flow meters to avoid treating duplicate evidence as independent. Reads use up to three groups per run: flows, opening snapshots, and closing snapshots.

Missing, conflicting, invalid, or rejected-quality boundary data fails. Identical acceptable duplicate records represent one sample. Configured quality flags apply at that instant; snapshot coverage is 100% only when an accepted exact sample exists. Bad flags cannot be bridged by interpolation. Inventory input never sums, averages, integrates, interpolates, carries forward stale readings, or falls back to saved manual readings. The app applies snapshots only to its detached run input and retains original values in input provenance.

Upgrade the app and gateway together for this contract. A previous gateway cannot supply the new snapshot mode. Existing normalized output tables need to admit the new metric strings and negative accumulation; review any plant-specific CHECK constraints before enabling storage output.

## Output data

Output is an append-only transaction with one row for each observable mapped stream and incoming/outgoing mass rows for each observable mapped process unit. Mapped storage units additionally include observable opening inventory, closing inventory, and signed accumulation. All mass fields are kilograms; inventories are boundary quantities, not flow rates. The canonical result table requires these columns:

| Column | Meaning |
| --- | --- |
| `run_id`, `model_id`, `model_name` | Run and model provenance |
| `published_version` | Publication number, or null for a draft run |
| `item_id`, `item_type` | Stable item ID; `stream` or `unit` |
| `source_name` | Model item’s mapped external name |
| `metric` | `mass` for streams; `incoming_mass`, `outgoing_mass`, `opening_inventory`, `closing_inventory`, or `accumulation` for units |
| `value_kg` | Reconciled mass |
| `raw_kg`, `correction_kg`, `uncertainty_kg` | Available source mass, adjustment, and 1σ uncertainty; otherwise null |
| `status` | `measured` or `estimated` for streams; `reconciled` for units/inventories; append `_questionable` when the run has warnings or is underdetermined |
| `batch_start`, `batch_end`, `finished_at` | UTC batch and completion timestamps |

The request must contain 1–1,500 rows from one consistent model run. Only `accumulation` can be negative. Unobservable values are not fabricated or exported. A unique key on `(run_id, item_type, item_id, metric)` prevents duplicate insertion of the same result. Statements are parameterized, sequential, and enclosed in a database transaction. A statement failure triggers rollback. Communication failure during/after `COMMIT` can leave a committed result without an acknowledgement; the app records output failure separately from the successful reconciliation. Before any manual replay, inspect destination rows by `run_id`. There is no automatic output retry, upsert, update, or delete endpoint.

Export quality uses the conservative `conservative-v1` policy: any reconciliation or input-quality warning, or an underdetermined model, marks every exported row questionable. This includes modeling-assumption warnings; observable numerical results remain usable for review. Only a successful run without warnings uses the original clean statuses. Failed/invalid runs and unobservable values are not exported. The run's output audit retains the verdict, original reconciliation status, and warning messages; CSV results also include these fields.

**Upgrade existing output tables before exporting warning results.** Deploy the updated gateway and extend the table's `status` CHECK constraint to accept `measured_questionable`, `estimated_questionable`, and `reconciled_questionable` alongside the three existing statuses. The existing `VARCHAR(32)`/`NVARCHAR(32)` column size and 16-column layout are unchanged. Updated examples in `schema/` contain the allowed values. Have the database administrator inspect and alter the existing constraint; do not drop or recreate a populated table. Consumers should treat the suffix as a review-required verdict and use the prefix as the item classification. An old gateway or restrictive constraint rejects the batch; the application never strips the quality flag to make delivery succeed.

Diagram node and stream IDs share the same portable contract on import, save, and connector export: 1–128 UTF-16 code units, without surrounding whitespace, control characters, or malformed Unicode. IDs travel unchanged; rejected model files need their IDs and connection references corrected before import.

Identity columns must use binary/case-sensitive comparisons that preserve distinct IDs such as `F1` and `f1`; the supplied output schemas declare these collations explicitly. For an existing table, ask the DBA to inspect identity-column collations and migrate them if necessary, checking indexes/constraints before changing a populated table. Model/source display names do not need these identity collations.

Before upgrading a workspace containing externally imported models, check draft and published model files for unsupported IDs. Standard UI-generated IDs already satisfy this contract. Repair nonportable IDs and their endpoint references in the prior application version, then republish the corrected model before upgrade. Keep a complete workspace backup; the new version rejects invalid persisted models rather than silently truncating IDs or altering their identity. Historical run snapshots remain audit records and should not be rewritten to disguise a migration.

The **Test connection** operation performs `SELECT ... WHERE 1 = 0` against input columns or the complete output schema. It proves connectivity and column accessibility, without inserting dummy results. It cannot prove INSERT permissions, output constraints, transactional engine behavior, or future availability; validate those with a real approved batch before operational use.

## HTTP contract

Every endpoint requires `Authorization: Bearer <SQL_GATEWAY_TOKEN>`. POST bodies use `Content-Type: application/json`. There is no CORS access; browsers use the authenticated app backend. Error responses are `{ "error": { "code": "...", "message": "..." } }`, with safe validation messages or a generic database error. Database server messages, queries, and credentials are not returned.

- `GET /connections` → `{ connections: [{ id, name, dialect, canRead, canWrite }] }`; no host/user/password.
- `POST /test` with `{ connectionId, direction, table, tagColumn?, valueColumn?, timestampColumn?, quality? }` → `{ ok: true }`. `direction` is `input` or `output`; input requires all three columns and tests the optional quality column.
- `POST /read` with `{ connectionId, table, tagColumn, valueColumn, timestampColumn, tags, start, end, aggregation, quality? }` → `{ readings: [{ sourceName, value, timestamp, quality? }], window: { start, end } }`.
- `POST /write` with `{ connectionId, table, rows: [canonicalResultRow] }` → `{ written: number }`.

Only generated SQL is supported. Table/column identifiers use the bounded grammar and exact table allowlists; all tags, dates, and result values are driver parameters. Requests are bounded by 2 MiB, a 20-second deadline, and eight concurrent operations; database statements have 10-second timeouts, and pools have at most four connections per configuration. Timed-out operations remain in the concurrency count until driver cancellation/rollback finishes. Driver sessions are discarded on abort where supported. Use reverse-proxy and database-side connection/query limits as additional operational controls.

## Verification

`npm test` covers generated SQL/parameter binding for all dialects, validation and aggregation, TLS defaults, HTTP authentication/limits/sanitization, cancellation, and transaction rollback through injected drivers. These are contract tests, not evidence of a connection to a plant database. Run `npm ci` and a source test against each intended database, then an approved batch plus destination-row inspection, before enabling scheduled production export.

Pinned versions were checked against the official npm registry on 2026-10-10: `mssql` 12.7.4, `pg` 8.23.1, and `mysql2` 3.24.5. The current SQL Server dependency tree reports [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) for transitive `sprintf-js` 1.1.3 (no patched release available at that check). Its vulnerable input is an attacker-controlled format string; the installed Tedious call sites use fixed format strings, and this gateway exposes no format-string input. The advisory remains an operational dependency-review item; the lockfile is not claimed audit-clean. Avoid driver debugging that logs connection payloads, and update/re-audit when upstream publishes a fix.
