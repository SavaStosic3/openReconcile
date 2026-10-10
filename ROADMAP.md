# Feature roadmap

Current capabilities and planned enhancements for openReconcile, a standalone, open-source mass balance reconciliation tool. Unattended scheduling for internal installations, completed reporting periods, SQL input quality controls, authenticated shared models, administrator/model permissions, data mapping, SQL input/output through a server gateway, virtual meters, tanks and storage, line visibility/crossing bridges, published results, audit history, and the process-unit symbol library are implemented as described below. Other items describe planned behavior.

## 1. Scheduled reconciliation

**Implemented with unattended standalone execution:** editors and administrators configure each published model's elapsed run frequency in minutes, hours, or days from the hamburger menu's Model Management page. The Docker/internal server executes schedules without open browsers, rechecks the configuring account's current scheduling rights, and persists claims and run state across restart. Existing enabled schedules require an explicit save to authorize unattended execution. New models are drafts with scheduling disabled; publishing is explicit. Runs use saved model measurements and store results in the workspace by default. Administrators can define SQL input/output sources for a model, using a separately configured gateway, then select them for its manual and scheduled workflow. Manual and scheduled runs retain snapshots, results, and status for the latest 20 runs per model.

The retained hosted testing site continues to require an open app with an account permitted to run that model. The backend checks permissions and atomically claims due runs to prevent duplicate execution across sessions. Browser sleep and background throttling may delay hosted runs. On standalone restart or hosted browser resumption, an enabled overdue schedule executes once and skips missed periods. Run frequency is elapsed time, so a daily frequency means every 24 hours; reporting periods use the model's configured time zone and calendar boundaries. Unpublishing or deleting a model pauses its schedule. Standalone interrupted claims are recovered after lease expiry and recorded as failed. Interruptions before output permit later due occurrences; uncertain output from either a manual or scheduled run atomically pauses automatic scheduling for the model until destination review and explicit re-enabling. Overlapping runs for the same model are blocked.

**Implemented reporting periods:** select completed hours, calendar days, configurable shifts, or custom batches. Defaults are UTC, midnight reporting-day cutoff, 8-hour shifts starting at 06:00, and no late-data allowance. A configurable allowance delays eligibility for late source arrivals; an hourly run at 10:07 reads 09:00–10:00 instead of 09:07–10:07. Daylight saving changes preserve actual elapsed time and distinct repeated hours. Manual runs can choose another period kind or an aligned historical interval; scheduled runs use the latest ready configured period. Fixed-duration recurring batches have a deterministic epoch anchor; explicit times represent custom production batches. Reruns reread source data and append results with a link to a previous retained run for the period. Input, output, and run records share exact start/end boundaries. Only the latest 20 runs per model are retained.

**Future server capabilities:**

- Add an unattended scheduler to the hosted deployment; internal installations already run without a browser.
- Add calendar-based trigger scheduling; configured reporting calendars and time zones are already implemented.
- Add automatic late-data detection/backfill; manual historical reruns are already implemented. Application run history remains capped at 20 per model; use output destinations for long-term reconciliation results.
- Add further external input adapters and quality controls beyond the current SQL policies.
- Add explicit retry/delivery workflows and broader job administration; standalone interrupted-run recovery and per-model overlap prevention are implemented.

## 2. Multiple models with role-based access control

**Implemented in the shared workspace:** sign in with a username/password account or through the hosting provider, then create, select, open, and duplicate saved plant models with stable identities and separate schedules and run histories. Users, models, grants, schedules, and results are stored in D1. New model, Load template, and Import preserve existing models. Duplicated models start as drafts with scheduling disabled and empty history. Earlier browser data is imported only after an explicit user action; JSON exports remain portable.

The administrator-only **Admin** page lists users and models. Administrators assign account roles and per-model grants, enable/disable accounts, control publication, lock editing or unpublishing, and delete or restore models. Non-admin access is limited by both the account role and the model grant: viewer, operator, or editor. New users are viewers with no models assigned. Only a configured verified owner identity receives the initial administrator role; the first visitor does not receive it.

Every API request enforces authentication and permissions. Content writes also check model revisions to reject stale edits. Editing locks apply to administrators too until unlocked; unpublishing locks independently protect publication. Only administrators can delete models, including active models. Deleted models retain their data and can be restored as drafts with scheduling paused. The last active administrator cannot be demoted or disabled.

**Future organization and versioning:**

- Add plant/workspace organization, browsable model versions, and restoration of a previous model version.
- Extend the current administrator-only connector configuration and model-run permissions with dedicated connector grants and broader publishing controls as those integrations grow.

Revision checks, run snapshots, and separate working drafts and published snapshots are implemented. Publishing promotes the saved draft to a numbered publication; manual published runs and schedules use that copy while edits remain separate. A user-facing history for browsing or restoring every model version remains planned.

## 3. Tanks and storage units

**Implemented:** tank and bulk-storage symbols with opening/closing inventories, accumulation balances, measured or inferred endpoints, optional known mass capacity, and mass/volume/level conversion. Level supports cylinders, constant area, and zero-origin monotonic calibration tables without extrapolation. Endpoint reading correlation and a common density error enter the same joint weighted fit as flow measurements; accumulation is derived, without double-counting inventory evidence. The UI and published results distinguish throughput from stocks and signed accumulation. Unobservable absolute stocks remain unresolved even when net accumulation is identifiable.

Endpoint mappings integrate with exact start/end SQL snapshots, quality validation, detached run inputs, signed storage output, permissions, publication snapshots, and audit changes. A separate [three-tank analytical example](examples/storage-showcase-model.md) preserves the existing filtration template.

Known scope: geometry is fixed; inventory conversion is first order and uses common density at both endpoints. Calibrated levels require zero density uncertainty. Cross-tank shared errors, changing boundary density, uncertain geometry, and dynamic simulation remain extensions. See [storage math and assumptions](docs/storage-mathematics.md).

## 4. Input data connectors

**Implemented mapping foundation:** the hamburger menu's **Data Mapping** page lists items in the selected model with their current **Model Name** and an optional **Source Name** for an external tag, column, or field. Source Name is also editable from a unit or stream's settings, including unmetered streams. Mappings attach to stable item IDs, survive renaming, saving, duplication, and JSON import/export, and follow existing draft editing permissions and locks. Published mappings remain read-only until draft changes are published.

**Implemented SQL input:** an administrator can configure and inspect per-model SQL sources through **Data connectors**, test a server connection, and preview data without changing readings. Connection IDs refer to a separately deployed Node.js gateway using `mssql` for SQL Server, `pg` for PostgreSQL, or `mysql2` for MySQL. Database credentials remain in the gateway's server environment; the Workers app calls that gateway over authenticated HTTP.

The input format is a tag/value/timestamp table, with an optional historian quality column, matched by each physical meter's distinct Source Name. A run reads its selected completed reporting period with configurable Latest, Sum, arithmetic Average, Time-weighted average, or Totalizer difference aggregation. Every physical meter requires a mapping and valid interval data. Values must already use the meter's configured unit; virtual meters then calculate from the fresh readings. Inputs are retained in the run snapshot rather than overwriting saved model readings. Current source configuration applies to subsequent selected-source runs, while diagram mappings come from the selected draft/publication snapshot. Changing or removing a selected source pauses its schedule pending explicit re-enabling.

**Implemented SQL data quality:** configurable maximum age at the period end, temporal coverage thresholds, exact accepted historian flag strings, rejection/exclusion of bad flags, step/linear time-weighted flow integration, and explicit counter reset/rollover policies. New quality-enabled sources default to 60-minute maximum age, full coverage, and rejection of bad flags, gaps, and counter decreases. Excluded bad points retain gaps; optional flow-gap scaling is audited as extrapolation. Counter calculations require boundary data and reject unknown gaps; zero-reset and one-wrap assumptions are explicit and warned. Preview and retained run inputs include per-meter coverage, sample/exclusion counts, latest timestamps, resets, and warnings. Legacy sources without quality settings keep their earlier aggregation behavior until configured.

Mapping names are model metadata rather than credentials. Saving a mapping alone does not fetch data or change readings. SQL requires explicit server connection setup and network access; an actual plant integration must be configured and validated separately.

**Implemented PI Web API input:** server-owned HTTPS connection profiles expose allowlisted Source Names and configured units through the shared Data connectors page. Recorded numeric readings use the same completed periods, age/coverage/integration/totalizer policies, exact inventory boundaries, and detached run snapshots as SQL. PI flags are mandatory and strict: Good=true, Questionable=false, and Substituted=false. Administrators select rejection or exclusion with retained coverage barriers. Inputs and output destinations may use different connector types; SQL and PI source registries coexist. Native Windows integrated/Kerberos authentication remains outside the supplied client; Basic over HTTPS and a bearer-authenticated company proxy are supported. See [PI configuration](docs/pi-web-api.md).

**Future connector capabilities:**

- Obtain model readings from CSV files, ODBC sources, SAP, other HTTP APIs, and additional adapters; broaden SQL table formats and supported databases.
- Extend item mappings with per-meter connector settings. Inventory endpoint mappings and unit/uncertainty configuration are implemented.
- Add provider-specific quality-code decoding, engineering-range rules, calibration information, and time-varying measurement uncertainty beyond the current SQL source-wide quality policy.
- Support credentials and plant-network connectivity through server-side integrations or gateways.

## 5. Output data connectors

**Implemented SQL output:** administrators configure a per-model output source through **Data connectors** and select it in Model Management. The SQL gateway writes observable mapped stream results and mapped unit incoming/outgoing totals to a normalized result table, in kg per reporting batch, with run/model/item identifiers and available measurement, correction, uncertainty, and status fields. Unobservable values are skipped and counted. Bound inserts execute in one transaction. Database operation errors roll back output; reconciliation results and delivery failures remain in shared run history. A lost acknowledgement after commit needs destination inspection by run ID before replay. Internal installations pause the model's automatic schedule after uncertain manual or scheduled delivery until explicit re-enabling following review.

Administrators configure sources; permitted operators execute the model's selected workflow. Table allowlists and database credentials stay in the gateway. Source settings are current operational configuration; item mappings and run inputs come from the selected snapshot. The gateway and destination schema require separate setup and real database validation before plant use.

**Implemented PI Web API output:** separate server-owned output bindings map each Source Name/result metric to a permitted destination. Every selected result must be observable before writing. Reconciled kg values convert to configured kg/t/g destinations or period-average kg/h/t/h throughput, using actual elapsed duration. Inventories and signed accumulation remain mass. Opening inventory is written at period start and other metrics at period end. Explicit reruns replace values at the same point/timestamp. Scalar writes are acknowledged independently, so there is no cross-tag transaction; partial or uncertain delivery requires destination review and pauses internal automatic scheduling until explicitly re-enabled. No automatic retries or PI point provisioning are included.

**Future output capabilities:**

- Deliver results through CSV, ODBC, SAP, other HTTP APIs, and additional adapters where the destination supports the required writes.
- Add destination schema flexibility, separate input/output mappings, and additional quality/metadata fields.
- Add dedicated publishing grants, delivery acknowledgement workflows, retries, and duplicate/revision handling.

## 6. Reusable plant data workflows

**Implemented data workflow:** configure item mappings, per-model SQL or PI sources, reporting periods, quality policies, and Model Management's input/output selections once; preview fresh data and run the same workflow manually or on a schedule. Internal servers execute schedules unattended; the hosted testing site retains browser triggering. Runs retain exact reporting boundaries, actual elapsed duration, input/quality snapshots, publication target, results, rerun provenance, and delivery status. Multiple model sources can refer to a server-configured connection ID without exposing its database credentials.

Further enhancements include independent input/output mappings, reusable configuration templates, explicit input review/approval before automatic output, and richer delivery provenance across connector types.

## 7. Virtual meters

**Implemented initial arithmetic formulas:** select **Virtual** in a stream's meter settings, name its meter, and enter a formula referencing physical or virtual meters as `[Meter name]`. An empty meter name uses the stream name. Names are case-sensitive and trimmed. Basic arithmetic, parentheses, unary signs, and `^` exponentiation support calculations such as `[Feed meter] - [Waste meter]`. Virtual readings are calculated and read-only on Measurements.

References use original readings in each meter's configured unit; the output uses the virtual meter's configured unit. Explicit conversion factors are required where units differ. Manual and scheduled runs evaluate formulas freshly on the server using the selected snapshot. Dependency cycles, missing or ambiguous references, invalid syntax, and invalid output readings block a run with a meter-specific error. Drafts can retain incomplete formulas while being edited; formulas survive saving, publication, and JSON import/export.

First-order propagation includes reference uncertainty and shared-input covariance in reconciliation. Each virtual meter also requires positive independent calculation/model error. Physical instrument errors remain independent; arbitrary instrument correlation is not configurable. Nonlinear propagation is approximate, fixed density is retained, and a formula supplies a calculated input reading rather than an exact constraint on reconciled flows.

**Future formula capabilities:** add a documented engineering-function library, dimensional validation, parameter management, and calibration models as those capabilities are designed and validated.

## 8. Line-crossing bridges

- Implemented: small bridge bumps at perpendicular crossings without a connection, updated during dragging, zooming, and automatic routing.
- Shared ports, touching endpoints, and collinear paths do not receive crossing bridges. Connection behavior remains independent of visual crossing treatment.

## 9. Hide flow lines

- Implemented: hide individual streams in the inspector or right-click actions. The **Hidden lines** menu lists only hidden streams, with a **Restore** button for each. **Restore all** and **Show hidden lines** provide full restoration and temporary reveal.
- Hidden streams remain in the model, measurements, reconciliation, and exports. Visibility never changes the mass balance or published version.
- Hidden counts and individual visibility are shown in the menu. Preferences are personal per account/model in the current browser, across editor and published views; shared visibility presets and groups remain future work.

## 10. Import a model from CSV connections

- Build a model from a documented CSV connection structure using stable unit and stream identifiers, source/target relationships, equipment types, and optional coordinates and properties.
- Preview the topology and provide row-specific validation for missing units, invalid connections, duplicate identifiers, and unsupported values before applying an import.
- Arrange units automatically when positions are absent and allow subsequent visual editing.
- Keep topology import distinct from importing measurement readings through an input connector.

## 11. Reconciled results on the visual diagram

**Implemented initial published view:** the read-only published diagram shows each stream's reconciled or inferred mass and incoming/outgoing mass totals above every unit symbol, in kg per batch. Its header identifies the publication version, last run, and status. Values are loaded only from runs matching that publication version and input snapshot; missing runs and unresolved values are explicit. Draft editing and test results stay separate until the draft is published.

Further enhancements:

- Extend the existing reconciled-value labels and unit totals with selectable overlays for measured/reconciled values, corrections, uncertainty, and result status.
- Identify physical measurements, virtual meters, inferred flows, unresolved values, and bounds or quality warnings.
- Extend completed-period and saved-run selection with comparisons and richer diagram inspection within the latest 20 runs. Use output destinations for long-term result trends; saved-reading change trends are available in Audit history.
- Keep dense diagrams legible and indicate when results are stale after a model or data change.

## 12. Process-unit symbols

**Implemented library:** twelve internal symbols represent pumps, compressors, valves, heat exchangers, filters, cyclones, conveyors, mixers, splitters, generic process units, tanks, and bulk storage. The toolbox and flowsheet use the same SVG artwork. Red inflow/outflow triangles remain distinct boundaries.

Each internal unit has consistent left input and right output ports; each accepts multiple streams. Clear names, selection targets, keyboard controls, movement, and connection behavior remain available. Double-click a unit to change its symbol while preserving its identity, position, connections, and readings. The choice is saved with the model and retained in JSON import/export and undo/redo. Boundary direction remains fixed, and existing edit permissions and locks apply.

Ordinary equipment symbols use zero accumulation without equipment-specific physics. Additional materials leaving a filter or cyclone must be modeled as explicit streams. Tanks and bulk storage use opening/closing inventory balances; converting them to an ordinary unit requires confirmation to remove inventory configuration.

**Future symbol capabilities:** expand the library and add additional port arrangements where they improve diagram readability.

## 13. Audit history and recorded reading trends

**Implemented:** server-recorded before/after changes for measurements, mappings, model properties, schedules, connector configuration, permissions, publications, model protection, deletion/restoration, and audit retention settings. Change records commit atomically with successful writes and retain the acting account, timestamp, and relevant model revision. Large changes are split into bounded records; credentials, session tokens, full models, and reconciliation results are excluded.

**Audit history** provides model/user/type/date/text filters, historical pagination, and physical-meter reading-change trends. Administrators can retain audit records for 1–3,650 days or indefinitely; the default is 365 days. Other users see only history for currently accessible models. Retention applies independently of the fixed latest-20-run history. Long-term reconciled results belong in configured output destinations. Recording begins with installation, without reconstructing earlier changes. Reading trends describe saved input changes, including gaps and unit changes, rather than continuous historian sampling.
