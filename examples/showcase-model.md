# Slurry filtration with recycle

This model represents a continuous slurry-conditioning and filtration process. Raw slurry is pumped into a mixer with wash water and recycled filtrate. A heater conditions the mixed slurry without adding or removing mass. A pressure filter removes wet cake. Its filtrate splits into saleable product and a recycle stream.

The model has nine symbols, nine streams, five physical meters, one virtual meter, and three unmetered streams. The wet-cake flow is inferred from the measured network rather than guessed. There are no tanks or storage terms.

## Verify the model

1. Select a completed one-hour period. All physical readings are average mass flow rates in **kg/h**; absolute uncertainty values are one standard deviation in **kg/h**.
2. Review the **Measurements** tab. Raw feed is 800, wash water is 200, recycle is 50, filter feed is 1,060, and product is 900.
3. Open the mixed-feed meter. Its virtual formula is `[RAW FEED] + [WASH WATER] + [RECYCLE]`, which gives a raw calculated value of 1,050 kg/h.
4. Run reconciliation. The independent filter-feed meter reads 10 kg/h above the upstream sum. Reconciliation distributes that mismatch according to meter uncertainty while exactly closing each process unit.
5. Inspect the published diagram and results. Product remains 900 kg; wet cake is inferred as **105 kg** for the selected hour. Every stream is uniquely observable.
6. Select a completed 24-hour period and run again with the same rate inputs. Every reconciled mass is multiplied by 24; the reconciled rates and weighted objective remain the same. Rerun a previous period to verify preserved run history.

## Expected values

For a one-hour interval, the kg/h values below are numerically equal to the result totals in kg. The rate measurements represent constant averages for the selected interval.

| Stream | Meter | Raw kg/h | Absolute input uncertainty kg/h | Reconciled kg/h | Change kg/h | 24-hour total kg |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| F-01 Raw feed | RAW FEED, physical | 800 | 10 | **804** | +4 | 19,296 |
| F-02 Pump discharge | Unmetered | — | — | **804** | — | 19,296 |
| F-03 Wash water | WASH WATER, physical | 200 | 5 | **201** | +1 | 4,824 |
| F-04 Mixed feed | MIXED FEED, virtual | 1,050 | 5 independent calculation error; 13.229 including propagated reference error | **1,056** | +6 | 25,344 |
| F-05 Filter feed | FILTER FEED, physical | 1,060 | 10 | **1,056** | −4 | 25,344 |
| F-06 Filtrate | Unmetered | — | — | **951** | — | 22,824 |
| F-07 Wet filter cake | Unmetered | — | — | **105** | — | 2,520 |
| F-08 Product | PRODUCT, physical | 900 | 10 | **900** | 0 | 21,600 |
| F-09 Recycle | RECYCLE, physical | 50 | 5 | **51** | +1 | 1,224 |

## Independent analytical check

Let `r`, `w`, `c`, `h`, `v`, and `p` be reconciled raw feed, wash water, recycle, filter feed, virtual mixed feed, and product. Conservation through the mixer and heater imposes `h = v = r + w + c`.

The measured discrepancy is `800 + 200 + 50 − 1060 = −10 kg/h`. The sum of the four independent physical-meter variances is `10² + 5² + 5² + 10² = 250 (kg/h)²`. Weighted least squares allocates corrections proportional to variance, with the downstream sign reversed:

```text
raw feed:    +10 × 100/250 = +4 kg/h
wash water:  +10 ×  25/250 = +1 kg/h
recycle:     +10 ×  25/250 = +1 kg/h
filter feed: −10 × 100/250 = −4 kg/h
```

The product reading has no conflicting independent downstream measurement, so it remains at 900 kg/h. The filter and splitter then determine `filtrate = product + recycle = 951 kg/h` and `wet cake = filter feed − filtrate = 105 kg/h`.

The unmetered wet cake cannot absorb the upstream discrepancy: the independent filter-feed meter is after the heater, and the heater must conserve the upstream total before the filtration split occurs.

The virtual meter is correlated with its three references. Its independent error term is `(v − 1050) − (r − 800) − (w − 200) − (c − 50)`, which is zero under exact mixer conservation. It therefore does not provide a duplicate independent measurement of throughput. The configured calculation uncertainty is 5 kg/h; the raw propagated uncertainty is `sqrt(10² + 5² + 5² + 5²) = sqrt(175) ≈ 13.229 kg/h`.

The weighted objective is `4²/10² + 1²/5² + 1²/5² + (−4)²/10² = 0.4`. The solver reports two degrees of freedom and its standard explanatory virtual-meter warning. It does not report unobservable flows or excessive disagreement.

## Unit and overall closure

| Process unit | Reconciled input kg/h | Reconciled output kg/h | Residual kg/h |
| --- | --- | --- | ---: |
| Feed pump | 804 | 804 | 0 |
| Feed mixer | 804 + 201 + 51 = 1,056 | 1,056 | 0 |
| Slurry heater | 1,056 | 1,056 | 0 |
| Pressure filter | 1,056 | 951 + 105 = 1,056 | 0 |
| Product split | 951 | 900 + 51 = 951 | 0 |
| External model boundary | 804 + 201 = **1,005** | 900 + 105 = **1,005** | **0** |

The recycle is internal and cancels from the overall boundary balance. Wet cake includes retained liquid. This is a total-mass balance, with no claim that component composition, heat duty, pressure losses, or filtration yield are separately solved.

## Mapping and additional checks

Each stream has a distinct `FILTRATION.*` Source Name, illustrating mapping targets without configuring or claiming a live SQL connection. Physical meters can be populated by an input connector; virtual and unmetered streams are calculated. Replace these tags with plant source names when connecting actual data.

For a perfectly consistent baseline, change the FILTER FEED reading from 1,060 to **1,050 kg/h**. Physical readings should then remain unchanged; inferred wet cake becomes **100 kg/h**, and the weighted objective becomes zero.

The supplied automated checks validate model structure, detached template creation, the independent analytical solution, every unit and boundary closure, the consistent baseline, and rate-to-mass scaling for 2.5-, 8-, 23-, 24-, and 25-hour periods.
