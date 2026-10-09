# Feature roadmap

Current capabilities and planned enhancements for openReconcile, a standalone, open-source mass balance reconciliation tool. Browser-triggered scheduling, authenticated shared models, administrator/model permissions, and the initial process-unit symbol library are implemented as described in sections 1, 2, and 12. Remaining items describe planned behavior. Basic reconciled-value labels already exist on the visual diagram.

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

- Create meters calculated from engineering equations or empirical relationships instead of a physical instrument.
- Configure named input readings, formulas, parameters, units, and uncertainty; distinguish virtual meters visually from physical meters and flows inferred by reconciliation.
- Evaluate dependencies in a defined order and report missing inputs, invalid calculations, or dependency cycles.
- Propagate uncertainty and account for shared inputs and calibration error so calculated readings do not falsely add independent measurement evidence.

## 8. Line-crossing bridges

- Draw small bridge bumps where flow lines cross without connecting.
- Distinguish geometric crossings from shared endpoints and actual connections, including during dragging, zooming, and automatic routing.
- Keep connection behavior independent of the line's visual crossing treatment.

## 9. Hide flow lines

- Hide individual streams or groups of lines to simplify a diagram and provide a clear way to show them again.
- Preserve hidden streams in the model, measurements, reconciliation, and exports; visibility must not change the mass balance.
- Indicate that the current view contains hidden lines and retain visibility settings with the model.

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
