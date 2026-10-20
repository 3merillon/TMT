# Projectile effects and driving guide

Implemented on `codex/projectile-effects` from `game/runtime` (`db2cae9`). Authoritative flight, collision, damage, ammunition, checkpoint data and canonical hashes are unchanged.

## Presentation

HE has an olive shell, brass driving band and exposed fuse. Heavy demolition has a wider steel nose and two copper bands. Incendiary has a red canister body and four stabilizing fins. Nuclear uses the workshop bomb's original silhouette and sampled albedo, with olive enamel, metal seams, four fins and the faded yellow radiation marking. Its transport equipment is removed. The original workshop GLB and preview are untouched; gameplay imports no workshop loader or room asset. Extraction provenance and its source SHA-256 live in `assets/projectiles/workshop-bomb.provenance.json`; the reproducible Blender script is `scripts/blender/extract-workshop-bomb.py`.

Four shared meshes replace the emissive balls. Each live round uses one instance, with no projectile light. Flight frames transport the previous up direction, avoiding pole flips; steep apex reversal is bounded and render positions interpolate fixed ticks. Painted casings remain dielectric and metal bands retain separate material identities. The smallest HE round is deliberately small at the normal camera distance; the close inspection shows its construction more clearly.

The accepted shot event captures copied position, direction, local up, ammunition, weapon, power, tick and projectile ID. Presentation and audio consume that same launch identity exactly once. Changing the later selection cannot recolor an old shot. Replayed historical events are drained before live presentation resumes. Observer visibility still controls launch and projectile effects.

Muzzle flashes use two shared rounded directional meshes with eight bounded slots. Smoke uses pressure projection, advection and vorticity in a separate preallocated gas atlas. Launch momentum, entrainment, local-up buoyancy and dissipation produce the expanding puff. Ammunition changes smoke mass, heat, color and lifetime; mortar broadens the puff, cannon emphasizes the jet, and rail shortens/reduces smoke. Muzzle emissions cannot evict explosion or mushroom-cloud domains.

The old explosion overlay ring is replaced with an analytical world-space spherical pressure shell. One depth-aware pass integrates its thin visible portion, adds irregular condensation and surface dust/mist, and limits displacement to 1.8 pixels. It rejects foreground/depth discontinuities and samples the existing water atlas for seas, lakes and crater water. Nuclear has greater reach and duration. Fire, blast smoke, debris, mushroom clouds and water spray remain. Aiming and radar still use their existing overlays.

Every match mode now shows the complete predicted flight while the observed player can aim. A solid mint arc with a dark outline stays five CSS pixels wide; hidden sections are dim and dotted. Actual contacts receive a terrain ring, screen reticle and surface-distance readout. Terrain-obscured targets are dashed and labelled accordingly. Flight expiry is labelled FLIGHT LIMIT rather than a landing. The predictor supplies a contact flag without changing its points or canonical state, including extension contacts and cached predictions. Labels prefer either side of the target and avoid visible HUD panels.

The guide interpolates adjacent predicted curves using the same fixed-tick fraction as the tank. Its first point stays on the rendered muzzle. Full previews retain the authoritative impact endpoint. Automatic turret counter-rotation refreshes prediction without resetting interpolation; terrain changes, ammunition/power changes and discontinuous target changes reset history. The obsolete Aim assist checkbox is removed; its saved profile field remains readable for compatibility.

All four shell types leave soft, distance-spaced smoke along their visible rendered flight. Individual puffs disperse over 1.25–1.6 seconds and remain after impact. One transparent draw uses a fixed 2,048-particle buffer, depth-softened edges and the existing world-space fog volume. Hidden flight is never backfilled on reappearance; restart clears both emitters and lingering smoke. These trails stay enabled on Low because they communicate projectile motion.

Free-drive controls use WASD to drive, left click or drag to choose a world target, right drag to orbit the camera, and Space to fire. The wheel trims surface range while left mouse is held and zooms after release. A click retains the selected place after release while the turret finishes turning. Q/E, the arrow keys and sliders remain manual aiming alternatives and cancel the selected target. Pause, blur and scene changes cancel pointer ownership and targeting.

Target picking uses the last rendered camera, including narrow-screen offsets, and tests terrain against the actual rendered surfaces of currently visible living tanks. Mesh picking reuses the current LOD and animated part transforms, rejecting local part bounds before testing triangles; it adds no GPU readback. The local tank and hidden enemies are excluded. Future objects can register the same visible target provider. Selected objects update their pose after release and are dropped if they become hidden or disappear. Tank clicks use the hovered surface point, not its center; the retained offset follows chassis rotation. Only the selected object's explicit collision geometry enters prediction; the solver never queries undiscovered enemies. Range trim projects the requested distance back onto the terrain; returning the wheel trim to one restores precise object targeting.

Ballistic assistance finds yaw, elevation and power using bounded samples of the real flight integrator against committed terrain, respecting the equipped barrel's elevation limits. Requested points appear as square brackets; the actual predicted contact remains a circle at the end of the arc. The selected object also clips the actual preview. Blocked or unreachable solutions display feedback, and Space always fires from the current barrel pose, including during a turn. No firing command teleports the barrel to an unfinished solution.

Cursor picking and turret movement update every animation frame. Trajectory search runs at most 30 times per second and reuses unchanged solutions, with a maximum of 24 traces and 3,600 integration steps per search. The barrel approaches its solution exponentially at 14/s, bounded to 6 rad/s yaw, 4 rad/s elevation and 3/s power. Small cursor adjustments refine the prior solution; large turns remain visibly animated. Object fitting follows the exact hovered surface point, with a 4 mm refinement threshold, rather than accepting any hit inside the collision sphere. A hypothetical path may pass through the selected sphere solely for fitting the hovered point; the displayed and fired projectile still stop at the first authoritative collision. A visible protrusion outside the simplified physics collider can therefore be aimed at without being promised a hit. Targeting introduces no new GPU pass or texture allocation.

After a local shot, the chosen place is pinned until the next deliberate pointer move, so recoil cannot steer a stationary held cursor. A ground selection stores its original planet bearing and committed footprint epoch. Once a crater commits, it queries the fixed surface once and moves to the new floor; a removed surface or through-hole clears the target. Dynamic collision revisions from moving debris do not move the anchor or redirect the solver. The actual next-shot preview remains visible throughout free-drive resolving, and still collides with moving debris and other live geometry. This separates steady player intent from honestly changing obstructions without altering fired-shot collision.

Turret audio measures the difference from the bearing that the simulation would automatically hold while the chassis moves. This removes stabilization noise without relying on a specific input device. Deliberate yaw and pitch retain a quieter, lower motor hum with restrained harmonics and a fast release. A 150-tick real driving regression produces zero servo activation, followed by audible deliberate adjustment while still driving. No extra loop voices are allocated.

## Browser and motion evidence

Chrome 155.0.8059.40, NVIDIA Ampere hardware WebGPU (non-fallback), Windows, 2026-10-13. The main capture is 1440×900, with all four rounds at normal distance, in close flight and at the muzzle; additional shots cover cannon, rail, elevated/grazing impacts, daylight/night, terrain/water, medium quality, and low quality at 390×844. These 22 scenarios produced no browser, shader compilation or WebGPU validation errors.

The final video runs continuously through each shot. Earlier screenshot-per-frame captures stalled rendering during readback and were rejected as motion evidence. Review of the continuous sequence confirmed stable physical silhouettes, a brief ignition glint followed by rolling smoke, and irregular expanding water mist with sharp foreground occlusion. Dry-land pressure fronts are intentionally faint and can be masked by the retained bright flash/fireball; there is no persistent bright hoop or opaque dome.

The separate keyboard driving capture advances and steers the tank, then changes aim. It records 989 rendered samples, 487 moving fixed-tick samples (all interpolating), 376 frames moving between fixed ticks, zero muzzle attachment error and zero GPU validation errors. A real `GameSimulation` driving regression also covers automatic yaw compensation on every tick and unchanged canonical state.

The earlier relative-mouse normal-UI capture (before the world-targeting revision below) verifies a 29-point full arc and visible landing range at startup, right-drag while driving, held-wheel range, released-wheel zoom, pause isolation, and firing the selected power. A 120-pixel wheel gesture changes power from 55% to 56.562%, with the reverse gesture returning within 0.000005 percentage points. Camera distance stays at 17 during range adjustment, then changes to 20.353 after releasing right mouse. The actual worklet servo parameter stays zero while driving, reaches 0.684 during deliberate aim, and returns to zero on all four loop voices after release. Its 528 recorded driving/aiming frames have zero muzzle error and GPU validation errors. Day and night screenshots show the final outlined arc and readout; the continuous video is motion evidence, not an isolated performance benchmark.

The final world-targeting capture passes 19 checks over 2,288 rendered frames: exact mesh-point tank targeting, seven small same-tank cursor positions, click/release settling, front/back ground points, drive-and-aim, held-wheel range, released-wheel zoom, right-drag camera, pause/UI isolation, failed-target feedback, real tank and terrain hits, no firing-time aim snap, and post-crater stability. Actual impact differs from preview by 2.3 mm on the selected tank and 0.014 mm on terrain. Cursor-to-requested-marker RMS is 0.63 CSS pixels; the large turn advances across 41 moving frames. A real crater advances committed surface epoch 2 to 3 with exactly one retained anchor per epoch; the final 72 frames have zero target or solver-goal movement. The next-shot arc stays visible through flight and commit. All browser and GPU error counts are zero.

Across 230 distinct solves in that recorded run, CPU cost is 0.7 ms median, 3.8 ms p95 and 9.6 ms maximum. The maximum search remained 24 traces; mesh picking during the tank sweep measured 0.1 ms p95 and 0.2 ms maximum. A separate Node benchmark with eight high-LOD heavy tanks measured 0.23 ms median / 0.40 ms p95 for picking, with at most 1,392 part bounds and 6,216 narrow-phase triangles tested. These are desktop observations, not phone or guaranteed frame budgets. The [world-targeting measurements](evidence/world-targeting.json) preserve the checks, crater anchors, costs and build results.

Local large artifacts are kept under ignored `artifacts/`:

- `projectile-effects-final/video/`: uninterrupted 22-scenario video.
- `projectile-effects-final/review/`: selected motion clips and pressure/muzzle frame sequences.
- `projectile-effects-final/report.json`: event timestamps, GPU/CPU samples and lifecycle evidence.
- `projectile-trajectory/`: driving video, frame sequence and telemetry summary.
- `projectile-controls-readable/`: historical relative-drag/range controls video, daylight/night aiming frames and real worklet measurements.
- `ground-aim-final/`: final world-targeting video, tank precision frames, post-crater frames and full telemetry report.
- `projectile-effects/assets/extracted-bomb.png`: authoring inspection of the isolated workshop bomb.

The committed [compact measurements](evidence/projectile-effects.json) preserve the measurements and lifecycle results without recording large snapshots or videos.

## Cost and resource bounds

Performance uses a separate 1280×720 browser context with no recording or screenshots: 2.5 seconds idle followed by seven seconds of actual nuclear firing. Values include the existing explosion, terrain destruction and water work, so idle-to-shot differences are **not** isolated costs of the new effects. GPU timestamp telemetry is sampled on rendered frames and can repeat the last completed timestamp batch; sample counts are not independent trials.

| Tier | Idle GPU median / p95 | Nuclear interval GPU median / p95 | CPU encode median, idle → shot |
| --- | ---: | ---: | ---: |
| High | 3.753 / 4.586 ms | 4.990 / 6.211 ms | 0.665 → 0.737 ms |
| Medium | 2.858 / 3.326 ms | 3.904 / 4.254 ms | 0.651 → 0.743 ms |
| Low | 3.159 / 3.443 ms | 3.223 / 3.650 ms | 0.675 → 0.582 ms |

High-tier new-pass p95 costs over that interval were 0.070 ms muzzle simulation, 0.033 ms muzzle volume draw and 0.037 ms shockwave. Whole-renderer transient maxima were 59.623 / 32.734 / 23.731 ms at high/medium/low, dominated by existing crater/SDF work. These short runs are observations, not guaranteed frame budgets or a cross-device benchmark.

| Tier | Muzzle domains | Grid per domain | Atlas storage |
| --- | ---: | ---: | ---: |
| Low | 2 | 16³ | 458,752 B |
| Medium | 2 | 20³ | 896,000 B |
| High | 3 | 24³ | 2,322,432 B |
| Ultra | 4 | 24³ | 3,096,576 B |

Muzzle storage adds one 128 KiB noise texture and small parameter buffers. Shockwaves use a fixed 400-byte uniform allocation, no new textures, and at most 3/5/8/8 live fronts by tier. All four projectile meshes total approximately 631 KB of decoded arrays; decoding occurs once, not once per shot. The asset microbenchmark measured roughly 13.1 ms nuclear decode and 20.3 ms for all model construction in Node, not browser rendering time. Final lossless PMB2 packing removes redundant regular-grid indices, reducing the bomb payload from 215,320 to 129,312 bytes. All five decoded arrays were verified byte-for-byte identical; the regression pins their fingerprint.

Six additional real nuclear shots held the muzzle atlas at 2,322,432 B, shockwave storage at 400 B and renderer mesh allocation at 12,722,200 B. The whole renderer grew from 649,562,574 to 654,509,534 B as persistent crater data accumulated. Main-renderer heap samples rose during this run and do not prove a heap plateau; they include the recording harness and terrain state and exclude workers/driver memory. The new effect pools themselves stayed fixed.

After a 16-second natural settle, shells, flashes, muzzle smoke, blast gas and shockwave live/draw counts were all zero. They were also zero after restart and scene exit. Restoring a real mid-flight checkpoint left the muzzle emission count unchanged (10 before and after), then completed the projectile normally. Whole-renderer allocations remained high across restart/exit, with resident terrain caches dominating; this verifies effect retirement, not release of every existing world cache.

## Verification and limitations

The full fast selection passed 132 files: 1,192 passing tests and three declared expected failures. It includes shot identity, audio deduplication, save/replay, trajectory interpolation, flight frames, fixed resource bounds, shell depth clipping, turret stabilization audio and Naga shader validation. After the final control/readability revision, all affected UI, FX, rules and audio suites passed again: 64 files, 499 passing tests and one declared expected failure. Final label placement received a further seven passing focused tests. TypeScript, production compilation, Naga validation of the revised ribbon, and source guards pass. Actual hardware pipelines were exercised in all browser scenarios above.

The aiming follow-up passes all affected UI/FX/rules suites (57 files, 424 passing tests and one declared expected failure), then 85 focused tests after the final crater and trimmed-shot fixes. TypeScript, production compilation and source guards pass. The current game closure is 4,488.8 KB, with initial raw/gzip sizes 4,158.1 / 1,529.9 KB.

A clean build of the starting commit confirms two inherited bundle-budget failures: game initial raw and gzip size. They remain with unchanged limits. The lossless bomb packing keeps the complete game closure within its existing size limit; no new bundle gate fails. Baseline/current sizes are recorded in the compact evidence.

No phone was attached. The 390×844 low-tier case is a desktop phone-shaped viewport with no CPU throttling; it is not evidence of phone hardware performance. Ultra's pool sizing is covered by tests, while the browser performance table covers high/medium/low.

Reproduce from the repository root (PowerShell):

```powershell
$env:TMT_FX_OUT='artifacts/projectile-effects-final'
node node_modules/tsx/dist/cli.mjs scripts/capture-projectile-effects.ts --full --motion-only
$env:TMT_FX_OUT='artifacts/projectile-trajectory'
node node_modules/tsx/dist/cli.mjs scripts/capture-projectile-effects.ts --driving-only --motion-only --visual-only
$env:TMT_GROUND_AIM_OUT='artifacts/ground-aim-final'
node node_modules/tsx/dist/cli.mjs scripts/capture-ground-aim.ts
```

`TMT_CHROME` selects an installed Chrome executable. The harness uses the shared GPU capture lock and records separate performance intervals without video capture overhead.
