# openReconcile — visual mass balance reconciliation

openReconcile is a standalone, MIT-licensed web workbench for building a physical process flowsheet, entering hourly/daily measurements, and reconciling total mass. Its MassFlow interface pairs a visual process editor with a constrained weighted least-squares solver, authenticated accounts, and a shared model workspace.

See the [feature roadmap](ROADMAP.md) for planned capabilities and enhancements.

## Run locally

Requires Node.js 22.13 or later. The application uses a Workers backend, D1 database, and the Sites authentication integration. Frontend assets live in `public/`; `dist/` is generated build output.

```powershell
npm ci
'ADMIN_EMAIL=seedy@sites.test' | Set-Content .dev.vars
npm run build
npx wrangler d1 execute DB --local --config dist/server/wrangler.json --file ./drizzle/0000_complete_random.sql
npm run dev
```

Apply the SQL initialization once to an empty local database. Open the loopback URL printed by the development server, normally http://127.0.0.1:5173. The development server binds to this computer; its local sign-in simulates `seedy@sites.test`. This is a development identity, and the `.dev.vars` file is excluded from Git. Production authentication uses the hosting provider's verified identity, without the local simulation.

## Hosted authentication and database setup

The hosted application signs users in with ChatGPT through Sites. Its API stores users, model grants, models, schedules, and run snapshots in the D1 `DB` binding. Reconciliation runs on the server using saved model measurements.

For a new deployment, create a Sites project, set its project ID in `.openai/hosting.json`, provision the `DB` binding, apply `drizzle/0000_complete_random.sql` through the host's D1 migration service, and configure `ADMIN_EMAIL` as a server runtime secret before the intended administrator's first sign-in. Publish the built application through Sites. The generated configuration's database ID is a local development placeholder; the host supplies the production binding.

Only the verified identity matching `ADMIN_EMAIL` receives the initial administrator role when its account is inserted. Other first-time users become viewers with no model access until an administrator assigns grants. The first visitor does not become an administrator. Changing the secret does not promote an existing account or re-enable a disabled account; an existing administrator or an authorized database migration must handle those changes.

The production backend must be reached through the trusted Sites authentication dispatch. `app/chatgpt-auth.ts` reads the identity supplied by that dispatch; those headers must never be accepted directly from an untrusted client. When adapting the project to another host or identity provider, replace that integration with server-verified sessions or tokens and retain this trust boundary. A direct public Worker or an unauthenticated static server is not an equivalent deployment.

## The two-minute workflow

1. Sign in and open an assigned model, or create one with an editor/administrator account. Drag a pump, valve, heat exchanger, or another process-unit symbol from the toolbox onto the canvas. Click-to-add is also available. Add red inflow/outflow triangles for every external material path.
2. Drag the right port of a source to the left port of a destination. Alternatively, select Connect and click the source then destination. Drag units to reposition them; lines update automatically.
3. Right-click or double-click a stream. Set its name, material, phase, density, temperature, and pressure. Enable a meter and choose mass/volume, transferred quantity/flow rate, and units. Double-click a unit to change its name or equipment symbol.
4. Enter readings and one-standard-deviation uncertainties on Measurements. Pick a 1-hour, 24-hour, or custom batch duration. Run reconciliation and review Results or overlays on the flowsheet.

Unmetered streams can be inferred only when the measurements and network uniquely determine them. Otherwise they are clearly marked as needing a measurement. The example starts with a 100 kg feed and 60/35 kg outlets, with uncertainties 1/2/2 kg. Its correct reconciled values are 99.444444, 62.222222, and 37.222222 kg; the missing internal flow is 99.444444 kg.

## Editing and saving

- Mouse wheel zooms. Pan mode or middle-drag moves the viewport. Fit frames the current model.
- Select a unit or stream and press Delete to remove it. Enter edits the selection. Arrow keys move focused units (Shift for larger increments). V/C/H select the canvas tools.
- Undo/redo retain the last 100 model states. Ctrl+Z and Ctrl+Shift+Z work outside text fields.
- Models are autosaved to the shared backend with separate identities, measurements, schedules, and run histories. New, Demo, and Import add draft models and preserve existing models. Creating models requires an editor or administrator account.
- Open the hamburger menu and choose **Model Management** to select, open, create, or duplicate a saved model. A duplicate starts with scheduling disabled and empty run history.
- The backend checks permissions and model revisions before saving. A stale edit is rejected rather than overwriting someone else's changes; export your unsaved draft, then refresh the workspace. Revision checks support concurrent editing and are not a browsable model version history.
- Earlier browser data is retained locally and is not uploaded automatically. **Import browser models** asks before importing the last single-model autosave into the shared workspace. Use JSON export/import for additional models from the previous browser library. Export files also provide portable backups.
- Export model saves a JSON file including all properties and readings. Import adds a model from that format. Export results produces CSV with normalized masses and estimated uncertainties.

## Process-unit symbols

The toolbox provides ten internal unit symbols: **pump, compressor, valve, heat exchanger, filter, cyclone, conveyor, mixer, splitter, and generic process unit**. The same concise SVG artwork appears in the toolbox and flowsheet. Red inflow/outflow triangles remain distinct model boundaries.

Drag a symbol onto the canvas or click its toolbox button to add it. Each internal unit has a left input port and a right output port; each port accepts multiple streams for mixing, splitting, or additional material paths. Drag from an output port to an input port, or use Connect mode. Names, ports, and selection targets remain consistent across symbols.

Double-click an existing unit and choose **Unit symbol** to change its appearance. This preserves its identity, location, connections, material properties, and readings, and works with undo/redo, saving, and JSON import/export. Boundary direction stays fixed, and edit permissions and locks still apply.

Equipment symbols describe the process diagram. Every internal unit uses the same total-mass conservation equation, with no accumulation. Pump curves, pressure drop, compression, heat transfer, particle separation, and storage calculations are not introduced by choosing a symbol. Add every material path explicitly; tank/storage balances remain a separate planned feature.

## Accounts, model permissions, and protection

The hamburger menu's **Admin** page is available only to active administrators. It lists signed-in users and models, including deleted models when requested. Administrators can set account roles, enable/disable accounts, assign per-model access, publish models, apply locks, and delete or restore models. The backend authenticates and authorizes every API request; hiding controls is an additional UI safeguard.

| Effective model level | Capabilities |
| --- | --- |
| Viewer | View the model and saved results; export accessible data. |
| Operator | Viewer capabilities plus manual reconciliation and execution of a due schedule. |
| Editor | Operator capabilities plus editing, publishing/unpublishing, and configuring schedules for published models, subject to locks. Editor accounts can create models. |
| Administrator | Access all models and administer accounts, grants, publication, locks, deletion, and restoration. |

For non-admins, effective access is the lower of their account role and their model grant. A grant of **No access** hides that model. Administrators have access to all models, while disabled accounts cannot access the workspace. Non-admins cannot change their own account role or model grants, and the last active administrator cannot be removed or disabled.

New models are drafts. Publish a model explicitly to make it active and eligible for scheduling. An **editing lock** blocks model-content edits for everyone, including administrators, until an administrator unlocks it. An **unpublishing lock** separately prevents unpublishing; unlock it first. Viewing and permitted reconciliation can continue while editing is locked.

Only administrators can delete a model, including an active, published model. Deletion removes it from users' workspaces and pauses its schedule while retaining the model and run data. An administrator can restore it as a draft with scheduling disabled. It must be published and its schedule re-enabled before scheduled execution resumes.

## Scheduled runs and run history

1. Open **Model Management** from the hamburger menu and select a model.
2. With editor or administrator access, publish the model, enable scheduled runs, and choose a frequency in minutes, hours, or days, with a minimum interval of one minute. Save the schedule. New models start with scheduling disabled.
3. Leave Input data source and Output destination at their defaults to use the model's saved measurements and save results in the shared workspace. Optional sources must be defined for that model and have a registered input or output adapter. The shipped app has no external adapters or source setup interface, so it does not fetch fresh plant readings or publish to external destinations.
4. Use **Run now** for a manual run, or keep the app open with an account permitted to run that model for scheduled runs. The backend retains the latest 20 manual/scheduled runs per model, including input snapshots, results, and status; the management page displays the latest 10. A saved run can be viewed on the workbench while the model still matches its snapshot.

The open browser triggers scheduled API requests; the server checks authorization, atomically claims due schedules, performs the calculation, and saves the run. Closing all eligible sessions stops triggering; browser sleep and background throttling can delay it. When the app resumes or reopens, an overdue schedule executes once and advances to the next future interval rather than replaying every missed run. Frequencies are elapsed intervals: a day means 24 hours. Timestamps are stored as absolute instants and displayed in the browser's local time zone. Atomic claims prevent two sessions from executing the same due occurrence. Unpublishing or deleting a model pauses its schedule.

Unattended cloud scheduling, retries, external connectors, and browsable model version history remain planned capabilities.

## Mathematical scope

For each internal unit, incoming mass minus outgoing mass equals zero. In matrix form:

\[
\min_{x\ge0}\sum_{i\in M}\left((x_i-y_i)/\sigma_i\right)^2,
\qquad Ax=0.
\]

All quantities are normalized to kg per reporting interval before the server solves the saved model. Missing streams have no fabricated measurement or objective term. The numerical engine uses null-space reduction, pivoted Householder QR, and a feasible active-face network optimization for nonnegative flows. It handles rank-dependent conservation constraints and checks identifiability of each unmeasured stream. An internal representative of an ambiguous solution is never presented as a unique inferred flow.

Input uncertainty is one standard deviation (1σ), either an absolute amount in the reading's unit or a percentage of the reading. At a zero reading use absolute uncertainty. Volume-to-mass conversion uses fixed stream density; flow rates are multiplied by batch duration. Results retain original readings and show reconciled mass, corrections, estimate uncertainty, and unit closure checks.

Independent, unbiased errors and an accurate physical model are assumed. Very poor numerical conditioning is rejected instead of presenting unreliable results. Interior Gaussian covariance estimates are withheld for a connected process affected by active nonnegative bounds. Topology-forced zero flows are distinguished from measurement-driven bound activation. Gross-error indications are diagnostics, not automatic meter-fault identification.

## Deliberate MVP limits

- No tanks, storage, or accumulation. Hourly/daily reporting does not imply that a real plant is steady; use this only for boundaries with negligible net holdup change.
- Total mass only. Temperature and pressure describe streams but do not automatically compensate gases or compute thermodynamics. Density is fixed and its uncertainty is not propagated.
- No component/species reconciliation, reactions/stoichiometry, energy balances, historian integration, correlated measurement errors, or min/max throughput limits beyond nonnegativity.
- No unattended cloud scheduler, external input/output connectors, or model version browsing. Shared workspace storage and account/model permission enforcement are implemented.
- Diagram limit: 200 nodes and 500 streams. Verified examples are small networks; the interface is primarily a desktop/tablet engineering workbench.
- All material paths, including waste and vents, must be modeled. Conservation and nonnegativity can force a dead-end path to zero; the tool warns about incomplete topology rather than treating closure as proof of physical correctness.
- The local test suite and browser checks do not establish accuracy on an actual plant's meters, density conventions, or reporting data. Validate the model and uncertainty configuration against known company cases before adopting it for reporting.

## Verification

```powershell
npm test
npm run typecheck
npm run build
```

Tests cover analytical solutions, inferred/unobservable flows, recycles and rank reduction, nonnegative bounds, zero readings, conversions and interval duration, numerical conditioning, and independent cross-validation over 80 seeded tiny networks. They also cover model/source isolation, editable drafts, elapsed cadence, delayed runs, snapshots, adapter failures, bounded history, browser save queues, stale revisions, authenticated API permissions, account/grant changes, locks, deletion/restoration, atomic schedule claims, and canvas read-only behavior. The independent solver oracle enumerates every active face and solves KKT equations separately from the production QR/network algorithm.

## Mathematical reference

- [Tamhane & Mah (1985), Data Reconciliation and Gross Error Detection in Chemical Process Networks](https://www.stat.cmu.edu/technometrics/80-89/VOL-27-04/v2704409.pdf), especially Section 3 and Eq. 3.8.

The solver implements standard mathematical methods for mass balance data reconciliation.

## License

Released under the [MIT License](LICENSE). Source code, tests, examples, and documentation are available in [SavaStosic3/openReconcile](https://github.com/SavaStosic3/openReconcile).

The bundled Sites Vite integration retains its upstream [MIT license and attribution](build/sites-vite-plugin.LICENSE). Third-party dependencies retain their respective licenses.
