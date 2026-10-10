# Storage balances and uncertainty

## Conservation over a finite reporting period

For total mass in a tank or storage boundary over `[t0, t1]`, with all material paths explicitly represented:

```text
Σ incoming transferred mass − Σ outgoing transferred mass
    = closing inventory − opening inventory
```

Transferred masses and inventories are in kg. Average rates are multiplied by the actual elapsed period; opening/closing snapshots are not multiplied by duration. An ordinary process unit retains zero accumulation. A tank may fill or empty; accumulation can be negative even though streams and inventories are nonnegative. This is a finite-period total-mass model, not a dynamic simulation or a component/energy balance. The incremental conservation formulation is described in [MIT's mass-balance lecture notes](https://ocw.mit.edu/courses/1-020-ecology-ii-engineering-for-sustainability-spring-2008/860c054b34c45afc0d5520bdaad4a063_lec1_2.pdf).

The solver adds opening inventory as an edge entering the tank and closing inventory as an edge leaving it. This creates one joint incidence system `A x = 0`, with existing stream masses and both inventory states in `x`. It minimizes the whitened measurement objective

```text
(H x − y)ᵀ Σ⁻¹ (H x − y)
subject to A x = 0, x ≥ 0,
and opening/closing ≤ an optional known mass capacity.
```

`H` selects measured quantities. Missing quantities contribute no invented measurement. The existing null-space/pivoted-QR calculation determines rank and uncertainty; the feasible circulation optimizer handles nonnegative and upper bounds. Conservation is checked again numerically before results are returned. The implementation rejects unreliable conditioning or nonconvergence.

Accumulation is derived from the two fitted states. It is **not** added as a third measurement of the same inventory evidence. If only the net flow is observed, accumulation may be identifiable while absolute opening and closing stocks remain unobservable; those stocks are returned as null. An arbitrary representative used internally by the optimizer is not reported as a measured or inferred unique stock.

## Inventory conversion

- Mass: `kg = reading × unit_factor`, with factor 1 for kg or 1,000 for t.
- Volume: `mass = density × volume`, with volume in m³; litres convert by 0.001.
- Level: `mass = density × V(level)`, with level in metres. Vertical cylinders use `V(h) = π D² h/4`; constant-area vessels use `V(h) = area × h`.
- A calibration table maps metres to m³ with piecewise-linear interpolation. It must start at `(0, 0)` and increase strictly in both coordinates. Raw levels outside the table fail, and the last volume imposes an upper conversion limit on fitted stocks. Extrapolation is not allowed.

Geometry is treated as known. Opening and closing use the same configured uniform density. If density changes between boundaries, supply independently converted **mass inventories** with their appropriate uncertainty rather than using this constant-density conversion. Calibration tables currently require zero density uncertainty; otherwise their nominal-density upper range would not represent an exact mass constraint. Nonzero density uncertainty remains available for direct volume, cylinders, and constant-area vessels.

## Covariance and first-order uncertainty

Configured reading uncertainty is one standard deviation in the endpoint's input unit, or a percentage of its reading. It must be positive. A zero reading requires absolute uncertainty. With volume endpoints `V0,V1`, density `ρ`, reading errors `σV0,σV1`, density error `σρ`, and configured reading correlation `r`:

```text
Var(m0) = ρ² σV0² + V0² σρ²
Var(m1) = ρ² σV1² + V1² σρ²
Cov(m0,m1) = ρ² r σV0 σV1 + V0 V1 σρ²
Var(m1−m0) = Var(m0) + Var(m1) − 2 Cov(m0,m1)
```

Level readings replace each `σV` with `V′(h) σh`, including unit conversion. Direct mass readings use their input uncertainties and configured correlation; density does not affect mass-basis readings. The shared density term can largely cancel in an inventory difference; treating the endpoint density errors as independent would give incorrect accumulation uncertainty.

This follows the derivative/covariance propagation rule in [NIST Technical Note 1297, Appendix A](https://www.nist.gov/pml/nist-technical-note-1297/nist-tn-1297-appendix-law-propagation-uncertainty). It is a first-order approximation evaluated at raw readings. Calibration uses the local segment slope (the right segment at an interior knot). Large errors, nonlinear conversion, or a breakpoint within the uncertainty range require additional engineering validation; reported Gaussian uncertainty is not a nonlinear uncertainty guarantee.

The solver whitens the correlated pair using a numerically stable factored conditional variance. It also preserves existing virtual-meter covariance. Reading errors are assumed independent of density error; density and reading correlation are shared **within a single storage unit**. Cross-tank shared calibration/density errors, stream-to-inventory correlations, and arbitrary instrument covariance are not configured. Do not model multiple correlated readings as independent evidence; supply an appropriate independent mass dataset or extend the covariance model first. SQL rejects reuse of the same inventory source sample across different storage units.

Interior estimate uncertainty is obtained from the joint fitted covariance. Accumulation uncertainty uses the fitted covariance of closing minus opening, including correlations induced by conservation. At an active zero/capacity bound, Gaussian estimate uncertainties are withheld for the affected connected process. Exact closure alone does not prove measurement consistency or identify a faulty meter.

## Boundary input and output

Measured opening and closing endpoints have separate Source Names. SQL input reads exactly `timestamp = period.start` for opening and `timestamp = period.end` for closing, independent of the flow aggregation setting. Missing, ambiguous, invalid, or unacceptable-quality snapshots fail the input workflow. There is no inventory averaging, integration, stale carry-forward, interpolation, or saved-reading fallback. Reads populate detached run snapshots, preserving the draft/publication and original manual values.

Mapped unit output adds `opening_inventory`, `closing_inventory`, and signed `accumulation` rows alongside incoming/outgoing transferred mass. Values are kg, not kg/h. Unobservable quantities are skipped; available correction and estimate uncertainty accompany observed/fitted inventories. Existing output transactions, failure provenance, reporting periods, and 20-run retention remain in force.

The [three-tank reference](../examples/storage-showcase-model.md) provides independently calculated fitted readings, uncertainty, objective, and unit/boundary closure. Tests also cover missing inventories, correlated endpoints, density covariance, capacity bounds, unit conversions, and unchanged legacy steady-flow behavior. These checks validate implemented cases; actual plant models still require appropriate boundaries, synchronized data, and independently justified conversion and uncertainty inputs.
