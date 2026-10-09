# openReconcile — visual mass balance reconciliation

openReconcile is a standalone, MIT-licensed browser-based workbench for building a physical process flowsheet, entering hourly/daily measurements, and reconciling total mass. Its MassFlow interface pairs a visual process editor with a constrained weighted least-squares solver.

See the [feature roadmap](ROADMAP.md) for planned capabilities and enhancements.

## Run locally

Requires Node.js 22 or later. No npm packages or installation are needed.

```powershell
npm start
```

Open http://127.0.0.1:4178. To choose another port, set the PORT environment variable before starting. The local server binds only to this computer. All calculation and model editing happen in the browser.

## The two-minute workflow

1. Drag a process unit, mixer, or splitter from the toolbox onto the canvas. Click-to-add is also available. Add red inflow/outflow triangles for every external material path.
2. Drag the right port of a source to the left port of a destination. Alternatively, select Connect and click the source then destination. Drag units to reposition them; lines update automatically.
3. Right-click or double-click a stream. Set its name, material, phase, density, temperature, and pressure. Enable a meter and choose mass/volume, transferred quantity/flow rate, and units. Double-click a unit to rename it.
4. Enter readings and one-standard-deviation uncertainties on Measurements. Pick a 1-hour, 24-hour, or custom batch duration. Run reconciliation and review Results or overlays on the flowsheet.

Unmetered streams can be inferred only when the measurements and network uniquely determine them. Otherwise they are clearly marked as needing a measurement. The example starts with a 100 kg feed and 60/35 kg outlets, with uncertainties 1/2/2 kg. Its correct reconciled values are 99.444444, 62.222222, and 37.222222 kg; the missing internal flow is 99.444444 kg.

## Editing and saving

- Mouse wheel zooms. Pan mode or middle-drag moves the viewport. Fit frames the current model.
- Select a unit or stream and press Delete to remove it. Enter edits the selection. Arrow keys move focused units (Shift for larger increments). V/C/H select the canvas tools.
- Undo/redo retain the last 100 model states. Ctrl+Z and Ctrl+Shift+Z work outside text fields.
- The current model is autosaved in browser localStorage. This is one local working model, not a server database, team workspace, or durable backup. Private browsing, browser cleanup, and a different website origin can change its availability.
- Export model saves a JSON file including all properties and readings. Import loads that format. Export results produces CSV with normalized masses and estimated uncertainties.

## Mathematical scope

For each internal unit, incoming mass minus outgoing mass equals zero. In matrix form:

\[
\min_{x\ge0}\sum_{i\in M}\left((x_i-y_i)/\sigma_i\right)^2,
\qquad Ax=0.
\]

All quantities are normalized to kg per reporting interval before solving. Missing streams have no fabricated measurement or objective term. The numerical engine uses null-space reduction, pivoted Householder QR, and a feasible active-face network optimization for nonnegative flows. It handles rank-dependent conservation constraints and checks identifiability of each unmeasured stream. An internal representative of an ambiguous solution is never presented as a unique inferred flow.

Input uncertainty is one standard deviation (1σ), either an absolute amount in the reading's unit or a percentage of the reading. At a zero reading use absolute uncertainty. Volume-to-mass conversion uses fixed stream density; flow rates are multiplied by batch duration. Results retain original readings and show reconciled mass, corrections, estimate uncertainty, and unit closure checks.

Independent, unbiased errors and an accurate physical model are assumed. Very poor numerical conditioning is rejected instead of presenting unreliable results. Interior Gaussian covariance estimates are withheld for a connected process affected by active nonnegative bounds. Topology-forced zero flows are distinguished from measurement-driven bound activation. Gross-error indications are diagnostics, not automatic meter-fault identification.

## Deliberate MVP limits

- No tanks, storage, or accumulation. Hourly/daily reporting does not imply that a real plant is steady; use this only for boundaries with negligible net holdup change.
- Total mass only. Temperature and pressure describe streams but do not automatically compensate gases or compute thermodynamics. Density is fixed and its uncertainty is not propagated.
- No component/species reconciliation, reactions/stoichiometry, energy balances, historian integration, correlated measurement errors, min/max throughput limits beyond nonnegativity, or multiuser server storage.
- Diagram limit: 200 nodes and 500 streams. Verified examples are small networks; the interface is primarily a desktop/tablet engineering workbench.
- All material paths, including waste and vents, must be modeled. Conservation and nonnegativity can force a dead-end path to zero; the tool warns about incomplete topology rather than treating closure as proof of physical correctness.
- The local test suite and browser checks do not establish accuracy on an actual plant's meters, density conventions, or reporting data. Validate the model and uncertainty configuration against known company cases before adopting it for reporting.

## Verification

```powershell
npm test
```

There are 26 tests: analytical solutions, inferred/unobservable flows, recycles and rank reduction, nonnegative bounds, zero readings, conversions and interval duration, numerical conditioning, and independent cross-validation over 80 seeded tiny networks. The independent oracle enumerates every active face and solves KKT equations separately from the production QR/network algorithm.

## Mathematical reference

- [Tamhane & Mah (1985), Data Reconciliation and Gross Error Detection in Chemical Process Networks](https://www.stat.cmu.edu/technometrics/80-89/VOL-27-04/v2704409.pdf), especially Section 3 and Eq. 3.8.

The solver implements standard mathematical methods for mass balance data reconciliation.

## License

Released under the [MIT License](LICENSE). Source code, tests, examples, and documentation are available in [SavaStosic3/openReconcile](https://github.com/SavaStosic3/openReconcile).
