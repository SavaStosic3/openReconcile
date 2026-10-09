# Feature roadmap

Current capabilities and planned enhancements for openReconcile, a standalone, open-source mass balance reconciliation tool. Browser-open scheduling and a local saved model library are implemented as described in sections 1 and 2. Remaining items describe planned behavior. Basic reconciled-value labels already exist on the visual diagram.

## 1. Scheduled reconciliation

**Implemented in the browser:** configure each model's elapsed run frequency in minutes, hours, or days from the hamburger menu's Model Management page. Schedules start disabled. Runs use saved model measurements and store results locally by default; optional sources require defined adapters, and no external adapters are included. Manual and scheduled runs retain snapshots, results, and status for the latest 20 runs per model.

Execution requires an open app. Browser sleep and background throttling may delay runs. On resume or reopening, an overdue schedule executes once and skips missed intervals. Timestamps are stored as absolute instants and shown in the browser's local time zone; daily means every 24 hours. Repeated ticks are guarded within a tab, with cross-tab coordination where Web Locks are supported.

**Future server capabilities:**

- Run without an open browser, using a backend scheduler and durable run storage.
- Configure calendar schedules, reporting windows, and explicit time zones.
- Retrieve fresh input data through external adapters and retain model versions alongside input snapshots, results, and status.
- Add retries and server-enforced protection against duplicate or overlapping runs.

## 2. Multiple models with role-based access control

**Implemented locally:** create, select, open, and duplicate saved plant models with stable identities and separate schedules and run histories. New, Demo, and Import preserve existing models. Existing single-model browser data is migrated into the library. Duplicated models start with scheduling disabled and empty history. Models remain in browser localStorage; exports provide portable copies.

**Future shared access and versioning:**

- Add model organization, durable storage, version history, and restoration.
- Add accounts and shared plant/workspaces with model permissions and roles such as administrator, editor, operator, and viewer.
- Enforce permissions on the server for viewing, editing, running, scheduling, managing connectors, and publishing results; record significant changes and actions.

Authentication and role-based access control are not implemented in the local browser library.

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

- Extend the existing reconciled-value labels with selectable overlays for measured/reconciled values, corrections, uncertainty, and result status.
- Identify physical measurements, virtual meters, inferred flows, unresolved values, and bounds or quality warnings.
- Support selecting a saved run/reporting interval and inspecting detailed stream results directly from the diagram.
- Keep dense diagrams legible and indicate when results are stale after a model or data change.

## 12. Process-unit symbols

- Offer recognizable equipment symbols, such as pumps, valves, compressors, heat exchangers, mixers, separators, and tanks, in place of generic blocks.
- Preserve clear names, connection ports, selection targets, accessible controls, and consistent behavior while units are moved or connected.
- Store the equipment/symbol choice with the model. A symbol alone does not introduce additional physical equations; storage behavior is provided through the tank/storage feature.
