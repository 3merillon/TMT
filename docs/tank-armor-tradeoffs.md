# Armor and handling verification

The armor configuration is independent of paint, weathering, lamps, damage marks and brush strokes. Every utility design shares the original antenna's 0.3 mass, 1 build point, mass distribution and combat collision envelope: accessory swaps are cosmetic and cannot tune handling or ramming. Their authored geometry still determines workshop picking and assembly interference validation. Radar scan remains the existing match action; the point-defense preview intercepts no targets. Old kits with no `armor` member use standard armor. `armor: "reactive"` is valid only on Bastion; the workshop reports incompatible hulls explicitly. Existing five-slot IDs and legacy loadouts retain their mappings.

## Comparable builds

Measurements use the actual Rapier `ResidentTanks` bridge on a level plane, with **Grip tracks, Dome turret, Field cannon, Whip antenna** on every hull. After two seconds settling: accelerate for two seconds, release for 1.5 seconds, pivot for two seconds, then drive and steer for two seconds. Values are game units, not claims about real tanks.

| Build | Mass | HP | Speed at 0.5 s | Sustained speed | Neutral pivot (rad/s) | Moving turn (rad/s) | Front cannon damage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Skiff | 10.2 | 100 | 3.162 | 3.557 | 1.950 | 1.263 | 70 |
| Warden | 11.7 | 130 | 2.952 | 3.321 | 1.821 | 1.179 | 60 |
| Bastion | 14.2 | 170 | 2.679 | 3.014 | 1.653 | 1.070 | 44 |
| Bastion + reactive | 16.2 | 170 | 2.509 | 2.822 | 1.547 | 1.001 | 26, then 44 |

Skiff is about 18% faster than standard Bastion with identical equipment; Warden trades some of that mobility for 30 extra HP and moderate protection. Bastion combines greater durability and directional protection with slower acceleration and turning. Reactive equipment costs 2 extra build points and 2 mass units, reducing this Bastion's speed and turn rates by about 6.4%. Its health does not increase. The normal suspension, traction, stabilization, recoil and blast impulse systems use the resulting assembly mass and inertia. Empty reactive cassettes remain aboard, so spent sections retain their mass.

Moving yaw now follows mass as neutral pivot already did. Its reference mass preserves the accepted Warden/Scout/Dome/Mortar driving turn. Gear continues to supply its own mass, top speed, wheel layout and longitudinal/lateral traction: Scout favors speed, Grip balances traction, and Crawler favors lateral support. Cosmetic settings never enter these calculations.

Braking from each build's own maximum speed takes 0.750 / 0.700 / 0.636 / 0.595 units in the same order. The heavy builds stop over less distance because their starting speed is lower; this is not an extra heavy-brake bonus. Acceleration and braking ramp rates both scale with equipped mass. All four remain upright through the comparison.

## Fantasy sets and gear

The complete Aether set combines Aether hull, drive, crown, arc cannon and vane. The complete Forge set combines Forge hull, tracks, casemate, mortar and Steam sentinel. Their mechanical bonuses come from hull, turret, weapon and running gear; accessories remain cosmetic. The same resident-vehicle test above produces:

| Complete set | Cost | Mass | HP | Weapon damage | Tempo multiplier | Sustained speed | Fuel | Pivot | Moving turn | Front cannon damage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Aether | 22 | 11.1 | 180 | 75 | 0.681 | 4.196 | 10.577 | 1.869 | 1.212 | 57 |
| Forge | 27 | 20.8 | 275 | 90 | 1.427 | 2.235 | 4.363 | 1.368 | 0.884 | 39 |

Aether trades frontal protection for quicker fire, movement and range. Forge trades mobility and firing tempo for health, heavier hits and protection. These are intentionally expensive fantasy upgrades, not damage caused by paint or accessory choices. Braking distances from each set's own maximum speed are 1.066 and 0.429 units respectively.

The gear alone has these authored base values, before assembly mobility scaling:

| Gear | Cost | Mass | Speed | Fuel | Climb stat | Traction / lateral |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Aether drive | 5 | 2.6 | 4.8 | 8.5 | 41° | 1.7 / 1.3 |
| Forge tracks | 6 | 4.8 | 3.5 | 6.0 | 50° | 2.0 / 1.55 |

The solver retains its proven 1.6 longitudinal friction cap to prevent traction-induced backflips; solver lateral friction is 1.25 for Aether and 1.35 for Forge. Climb stats describe the part and are not a guarantee for arbitrary terrain. Both gear sets actually climb the 45° test ramp on a Warden/Dome/Cannon build, brake and turn upright, and the Aether replay is deterministic. The same-equipment speed tests require at least a 15% improvement over Grip for Aether and 5% over Crawler for Forge. Their rig dimensions remain compatible with the original bogie/rocker families; conductive hub covers, insulated suspension bobbins, raised bolted discs and steel-backed rubber contact pads are authored geometry.

## Directional damage and reactive sections

The existing direct-hit sphere and blast exposure model are preserved. Direct hits classify the contact in the hull frame into front, driver-left, driver-right, rear or roof. Standard mitigation multipliers are front 1.5, side 1, rear 0.45, roof 0.3 times the hull's original mitigation. Nearby blast retains the original all-round mitigation.

For a 70-damage Field cannon shell, standard Bastion takes 44 front, 53 side, 62 rear or 65 roof damage. Warden takes 60 front damage; Skiff takes 70. Damage remains at least one point for a damaging impact. Facing armor matters; flanking and roof attacks remain useful.

A reactive Bastion has **four independently consumed sections**, represented by a bounded integer bit mask in `TankState.reactiveArmor`: front 1, driver-left (+X) 2, driver-right (-X) 4, rear 8. A qualifying direct hit consumes only its section and reduces residual damage by 40%; rail weapon hits receive only 15%. Nuclear damage, splash, upper turret/roof hits and exposed running gear do not activate the cassettes. The direct envelope contact must be between local Y -0.15 and +0.30. This is deliberately a coarse section model: visual individual blocks are not separate penetration hitboxes.

The mask is temporary combat state, never a workshop preference or ownership entry. It is derived deterministically from the command replay, included in the canonical state hash, and starts intact in each new match. No clock or random source is used. Friendly-fire immunity, dead tanks and the invulnerable drive test do not consume sections. Impact events include the consumed bit for presentation; spent meshes show the corresponding whole section.

## Reproduction and CPU cost

Run `node --import tsx scripts/bench-tank-designs.ts`; it writes `artifacts/tank-designs/armor-benchmark.json`. In environments where the tsx loader cannot read account metadata, bundle it first:

```powershell
node node_modules/esbuild/bin/esbuild scripts/bench-tank-designs.ts --bundle --platform=node --format=esm --packages=external --outfile=artifacts/tank-designs/bench.mjs
node artifacts/tank-designs/bench.mjs
```

On the i7-12700F / Node 22.15 test host, 1,200 measured simulation steps after 360 warm-up/settle steps gave these CPU timings. All tanks use Bastion/Grip/Dome/Cannon/Antenna and drive simultaneously on separate parts of the same flat world; rendering is excluded.

| Tanks | Standard median / p95 | Reactive median / p95 |
| ---: | ---: | ---: |
| 1 | 0.075 / 0.103 ms | 0.072 / 0.100 ms |
| 4 | 0.287 / 0.380 ms | 0.290 / 0.399 ms |
| 8 | 0.555 / 0.721 ms | 0.551 / 0.709 ms |

The same run also measured the complete fantasy sets with identical counts and inputs:

| Tanks | Aether median / p95 | Forge median / p95 |
| ---: | ---: | ---: |
| 1 | 0.066 / 0.097 ms | 0.071 / 0.098 ms |
| 4 | 0.259 / 0.356 ms | 0.277 / 0.382 ms |
| 8 | 0.500 / 0.655 ms | 0.553 / 1.026 ms |

Small differences are measurement noise, not evidence that reactive armor improves performance. Reactive state is four bits and armor response is constant work per exposed tank at impact; there is no per-tick armor simulation. These measurements do not establish a GPU/frame-time budget or worst-case terrain/contact cost.

Focused tests: `rules-armor` covers direction, independent consumption, bypass cases, friendly fire, drive invulnerability and a real fired shot replayed from JSON. `vehicle-armor` drives equivalent builds and repeats a reactive run byte-for-byte. Existing aiming, gravity, checkpoint, driving, recovery and collision tests remain the behavioral regression checks. The seed-11 duel golden is intentionally updated because weak-area damage ends that fight one turn earlier; its winner, winner health and comparable projectile ranges are unchanged.

The seed-7 capture-route regression starts each timing schedule with a fresh Rapier world, matching `ResidentGameTerrain.create` in production. Previously it reused one solver across independent captures: retained body-handle/contact ordering changed the later post-ram route onto steeper ground even though the same timing passed alone. All four original schedules and their 20° roll, 25° pitch, contact, distance and steering thresholds are retained. A repeated fresh-world slow-shot capture must also produce exactly the same result. No production vehicle tuning was changed to compensate for that fixture contamination.

## Recorded renderer cost and comparison captures

These measurements predate the texture-paint path described in [tank designs](tank-designs.md). They preserve the original benchmark evidence and are not current paint-rendering performance claims. Rerun the harness for a comparison against the present build.

Run `node node_modules/tsx/dist/cli.mjs scripts/bench-tank-render.ts`. The harness opens its own local Vite server and installed Chromium, then closes both. `--quick` runs one relief smoke case; `--combat-only` captures the real emitted hit without repeating performance measurements. `--performance-only` and `--captures-only` split measurement and visual review; the latter preserves the performance report. `--scar-stress` exercises the combined paint and impact-mark limits. Outputs are under `artifacts/tank-designs/render/`.

The measured run used Chromium 149.0.7827.55, the i7-12700F and the hardware NVIDIA Ampere adapter at **1600×1000, high tier, native render resolution**. Each case warmed 240 frames, then captured 300 raw GPU/CPU samples without video or screenshots during measurement. It used the production `Engine` and `TankViews`, moving suspension/treads, turret traverse, elevation and recoil, plus two shadowed headlamps per vehicle. Every vehicle remained at LOD0. The baseline was Bastion/Grip/Dome/Cannon/Antenna with reactive armor; the fantasy cases used their complete sets. Paint stress exercised the then-current 192-dab allowance on the player tank. Current texture painting has no stroke-count cap.

| Set | Tanks | Player paint dabs | GPU median / p95 | Encode CPU median / p95 | Pose CPU median / p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline | 1 | 0 | 2.88 / 4.64 ms | 0.50 / 0.80 ms | 0.50 / 0.80 ms |
| Baseline | 1 | 192 | 4.09 / 5.30 ms | 0.40 / 0.50 ms | 0.50 / 0.60 ms |
| Baseline | 4 | 0 | 3.77 / 4.88 ms | 0.40 / 0.50 ms | 1.50 / 1.70 ms |
| Baseline | 4 | 192 | 3.95 / 5.17 ms | 0.40 / 0.50 ms | 1.40 / 1.70 ms |
| Baseline | 8 | 0 | 4.79 / 6.15 ms | 0.50 / 0.60 ms | 2.70 / 3.10 ms |
| Baseline | 8 | 192 | 4.84 / 6.22 ms | 0.50 / 0.60 ms | 2.70 / 3.00 ms |
| Aether | 1 | 0 | 2.69 / 3.37 ms | 0.40 / 0.50 ms | 0.50 / 0.70 ms |
| Aether | 4 | 0 | 4.68 / 6.13 ms | 0.40 / 0.50 ms | 1.40 / 1.70 ms |
| Aether | 8 | 0 | 4.97 / 6.44 ms | 0.50 / 0.60 ms | 2.70 / 3.00 ms |
| Forge | 1 | 0 | 2.06 / 2.77 ms | 0.40 / 0.50 ms | 0.50 / 0.70 ms |
| Forge | 4 | 0 | 4.92 / 6.28 ms | 0.40 / 0.50 ms | 1.50 / 1.80 ms |
| Forge | 8 | 0 | 5.13 / 6.51 ms | 0.50 / 0.60 ms | 2.90 / 3.20 ms |

The GPU metric sums timestamped render/compute passes, including `gbuffer.tanks` (which has its own timestamp label). It is not a percentile of the HUD's rolling averages. All twelve cases had **zero dropped/pending capture queries, GPU validation errors, shader errors or JavaScript errors**. Frame interval was 8.3 ms median / 8.4 ms p95 on this 120 Hz host; the largest measured GPU sum was 6.86 ms. Raw pass series are retained in `benchmark.json`.

The separate bounded relief stress case repeats one real emitted impact 25 times in one frame through production `TankViews.impact`, confirms that only 24 scars remain, and combines those overlapping craters with 192 paint dabs on a close-view Bastion. This intentionally stresses rendering rather than simulating 25 surviving cannon hits. After 240 additional warm-up frames, its 300 samples measured **4.46 / 5.92 ms GPU median / p95** (6.18 ms maximum), **0.40 / 0.60 ms encode CPU**, and **0.50 / 0.70 ms pose CPU**, with zero validation/shader/JavaScript errors or lost/dropped queries. Tracked VRAM stayed at 459.22 MiB. Its raw report is `benchmark-scar-stress.json` and the visible crater is recorded in `scar-stress.png`.

| Set | Tanks | Draw calls/frame | Submitted triangles/frame | Tracked VRAM |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 1 | 64 | 300,832 | 459.22 MiB |
| Baseline | 4 | 235 | 461,437 | 459.32 MiB |
| Baseline | 8 | 463 | 675,577 | 459.46 MiB |
| Aether | 1 | 54 | 302,861 | 459.22 MiB |
| Aether | 4 | 189 | 466,913 | 459.32 MiB |
| Aether | 8 | 369 | 685,649 | 459.46 MiB |
| Forge | 1 | 50 | 303,097 | 459.25 MiB |
| Forge | 4 | 176 | 470,209 | 459.32 MiB |
| Forge | 8 | 344 | 693,025 | 459.46 MiB |

Submitted triangles include the studio planet/plate and shadow passes; they are not the unique tank mesh triangle budget. The shared 1024² height/mask and derived normal maps use 11 mip levels and exactly 11,184,808 bytes (10.67 MiB) across all vehicles. Their 0.42-unit repeating tile includes fine scratches, rare 18–35 mm chipped notches and shallow 22–44 mm painted metal depressions; the maximum relief range is 2.5 mm, with more than 90% of the encoded paint remaining planar. Tests verify normal/height agreement at every mip and both texture seams. Paint storage is bounded, so filling the dab allowance adds no buffer allocation. The camera moves back to fit additional vehicles, changing projected area and relief mip level; these results are not a claim of linear per-tank scaling. This is a vehicle rendering stress scene, not a worst-case destructible battlefield or a result for lower-end GPUs. Existing mesh, LOD and renderer budgets are unchanged.

`compare-{skiff,warden,bastion}-{quarter,front,side,rear,top,detail,tracks}.png` supplies matched studio views using the same solid paint, Grip, Dome, cannon and antenna. Corresponding `compare-aether-*` and `compare-forge-*` files show the two complete fantasy sets, for 35 comparison views in total. The low track view exposes round wheels, separate steel soles and rubber pads. The separate `reactive-front-intact.png` and `reactive-front-spent.png`, plus their `-normal.png` shading-normal counterparts, use the same camera and pose. Their damage comes from a solved, fired shell in the real simulation on the analytic test world, not a fabricated hit: `combat-state.json` retains the emitted event and the hull-frame transformation onto the studio vehicle. Only the front section is spent; the other three remain intact. Temporary impact scarring is applied through production `TankViews.impact`.
