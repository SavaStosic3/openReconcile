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

## Username/password sign-in

Local evidence on 2026-10-10: **316 tests passed**, including 16 backend authentication and six login-controller tests. Type checking and the production build passed. An independent scoped authentication review found no remaining actionable defects. Migration `0002` applied successfully to the existing local database without replacing models. The sign-in form was checked at desktop and 390px widths with no horizontal overflow. Hosted sign-in and account provisioning are verified separately after deployment.

- [ ] Apply migration `0002` to an existing-data copy. Verify models, publication snapshots, grants, schedules, runs, and existing ChatGPT accounts are preserved.
- [ ] Configure the initial username, salted password hash, and server-only pepper through runtime configuration. Keep plaintext passwords, hashes, pepper, session cookies, and database state out of Git, browser storage, client bundles, logs, and release notes.
- [ ] Verify successful sign-in, generic wrong-password/unknown/disabled-account errors, case-insensitive usernames, bounded requests, same-origin JSON enforcement, and atomic per-username/per-IP rate limits.
- [ ] Check Secure/HttpOnly/SameSite cookies, hashed session-token storage, eight-hour expiry, stale/duplicate/invalid cookie denial, revocation on sign-out, and invalidation after account changes. Invalid password sessions must not fall back to a different ChatGPT identity.
- [ ] Verify bootstrap does not reset, promote, or re-enable existing accounts. Check backend model permissions for password accounts and that changing roles or disabling a user takes effect without trusting client controls.
- [ ] Open `?signin=1`, sign in, and verify the retained model/view opens under the intended account. Check keyboard access, accessible error/status messages, password clearing, and narrow layouts.
- [ ] Check real hosted username/password sign-in without ChatGPT authentication, administrator model access, sign-out denial, and explicit ChatGPT sign-in for an existing account. Record live checks separately from local simulated identities and automated tests.
- [ ] Exercise administrator, editor, operator, viewer, disabled-account, and no-model-grant access. Confirm backend enforcement, editing/unpublishing locks, and administrator-only deletion/restoration.

## Reconciliation and model workflow

- [ ] Reconcile a known example: feed/outlet readings `100/60/35 kg`, uncertainties `1/2/2 kg`, produce `99.444444/62.222222/37.222222 kg`; the internal flow is `99.444444 kg`. Check unit closure and displayed rounding.
- [ ] Confirm inferred, unobservable, invalid, and failed-run states do not present fabricated values. Check saved history and results export.
- [ ] Edit and test a draft while its published copy and published results remain unchanged. Publish changes; the new version must await its own run before displaying values.
- [ ] Run the publication, reopen it, and inspect stream masses and incoming/outgoing totals above symbols. Confirm the results belong to that publication version and input snapshot.
- [ ] Drag common equipment symbols, connect their ports, move units, and change a symbol. Confirm connection endpoints and properties survive saving and reopening.
- [ ] Test an enabled schedule with an eligible browser session open; confirm a due run uses the publication and two sessions cannot claim the same occurrence. Confirm overdue reopening runs once, and unpublishing/deleting pauses the schedule. Record that unattended scheduling is not supported.

## Audit history and retention

Local verification on 2026-10-10: **366 application tests** passed, including 50 audit backend, diff, and UI checks. Type checking and the production build passed. Migration `0003` applied successfully to the existing local D1 workspace. A separate local verification model produced the expected measurement/mapping records and three physical-reading points (110, 105, 108 kg). Browser checks confirmed model/text/category filtering, expanded before/after details, the chart and change table, shortening confirmation with cancellation, and a narrow page without document overflow. Reconciliation history remains capped at 20 runs. These checks use simulated local sign-in and synthetic readings; they do not establish real plant validation or backup/restore readiness. Hosted verification is recorded separately after publication.

- [ ] Apply migration `0003` to an existing-data copy and verify users, models, publication snapshots, grants, schedules, and the latest-20-run history are preserved. Verify no existing changes are presented as reconstructed history.
- [ ] Change physical readings, uncertainty/units, virtual formulas, item mappings, model properties, schedules, connector configuration, publication/protection, account roles/status, and model grants. Check actor, timestamp, exact before/after values, and relevant revisions. Verify no-op saves and denied/stale writes create no records.
- [ ] Force an audit-write failure and verify the associated application mutation rolls back. Exercise concurrent revisions and grants/account changes; records must describe the state actually changed, without duplicate or misleading before values.
- [ ] Search by model, actor, category, text, and UTC date bounds. Check chronological/keyset pagination, equal-timestamp records, literal wildcard characters, invalid query values, and large edits split into complete bounded records.
- [ ] Verify current role/model permissions for history, actor/filter metadata, and reading trends. Non-admins must not access unassigned/deleted models or global account/retention events. Revocation and disabled accounts must clear cached history and reject new requests.
- [ ] Check physical-reading trends against independent examples: zero, clearing/removal, unit/metric changes, rename, and more than 500 points. Verify timestamp and original-unit labels, disconnected series, accessible values, and the truncation notice. Virtual caches, detached SQL inputs, and reconciliation runs must not create reading-change points.
- [ ] Configure 365-day default, custom retention, and indefinite retention. Verify administrator-only writes, revision conflicts, explicit shortening confirmation, immediate query exclusion, bounded deletion/cascades, and that extending retention cannot recover deleted records. Do not change or prune `model_runs` through audit retention.
- [ ] Check loading, empty, errors, interrupted requests, expanding details, load-more navigation, keyboard access, and narrow layouts. Keep secrets, credential objects, and full model/run snapshots out of audit records, API responses, and exports.
- [ ] Record automated/local checks and a hosted audit-page smoke test separately; preserve live plant models while testing. Include audit tables in the authorized database backup and restoration procedure.

## Data mapping

- [ ] Open **Data Mapping** from the hamburger menu and confirm it lists only the selected model's items with their current **Model Name** and **Source Name**. Set, change, and clear a source name from both that page and a unit/stream's edit menu; confirm both interfaces show the same mapping.
- [ ] Map a unit, a physical meter, a virtual meter, and an unmetered stream. Rename items and meters; mappings must remain attached to their stable IDs while Model Name updates. Delete an item and undo/redo the change; confirm its mapping follows the item without leaving a stale row.
- [ ] Check mapping input validation and rendering of names containing punctuation or markup. Confirm invalid mapping metadata is rejected by model validation and the backend, and identifiers render as text.
- [ ] Save, reopen, duplicate, and JSON-export/import mapped models. Confirm names are retained and mappings do not leak between models. Keep credentials and connection strings out of mapping fields and exported model data.
- [ ] Exercise administrator/editor editing, operator/viewer read-only access, no model grant, and editing locks. Confirm the backend rejects unauthorized or stale mapping writes even if client controls are bypassed.
- [ ] Edit a draft mapping while its publication and saved results remain unchanged. Publish changes and confirm the publication has the updated mapping; published mapping controls must be read-only and retained run snapshots must preserve their own mappings.
- [ ] Confirm saving or clearing a mapping does not itself retrieve external data, overwrite manual readings, alter virtual formulas, or send results. Connector execution must occur only through an explicit preview/test or a selected-source reconciliation workflow.

## SQL connectors

Previous SQL-integration verification on 2026-10-10: the combined suite passed 243 tests, including gateway driver/HTTP contracts and API/UI ordering regressions. Type checking and the production build passed. Browser checks used simulated local sign-in and an injected-driver gateway: source setup/test/preview, fresh physical and virtual readings, six acknowledged output rows, diagram/inspector results, denied-table errors, retained reconciliation after output failure, schedule pause after selected-source changes, and a 360px settings layout without page overflow. These checks do not establish a live connection to any plant database, and do not replace checks of the reporting-period release; operational gates below remain open.

- [ ] Run the gateway's own tests and review the pinned `mssql`, `pg`, and `mysql2` dependency/lockfile changes. Distinguish driver-adapter tests from a real connection to each supported database engine.
- [ ] Configure the gateway in an authorized environment and set its connection registry, encrypted database connections, least-privilege database accounts, and explicit `readableTables`/`writableTables` allowlists. Configure the app's server-only `SQL_GATEWAY_URL` and matching `SQL_GATEWAY_TOKEN`; verify neither these tokens nor database credentials appear in the browser, model metadata/exports, Git, logs, or API errors.
- [ ] Confirm the gateway rejects absent/invalid authentication, unknown connection IDs, invalid identifiers, unauthorized tables, oversized requests, and unexpected operations. Verify values/tags are bound parameters, table/column identifiers are validated and quoted for their dialect, and arbitrary SQL text is not accepted.
- [ ] Exercise administrator-only SQL source configuration, connection tests, and input previews. Check viewer/operator/editor/disabled/no-grant denial on those API routes, editing-lock enforcement on configuration writes, revision conflicts, model isolation, and that permitted operators can execute a model's already configured workflow.
- [ ] Create input/output sources from **SQL Connectors**, reopen them, and select them in **Model Management**. Check a missing gateway/connection produces an actionable configuration error rather than a successful test or invented readings. Connection tests and input previews must perform no destination writes; preview must not modify the saved model or create a reconciliation run.
- [ ] Read known tag/value/timestamp data using Latest, Sum, and Average over the selected completed `[period.start, period.end)`. Verify inclusive start/exclusive end, UTC timestamp handling, duplicate-latest behavior, required physical-meter mappings, missing tags, empty intervals, nonnumeric/nonfinite/negative values, invalid timestamps, query limits, and unsupported data formats. Verify input values are interpreted in each meter's configured unit and no automatic conversion is claimed.
- [ ] Run with SQL input and virtual-meter dependencies. Confirm formulas use freshly read physical values, no stale manual fallback occurs, and only the detached run snapshot changes. Check selected draft/publication mappings, retained snapshots, and browser result matching when input values differ from saved manual readings. A failed latest input must show failure rather than silently retaining prior success. Changing the selected input/source configuration must clear mismatched results, while output-only changes preserve calculated values and historical delivery provenance.
- [ ] Write known mapped stream and unit results to the normalized destination schema. Check kg-per-batch units, original/input/reconciled distinctions, source names, item/run/model/publication identifiers, unresolved flows, and delivery row count. Force a mid-write database error and verify the entire output transaction rolls back while the computed reconciliation remains visible in run history with a delivery failure. Distinguish database rollback from a lost acknowledgement after commit; verify the documented run-ID inspection procedure before any replay.
- [ ] Run the configured input/output workflow manually and through an eligible browser-triggered schedule. Check one due occurrence is claimed across sessions and failure history remains usable. Document that automatic retries, duplicate replay handling, and unattended scheduling are not implemented.
- [ ] Change a current SQL source configuration without republishing; confirm subsequent runs selecting it use the new operational configuration while diagram mappings still come from the chosen draft/publication snapshot. Changing or removing a selected source must pause the schedule; removal must also clear the affected source selection and require deliberate workflow/schedule confirmation before resuming.
- [ ] Record real database/server/network smoke checks separately from mocks, simulated local sign-in, and frontend deployment. Do not mark actual plant integration complete until an authorized database has supplied inputs and accepted checked outputs.

## Reporting periods and data quality

Local evidence on 2026-10-10: the final `npm test` suite passed **289 tests**, including period/DST calculations, analytical integration/counter examples, SQL gateway HTTP contracts, backend quality failures and rerun persistence, permissions, and UI controller ordering. `npm run typecheck` and `npm run build` passed. Browser verification used simulated local sign-in and a synthetic injected-driver gateway: configurable Toronto shifts and late-data allowance saved/reopened; a historical 2.5-hour custom batch ran and reran; weighted SQL preview showed analytically expected 113.333 kg/h and 100% coverage; published reconciliation acknowledged four output rows; a bad historian flag blocked reconciliation and output, and a corrected-data rerun recovered. Results and Model Management had no page overflow at a 390px viewport. Preview images are local QA evidence, not real plant validation. Live publication is recorded separately after deployment.

- [x] Verify completed calendar hours/days, configurable day/shift cutoffs, 8-hour shifts starting at 06:00, UTC defaults, late-data allowance, historical selections and manual kind overrides. Check actual elapsed durations across 23/25-hour days, 7/9-hour shifts, repeated hours, nonexistent cutoffs, half-hour DST, and non-whole-hour zone offsets. Covered by the focused test command above.
- [x] Verify optional reporting settings survive catalog save/load and schedule advancement while existing schedules retain their legacy shape. Reject unsupported time zones, shift lengths, timestamps, incomplete/future selections, and periods longer than 366 days. Covered by the focused test command above.
- [x] Run the final full application and gateway tests, type checking, and production build. Recorded above; gateway driver/HTTP tests use injected drivers rather than real database engines.
- [ ] In the browser, configure reporting time zone, day cutoff, shift start/length, batch duration, and late-data allowance. Confirm saved settings reopen correctly and respect editor/administrator permissions, publication requirements, and model locks.
- [ ] Select hour/day/shift/batch, recent periods, and an older/custom interval in both the workbench and Model Management. Confirm UTC custom inputs and configured-zone labels describe the same interval; current/future and misaligned calendar periods must fail. Check keyboard access, dialog focus, and narrow layouts.
- [ ] At 10:07 local, confirm the selected hourly period is 09:00–10:00. With a 15-minute allowance, confirm it waits until 10:15. Check scheduled runs use the saved reporting kind rather than a manual override, and still require an eligible open browser session.
- [x] Compare input preview, saved run metadata, actual `periodHours`, flow-rate conversion, and SQL output `batch_start`/`batch_end`. All describe the same exact period, including daylight saving transitions and custom batches. API tests and the local synthetic browser workflow preserve saved readings and baseline durations.
- [ ] Add late/corrected source data and rerun the same period. Confirm a new run links to the previous retained run, rereads the source, preserves earlier input/results, and uses a new output run ID. Check failures remain visible. Record the 20-run retention limit and absence of automatic backfill or delivery retries.
- [ ] Configure maximum reading age and temporal coverage. Check historical staleness relative to the period end, not today's clock; missing, stale, ambiguous, or insufficiently covered readings must fail without a manual fallback. Confirm legacy sources without quality settings still run with their earlier behavior.
- [ ] Configure an optional historian quality column and accepted string flags. Test rejection and explicit exclusion, including an excluded point between good samples. Exclusion must leave a coverage gap and must not bridge bad data. Review coverage, sample/exclusion counts, latest timestamps, resets, and warnings in preview and retained input audits.
- [x] Validate time-weighted flow using independently calculated irregular step and linear examples. Require rate units; test fresh pre-start seeds, end-boundary samples, stale gaps, threshold failures, and explicit scaling warnings. Analytical and backend tests verify actual elapsed duration is applied exactly once.
- [x] Validate counter differences with a start baseline and exact end reading. Require cumulative quantity units; test missing boundaries, start interpolation, unknown gaps, decrease rejection, explicit zero-reset assumptions, rollover modulus, and a reset across an interpolated boundary. Analytical and gateway tests reject unknown counter gaps and retain reset/rollover warnings; real counter datasets remain an operational check.
- [ ] Run period/quality workflows against each authorized real database engine and known plant datasets before plant reporting. Keep driver mocks, local sign-in, and browser checks separate from real historian quality conventions, reset behavior, schema compatibility, network access, and plant accuracy.

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
- [ ] Confirm **Load template** creates a separate **Slurry filtration with recycle** model and preserves existing models. Verify the [analytical reference](examples/showcase-model.md): one-hour external inputs `804 + 201 kg`, outputs `900 + 105 kg`, recycle `51 kg`, mixed/filter feed `1,056 kg`, and zero unit residuals. Confirm **Reset template readings** restores physical presets for this template and the legacy **Feed and separation** template without replacing virtual formulas or the reporting period.
- [ ] Confirm operational requirements remain clear: total-mass conservation without accumulation, fixed conversion properties, browser-session scheduling, and SQL gateway configuration.
- [ ] Review results and settings layouts for clipped or overflowing labels, and keep the README and roadmap action names aligned with the interface.
- [ ] Check stream and unit settings with optional labels, physical and virtual meters, and source mappings. Paired controls must align on desktop; narrow dialogs must stack fields without horizontal overflow. Confirm uncertainty controls fit their column and line actions remain grouped at the left of the stream footer.

Local verification on 2026-10-10: **294 tests** passed, including five independent checks of the filtration showcase, every unit/boundary balance, a consistent baseline, and elapsed-duration scaling. Type checking and the production build passed. Browser checks with local simulated sign-in confirmed template creation, physical-reading reset, the expected one-hour draft and published reconciliation, and visible results on the diagram. Physical/virtual stream settings aligned on desktop and stacked without dialog overflow at 390px; unit mapping labels were checked. These checks do not establish real plant or connector validation.

Live browser verification on 2026-10-10: the filtration showcase was created, published, and reconciled through the authenticated production workspace. Published model version 2 displays the expected one-hour stream values, three inferred flows, objective `0.4`, and zero closing error at all five units. The wash-water inlet was moved clear of result labels. Stream settings show aligned optional labels, reading/uncertainty fields, and source mappings. The earlier user-created model was retained. This run used supplied rate readings, with no external input/output connector configured.

## Closeout

- [ ] Update the README, roadmap, and release notes to match delivered behavior and current limits.
- [ ] Record remaining operational or live checks and assign follow-up work. Do not mark a release ready based only on local automated checks.
