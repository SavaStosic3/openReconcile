# openReconcile — visual mass balance reconciliation

openReconcile is a standalone, MIT-licensed web workbench for building a physical process flowsheet, entering hourly/daily measurements, and reconciling total mass. Its MassFlow interface pairs a visual process editor with a constrained weighted least-squares solver, authenticated accounts, and a shared model workspace.

See the [feature roadmap](ROADMAP.md) for planned capabilities and enhancements.

## Run locally

Requires Node.js 22.13 or later. The application uses a Workers backend, D1 database, and the Sites authentication integration. Frontend assets live in `public/`; `dist/` is generated build output.

```powershell
npm ci
'ADMIN_EMAIL=seedy@sites.test' | Set-Content .dev.vars
npm run build
npx wrangler d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file ./drizzle/0000_complete_random.sql
npx wrangler d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file ./drizzle/0001_published_snapshots.sql
npm run dev
```

Apply both SQL migrations once, in order, to an empty local database. For an existing database initialized with `0000`, apply only `0001`; it preserves current models, grants, schedules, and runs. The explicit persistence path shares the database with the development server. Open the loopback URL printed by the development server, normally http://127.0.0.1:5173. The development server binds to this computer; its local sign-in simulates `seedy@sites.test`. This is a development identity, and the `.dev.vars` file is excluded from Git. Production authentication uses the hosting provider's verified identity, without the local simulation.

## Hosted authentication and database setup

The hosted application signs users in with ChatGPT through Sites. Its API stores users, model grants, models, schedules, and run snapshots in the D1 `DB` binding. Reconciliation runs on the server using saved model measurements.

For a new deployment, create a Sites project, set its project ID in `.openai/hosting.json`, provision the `DB` binding, apply the ordered SQL files in `drizzle/` through the host's D1 migration service, and configure `ADMIN_EMAIL` as a server runtime secret before the intended administrator's first sign-in. Publish the built application through Sites. Existing deployments apply only pending migrations. The generated configuration's database ID is a local development placeholder; the host supplies the production binding.

Only the verified identity matching `ADMIN_EMAIL` receives the initial administrator role when its account is inserted. Other first-time users become viewers with no model access until an administrator assigns grants. The first visitor does not become an administrator. Changing the secret does not promote an existing account or re-enable a disabled account; an existing administrator or an authorized database migration must handle those changes.

The production backend must be reached through the trusted Sites authentication dispatch. `app/chatgpt-auth.ts` reads the identity supplied by that dispatch; those headers must never be accepted directly from an untrusted client. When adapting the project to another host or identity provider, replace that integration with server-verified sessions or tokens and retain this trust boundary. A direct public Worker or an unauthenticated static server is not an equivalent deployment.

## The two-minute workflow

1. Sign in and open an assigned model, or create one with an editor/administrator account. Drag a pump, valve, heat exchanger, or another process-unit symbol from the toolbox onto the canvas. Click-to-add is also available. Add red inflow/outflow triangles for every external material path.
2. Drag the right port of a source to the left port of a destination. Alternatively, select Connect and click the source then destination. Drag units to reposition them; lines update automatically.
3. Right-click or double-click a stream. Set its name, material, phase, density, temperature, and pressure. Enable a meter and choose **Physical** or **Virtual**, mass/volume, transferred quantity/flow rate, and units. A virtual meter takes a formula using references such as `[Feed meter]`. Double-click a unit to change its name or equipment symbol.
4. Enter physical readings and one-standard-deviation uncertainties on Measurements; virtual readings are calculated. Pick a 1-hour, 24-hour, or custom batch duration. **Test draft reconciliation** checks your working draft. Choose **Publish model** or **Publish changes**, then run the published version to show results above its symbols and on its flow lines.

Unmetered streams can be inferred only when the measurements and network uniquely determine them. Otherwise they are clearly marked as needing a measurement. **Load template** creates **Slurry filtration with recycle**, a verified network with nine symbols, five physical meters, one virtual meter, and three inferred streams. For one hour, its reconciled external balance is **804 kg raw feed + 201 kg wash water = 900 kg product + 105 kg wet filter cake**. A deliberate 10 kg/h meter discrepancy illustrates uncertainty-weighted corrections; the recycle and correlated virtual sum exercise the same solver used for plant models. See the [walkthrough and analytical reference values](examples/showcase-model.md), or import the [model JSON](examples/showcase-model.json). **Reset template readings** restores the physical input readings while retaining the selected reporting period. The smaller feed-and-separation analytical fixture remains in the automated tests.

## Editing and saving

- Mouse wheel zooms. Pan mode or middle-drag moves the viewport. Fit frames the current model.
- Select a unit or stream and press Delete to remove it. Enter edits the selection. Arrow keys move focused units (Shift for larger increments). V/C/H select the canvas tools.
- Undo/redo retain the last 100 model states. Ctrl+Z and Ctrl+Shift+Z work outside text fields.
- Models are autosaved to the shared backend with separate identities, measurements, schedules, and run histories. New model, Load template, and Import add draft models and preserve existing models. Creating models requires an editor or administrator account.
- Open the hamburger menu and choose **Model Management** to select, open, create, or duplicate a saved model. A duplicate starts with scheduling disabled and empty run history.
- The backend checks permissions and model revisions before saving. A stale edit is rejected rather than overwriting someone else's changes; export your unsaved draft, then refresh the workspace. Revision checks support concurrent editing and are not a browsable model version history.
- Earlier browser data is retained locally and is not uploaded automatically. **Import browser models** asks before importing the last single-model autosave into the shared workspace. Use JSON export/import for additional models from the previous browser library. Export files also provide portable backups.
- Export model saves a JSON file including all properties and readings. Import adds a model from that format. Export results produces CSV with normalized masses and estimated uncertainties.

## Data mapping

Open **Data Mapping** in the hamburger menu to map items in the selected model. Each row shows a **Model Name** and an optional **Source Name**. Model Name comes from the current unit name or meter name, with the stream name used when there is no separate meter name. Source Name identifies the corresponding field in an external source, such as a historian tag or CSV column. You can also set Source Name in a unit's edit menu or a stream's material and meter menu; streams can have a mapping before a meter is enabled.

Mappings belong to each item's stable model ID. Renaming an item updates its displayed Model Name while retaining its Source Name; deleting the item removes its mapping. An empty Source Name leaves the item unmapped. The fields retain their contents through saving, reopening, duplication, and JSON import/export. Mapping edits use the existing model edit permissions, editing locks, revision checks, and undo/redo behavior.

The Data Mapping page edits the working draft. A published model's mappings are read-only and remain part of its publication snapshot until changes are published. Editing a draft mapping does not change the active publication or its saved results.

Saving a Source Name does not itself retrieve data, change a reading, or deliver results. SQL input and output connectors use those mappings when selected for a run. Use a source identifier, not a password, token, or connection string: mapping names are model metadata included in accessible exports.

## SQL input and output connectors

Open **SQL Connectors** in the hamburger menu and select a model. An administrator can create an input source or output destination using a configured server connection, a table, and the supported column settings. SQL connector setup also requires permission to edit that model and an unlocked draft. Test the connection and preview an input without changing model readings or writing output. Once saved, the source is available in that model's **Model Management** input/output selectors. Publish the model before saving these workflow selections; select the sources, save the schedule settings, and run the model. Scheduling can remain disabled for manual runs.

The integration uses standard Node.js database drivers: `mssql` for SQL Server, `pg` for PostgreSQL, and `mysql2` for MySQL. The hosted Workers application calls the separately deployed SQL gateway over authenticated HTTP; it does not open a database TCP connection itself. Database credentials belong only in the gateway's server environment. The app stores connection identifiers and nonsecret table/column configuration, not passwords or connection strings. See the [SQL gateway setup guide](connectors/sql-gateway/README.md) for deployment, driver configuration, table allowlists, and example schemas. Configuring an actual plant connection requires its server credentials and network access; no external plant database is included or preconfigured.

SQL inputs use a long-format table: each row identifies a tag, numeric value, and timestamp. The model item's **Source Name** matches the tag. Every enabled physical meter must have a distinct mapping and data in the requested interval; missing or invalid data fails the run rather than falling back to an old manual reading. Virtual meters are calculated afterward from the fresh physical readings and are not loaded directly from SQL. Input values must already use each meter's configured unit, including the correct quantity/rate convention; the connector does not infer conversion factors or validate dimensional consistency.

SQL reads use the selected completed reporting period, with inclusive start and exclusive end. Choose **Latest**, **Sum**, **Average**, **Time-weighted average**, or **Totalizer difference** to match the source's meaning. Average remains an arithmetic sample mean; time-weighted average integrates irregularly sampled flow rates, and totalizer difference calculates transferred quantity from cumulative readings. Integration and counter calculations may retrieve a fresh pre-start baseline and a reading at the end boundary without including material outside the reporting period. Reads exceeding 10,000 rows require a smaller window. Readings are applied only to the run's detached input snapshot, preserving saved draft and publication readings. See the reporting-period and quality settings below.

SQL outputs write normalized rows to the configured destination table. Mapped streams export reconciled/inferred mass and available measurement, correction, uncertainty, and status information; mapped units export incoming/outgoing reconciled mass totals. Unobservable streams and unit totals depending on them are skipped and counted in the output audit; a destination needs at least one observable mapped result. These result values use **kg per reporting batch**, regardless of the input meter's configured unit. Run and model identifiers, publication information, item identifiers, source mappings, and timestamps accompany the values. Output uses bound parameters inside one database transaction; database operation errors roll back that delivery. Reconciliation results remain in run history if output delivery fails, with the run marked as requiring attention. A communication failure after a database commit can leave delivery unconfirmed even though rows were written; inspect the destination using the run ID before attempting another delivery. Automatic delivery retries and replay/upsert workflows remain future work.

Mappings belong to the selected draft or published model snapshot. Connector source configurations are current operational settings outside that publication snapshot: an administrator's saved configuration changes apply to subsequent runs selecting that source without republishing the diagram. Changing or removing a selected source pauses the schedule so it must be deliberately re-enabled; removing it also clears the affected input/output selection. Changing the selected input source or its configuration clears the currently displayed reconciliation until a matching run is available. Changing only the output destination preserves the calculated values; earlier deliveries retain their own source configuration in run history. Operators may execute a permitted model's configured workflow; only administrators with model editing access configure SQL sources and run connection tests/previews. Locking model editing prevents configuration changes and tests/previews while permitted runs can continue.

Deploy the gateway separately and configure `SQL_GATEWAY_URL` and `SQL_GATEWAY_TOKEN` as server runtime settings on the application. Configure the same `SQL_GATEWAY_TOKEN` and a `SQL_CONNECTIONS_JSON` connection registry on the gateway. Each connection has explicit `readableTables` and `writableTables` allowlists. Use a database account with only the required table permissions, configure encrypted transport, and keep secrets out of model mappings, model exports, browser assets, and source control. These connections must be set up before SQL sources can run; saving a source does not provision a database or gateway.

## Reporting periods and input data quality

**Model Management** stores a model's reporting configuration separately from its run frequency: hour, day, shift, or batch; IANA time zone; reporting-day cutoff; first shift start and duration; batch duration; and late-data allowance. Defaults are **UTC**, day start **00:00**, three **8-hour shifts starting at 06:00**, and **zero minutes** of late-data allowance. An unconfigured model defaults to hourly reporting for a 1-hour duration, daily for 24 hours, and batch otherwise. Existing schedules remain valid and derive these defaults until explicitly configured.

Runs select a completed period, rather than a rolling window ending at the run time. An hourly run at 10:07 selects 09:00–10:00 in the model's time zone. A 15-minute late-data allowance makes that period eligible at 10:15; before then the previous ready period is selected. Calendar days and shifts follow local clock boundaries, so daylight saving changes can make a day 23 or 25 elapsed hours or an 8-hour shift 7 or 9 hours. Both occurrences of a repeated hourly boundary are distinct UTC periods. Ambiguous day/shift boundaries use their earlier occurrence; nonexistent boundaries move forward by the clock jump. Flow-rate conversion uses the selected period's actual elapsed duration. Input and output audits and SQL output `batch_start`/`batch_end` identify the same exact interval.

The completed-period selector supports hour, day, shift, or batch for a manual run independently of the scheduled kind. Choose a recent period or **Earlier / custom…**; calendar selections must align with one configured period, while batches accept arbitrary completed UTC start/end timestamps, up to 366 days. Recurring batches use fixed elapsed durations anchored at 1970-01-01's configured day start in the model's time zone. They do not realign at daylight saving transitions; use explicit batch times to represent physical production batches.

Rerunning a period fetches its current source data, so late arrivals or corrections can be included. It creates a new run linked to the previous retained run for that period rather than overwriting the old inputs/results. The backend still retains only the latest **20 runs per model**; this is not a long-term reporting archive. Output delivery for a rerun is a new transaction with a new run ID, so destinations must distinguish those records. Automatic late-data detection, historical backfill, and delivery retries are not implemented. Saved quantity readings must represent the chosen interval; selecting a different period does not fabricate new manual measurements.

Administrators configure input quality in **SQL Connectors**. New quality-enabled sources default to **60-minute maximum reading age**, **100% temporal coverage**, no quality column, accepted flag **`Good`** when a column is configured, and rejection of bad flags, flow gaps, and counter decreases. Historian flags are matched exactly against a configurable string allowlist. Maximum age is measured relative to the selected period's end, including historical runs, rather than today's clock. Coverage measures accepted time intervals, not a sample-count percentage. Excluded bad-quality readings remain gaps; excluding them does not connect good readings across them. Legacy Latest/Sum/Average sources without quality settings retain their previous aggregation behavior until quality is configured.

For **Time-weighted average**, every physical meter must use a rate unit per hour. Choose finite last-value hold (**Step**) or linearly interpolated trapezoids (**Linear**); the resulting mean is multiplied by actual period hours during mass conversion. A maximum reading age also limits how far samples support the interval. Incomplete coverage fails by default. Explicit scaling is permitted only if the configured coverage threshold passes, and records a warning that the uncovered duration was extrapolated.

For **Totalizer difference**, every physical meter must use cumulative mass/volume units without a rate denominator. A valid start baseline and a reading exactly at the period end are required. A fresh pre-start baseline may support linear interpolation at the start boundary, recorded in the audit; unknown counter gaps cannot be scaled. Counter decreases fail by default. **Restart** explicitly assumes a reset to zero and excludes the unknown amount between the previous sample and reset; **Rollover** requires a modulus and assumes one wrap per observed decrease. Both produce warnings, and a reset crossing an interpolated period boundary fails because its amount cannot be allocated. The audit records coverage, accepted/excluded sample counts, latest reading timestamp, resets, and warnings in the input snapshot and preview.

## Process-unit symbols

The toolbox provides ten internal unit symbols: **pump, compressor, valve, heat exchanger, filter, cyclone, conveyor, mixer, splitter, and generic process unit**. The same concise SVG artwork appears in the toolbox and flowsheet. Red inflow/outflow triangles remain distinct model boundaries.

Drag a symbol onto the canvas or click its toolbox button to add it. Each internal unit has a left input port and a right output port; each port accepts multiple streams for mixing, splitting, or additional material paths. Drag from an output port to an input port, or use Connect mode. Names, ports, and selection targets remain consistent across symbols.

Double-click an existing unit and choose **Unit symbol** to change its appearance. This preserves its identity, location, connections, material properties, and readings, and works with undo/redo, saving, and JSON import/export. Boundary direction stays fixed, and edit permissions and locks still apply.

Equipment symbols describe the process diagram. Every internal unit uses the same total-mass conservation equation, with no accumulation. Pump curves, pressure drop, compression, heat transfer, particle separation, and storage calculations are not introduced by choosing a symbol. Add every material path explicitly; tank/storage balances remain a separate planned feature.

## Virtual meters

Enable a stream's meter, select **Virtual**, and enter a formula. Give referenced meters clear, unique names; an empty meter name uses the stream name. Reference a physical or virtual meter with brackets, for example `[Feed meter] * 0.95` or `([Feed meter] - [Waste meter]) / 2`. Names are case-sensitive and trimmed. Basic arithmetic supports `+`, `-`, `*`, `/`, parentheses, unary signs, and `^` for exponentiation. Powers are right-associative: `2 ^ 3 ^ 2` means `2 ^ (3 ^ 2)`.

References use the other meter's original reading in its configured unit, before reconciliation. The formula's result is interpreted in the virtual meter's configured unit. Conversion is explicit: `[Feed t/h] * 1000` can supply a virtual meter configured in kg/h. The app does not infer unit conversions or dimensional consistency within a formula. Both physical and virtual readings are then converted to kg per reporting interval for the mass balance.

The diagram marks physical meters with **M** and virtual meters with **V**. Measurements displays virtual readings as calculated, read-only values. Changing a physical reading updates its dependents. A virtual meter may reference another virtual meter; dependency order is resolved automatically. Missing or ambiguous names, circular references, invalid syntax, division by zero, and nonfinite or negative readings prevent reconciliation and report the affected meter. You can save an unfinished draft formula and complete it before running.

Physical reading errors are assumed independent. A virtual meter's configured one-standard-deviation uncertainty represents independent calculation/model error; uncertainty from its references is added through first-order propagation. Shared inputs produce covariance between readings, which the reconciliation uses to avoid counting the same physical evidence twice. Every configured uncertainty must be positive; at a zero reading use absolute uncertainty. The app uses derivatives around the original readings, so nonlinear uncertainty propagation is an approximation. Formulas calculate input readings, not exact relationships imposed on the reconciled values; density remains fixed.

Formulas are parsed as arithmetic rather than executed as JavaScript; functions, property access, and arbitrary code are unsupported. Manual and scheduled runs evaluate the selected snapshot's formulas on the server instead of trusting a client-supplied calculated value. Names, formulas, and settings are retained in JSON import/export, saving, duplication, and publication snapshots. Editing a draft formula does not change a published model's formula or results until publishing changes.

## Line visibility and crossings

Select a flow line and choose **Hide line** in its inspector, or right-click it and choose **Hide line**. Open **Hidden lines** in the canvas toolbar to see only hidden streams and choose **Restore** beside a stream, **Restore all**, or toggle **Show hidden lines** for a temporary reveal. Revealed hidden lines appear lighter. The menu shows the hidden-line count and each stream's endpoints.

Visibility is a personal browser preference per account and model, shared between its editor and published view. It does not edit the model, invalidate results, change publication versions, or remove streams from measurements, reconciliation, and JSON exports. It remains available to read-only viewers. Preferences are retained in this browser; they are not shared with other users or devices.

Small bridge bumps mark perpendicular crossings without a connection. Shared ports, touching endpoints, and collinear paths are not given bridge bumps. Connections remain defined by the streams' source and target units. Crossing bridges update as units move, and hidden lines do not leave bridges on visible lines.

## Published models and working drafts

**Published model** and **Model editor** are separate views, available above the workbench and in the hamburger menu. Their URLs retain the selected model and view. The published page lists only active publications and provides a read-only diagram with pan, zoom, Fit, result inspection, and permitted reconciliation. Model editor holds the editable draft, measurements, toolbox, and draft test results.

Publishing atomically copies the saved draft, including its topology, symbol positions, material properties, and readings, into a published snapshot. Subsequent autosaved draft edits do not change that snapshot. **Publish changes** promotes them to the next publication version. Editing locks also prevent promotion. Scheduled runs and **Run reconciliation** on the published page always use the published snapshot; draft tests do not replace its results. Model Management provides separate actions for viewing the publication, editing the draft, promoting changes, and unpublishing.

The published diagram loads the latest run for its exact publication version and input snapshot, including after reopening the app. Stream labels show individual reconciled or inferred masses. Badges above symbols show reconciled incoming and outgoing totals in **kg per batch**; boundary triangles show their plant inflow or outflow. Select a symbol to inspect the same totals and its connected streams. Missing or unobservable flows show dashes; no run shows **Awaiting run**. Publishing a new version does not reuse values from a prior version, and a latest failed run is shown as needing attention. The page includes the run time, status, batch duration, and publication version.

The additive `0001` migration changes only the schema. Existing active models appear as publication 1, and their first per-model access atomically preserves that live copy before any draft edit. This bounded initialization attributes only the latest 20 existing results to publication 1 when their recorded snapshot matches; other legacy results remain draft runs. Unpublishing retains snapshots and run history but removes the model from the published page and pauses its schedule. Only the current published copy and working draft are retained as full model records; browsing or restoring every historical model version remains planned.

## Accounts, model permissions, and protection

The hamburger menu's **Admin** page is available only to active administrators. It lists signed-in users and models, including deleted models when requested. Administrators can set account roles, enable/disable accounts, assign per-model access, publish models, apply locks, and delete or restore models. The backend authenticates and authorizes every API request; hiding controls is an additional UI safeguard.

| Effective model level | Capabilities |
| --- | --- |
| Viewer | View the model and saved results; export accessible data. |
| Operator | Viewer capabilities plus manual reconciliation and execution of a due schedule. |
| Editor | Operator capabilities plus editing, publishing/unpublishing, and configuring schedules for published models, subject to locks. Editor accounts can create models. |
| Administrator | Access all models and administer accounts, grants, publication, locks, deletion, and restoration. |

For non-admins, effective access is the lower of their account role and their model grant. A grant of **No access** hides that model. Administrators have access to all models, while disabled accounts cannot access the workspace. Non-admins cannot change their own account role or model grants, and the last active administrator cannot be removed or disabled.

New models are drafts. Publish a model explicitly to make it active and eligible for scheduling. An **editing lock** blocks model-content edits and publication of draft changes for everyone, including administrators, until an administrator unlocks it. An **unpublishing lock** separately prevents unpublishing; unlock it first. Viewing and permitted reconciliation can continue while editing is locked.

Only administrators can delete a model, including an active, published model. Deletion removes it from users' workspaces and pauses its schedule while retaining the model and run data. An administrator can restore it as a draft with scheduling disabled. It must be published and its schedule re-enabled before scheduled execution resumes.

## Scheduled runs and run history

1. Open **Model Management** from the hamburger menu and select a model.
2. With editor or administrator access, publish the model, configure its reporting period and time zone, and choose a run frequency in minutes, hours, or days, with a minimum interval of one minute. Enable scheduled runs and save the settings. New models start with scheduling disabled.
3. Leave Input data source and Output destination at their defaults to use the published snapshot's saved measurements and save results in the shared workspace. Alternatively, have an administrator define SQL sources for that model through **SQL Connectors**, then select the input and/or output here. SQL sources require a configured server gateway and database access; selecting a source does not create either.
4. Select a completed period and use **Run now** for a manual run of the selected publication (or draft if not published), or keep the app open with an account permitted to run that model for scheduled runs. Scheduled runs use the latest ready period of the saved reporting kind; they do not accept a manual historical override. The backend retains the latest 20 manual/scheduled runs per model, including reporting period, target, publication version, input snapshots, quality audit, results, and status; the management page displays the latest 10. A saved run can be viewed on its corresponding diagram while its snapshot and publication version still match.

The open browser triggers scheduled API requests; the server checks authorization, atomically claims due schedules, performs the calculation, and saves the run. Closing all eligible sessions stops triggering; browser sleep and background throttling can delay it. When the app resumes or reopens, an overdue schedule executes once and advances to the next future frequency interval rather than replaying every missed period. Run frequency remains an elapsed interval: a one-day frequency means 24 hours, independently of a calendar-day reporting period. Timestamps are stored as absolute instants; reporting boundaries and labels use the configured model time zone. Atomic claims prevent two sessions from executing the same due occurrence. Unpublishing or deleting a model pauses its schedule.

Unattended cloud scheduling, retries, additional connector types, and browsable model version history remain planned capabilities.

## Mathematical scope

For each internal unit, incoming mass minus outgoing mass equals zero. In matrix form:

\[
\min_{x\ge0}(x_M-y)^T\Sigma^{-1}(x_M-y),
\qquad Ax=0.
\]

Here \(M\) identifies metered streams, \(y\) contains their normalized physical or calculated readings, and \(\Sigma\) is the reading-error covariance matrix. With physical meters only, \(\Sigma\) is diagonal and this reduces to \(\sum_{i\in M}((x_i-y_i)/\sigma_i)^2\). Virtual formulas propagate shared-input covariance; independent configured calculation errors keep the covariance nonsingular. Triangular innovation whitening applies this weighting without explicitly inverting the covariance matrix.

All quantities are normalized to kg per reporting interval before the server solves the saved model. Missing streams have no fabricated measurement or objective term. The numerical engine uses null-space reduction, pivoted Householder QR, and a feasible active-face network optimization for nonnegative flows. It handles rank-dependent conservation constraints and checks identifiability of each unmeasured stream. An internal representative of an ambiguous solution is never presented as a unique inferred flow.

Input uncertainty is one standard deviation (1σ), either an absolute amount in the reading's unit or a percentage of the reading. For a virtual meter this setting is its calculation/model error before reference uncertainty is propagated. At a zero reading use absolute uncertainty. Volume-to-mass conversion uses fixed stream density; flow rates are multiplied by batch duration. Results retain original readings and show reconciled mass, corrections, estimate uncertainty, and unit closure checks.

Unbiased errors and an accurate physical model are assumed. Very poor numerical conditioning is rejected instead of presenting unreliable results. Interior Gaussian covariance estimates are withheld for a connected process affected by active nonnegative bounds. Topology-forced zero flows are distinguished from measurement-driven bound activation. Gross-error indications are diagnostics, not automatic meter-fault identification.

## Operating limits

- No tanks, storage, or accumulation. Hourly/daily reporting does not imply that a real plant is steady; use this only for boundaries with negligible net holdup change.
- Total mass only. Temperature and pressure describe streams but do not automatically compensate gases or compute thermodynamics. Density is fixed and its uncertainty is not propagated.
- No component/species reconciliation, reactions/stoichiometry, energy balances, dedicated historian connector, or min/max throughput limits beyond nonnegativity. Physical instrument errors are assumed independent; arbitrary instrument correlation or calibration covariance cannot be configured.
- No unattended cloud scheduler, automatic delivery retries, CSV/ODBC/SAP/PI connectors, or model version browsing. SQL input/output requires a separately configured gateway and database connection. Shared workspace storage and account/model permission enforcement are implemented.
- Diagram limit: 200 nodes and 500 streams. Verified examples are small networks; the interface is primarily a desktop/tablet engineering workbench.
- All material paths, including waste and vents, must be modeled. Conservation and nonnegativity can force a dead-end path to zero; the tool warns about incomplete topology rather than treating closure as proof of physical correctness.
- The local test suite and browser checks do not establish accuracy on an actual plant's meters, density conventions, or reporting data. Validate the model and uncertainty configuration against known company cases before adopting it for reporting.

## Verification

Use the [release checklist](RELEASE_CHECKLIST.md) to record deployment, data protection, access, and browser checks for each release.

```powershell
npm test
npm run typecheck
npm run build
```

Tests cover analytical solutions, inferred/unobservable flows, recycles and rank reduction, nonnegative bounds, zero readings, conversions and interval duration, numerical conditioning, and independent cross-validation over 80 seeded tiny networks. They also cover model/source isolation, editable drafts, elapsed cadence, delayed runs, snapshots, adapter failures, bounded history, browser save queues, stale revisions, authenticated API permissions, account/grant changes, locks, deletion/restoration, atomic schedule claims, and canvas read-only behavior. Reporting-period tests cover configurable cutoffs, late-data allowance, historical selections, daylight saving changes and actual elapsed duration. Quality tests use controlled irregular samples, bad flags, stale readings, coverage gaps, counter resets, and rollover assumptions. The independent solver oracle enumerates every active face and solves KKT equations separately from the production QR/network algorithm.

The SQL gateway has a separate dependency installation and test command in its [setup guide](connectors/sql-gateway/README.md). Gateway contract/driver tests and application SQL adapter tests use controlled data and mocked database drivers; they do not establish connectivity, schema compatibility, permissions, or data accuracy on a real plant database. Record actual SQL Server, PostgreSQL, and MySQL connection/read/write checks separately before relying on those integrations.

## Mathematical reference

- [Tamhane & Mah (1985), Data Reconciliation and Gross Error Detection in Chemical Process Networks](https://www.stat.cmu.edu/technometrics/80-89/VOL-27-04/v2704409.pdf), especially Section 3 and Eq. 3.8.

The solver implements standard mathematical methods for mass balance data reconciliation.

## License

Released under the [MIT License](LICENSE). Source code, tests, examples, and documentation are available in [SavaStosic3/openReconcile](https://github.com/SavaStosic3/openReconcile).

The bundled Sites Vite integration retains its upstream [MIT license and attribution](build/sites-vite-plugin.LICENSE). Third-party dependencies retain their respective licenses.
