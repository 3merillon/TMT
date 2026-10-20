# Performance measurements — 14 October 2026

This is a dated comparison of preserved production revisions, beginning at planetary-lighting commit `29baad2`.
Its timings, bundle sizes and failures apply to the named revisions and hardware, rather than the current checkout.
Current Rust/WASM ownership is described in [runtime architecture](architecture.md);
[release readiness](release-readiness.md) records current validation and remaining qualification.

Raw reports, helper output and preserved bundles are local-only material outside the public source tree. Paths such
as `artifacts/performance-pass/` below identify their original layout; these files are not included in a clone.

## How it was measured

Hardware and software: Intel i7-12700F, NVIDIA RTX 3080 (driver 617.42), 64 GB, Windows 11, Chromium 149.0.7827.55 (Playwright build 1228) with WebGPU on D3D12, 1600×1000 at device scale 1, High tier, native render scale, on a 120 Hz desktop. Every arm is a preserved production bundle with recorded source hashes (`scripts/build-planetary-lighting.ts`), served by `vite preview`.

Two harnesses answer two different questions.

**GPU pass cost**: `scripts/capture-planetary-lighting.ts`, the existing fixed-step driver. It advances presentation by 1/60 s per frame, allows two outstanding submissions, freezes the simulation and records per-pass GPU timestamps for every frame. Its numbers are the cost of the GPU work, not a frame rate. Plans: `planetary-lighting-matched.json` (six static views), `performance-impacts.json` (a real blast per munition, 8–10 s each), `performance-fog.json` (fog of war on, as in real matches), `performance-attribution.json` (single effects switched off, to attribute cost).

**Real play**: `scripts/capture-performance.ts`, new in this pass. It boots the same production bundle, settles it with the fixed-step driver, then puts a real-time driver in front of the `?renderbench` hook: no fixed step and no batch gate, so the ordinary rAF loop, real dt, real keyboard and mouse input and real shots run. Everything in the page is injected by the harness (`scripts/performance-probe.ts`), so an unmodified baseline bundle and a candidate are measured by the same code. Per rendered frame it records the rAF timestamp, main-thread work inside rAF callbacks, the JS heap and the time at which the GPU finished the frame; it also records long tasks, long animation frames with their scripts, and named marks. Reported per scenario: sustained FPS, frame-interval p50/p95/p99/max, counts of intervals over 16.7, 25, 33.4, 50 and 100 ms, main-thread work per frame, long tasks, allocation rate and collections. `--api-stats` adds WebGPU call counts, uploaded bytes, resource creation and readback latency; `--trace` adds a CPU profile per thread with garbage-collector time and the functions inside the worst frames; `--alloc` adds allocation sites. Those three, `--video` and `--shot-every` cost time and are used to attribute, never to report frame times. Function names in profiles come from an unminified build (`build-planetary-lighting.ts <dir> --profile`); frame times always come from the real bundle.

Scenarios (`scripts/capture-plans/performance-realtime.json`), all on seed 7: quiet driving with the follow camera (with and without fog of war), an idle overview, dense cloud under a rapid camera orbit, four tanks with headlights at night, three explosive shots, two incendiary shots, two nuclear shots, an overlapping barrage of six shots of mixed munitions, three radius-5 terrain edits, and a building blasted three times until it collapses (the last blast nuclear, at dusk). Shots are real: the Space key fires the tank's weapon and the shell flies, lands, cuts the terrain through the transaction path and throws debris. The first event of each scenario is marked as first use and later ones as warmed repeats.

What the real-time numbers mean. Headless Chromium paces rAF at the desktop's 120 Hz, so intervals sit on an 8.33 ms grid: a frame that needs 10 ms alternates between 8.33 and 16.67 ms and reads as 80–100 fps. Sustained FPS is frames over wall time. When the GPU is the limit the browser queues several frames, so the GPU-completion latency reported here (55–120 ms at baseline) is a property of this headless setup, not a claim about input latency on a display. The machine was checked idle before every timed block (CPU under 15 %, GPU under 12 %, read from `nvidia-smi`), one GPU workload ran at a time under the shared `tmt-gpu.lock`, and no compilation or test ran during a timed block.

Matched images: `scripts/capture-planetary-lighting.ts --visual --profile scripts/capture-plans/performance-visual.json` renders seven still views and four blasts at fixed frames; `scripts/compare-captures.ts` compares two such sets shot by shot (identical or not, largest and mean difference in 8-bit levels, PSNR, SSIM, share of pixels changed by more than 2 and 8 levels) and writes amplified difference images. The baseline was captured twice to measure its own run-to-run noise.

## Where the time went at baseline

Measured on `29baad2` before any change (`artifacts/performance-pass/baseline/`, three real-play repeats per scenario).

GPU, static views, fixed step: 9.4–11.7 ms per frame. The largest passes were the haze (`volumetrics`, 4.2–4.6 ms in the overview and daylight views of the other biomes, 0.9–1.2 ms close up), the deferred `lighting` kernel (1.1–3.2 ms, most in the low-sun close view), the cloud raymarch (1.2–3.4 ms, most at night with four headlights), grass (`gbuffer.foliage`, 1.5 ms on temperate planets) and the fluid solvers (`fluids.step` 0.9–1.1 ms, `fluids.water` 0.4 ms). Attribution runs (`performance-attribution.json`) located the haze cost: switching off the sun's haze removed 0.08 ms, switching off the local-light haze removed 4.3 ms. The lighting kernel's cost was not explained by any single effect; the largest single toggles were sun shadows (−0.17 ms) and contact shadows (−0.14 ms).

GPU during blasts: the cloud raymarch dominated. Mean over the 8–10 s after impact: 19.1 ms for an explosive shell in daylight (peaks 42.6 ms), 17.6 ms for a nuclear shell at night under dense cloud, 8.5 ms for incendiary at night, 4.9 ms for nuclear in daylight. Of the explosive case's 21.8 ms, the shockwave's cloud displacement accounted for 10.3 ms and the fire's local light inside the clouds for 5.6 ms (both off: 5.9 ms; calm sky: 2.1 ms). The gas draw added 1.4–1.8 ms and an SDF rebuild after each terrain commit about 2.2 ms on one frame.

CPU in real play: 3–4 ms of main-thread work per frame while driving, the frame rate otherwise held by the GPU (82 fps driving, 89 overview, 58 under dense cloud while orbiting, 109 at night). Every shot, first or repeated, stalled the main thread once for 110–135 ms at the terrain commit: `DebrisDynamics.syncScene` rebuilt the cosmetic debris world's whole-planet trimesh (53 % of the stall) and its visibility triangles (17 %). Structural collapse spent 42 % of its main-thread time in the debris world's update (the Rapier step, 3.0 s in 30 s) and produced 40 frames over 33 ms per run. JavaScript allocated 65–156 MB/s with heap peaks near 600 MB; the terrain page workers ran 100–220 ms tasks, about two thirds of it in garbage collection. A blast request reached committed terrain 182–633 ms later.

The six overlapping shots of the barrage scenario compounded both: 54.5 fps, six stalls over 100 ms and 5.3 s spent beyond 16.7 ms frames in 30 s.

## What changed

The measured changes were integrated into candidate `e672d19`. "Exact" means the same bits: images, simulation state or query answers identical to `29baad2`, checked by an oracle test that keeps the previous implementation, by hashing GPU state, or by comparing frames. Where a change is not exact it says so.

**Debris (the stall at every shot).** The cosmetic debris world rebuilt one trimesh of the whole planet (85,766 triangles, about 110 ms) on the first frame after every terrain commit. It now keeps one trimesh per collision page, cooked from the page's typed arrays with the same flags, friction and restitution, recooks only the pages a commit changed (a 2.6 crater: 4 pages, 530 triangles, 0.5 ms), and cooks the committed planet in 2 ms slices after load, stopping before a page that would overrun the slice. Its step is O(awake) in Rapier calls and allocates nothing; kinematic mirrors of the tanks write only what changed. Fragments, shard states against the old step and sleeping shards are bit-identical to the oracle (`tests/fx-terrain-debris.test.ts`). Not exact: internal-edge smoothing now stops at the 6-unit brick seams, as in the gameplay world, and a commit wakes only shards touching a replaced page, so chunks tumble along different paths from the baseline. `scripts/check-debris-pages.ts` runs both worlds in lockstep through real blasts: no tunnelling, the same slide distances and rest depths. The candidate is deterministic run to run, and the matched blast images differ only in where chunks land.

**Terrain edits.** Page workers produce far less garbage per compile; the commit reports tight dirty bounds; changed triangles are matched by numeric keys; a transaction's page scratch, scan offsets and block sums come from pooled arenas and its uploads are batched; Rapier staging and the per-body loops of a prepare are sliced; sleeping bodies skip pose syncs; a cooked shape is handed to Rapier once. The structural and terrain tests pin the results.

**Collision queries.** Terrain collision chunks are indexed and their BVHs flattened; `math.ts` is computed without three.js temporaries, bit for bit; the query version is bumped only when a dynamic body moved; the tread profile samples flat buffers. Exact: `tests/game-tread-identity.test.ts` and the collision identity test (grazing rays and sweeps included) compare against the old code; `scripts/bench-queries.ts` times a bot-versus-bot match.

**Tank views.** The belt and kit pose kernels are allocation-free and memoised for unchanged poses; tank views and the part-mesh table pose and upload only what changed; draws are counted on demand; repeated overlay uploads and unchanged shadow-map stamps are skipped. Exact: the kernels are pinned to their pre-rewrite output by test.

**First use.** The renderer's one-time work for a match (full SDF build, first-use allocations, basin solve and water fill, tank meshes) now runs behind the loading screen: a warm-up loop renders the tick-0 snapshot with dt 0, so no simulation step runs and every presentation clock starts where it did, until the SDF is built, no pipeline compiles and the water is filled, plus three frames (at most 4 s), keeping one frame on the GPU at a time. The audio context and engine are built in idle time before the first gesture, which used to block the main thread for 60–90 ms. The gas solver's pipelines are warmed at load.

**Haze and lighting.** A new pass keeps a sun-visibility class per 4³-voxel SDF cell, proved from texel bounds swept along the sun within a drift allowance: lit, dark (must land in rock) or uncertain. The aerial-perspective, sky and haze marches toward the sun answer from one fetch where the class is certain and run the unchanged march elsewhere; dark answers are ignored while crater cuts are carved analytically, and the classes are cleared when the SDF changes. Each haze pixel is split over two invocations. Lighting no longer traces sun and moon visibility where N·L makes the term exactly zero. AO cones stop at zero, and tank bricks that cannot lower the minimum are skipped. All bit-identical (checked against the previous pipelines in the same frames; a CPU mirror test checks the class proofs).

**Grass.** A compute pass culls blades and clump shadows per frame against the jittered frustum and lists the survivors in root order. The G-buffer and shadow draws are indexed indirect draws over those lists, so the surviving blades run the same vertex code on the same inputs in the original order.

**Fluids.** Water passes skip 16×16 tiles where nothing can change (state, flux, levels and atlases hash identically through a moving hull, a water blast and a fireball). The gas raymarch samples only lattice indices whose footprint can reach occupied cells (bit-identical). The gas solver's second half runs at the start of the next frame, where nothing drawn reads it, so the field shown each frame is unchanged. The shockwave pass is scissored to the waves' reach, and the bed march during a pending crater covers only the cells a cut reaches.

**Clouds.** While no gas domain or pressure pulse is live, a second raymarch pipeline without the flow code runs. Rays that cross no gas domain and no young shell skip the departure, zero-fade domains skip the atlas fetch, steps outside every light's range chord skip the local-light path, and tank casters are tested before the terrain trace. Bit-identical against the `29baad2` kernels on the same inputs (raw cloud, metadata and shadow cube over ten scenes). This leaves the blast case nearly where it was (below).

**Temporal upscaler (optional, default off).** Below native resolution, the `taa` slot resolves through a temporal upscaler adapted from the Planets TSR (itself a port of `@pmndrs/upscaler` 0.5.0: FSR 2 structure, FSR 1 RCAS sharpening; MIT notices in the shader header and `public/THIRD-PARTY-NOTICES.txt`). TMT additions: a reactive mask for gas, fire, muzzle gas and spray, which resolve by the TAA's own rule; a shading-change test so flashes do not trail; re-committed terrain keeps history only where the depth agrees; and the clouds, which have their own temporal filter, keep only TAA-like history so they are not filtered twice. The settings offer native (default), 77 %, 67 % and 50 %. At native the module is never loaded, and the TAA shader is pinned by hash.

## Results

Baseline `29baad2` (two arms: three real-play repeats early on 2026-10-14, two later) against the merged candidate `e672d19` (three arms, two to five repeats), in the order A, B, A, B on one idle machine. Raw data: `artifacts/performance-pass/baseline/` and `artifacts/performance-pass/final/{baseline-run2,candidate-run1,candidate-run2,candidate-run2b}/`. The tables are `scripts/performance-report.ts` over those directories. Fixed-step values are the median of the arms' medians; real-play values are the median over every repeat.

The GPU frame in the static views fell by 26–56 % (11.4 → 5.0 ms in the overview). Every real-play scenario runs 10–33 % faster; the overview and the night scene now hold the display's 120 Hz. The main-thread stall at every terrain commit is gone. No run of the candidate had a frame over 50 ms, a long task, or a hitch over 100 ms; the baseline had two to six hitches over 100 ms in every scenario with a shot. Allocation fell from 65–154 MB/s to 23–43 MB/s. Terrain edits arrive as early as before or earlier.

### GPU passes per frame, fixed step: static (ms)

| Scene | Before median | After median | Change | Before p95 / max | After p95 / max | Tracked GPU MiB before → after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| temperate-low-sun-close-on | 10.56 | 7.86 | −26 % | 11.2 / 12.0 | 8.3 / 8.8 | 758 → 766 |
| temperate-overview-on | 11.41 | 5.02 | −56 % | 12.1 / 13.8 | 5.1 / 5.4 | 758 → 766 |
| temperate-night-spots-on | 11.71 | 8.41 | −28 % | 12.4 / 13.1 | 8.5 / 9.3 | 874 → 884 |
| glacial-day-on | 9.44 | 4.60 | −51 % | 10.0 / 10.5 | 4.6 / 5.3 | 756 → 764 |
| volcanic-day-on | 10.62 | 5.76 | −46 % | 11.3 / 13.0 | 5.8 / 6.1 | 749 → 757 |
| dune-day-on | 10.33 | 5.13 | −50 % | 11.0 / 11.6 | 5.2 / 5.8 | 752 → 760 |

Passes of at least 0.15 ms in either arm, mean ms over the frames on which the pass ran (before → after):

| Pass | temperate-low-sun-close-on | temperate-overview-on | temperate-night-spots-on | glacial-day-on | volcanic-day-on | dune-day-on |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `volumetrics` | 0.94 → 0.87 | 4.58 → 0.72 | 1.21 → 0.81 | 4.17 → 0.59 | 4.19 → 0.60 | 4.19 → 0.60 |
| `clouds.raymarch` | 2.02 → 1.53 | 1.69 → 1.29 | 3.44 → 3.03 | 1.18 → 0.81 | 1.82 → 1.29 | 2.02 → 1.51 |
| `lighting` | 3.22 → 3.19 | 1.11 → 1.00 | 2.04 → 1.69 | 1.60 → 1.35 | 1.88 → 1.57 | 1.69 → 1.41 |
| `gbuffer.foliage` | 1.51 → 0.12 | 1.44 → 0.13 | 1.52 → 0.12 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| `fluids.step` | 0.95 → 0.43 | 0.93 → 0.33 | 0.96 → 0.57 | 0.92 → 0.33 | 1.13 → 0.86 | 0.93 → 0.19 |
| `ao.sdf` | 0.22 → 0.20 | 0.08 → 0.09 | 0.58 → 0.54 | 0.08 → 0.09 | 0.08 → 0.08 | 0.08 → 0.08 |
| `fluids.water` | 0.39 → 0.31 | 0.39 → 0.34 | 0.40 → 0.19 | 0.40 → 0.34 | 0.41 → 0.23 | 0.39 → 0.09 |
| `fluids.composite` | 0.16 → 0.16 | 0.26 → 0.25 | 0.16 → 0.17 | 0.21 → 0.19 | 0.15 → 0.14 | 0.15 → 0.14 |
| `gbuffer.opaque` | 0.22 → 0.22 | 0.09 → 0.09 | 0.22 → 0.22 | 0.15 → 0.15 | 0.25 → 0.25 | 0.16 → 0.16 |
| `gbuffer.tanks` | 0.03 → 0.03 | 0.00 → 0.00 | 0.20 → 0.20 | 0.01 → 0.01 | 0.01 → 0.01 | 0.01 → 0.02 |
| `grass.shadows` | 0.18 → 0.04 | 0.17 → 0.00 | 0.18 → 0.00 | n/a → n/a | n/a → n/a | n/a → n/a |
| `gi.probes` | 0.10 → 0.10 | 0.11 → 0.11 | 0.12 → 0.12 | 0.11 → 0.11 | 0.10 → 0.10 | 0.11 → 0.29 |

### GPU passes per frame, fixed step: impacts (ms)

| Scene | Before median | After median | Change | Before p95 / max | After p95 / max | Tracked GPU MiB before → after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| impact-explosive-day | 26.89 | 24.85 | −8 % | 51.8 / 54.8 | 47.9 / 50.7 | 758 → 768 |
| impact-incendiary-night | 18.43 | 14.91 | −19 % | 20.5 / 21.7 | 16.4 / 17.4 | 758 → 768 |
| impact-nuclear-day | 14.31 | 12.26 | −14 % | 15.5 / 16.8 | 13.2 / 14.1 | 758 → 768 |
| impact-nuclear-night-dense-clouds | 26.76 | 24.42 | −9 % | 33.0 / 40.0 | 30.0 / 37.3 | 758 → 768 |

Passes of at least 0.15 ms in either arm, mean ms over the frames on which the pass ran (before → after):

| Pass | impact-explosive-day | impact-incendiary-night | impact-nuclear-day | impact-nuclear-night-dense-clouds |
| --- | ---: | ---: | ---: | ---: |
| `clouds.raymarch` | 19.25 → 19.03 | 8.54 → 7.77 | 4.86 → 5.18 | 17.62 → 17.80 |
| `lighting` | 2.16 → 1.87 | 2.17 → 1.80 | 2.28 → 1.97 | 2.09 → 1.68 |
| `fluids.gasDraw` | 1.80 → 1.67 | 1.77 → 1.69 | 1.54 → 1.61 | 1.41 → 1.49 |
| `gbuffer.foliage` | 1.59 → 0.12 | 1.57 → 0.12 | 1.55 → 0.10 | 1.57 → 0.11 |
| `sdf.grow` | 1.21 → 0.33 | 1.21 → 0.32 | 1.46 → 0.60 | 1.46 → 0.62 |
| `volumetrics` | 1.06 → 0.93 | 1.15 → 1.04 | 1.06 → 0.99 | 1.04 → 0.92 |
| `fluids.step` | 0.96 → 0.55 | 0.95 → 0.54 | 0.94 → 0.53 | 0.95 → 0.56 |
| `sdf.gather` | 0.40 → 0.10 | 0.40 → 0.10 | 0.42 → 0.27 | 0.41 → 0.30 |
| `fluids.water` | 0.39 → 0.21 | 0.39 → 0.22 | 0.40 → 0.21 | 0.39 → 0.21 |
| `gbuffer.opaque` | 0.23 → 0.23 | 0.23 → 0.23 | 0.25 → 0.25 | 0.25 → 0.25 |
| `ao.sdf` | 0.22 → 0.20 | 0.22 → 0.20 | 0.19 → 0.17 | 0.20 → 0.17 |
| `fluids.gas` | 0.21 → 0.09 | 0.17 → 0.09 | 0.21 → 0.11 | 0.21 → 0.12 |
| `grass.shadows` | 0.18 → 0.05 | 0.18 → 0.00 | 0.18 → 0.03 | 0.18 → 0.00 |
| `sdf.flood` | 0.17 → 0.18 | 0.17 → 0.18 | 0.17 → 0.18 | 0.17 → 0.18 |
| `fluids.composite` | 0.17 → 0.16 | 0.17 → 0.16 | 0.16 → 0.16 | 0.17 → 0.16 |

### GPU passes per frame, fixed step: fog (ms)

| Scene | Before median | After median | Change | Before p95 / max | After p95 / max | Tracked GPU MiB before → after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fog-low-sun-close | 10.79 | 8.17 | −24 % | 11.1 / 11.9 | 8.4 / 9.0 | 878 → 889 |
| fog-overview | 9.22 | 5.17 | −44 % | 9.4 / 10.3 | 5.2 / 5.6 | 878 → 889 |

Passes of at least 0.15 ms in either arm, mean ms over the frames on which the pass ran (before → after):

| Pass | fog-low-sun-close | fog-overview |
| --- | ---: | ---: |
| `lighting` | 3.41 → 3.39 | 1.28 → 1.16 |
| `clouds.raymarch` | 2.01 → 1.53 | 1.67 → 1.29 |
| `volumetrics` | 0.61 → 0.56 | 1.83 → 0.36 |
| `gbuffer.foliage` | 1.52 → 0.12 | 1.46 → 0.13 |
| `fluids.step` | 0.94 → 0.54 | 0.92 → 0.33 |
| `fluids.water` | 0.39 → 0.21 | 0.39 → 0.34 |
| `fluids.composite` | 0.16 → 0.16 | 0.28 → 0.27 |
| `fog.volume` | 0.23 → 0.22 | 0.21 → 0.21 |
| `gbuffer.opaque` | 0.22 → 0.22 | 0.09 → 0.09 |
| `ao.sdf` | 0.21 → 0.20 | 0.07 → 0.08 |
| `grass.shadows` | 0.18 → 0.04 | 0.17 → 0.00 |

### Real play (real rAF pacing, real input and shots; median over 2–5 repeats before, 4–5 after)

| Scenario | FPS | Change | Frame interval p50 / p95 / p99 ms (before) | (after) | Worst frame ms, median of runs | Worst frame ms, any run |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dense-clouds-orbit | 58.5 → 80.4 | +27 % | 16.7 / 25.0 / 25.1 | 8.5 / 16.7 / 16.8 | 27 → 25 | 33 → 25 |
| explosive-shots | 76.0 → 107.0 | +29 % | 16.6 / 16.8 / 25.0 | 8.3 / 16.7 / 16.7 | 125 → 17 | 133 → 18 |
| incendiary-shots | 78.4 → 116.3 | +33 % | 16.6 / 16.7 / 16.8 | 8.3 / 8.5 / 16.7 | 125 → 17 | 133 → 17 |
| large-edits | 75.0 → 91.8 | +18 % | 16.5 / 25.0 / 25.1 | 8.4 / 16.7 / 17.3 | 125 → 26 | 133 → 27 |
| night-headlights | 108.4 → 120.0 | +10 % | 8.3 / 16.7 / 16.8 | 8.3 / 8.4 / 8.6 | 33 → 9 | 33 → 10 |
| nuclear-shots | 93.0 → 106.7 | +13 % | 8.4 / 16.7 / 16.8 | 8.3 / 16.7 / 16.7 | 133 → 18 | 175 → 25 |
| overlapping-barrage | 54.5 → 68.7 | +21 % | 16.7 / 25.1 / 33.4 | 16.6 / 25.0 / 25.2 | 125 → 34 | 133 → 35 |
| overview-idle | 89.2 → 120.0 | +26 % | 8.4 / 16.7 / 16.8 | 8.3 / 8.4 / 8.5 | 25 → 9 | 33 → 9 |
| quiet-drive | 81.8 → 107.3 | +24 % | 8.4 / 16.7 / 16.8 | 8.3 / 16.7 / 16.7 | 42 → 17 | 83 → 17 |
| structure-collapse | 48.9 → 69.4 | +30 % | 16.7 / 33.3 / 41.4 | 16.6 / 25.1 / 33.4 | 131 → 43 | 142 → 43 |
| bot-duel | 81.0 → 104.4 | +22 % | 8.4 / 16.8 / 25.0 | 8.3 / 16.7 / 16.8 | 133 → 25 | 133 → 33 |
| quiet-drive-fog | 79.9 → 101.3 | +21 % | 16.6 / 16.7 / 25.0 | 8.3 / 16.7 / 16.7 | 33 → 17 | 33 → 17 |

Hitches per run (frame intervals over the limit), main-thread work per frame, long tasks and allocation (before → after):

| Scenario | > 33.4 ms | > 50 ms | > 100 ms | Time beyond 16.7 ms frames, ms | Main-thread work p95 / max ms | Long tasks: count, total ms | JS allocation MB/s | JS heap peak MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dense-clouds-orbit | 0 → 0 | 0 → 0 | 0 → 0 | 733 → 28 | 2.9 / 4 → 1.9 / 3 | 0, 0 → 0, 0 | 65 → 23 | 401 → 402 |
| explosive-shots | 4 → 0 | 3 → 0 | 3 → 0 | 530 → 3 | 6.4 / 129 → 4.5 / 14 | 3, 363 → 0, 0 | 128 → 36 | 502 → 388 |
| incendiary-shots | 2 → 0 | 2 → 0 | 2 → 0 | 247 → 3 | 6.0 / 124 → 4.0 / 12 | 2, 241 → 0, 0 | 123 → 38 | 595 → 386 |
| large-edits | 3 → 0 | 3 → 0 | 3 → 0 | 1458 → 192 | 9.9 / 125 → 7.5 / 20 | 3, 350 → 0, 0 | 130 → 35 | 467 → 394 |
| night-headlights | 0 → 0 | 0 → 0 | 0 → 0 | 19 → 0 | 3.8 / 6 → 2.5 / 5 | 0, 0 → 0, 0 | 154 → 43 | 553 → 602 |
| nuclear-shots | 2 → 0 | 2 → 0 | 2 → 0 | 391 → 5 | 5.7 / 131 → 4.4 / 22 | 2, 250 → 0, 0 | 136 → 34 | 454 → 402 |
| overlapping-barrage | 25 → 3 | 6 → 0 | 6 → 0 | 5283 → 2571 | 12.6 / 128 → 9.0 / 27 | 6, 736 → 0, 0 | 118 → 36 | 594 → 437 |
| overview-idle | 0 → 0 | 0 → 0 | 0 → 0 | 10 → 0 | 2.5 / 5 → 1.6 / 3 | 0, 0 → 0, 0 | 82 → 30 | 588 → 360 |
| quiet-drive | 1 → 0 | 0 → 0 | 0 → 0 | 38 → 2 | 4.0 / 6 → 2.8 / 5 | 0, 0 → 0, 0 | 120 → 30 | 456 → 365 |
| structure-collapse | 44 → 15 | 3 → 0 | 3 → 0 | 6683 → 2849 | 13.4 / 129 → 9.0 / 30 | 3, 357 → 0, 0 | 105 → 30 | 596 → 410 |
| bot-duel | 5 → 0 | 3 → 0 | 3 → 0 | 930 → 72 | 5.9 / 129 → 4.5 / 14 | 3, 362 → 0, 0 | 111 → 31 | 604 → 395 |
| quiet-drive-fog | 0 → 0 | 0 → 0 | 0 → 0 | 146 → 2 | 4.0 / 6 → 2.9 / 5 | 0, 0 → 0, 0 | 115 → 29 | 966 → 633 |

First use against warmed repeats, per marked event until the next mark (before → after):

| Event | Worst frame ms | Longest main-thread task ms | Frames > 33.4 ms | FPS in the window |
| --- | ---: | ---: | ---: | ---: |
| explosive-shots · shot-1-first-use | 125 → 17 | 129 → 0 | 2 → 0 | 75.2 → 106.6 |
| explosive-shots · shot-2-warmed | 117 → 17 | 116 → 0 | 1 → 0 | 75.5 → 106.2 |
| explosive-shots · shot-3-warmed | 117 → 17 | 119 → 0 | 1 → 0 | 74.9 → 106.6 |
| incendiary-shots · shot-1-first-use | 125 → 17 | 125 → 0 | 1 → 0 | 76.6 → 114.5 |
| incendiary-shots · shot-2-warmed | 117 → 17 | 116 → 0 | 1 → 0 | 78.5 → 117.6 |
| large-edits · edit-1-first-use | 125 → 25 | 125 → 0 | 1 → 0 | 76.6 → 93.0 |
| large-edits · edit-2-warmed | 108 → 26 | 112 → 0 | 1 → 0 | 73.8 → 89.3 |
| large-edits · edit-3-warmed | 117 → 26 | 114 → 0 | 1 → 0 | 73.0 → 89.7 |
| nuclear-shots · shot-1-first-use | 133 → 18 | 131 → 0 | 1 → 0 | 78.4 → 97.2 |
| nuclear-shots · shot-2-warmed | 117 → 17 | 120 → 0 | 1 → 0 | 106.4 → 115.0 |
| overlapping-barrage · shot-1-explosive | 125 → 17 | 128 → 0 | 2 → 0 | 77.9 → 105.4 |
| overlapping-barrage · shot-2-heavy | 125 → 25 | 124 → 0 | 1 → 0 | 53.1 → 72.6 |
| overlapping-barrage · shot-3-incendiary | 117 → 25 | 120 → 0 | 1 → 0 | 51.8 → 67.9 |
| overlapping-barrage · shot-4-nuclear | 108 → 25 | 114 → 0 | 1 → 0 | 58.3 → 77.0 |
| overlapping-barrage · shot-5-nuclear | 125 → 25 | 125 → 0 | 1 → 0 | 51.1 → 61.7 |
| overlapping-barrage · shot-6-nuclear | 117 → 34 | 122 → 0 | 19 → 3 | 47.7 → 57.5 |
| structure-collapse · collapse-1-first-use | 131 → 43 | 129 → 0 | 14 → 7 | 49.4 → 73.0 |
| structure-collapse · collapse-2-warmed | 123 → 36 | 118 → 0 | 19 → 8 | 49.6 → 72.0 |
| structure-collapse · collapse-3-nuclear | 108 → 27 | 110 → 0 | 7 → 0 | 45.9 → 59.7 |
| bot-duel · shot-1 | 133 → 25 | 129 → 0 | 4 → 0 | 68.2 → 87.1 |
| bot-duel · shot-2 | 117 → 25 | 114 → 0 | 1 → 0 | 80.3 → 103.1 |
| bot-duel · shot-3 | 18 → 9 | 0 → 0 | 0 → 0 | 90.2 → 120.0 |

Terrain edit latency, from the blast request to the committed terrain (ms, before → after):

| Edit | Latency ms |
| --- | ---: |
| large-edits · blast:heavy:5 | 240 → 190 |
| large-edits · blast:heavy:5 | 167 → 93 |
| large-edits · blast:heavy:5 | 219 → 129 |
| structure-collapse · blast:heavy:3 | 420 → 428 |
| structure-collapse · blast:heavy:3 | 633 → 527 |
| structure-collapse · blast:nuclear:4 | 260 → 213 |

### Startup

`scripts/benchmark-browser-startup.ts --frames 300` against both served bundles, 12 runs each (`artifacts/performance-pass/final/accept/startup-*`). The first seconds of play after the match reports ready: worst frame 167 ms (up to 242) → 42 ms, frames over 50 ms 2 → 0, time beyond 16.7 ms frames 328 → 25 ms, longest main-thread task 114 ms → none. The price is a longer loading screen: playable after 6.03 s → 6.39 s (the renderer warm-up takes 0.49 s; part of it overlaps other loading). Fully settled, fluids included, after 8.88 s → 8.93 s.

### Unchanged lighting gates

`scripts/capture.ts --plan lighting --perf --gpu-timings --repeat 3 --min` with `budgets/lighting.json`, run from a detached worktree at `29baad2` and then from the candidate (`artifacts/performance-pass/final/accept/lighting-*`). Baseline: 74 pass, 7 fail. Candidate: 75 pass, 6 fail. Every candidate failure is inherited:

| Gate | Limit | `29baad2` | Candidate |
| --- | ---: | ---: | ---: |
| temperate / glacial / dune / volcanic terminator (night-side ÷ day-side luma) | ≤ 0.15 | 0.292 / 0.348 / 0.337 / 0.287 | 0.292 / 0.348 / 0.337 / 0.287 |
| `gpu-day-lighting` (ms) | ≤ 0.805 | 0.869 | 0.818 |
| `gpu-crater-lighting` (ms) | ≤ 0.805 | 0.963 | 0.871 |
| `gpu-boom6-lighting` (ms) | ≤ 0.805 | 0.853 | passes |

The terminator ratios match to the fourth decimal in both arms, so this pass neither caused nor changed them. The two lighting timing gates that still fail are over by 2 % and 8 % after tolerance, where the baseline was over by 8 % and 20 %.

### Functional acceptance on the candidate

All under `artifacts/performance-pass/final/accept/`:

- Contact-shadow defect stays fixed: `check-terrain-shadow-comparison.ts` against `artifacts/planetary-lighting/diagnosis-before` passes.
- Real ground aiming (`capture-ground-aim.ts`): 19 of 19 checks, including aiming while driving, a moving target, the wheel-held range and aiming after a crater.
- Tank customization (`verify-tank-customization.ts`): 12 of 12 groups. Headlights (`--headlights-only`): 8 of 8. Workshop camera (`verify-workshop-camera.ts`): 3 of 3.
- Gas lighting (`qualify-gas-lighting.ts`) and optics (`qualify-optics.ts`): no errors.
- Tests: 184 files, 1536 tests passed (2 expected failures, as before); guards clean; Naga validation of the engine shaders runs inside the engine tests.

- Lifecycle (`capture-planetary-lighting.ts --motion --lifecycle`: driving, firing, a crater, an orbit, effects off and on, all four tiers, render scale, resize, a camera jump, two scene re-entries and renderer disposal), run to the end on both bundles with `TMT_LIFECYCLE_CONTINUE=1` (`accept/motion-baseline`, `accept/motion-candidate-2`, recordings included). Driving, firing and the crater pass on both. The baseline fails three allocation checks that the candidate passes: fluids allocations are not restored after the resize or after either re-entry (173,848,080 bytes against 173,725,536). Both fail the teardown check, so it is inherited: after `disposeRenderer` the GPU terrain's resident pages stay allocated, 365.7 MB at baseline and 374.3 MB on the candidate, whose extra 8.6 MB sit in the terrain category where the pooled transaction arenas are now counted.

### Temporal upscaler

Quality against native (`scripts/tsr-eval.ts`, `accept/tsr-eval/report.json`): SSIM 0.967–0.995 in still, creeping, orbiting and driving views at 77 % and 67 %, and 0.954–0.990 at 50 %. Blasts are at 0.943–0.987 and a crater commit at 0.914–0.954, the weakest case. Temporal instability (per-pixel luma spread on a still view) is equal to native or lower at every scale. The upscaler's own passes cost 0.2–1.4 ms.

Speed is not settled. Fixed step, six static views (`final/paced-render-scales`, one arm): at 67 % the low-sun close view (7.86 → 4.70 ms) and the overview (5.02 → 4.45 ms) are faster than native, but the night scene (8.41 → 12.47 ms), glacial (4.60 → 8.65), volcanic (5.76 → 11.27) and dune (5.13 → 8.59) are slower. 50 % is no better. Something below native resolution costs more than it saves, which is not yet understood, so that first run did not establish a speed benefit for lower scales. The second comparison below revisits and resolves that measurement.

## Image parity and determinism

Matched screenshots of the candidate against the baseline (`scripts/compare-captures.ts`; sets in `artifacts/performance-pass/baseline/visual-v2/` and `artifacts/performance-pass/candidate-1/visual/`, amplified differences in `candidate-1/visual-diff/`):

- Still views: the low-sun close view, four headlights at night and the dune planet are bit-identical on every shot. Glacial, volcanic and dense cloud differ by at most one 8-bit level, as two baseline runs do. The overview differs in at most 4 of 1.6 million pixels, by up to 8 levels, on the shoreline sparkle at the planet's limb. Those pixels also vary between two runs of the candidate itself, and the crops cannot be told apart (`candidate-1/overview-crop.png`).
- Blasts: smoke, fire, gas lighting, cloud displacement, terrain and sky match. The debris chunks land in different places (see Debris above), so the shots differ where chunks are: up to 4 % of pixels by more than 8 levels at the explosive blast's peak. The candidate reproduces its own blasts within one level (explosive 10 of 12 shots and incendiary 11 of 12 bit-identical). The nuclear blasts vary between runs at baseline already (SSIM down to 0.977); against the baseline the candidate's are at SSIM 0.959 or higher.

## Memory

- Tracked GPU allocations grew by 8–11 MiB (758 → 766 MiB in the daylight views, 874 → 884 at night, 878 → 889 with fog of war), for the new buffers and volumes of the lighting, grass, water and gas changes (not itemised).
- JavaScript heap peaks fell in 10 of 12 scenarios (594 → 437 MB in the barrage, 966 → 633 MB driving with fog of war). They were unchanged under dense cloud and 9 % higher at night with four tanks (553 → 602 MB). The debris world now holds the whole planet's collision pages from load instead of cooking them at the first commit; its WebAssembly memory was not measured separately.
- The upscaler costs nothing at native: its module is not loaded.

## Limits at the first checkpoint

- **Blasts seen close up in cloud.** The cloud raymarch still costs 19 ms per frame on average for an explosive shell in daylight (frame p95 48 ms in that fixed-step close-up) and is 0.3 ms slower after a nuclear shell in daylight. The shockwave's displacement is the larger part. An experimental bound pre-pass was unverified and was not part of the measured candidate.
- **Upscaler speed.** Below native it is slower than native in four of six static views (see Temporal upscaler).
- **Teardown.** The GPU terrain's resident pages survive renderer disposal (inherited; see the lifecycle result).
- **One page crash.** One of 62 real-play runs of the candidate ended with the page crashing (the barrage scenario, second arm); none of 57 baseline runs did. It did not recur in 29 later runs, including five barrage repeats with Chromium logging. The harness now keeps a crashed run's page errors and the browser's own log.
- The GI probe pass (`gi.probes`) is 0.18 ms slower on the dune planet only.
- Debris paths differ from the baseline (see Debris). The overview's four sparkle pixels are not deterministic between runs.
- Bundle: game JavaScript with lazy chunks is 4460.9 KB against the unchanged 4531 KB limit (4354.5 KB after the bomb mesh left the bundle at the start of this pass). The two initial-entry errors are inherited: 4076.4 KB raw and 1484.5 KB gzip now, 4178 KB and 1547.3 KB at `29baad2`.
- Real-play figures come from headless Chromium on a 120 Hz rAF grid. On a display the same work steps between 120, 60 and 40 Hz.
- Only the serialized interleaved arms above are reported as timing results. Individual change measurements overlapped other machine activity and are not comparable acceptance evidence. The merged candidate was checked by the fast suite, guards, bundle check, matched images, timed arms and acceptance runs.

## What came from Planets

- **Temporal upscaler**: adopted. `tsr-pipeline.ts`, `tsr-shaders.ts` and `tsr-math.ts` (themselves a port of `@pmndrs/upscaler`) were adapted to TMT's reversed-Z, velocity and jitter conventions, with the additions listed above. It is optional and off by default.
- **Cloud clear-bound and skip checks** (`cloud-clear-bound.ts`, `cloud-skip-check.ts`): adopted as exact skip tests in TMT's own march, as the calm pipeline, gas-domain and shell tests and light range chords. They save 0.3–0.5 ms of `clouds.raymarch` in the static views and nothing during blasts. A bound volume for the shockwave flow, the analogue that would matter during blasts, is unfinished.
- **LDS-tiled cloud blur** (`cloud-blur-lds.ts`): not adopted. TMT's clouds have no blur pass (they resolve temporally), and Planets' own measurements did not favour the tiled variant.
- **ILP cloud march** (`cloud-march-ilp-wgsl.ts`): not adopted in this pass.

## Second pass

The second comparison used production reference `c40b5a4` and candidate `08f67ca`. Changes `dfba5e3` (spray, sky, sun shafts, overlays) and `c40b5a4` (unified wind, persistent cloud field, exact building shadows) intentionally changed images and costs, so `29baad2` and `e672d19` are not like-for-like reference arms. Local-only reports used the `artifacts/performance-pass-2/` layout. The same machine/harnesses and three interleaved reference arms were used; fixed-step values are medians.

### Where the time is now

The new cloud field removed most of the blast cost on its own. `clouds.raymarch` mean over the blast, `e672d19` → `c40b5a4`: explosive in daylight 19.0 → 1.83 ms, incendiary at night 7.8 → 1.78, nuclear in daylight 5.2 → 1.95, nuclear at night under dense cloud 17.8 → 3.18. The frame median in the explosive close-up fell from 24.9 to 8.0 ms (p95 47.9 → 12.1). Real blasts drive the field on every captured frame (`cloudsDamagedRegions` ≥ 1). Attribution on `c40b5a4` (`base-attrib/`): the shockwave's share of the explosive case is now 0.53 ms and cloud local lights 0.25 ms; under dense cloud at night local lights are 1.34 ms. The field update itself (`clouds.field`) costs 0.01–0.02 ms.

Static views on `c40b5a4` (GPU median, ms): low-sun close 8.33, overview 5.11, night with four headlights 6.76, glacial 8.85–8.95, volcanic 5.81, dune 4.72. Two passes moved with those changes: `lighting` grew 0.3–0.45 ms in every view (3.6 ms in the low-sun close view; the exact building shadows and the sky changes), and glacial's static cloud march rose from 0.81 to 4.5 ms because the deck now drifts with the wind and that view looks through denser cloud (the calm pipeline runs; no damaged region). Night clouds fell from 3.03 to 1.27 ms.

**Lighting, per term** (a scratch build with temporary switches, not committed; low-sun close view, `lighting` 3.62 ms): uncertain-class sun marches inside `atmo_terrain_lit` 2.05 ms (the aerial perspective and the sky rays together; sky-ray integration alone 1.20 ms), sun trace 0.38, sky ambient and specular 0.35, GI sample 0.33, building-box scan 0.19, local lights 0.11, moon 0.04, stars 0.02; with every term off 0.15 ms. In the overview the uncertain marches are 0.44 ms of 1.32 and the stars 0.11 ms. So the kernel's cost is not a shadow term: it is the soft terrain visibility of air samples where the 4³-cell class proof cannot decide. The proof takes each swept box's bounds from a 5³-cell dilation (about ±8 voxels), so every sample within roughly 1.5 u of the ground marches, and at low sun those samples are genuinely penumbral. Looking classes up along the march was measured in pass 1 (`ae9583e`) and lost in the close and fog views.

### Changes kept

- **Teardown ledger** (item 9). The VRAM ledger learned of a destruction only through `ctx.deferDestroy`; the resident terrain destroys its buffers directly, so after `disposeRenderer` they stayed on the books (365.7 MB at `29baad2`, 374.3 MB at `e672d19`). Each tracked buffer and texture now untracks itself in its own `destroy` (`src/engine/gpu/vram.ts`, test in `tests/engine-gpu-core.test.ts`). Accounting only: no rendering change. The lifecycle run on the candidate bundle (`accept/motion`, `TMT_LIFECYCLE_CONTINUE=1`) now passes every check, teardown included: 0 bytes tracked after disposal. So the resident pages were freed all along; only the ledger missed them.
- **Warm-up** (items 7 and 12). The warm-up hands the match over after 5 s even if frames stop firing (the frame loop's own 4 s limit is checked only inside a frame); its readiness check reads pipeline compile counts without `telemetry()`, which had kept draw counting on for 120 frames into play; the startup record now keeps when the SDF, the fluids and the compiles were each first ready (`startup.warm`). No change to what renders or when the match starts.
- **Harness**: GPU telemetry adds the memory clock and P-state.

The candidate's GPU medians match the reference within the reference arms' own spread (static: 8.34 / 5.10 / 6.81 / 8.98 / 5.80 / 4.71 ms against 8.29–8.34 / 5.11–5.13 / 6.76–6.78 / 8.85–8.95 / 5.80–5.82 / 4.71–4.73; blasts 0.05–0.16 ms lower). Real play was not re-run for it: nothing it changes runs per frame.

### Tried and not kept

- **Four-wide cloud sun march** (item 11, the idea of Planets' `cloud-march-ilp-wgsl.ts`): the four light-march samples' field, weather and shape taps issued side by side, summed in the original order. Images match the reference within noise (dune and glacial differ in one pixel by one level). Timing, two arms against three reference arms, `clouds.raymarch` median: overview 1.064 → 0.971 ms, glacial 4.49 → 4.40, but night with four headlights 1.276 → 1.363 and low-sun close 1.503 → 1.539; volcanic and dune unchanged. The frame totals net to zero with a consistent loss at night, so it was not kept.

### Items from the first pass, resolved or still open

- **Blast clouds** (items 1, 2, 6): resolved by `c40b5a4`'s design, not by this pass (numbers above). The nuclear-in-daylight +0.3 ms belonged to the old shock path.
- **Upscaler speed** (item 3): does not reproduce. On `c40b5a4`, fixed step, GPU median native → 67 % → 50 %: low-sun close 8.34 → 4.91 → 3.78 ms, overview 5.11 → 4.30 → 3.87, night 6.76 → 4.49 → 3.62, glacial 8.85 → 5.32 → 4.16, volcanic 5.82 → 4.37 → 3.82, dune 4.71 → 3.48 → 2.98. Native and 67 % interleaved in one session agree (night 6.79 / 6.80 → 4.50 / 4.48 ms). The first pass's table had every pass inflated at random by 0.6–0.9 ms, including passes whose work does not depend on resolution (`composite`, `fluids.cache`, `grass.cull`); that run was disturbed, and its 1 Hz graphics-clock log could not show it. The GPU stayed in P0 (9.5 GHz memory clock) throughout these runs. Native stays the default; the quality evaluation is unchanged from the first pass.
- **`gi.probes` on dune** (item 6): a flat 0.28 ms per frame against 0.11 at `29baad2`, with no GI change in either pass. In the same frames `fluids.step` fell 0.92 → 0.19 ms and `fluids.water` 0.39 → 0.09 (dune has almost no water, so the tile skip leaves them empty), and the frame total fell. The probe kernel reads nothing the fluids write; this looks like time moving between timestamps around the now-empty dispatches, not new work. Not proven.
- **Overview sparkle** (item 10): the 4 pixels that differed by up to 8 levels between two runs no longer occur on `c40b5a4`. Two runs of the reference now differ by one level in at most 185 overview pixels and 5–8 glacial and dense-cloud pixels, the same class of noise `29baad2` showed between its own runs.
- **Blast reproducibility**: two runs of the reference no longer reproduce their blasts (pass 1's candidate did in 10 of 12 explosive shots). The differences are only where debris chunks land (up to 151 levels in the chunks, through the end shot). The debris world's sync is order-deterministic; the likely cause is that a blast's terrain commit arrives from the workers after wall-clock time and lands on a varying fixed-step frame. Debris is presentation-only and excepted from image matching; the cause is not proven.
- **Structure collapse and barrage** (item 5): on `c40b5a4` (one traced run each, unminified build, `head-trace/`): the barrage holds 96 fps with no frame over 33 ms (68.7 fps at `e672d19`); the structure collapse runs at 73 fps with 20 frames over 33 ms. In the collapse both sides are over budget in the same windows: main-thread frames of 30–35 ms right after each collapse, where the cosmetic debris world's Rapier step takes 3.0 s of main-thread time per 30 s run (as at `29baad2`), and GPU completion intervals of 25–48 ms. This measurement predates the later debris-worker integration; current ownership is described in architecture.md.
- **Bundle**: game total 4488.8 KB of the unchanged 4531 KB limit; the two inherited initial-entry errors stand (4104.3 KB raw, 1495.1 KB gzip, against 4178 / 1547.3 KB at `29baad2`).
- **Not repeated for the second candidate:** the 30-run barrage crash matrix, startup comparison, lighting gates, tank customization, ground aim, gas lighting, optics and upscaler quality evaluation. Their earlier results must not be described as fresh second-candidate coverage.
- **Still open**: the lighting kernel's uncertain sun marches (2 ms at low sun; a tighter class proof near terrain, per-cell bounds refined only where the coarse test fails, is the exact route; its gain is unknown while low sun keeps most near-ground samples penumbral); the glacial static cloud march (4.5 ms); volcanic `fluids.step` (0.86 ms, lava); the debris world on the main thread; the inherited lighting gates.

## Early CPU probes (historical)

The initial isolated flat-buffer probe measured byte-identical output on its seed-7 corpus: 271,772 intersection
constructions took 12.10 ms in flat TypeScript versus 5.11 ms in scalar Rust/WASM; 996,864 sample classifications
took 8.54 versus 4.36 ms. The browser worker ratios were 2.0× and 1.51×. These probes excluded cache keys, allocation,
exact reconstruction, tracing, connectivity and game integration, so they did not establish playable speedups.

GPU classification took 0.029 ms on the RTX 3080 but 3.1 ms including dispatch/readback, plus 38.8 ms to upload the
initial 32.6 MB dataset. CDP CPU throttling did not slow workers and therefore supplied no phone-worker evidence.

The later native resident engine superseded this intermediate integration. See [architecture](architecture.md#terrain-and-simulation)
for current ownership; these prototype results are retained only as measurement context.

## Reproduction

```powershell
# A preserved production arm and its server (one port per arm):
node node_modules/tsx/dist/cli.mjs scripts/build-planetary-lighting.ts artifacts/performance-pass/candidate-build
node node_modules/vite/bin/vite.js preview --outDir artifacts/performance-pass/candidate-build --host 127.0.0.1 --port 5192 --strictPort

# GPU pass cost (fixed step), static views, blasts, fog of war:
node node_modules/tsx/dist/cli.mjs scripts/capture-planetary-lighting.ts --base http://127.0.0.1:5192/ --profile scripts/capture-plans/planetary-lighting-matched.json --scenes temperate-low-sun-close-on,temperate-overview-on,temperate-night-spots-on,glacial-day-on,volcanic-day-on,dune-day-on --environment exclusive --out artifacts/performance-pass/candidate/paced-static
node node_modules/tsx/dist/cli.mjs scripts/capture-planetary-lighting.ts --base http://127.0.0.1:5192/ --profile scripts/capture-plans/performance-impacts.json --environment exclusive --out artifacts/performance-pass/candidate/paced-impacts
node node_modules/tsx/dist/cli.mjs scripts/capture-planetary-lighting.ts --base http://127.0.0.1:5192/ --profile scripts/capture-plans/performance-fog.json --environment exclusive --out artifacts/performance-pass/candidate/paced-fog

# Real play, three repeats of every scenario:
node node_modules/tsx/dist/cli.mjs scripts/capture-performance.ts --base http://127.0.0.1:5192/ --repeats 3 --environment exclusive --out artifacts/performance-pass/candidate/realtime

# Attribution on an unminified build (not a timing):
node node_modules/tsx/dist/cli.mjs scripts/build-planetary-lighting.ts artifacts/performance-pass/candidate-profile-build --profile
node node_modules/tsx/dist/cli.mjs scripts/capture-performance.ts --base http://127.0.0.1:5194/ --trace --alloc --scenes explosive-shots,structure-collapse --out artifacts/performance-pass/candidate/attribution

# Matched screenshots and their comparison:
node node_modules/tsx/dist/cli.mjs scripts/capture-planetary-lighting.ts --base http://127.0.0.1:5192/ --visual --warmup 240 --shot-every 30 --profile scripts/capture-plans/performance-visual.json --out artifacts/performance-pass/candidate/visual
node node_modules/tsx/dist/cli.mjs scripts/compare-captures.ts artifacts/performance-pass/baseline/visual artifacts/performance-pass/candidate/visual --diff artifacts/performance-pass/candidate/visual-diff
```

Use a new output directory for every run; the harnesses refuse an existing one.

## Intermediate Rust compiler measurements — 14 October 2026

At this checkpoint the v2/v3 game used a Rust/WASM topology compiler behind the TypeScript transactional service.
TS object conversion, connectivity, queries, body recuts and Rapier orchestration remained in that revision. This is
historical intermediate ownership; the current resident engine is described in [architecture](architecture.md).

One diagnostic browser pair measured cold terrain preparation at 1833.7 ms Rust versus 2346.9 ms TS, topology
including merge at 1124.2 versus 1682.4 ms, and five-shot median preparation at 36.7 versus 44.1 ms. Warm cached
terrain was 1550.5 versus 1500.9 ms; worst observed in-flight frames were 16.7 versus 8.7 ms. These were preliminary
paired observations, not A/B/B/A qualification or a universal latency win. Both arms passed five shots, the idle
oracle and reload without page/console/GPU errors. The packaged candidate recorded cold/cached startup at
6.914 / 6.728 seconds to ready and a post-reload shot.

The separately measured numeric resident pipeline reported 662 ms on CPU and 719 ms with direct WebGPU preparation.
Those isolated pipeline timings excluded live-game integration and must not be read as game startup results.
Local-only reports were named `live-browser-v1`, `live-packaged-v1`, `qualification-v4` and
`world-edits-bvh-v1.json`. No physical-phone evidence was produced by this comparison.
