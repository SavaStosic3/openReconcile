# Release checklist

Use this checklist for each release. Check an item only when its evidence is recorded for that release; local tests do not establish production readiness. Keep any incomplete operational checks visible.

Record: GitHub commit, Sites source commit, artifact/version ID, deployment URL, check date, and outstanding issues. Keep secrets and plant data out of release notes.

## Code and deployment

- [ ] Run `npm test`, `npm run typecheck`, and `npm run build` on the final source; record results and any limitations.
- [ ] Review the diff, documentation, and license notices; exclude secrets, local database state, and generated runtime files from Git.
- [ ] Commit and push to the intended GitHub branch. Confirm the local tree is clean and its commit matches the remote.
- [ ] Confirm the Sites source checkout matches the reviewed source, and package the build produced from that source. Record both source commits and the artifact/version ID.
- [ ] Preserve the existing project ID, database binding, audience, and authentication configuration unless the release explicitly changes them.
- [ ] Deploy that saved version, confirm a successful deployment, and check the live URL and served assets. Record which checks ran locally and which ran on the live application.

## Data and access

- [ ] Review pending ordered migrations and their metadata. Keep applied migrations unchanged; use schema-only migrations and bounded, separate initialization when needed. Never seed or replace existing plant data as part of deployment.
- [ ] Verify a migration against an existing-data copy preserves models, published snapshots, grants, schedules, and runs. Check that only pending migrations are applied by the host.
- [ ] Confirm an authorized database backup/export and a tested restoration procedure are available for the release. Model JSON export alone does not back up users, grants, schedules, or run history.
- [ ] Record the previous deployed version and a rollback/recovery plan compatible with the new database schema. Confirm who can execute it.
- [ ] Check signed-out API denial and real sign-in through the trusted Sites authentication dispatch. Keep local simulated identities and administrator secrets out of the deployed client.
- [ ] Exercise administrator, editor, operator, viewer, disabled-account, and no-model-grant access. Confirm backend enforcement, editing/unpublishing locks, and administrator-only deletion/restoration.

## Reconciliation and model workflow

- [ ] Reconcile a known example: feed/outlet readings `100/60/35 kg`, uncertainties `1/2/2 kg`, produce `99.444444/62.222222/37.222222 kg`; the internal flow is `99.444444 kg`. Check unit closure and displayed rounding.
- [ ] Confirm inferred, unobservable, invalid, and failed-run states do not present fabricated values. Check saved history and results export.
- [ ] Edit and test a draft while its published copy and published results remain unchanged. Publish changes; the new version must await its own run before displaying values.
- [ ] Run the publication, reopen it, and inspect stream masses and incoming/outgoing totals above symbols. Confirm the results belong to that publication version and input snapshot.
- [ ] Drag common equipment symbols, connect their ports, move units, and change a symbol. Confirm connection endpoints and properties survive saving and reopening.
- [ ] Test an enabled schedule with an eligible browser session open; confirm a due run uses the publication and two sessions cannot claim the same occurrence. Confirm overdue reopening runs once, and unpublishing/deleting pauses the schedule. Record that unattended scheduling is not supported.

## Data mapping

- [ ] Open **Data Mapping** from the hamburger menu and confirm it lists only the selected model's items with their current **Model Name** and **Source Name**. Set, change, and clear a source name from both that page and a unit/stream's edit menu; confirm both interfaces show the same mapping.
- [ ] Map a unit, a physical meter, a virtual meter, and an unmetered stream. Rename items and meters; mappings must remain attached to their stable IDs while Model Name updates. Delete an item and undo/redo the change; confirm its mapping follows the item without leaving a stale row.
- [ ] Check mapping input validation and rendering of names containing punctuation or markup. Confirm invalid mapping metadata is rejected by model validation and the backend, and identifiers render as text.
- [ ] Save, reopen, duplicate, and JSON-export/import mapped models. Confirm names are retained and mappings do not leak between models. Keep credentials and connection strings out of mapping fields and exported model data.
- [ ] Exercise administrator/editor editing, operator/viewer read-only access, no model grant, and editing locks. Confirm the backend rejects unauthorized or stale mapping writes even if client controls are bypassed.
- [ ] Edit a draft mapping while its publication and saved results remain unchanged. Publish changes and confirm the publication has the updated mapping; published mapping controls must be read-only and retained run snapshots must preserve their own mappings.
- [ ] Confirm saving or clearing a mapping does not itself retrieve external data, overwrite manual readings, alter virtual formulas, or send results. Connector execution must occur only through an explicit preview/test or a selected-source reconciliation workflow.

## SQL connectors

Local verification on 2026-10-10: the combined suite passed 243 tests, including gateway driver/HTTP contracts and API/UI ordering regressions. Type checking and the production build passed. Browser checks used simulated local sign-in and an injected-driver gateway: source setup/test/preview, fresh physical and virtual readings, six acknowledged output rows, diagram/inspector results, denied-table errors, retained reconciliation after output failure, schedule pause after selected-source changes, and a 360px settings layout without page overflow. These checks do not establish a live connection to any plant database; operational gates below remain open.

- [ ] Run the gateway's own tests and review the pinned `mssql`, `pg`, and `mysql2` dependency/lockfile changes. Distinguish driver-adapter tests from a real connection to each supported database engine.
- [ ] Configure the gateway in an authorized environment and set its connection registry, encrypted database connections, least-privilege database accounts, and explicit `readableTables`/`writableTables` allowlists. Configure the app's server-only `SQL_GATEWAY_URL` and matching `SQL_GATEWAY_TOKEN`; verify neither these tokens nor database credentials appear in the browser, model metadata/exports, Git, logs, or API errors.
- [ ] Confirm the gateway rejects absent/invalid authentication, unknown connection IDs, invalid identifiers, unauthorized tables, oversized requests, and unexpected operations. Verify values/tags are bound parameters, table/column identifiers are validated and quoted for their dialect, and arbitrary SQL text is not accepted.
- [ ] Exercise administrator-only SQL source configuration, connection tests, and input previews. Check viewer/operator/editor/disabled/no-grant denial on those API routes, editing-lock enforcement on configuration writes, revision conflicts, model isolation, and that permitted operators can execute a model's already configured workflow.
- [ ] Create input/output sources from **SQL Connectors**, reopen them, and select them in **Model Management**. Check a missing gateway/connection produces an actionable configuration error rather than a successful test or invented readings. Connection tests and input previews must perform no destination writes; preview must not modify the saved model or create a reconciliation run.
- [ ] Read known tag/value/timestamp data using Latest, Sum, and Average over `[startedAt − periodHours, startedAt)`. Verify inclusive start/exclusive end, UTC timestamp handling, duplicate-latest behavior, required physical-meter mappings, missing tags, empty intervals, nonnumeric/nonfinite/negative values, invalid timestamps, query limits, and unsupported data formats. Verify input values are interpreted in each meter's configured unit and no automatic conversion is claimed.
- [ ] Run with SQL input and virtual-meter dependencies. Confirm formulas use freshly read physical values, no stale manual fallback occurs, and only the detached run snapshot changes. Check selected draft/publication mappings, retained snapshots, and browser result matching when input values differ from saved manual readings. A failed latest input must show failure rather than silently retaining prior success. Changing the selected input/source configuration must clear mismatched results, while output-only changes preserve calculated values and historical delivery provenance.
- [ ] Write known mapped stream and unit results to the normalized destination schema. Check kg-per-batch units, original/input/reconciled distinctions, source names, item/run/model/publication identifiers, unresolved flows, and delivery row count. Force a mid-write database error and verify the entire output transaction rolls back while the computed reconciliation remains visible in run history with a delivery failure. Distinguish database rollback from a lost acknowledgement after commit; verify the documented run-ID inspection procedure before any replay.
- [ ] Run the configured input/output workflow manually and through an eligible browser-triggered schedule. Check one due occurrence is claimed across sessions and failure history remains usable. Document that automatic retries, duplicate replay handling, and unattended scheduling are not implemented.
- [ ] Change a current SQL source configuration without republishing; confirm subsequent runs selecting it use the new operational configuration while diagram mappings still come from the chosen draft/publication snapshot. Changing or removing a selected source must pause the schedule; removal must also clear the affected source selection and require deliberate workflow/schedule confirmation before resuming.
- [ ] Record real database/server/network smoke checks separately from mocks, simulated local sign-in, and frontend deployment. Do not mark actual plant integration complete until an authorized database has supplied inputs and accepted checked outputs.

## Virtual meters

- [ ] Open meter settings, switch between **Physical** and **Virtual**, name meters, and enter formulas using `[Meter name]`, arithmetic, parentheses, unary signs, and `^` exponentiation. Confirm exact, case-sensitive, trimmed name matching and read-only calculated virtual readings on Measurements.
- [ ] Test a physical-to-virtual dependency and a virtual-to-virtual chain. Change the source reading; confirm every dependent value changes and reconciliation uses the new readings.
- [ ] Check explicit unit conversion, for example `[Feed t/h] * 1000` into kg/h, and subsequent batch-duration/density conversion. Confirm references use original readings rather than reconciled values.
- [ ] Check duplicate and missing names, circular dependencies, incomplete formulas, division by zero, and nonfinite/negative outputs. Invalid formulas may be saved in a draft but must block a run with an actionable meter-specific error.
- [ ] Verify the arithmetic parser rejects code execution, property access, unsupported functions, and excessive expressions. Confirm the server recomputes virtual readings instead of accepting a submitted calculated value.
- [ ] Verify first-order uncertainty propagation and covariance against an independent analytical example with shared physical inputs. Confirm virtual meters do not double-count that shared evidence, configured positive calculation error has the documented effect, and zero readings require absolute uncertainty. Confirm physical-only reconciliation retains its existing analytical results.
- [ ] Save, reopen, duplicate, and JSON-export/import a model with formulas. Edit a draft formula without changing its publication; publish changes and confirm each manual/scheduled run evaluates the correct snapshot and retains its input/result provenance.

## Hidden lines and diagram usability

- [ ] Hide a line from its inspector and context menu. **Hidden lines** must list only hidden streams with their endpoints and a **Restore** button; visible streams must not appear in that list.
- [ ] Restore one line, use **Restore all**, and confirm the empty state reads clearly. Toggle **Show hidden lines** to reveal hidden streams temporarily without clearing their hidden preference.
- [ ] Repeat in the read-only published view. Confirm hiding/restoring does not edit the model, change its publication version, invalidate results, or remove streams from reconciliation or exports.
- [ ] Reopen the app and switch accounts/models; confirm preferences persist per account/model in that browser, without leaking between accounts or models.
- [ ] Check bridge bumps at perpendicular crossings, no bumps at real shared ports/touching endpoints, and updated bridges after moving or hiding a line.
- [ ] Check keyboard access, focus after restoring a row, accessible control names, and narrow layouts. Confirm diagram controls and published result labels remain usable.

## Application copy

- [ ] Review sign-in, navigation, empty states, dialogs, measurements, results, and settings for clear product wording. Keep demo, MVP, prototype, and future-feature promises out of the application interface.
- [ ] Confirm **Load template** creates a separate **Feed and separation** model, and **Reset template readings** restores its preset readings. Retain existing user-defined model names.
- [ ] Confirm operational requirements remain clear: total-mass conservation without accumulation, fixed conversion properties, browser-session scheduling, and SQL gateway configuration.
- [ ] Review results and settings layouts for clipped or overflowing labels, and keep the README and roadmap action names aligned with the interface.

## Closeout

- [ ] Update the README, roadmap, and release notes to match delivered behavior and current limits.
- [ ] Record remaining operational or live checks and assign follow-up work. Do not mark a release ready based only on local automated checks.
