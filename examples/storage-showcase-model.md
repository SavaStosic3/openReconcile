# Three-tank transfer

This separate template leaves **Slurry filtration with recycle** unchanged. Water passes through Buffer A, a transfer pump, Buffer B, a valve, and the dispatch tank. All three tanks accumulate material during the selected hour. The pump and valve have negligible holdup. Four intermediate transfers are unmetered and inferred from the inventory and boundary evidence.

## Verify the supplied one-hour readings

Select **Load template → Tanks and storage**, choose a completed one-hour reporting period, and review **Measurements**. Opening and closing readings represent snapshots at that period's exact start and end; they are not rates. The supplied values are a reproducible reference dataset, without an external database configured.

| Inventory | Basis | Opening | Closing | Reading uncertainty, 1σ | Converted opening / closing kg |
| --- | --- | ---: | ---: | --- | --- |
| Buffer A | Mass | 2,000 kg | 2,200 kg | 5 kg | 2,000 / 2,200 |
| Buffer B | Volume | 3 m³ | 3.2 m³ | 0.005 m³ | 3,000 / 3,200 |
| Dispatch | Level | 2 m | 2.05 m | 0.0025 m | 4,000 / 4,100 |

Volume and level use a configured constant density of **1,000 kg/m³** with zero density uncertainty. Dispatch has a known constant cross-sectional area of **2 m²**. Consequently, each opening/closing reading has a mass uncertainty of 5 kg. Endpoint reading errors are independent in this reference. All tank capacities are 10,000 kg and inactive at the solution.

Supply reads **1,010 kg/h**, delivery **500 kg/h**, each with absolute uncertainty **10 kg/h**. The total raw accumulation is 200 + 200 + 100 = **500 kg**, leaving a deliberate discrepancy of **10 kg** during one hour.

## Independent analytical solution

The only redundant constraint among the eight measured quantities is

```text
feed − delivery + opening_A − closing_A
                + opening_B − closing_B
                + opening_C − closing_C = 0
```

Its independent variance is `10² + 10² + 6 × 5² = 350 kg²`. Constrained weighted least squares adjusts a measured quantity by `−variance × constraint_sign × 10/350`:

- Supply: `−20/7 kg`; delivery: `+20/7 kg`.
- Each opening inventory: `−5/7 kg`; each closing inventory: `+5/7 kg`.
- Each accumulation increases by `10/7 kg`.

| Quantity | Expected reconciled kg |
| --- | ---: |
| Supply | **1,007.142857** |
| A → pump → B, both streams | **805.714286** |
| B → valve → Dispatch, both streams | **604.285714** |
| Delivery | **502.857143** |
| Buffer A opening / closing | **1,999.285714 / 2,200.714286** |
| Buffer B opening / closing | **2,999.285714 / 3,200.714286** |
| Dispatch opening / closing | **3,999.285714 / 4,100.714286** |
| Buffer A accumulation | **201.428571** |
| Buffer B accumulation | **201.428571** |
| Dispatch accumulation | **101.428571** |

Each tank closes `incoming − outgoing − accumulation = 0`; the pump and valve close `incoming − outgoing = 0`. The external check is **1,007.142857 − 502.857143 = 504.285714 kg**, equal to the three accumulated masses. The weighted objective is **100/350 = 0.2857142857**, with **one degree of freedom**.

The independently projected inventory variance is `25 − 25²/350`; the accumulation variance is `50 − 50²/350`. The automated reference compares these against the solver's reported estimate uncertainty, not just its closing residual.

For a perfectly consistent reference, change supply to **1,000 kg/h**. Reconciliation then preserves all supplied readings, gives transfers **800 and 600 kg**, accumulation **200, 200, and 100 kg**, and objective zero.

## Periods, mappings, and limits

Use fresh boundary snapshots when changing the reporting period. Flow rates scale with actual elapsed hours; inventories never scale with duration. Reusing these snapshots for a longer period does not describe the same physical operation. **Reset template readings** restores matching preset readings; changed conversion configurations are left intact.

Each measured flow and each tank endpoint has a distinct `TANKS.*` Source Name. Tank-level mappings identify unit output rows. Tags illustrate mapping targets; replace them with actual plant identifiers before configuring SQL. Inventory SQL input requires an exact timestamp at each boundary and fails on missing, ambiguous, or unacceptable-quality data. It does not substitute old saved readings.

Read the [storage mathematics and assumptions](../docs/storage-mathematics.md) before applying the feature to plant reporting. Published diagrams distinguish throughput, opening/closing inventory, and signed accumulation. Reconciliation history remains capped at 20 runs per model.
