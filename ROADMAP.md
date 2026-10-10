# Feature roadmap

Current capabilities and planned enhancements for openReconcile, a standalone, open-source mass balance reconciliation tool. Browser-triggered scheduling, authenticated shared models, administrator/model permissions, virtual meters, line visibility/crossing bridges, published results, and the initial process-unit symbol library are implemented as described below. Other items describe planned behavior.

## 1. Scheduled reconciliation

**Implemented with browser triggering and server execution:** editors and administrators configure each published model's elapsed run frequency in minutes, hours, or days from the hamburger menu's Model Management page. New models are drafts with scheduling disabled; publishing is explicit. Runs use saved model measurements and store results in the shared D1 workspace by default. Optional sources require defined adapters, and no external adapters are included. Manual and scheduled runs retain snapshots, results, and status for the latest 20 runs per model.

Triggering requires an open app with an account permitted to run that model. The backend checks permissions and atomically claims due runs to prevent duplicate execution across sessions. Browser sleep and background throttling may delay runs. On resume or reopening, an overdue schedule executes once and skips missed intervals. Timestamps are stored as absolute instants and shown in the browser's local time zone; daily means every 24 hours. Unpublishing or deleting a model pauses its schedule.

**Future server capabilities:**

- Run without an open browser, using an unattended backend scheduler.
- Configure calendar schedules, reporting windows, and explicit time zones.
- Retrieve fresh input data through external adapters and retain model versions alongside input snapshots, results, and status.
- Add retries, recovery for interrupted executions, and controls for long-running overlapping jobs.

## 2. Multiple models with role-based access control

**Implemented in the shared workspace:** sign in through the hosting provider, then create, select, open, and duplicate saved plant models with stable identities and separate schedules and run histories. Users, models, grants, schedules, and results are stored in D1. New, Demo, and Import preserve existing models. Duplicated models start as drafts with scheduling disabled and empty history. Earlier browser data is imported only after an explicit user action; JSON exports remain portable.

The administrator-only **Admin** page lists users and models. Administrators assign account roles and per-model grants, enable/disable accounts, control publication, lock editing or unpublishing, and delete or restore models. Non-admin access is limited by both the account role and the model grant: viewer, operator, or editor. New users are viewers with no models assigned. Only a configured verified owner identity receives the initial administrator role; the first visitor does not receive it.

Every API request enforces authentication and permissions. Content writes also check model revisions to reject stale edits. Editing locks apply to administrators too until unlocked; unpublishing locks independently protect publication. Only administrators can delete models, including active models. Deleted models retain their data and can be restored as drafts with scheduling paused. The last active administrator cannot be demoted or disabled.

**Future organization and versioning:**

- Add plant/workspace organization, browsable model versions, and restoration of a previous model version.
- Extend the permission model to connector credentials and publishing results to external systems as those integrations are introduced.
- Record significant administrative and model changes in an audit history.

Revision checks, run snapshots, and separate working drafts and published snapshots are implemented. Publishing promotes the saved draft to a numbered publication; manual published runs and schedules use that copy while edits remain separate. A user-facing history for browsing or restoring every model version remains planned.

## 3. Tanks and storage units

- Add tanks and other storage units with opening and closing inventory for each reporting interval.
- Reconcile the accumulation balance: incoming mass minus outgoing mass equals closing inventory minus opening inventory.
- Support inventory measurements and uncertainty, including appropriate level/volume-to-mass conversions, and distinguish inventory from throughput in the interface and results.
- Report missing or unobservable inventories and account for shared measurement inputs rather than assuming every derived value is independent.

## 4. Input data connectors

- Obtain model readings from CSV files, SQL databases, ODBC sources, SAP, OSIsoft PI, HTTP APIs, and additional adapters.
- Map tags, columns, or fields to stream and inventory measurements, with units, timestamps, uncertainty, and data-quality information.
- Preview and validate the data; align readings and interval totals to the reporting window and explain missing, stale, or invalid inputs.
- Support credentials and plant-network connectivity through server-side integrations or gateways.

## 5. Output data connectors

- Deliver results through CSV, SQL, ODBC, SAP, OSIsoft PI, HTTP APIs, and additional adapters where the destination supports the required writes.
- Map reconciled values, corrections, uncertainty, quality/status, and run metadata to destination fields or tags.
- Preserve the original readings and distinguish reconciled results from raw data at the destination.
- Support explicit publishing permissions, delivery acknowledgements, retries, and duplicate/revision handling.

## 6. Reusable plant data workflows

- Configure a model's input mappings, reconciliation settings, and output mappings as a reusable workflow.
- Let users preview inputs, run and review the balance, and publish or consume the selected results without rebuilding mappings for each run.
- Reuse compatible connector configurations across models while keeping model permissions and credentials scoped correctly.
- Keep the reporting interval, units, model version, and result provenance attached to data throughout the workflow.

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
- Support selecting a saved run/reporting interval and inspecting detailed stream results directly from the diagram.
- Keep dense diagrams legible and indicate when results are stale after a model or data change.

## 12. Process-unit symbols

**Implemented initial library:** ten internal symbols represent pumps, compressors, valves, heat exchangers, filters, cyclones, conveyors, mixers, splitters, and generic process units. The toolbox and flowsheet use the same SVG artwork. Red inflow/outflow triangles remain distinct boundaries.

Each internal unit has consistent left input and right output ports; each accepts multiple streams. Clear names, selection targets, keyboard controls, movement, and connection behavior remain available. Double-click a unit to change its symbol while preserving its identity, position, connections, and readings. The choice is saved with the model and retained in JSON import/export and undo/redo. Boundary direction remains fixed, and existing edit permissions and locks apply.

Symbols are diagram labels: all internal units retain the existing total-mass conservation equation without accumulation or equipment-specific physics. Additional materials leaving a filter or cyclone must be modeled as explicit streams. Tanks and their inventory/accumulation behavior remain part of the planned tank/storage feature.

**Future symbol capabilities:** expand the library and add additional port arrangements where they improve diagram readability.
