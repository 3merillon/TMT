# Startup topology qualification

2026-10-13. These are CPU geometry/connectivity results, separate from the browser/WebGPU captures and startup performance measurements.

## Recovered failures

The deterministic sweep recovered the reported class of failure at **seed 13**, `resident-f32-game-v3`, brick `0,1,2`. The original implementation failed both serial compilation and the runtime's eight-partition compilation/merge order. The saved pre-fix eight-partition fixture is [`startup-topology-failure.json`](../../tests/fixtures/terrain/startup-topology-failure.json): `Non-manifold occupied portal 113062,113072,113119`.

The physical triangle had four incidences, but they belonged to **two distinct supporting faces**: the shared lattice face and the bedrock plane. Each supporting face had exactly two opposite incidences. Rounded f32 geometry made the two topological patches coincide. Connectivity had used only the physical vertex set, incorrectly combining those separate portals. Portal matching now also checks `RegionFace.source`, consistently in local contraction, cross-brick adjacency, boundary lookup, and the independent fine graph. Three incidences of the same supporting face still fail explicitly. The regression asserts every captured region volume and every original physical face coordinate remain unchanged.

The extended sweep also recovered an inherited **seed 27** failure, brick `2,1,-1`: three unpaired edges and three orientation errors. The unmodified baseline produced the same failure; [`startup-seam-failure-27.json`](../../tests/fixtures/terrain/startup-seam-failure-27.json) records its affected regions and exact f32 words. A tiny triangle rounded collinear: all three vertices had x `13.916728019714355` and y `6.911545753479004`, with three distinct z words. Face tracing discarded the zero-area patch before its intermediate vertex could subdivide a neighboring long edge.

Flat traced patches now reach physical face construction, which retains their exact collinear edge subdivisions in adjacent positive-area polygons. No positions are moved or welded, and no positive-area polygon is removed. The seed-27 regression checks identical physical vertex sets, face counts and region volumes, unchanged surface area, and closed per-region boundaries. The source-page compiler cache is v4 so old packets that already discarded these subdivisions cannot be reused. Generator hashes and saved source parameters are unchanged.

## Reproduction and checks

- `npx vitest run tests/terrain-portal-identity.test.ts`: four fast tests covering both recorded fixtures, distinct coincident cross-brick portals, repeated prepares, discarded deltas, replacement updates, and genuine non-manifold rejection.
- `npx vitest run tests/resident-startup-portal.slow.test.ts`: both seeds initialize after an injected late initialization failure, pass the complete fine-graph oracle, abort a staged edit, retry the same edit, and pass multi-brick destruction, volume ledger and resource cleanup checks.
- Existing `terrain-transaction.test.ts` and the 64-impact `terrain-tetcache-identity.test.ts` passed during this work.
- `node --import tsx scripts/topology-seed-sweep.ts 0 64 0`: serial seeds 0–63, with the historical automatic type mapping (16 seeds of each type), qualify every local page and the complete adjacent-brick boundary. The final run was split into two independent processes; raw results are [`startup-topology-sweep-0-31.jsonl`](startup-topology-sweep-0-31.jsonl) and [`startup-topology-sweep-32-63.jsonl`](startup-topology-sweep-32-63.jsonl).
- `node --import tsx scripts/topology-seed-sweep.ts 13 1 8 - all` and the same command for seed 27 explicitly select all four world types and compile/merge all eight worker partitions. All eight combinations passed; raw results are [`startup-topology-selected-worlds.jsonl`](startup-topology-selected-worlds.jsonl) and [`startup-topology-selected-worlds-27.jsonl`](startup-topology-selected-worlds-27.jsonl). Seed-13's selected-type matrix preceded the second repair; its recorded geometry regression and full startup/edit tests also passed after both repairs.

The sweep's elapsed times include concurrent test/process contention and are **not performance benchmarks**. Worker-partition qualification executes the actual compiler and canonical merge order in Node, rather than claiming real worker parallelism or mobile hardware measurements. Real browser startup for seeds 13 and 27 is recorded separately under `artifacts/startup-audio/regressions`.
