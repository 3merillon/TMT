# Read-only basin depth diagnosis

2026-10-13. Reproduce with `node --import tsx scripts/diagnose-basin-depth.ts 128`. Raw results: [basin-depth-diagnostic.json](basin-depth-diagnostic.json). Production basin recipes were **not changed**.

The diagnostic samples the spherical v3 analytic terrain radius at all 98,304 production basin-grid directions and applies `solveBasins` for seeds 0, 7, 13, 27, 63 and 4,294,967,295, each explicitly selecting all four world types. These are initial analytic-bed measurements, **not GPU bed readbacks or settled visual-solver measurements**. They omit structures, SDF discretization, tank dry-point caps and dynamic flow. Additional dry-point caps can lower levels.

Depth means and shallow fractions below are weighted by wet surface area, combined across the six seeds. Maximum depth is the deepest sampled cell across that corpus. “Shallow” means the fraction of exposed liquid area with radial depth below the stated threshold; it is not camera-weighted visibility.

| Recipe and material | Mean depth (u) | Maximum depth (u) | Area below 0.3 u | Area below 0.6 u | Mean planet coverage |
|---|---:|---:|---:|---:|---:|
| Temperate water sea | 1.441 | 2.650 | 12.8% | 22.7% | 15.0% |
| Glacial water sea | 1.643 | 2.650 | 8.2% | 15.3% | 19.7% |
| Dune water lakes (no sea) | 0.852 | 1.926 | 26.8% | 43.3% | 7.6% |
| Volcanic lava sea | 0.263 | 0.907 | 61.8% | 93.6% | 13.0% |

Individual temperate sea means range from 0.783–1.684 u; glacial means from 1.357–1.833 u. Both sea recipes hit `MAX_SEA_LEVEL = 17.8` on every sampled seed. Increasing their target coverage by ten percentage points, or even to 50%, makes no difference: the safety cap is already the constraint. Their recipes do not explain generally shallow seas in this sample. Runtime bed/dry-cap probes and optical presentation should be checked before changing them.

Volcanic lava is genuinely shallow under the current 12% coverage target: it fills only the lowest parts of the broad basin floor. A diagnostic-only increase to 16% target coverage increases aggregate mean depth to 0.569 u, maximum depth to 1.847 u and reduces the below-0.3-u area to 40.4%; average actual coverage rises to 16.0%. This is a small candidate recipe change, but not free of tradeoffs: seed 13 loses one water lake because the solver omits water lakes whose level is below the lava sea level. A 22% target is much more disruptive (mean lava depth 1.611 u and fewer water lakes). Keep the existing dry-spawn cap in any deliberate recipe revision.

`LakeRule.minDepth` filters **potential spill depth**, before multiplying by `fill`. It does not guarantee the final lake's depth or mean depth. Current threshold/fill combinations permit maximum depths as small as 0.245 u for temperate, 0.210 u for dune and 0.165 u for volcanic water pools, before dry caps. Some small dune lakes have mean depth only 0.077 u. Raising all lake fills to 0.85 is not a narrow fix: in this corpus dune coverage grows from 7.6% to 16.7%, but mean depth falls from 0.852 to 0.800 u and the shallow fraction rises from 26.8% to 45.6%, as broad shallow margins become wet.

Recommended verification before tuning:

- Probe actual initialized GPU bed, surface and depth at interior and shoreline points for the same explicit seed/type matrix; repeat after warm-up and after settling. Record the active spawn cap. Compare to this analytic baseline.
- Keep dry-spawn, deterministic labels, material separation, overflow and volume conservation tests. Any minimum-depth requirement must state whether it means spill depth, final maximum depth or mean wet-area depth; dry safety must remain dominant.
- Compare a stationary tank and a moving tank on the same wet route using waterline contact, displaced volume, peak wake height, flow, foam and spray. Deepening water alone can submerge the hull below the waterline and attenuate the visible wake.
- Preserve the presentation/gameplay distinction: the rendered liquid and its wakes are separate from deterministic standing-liquid queries. The current gameplay path uses `GameLiquids` and vehicle liquid resistance; this earlier analytic diagnosis did not measure that behavior. See [fluid architecture](../fluid-architecture.md).

No GPU or browser work was run for this diagnosis.
