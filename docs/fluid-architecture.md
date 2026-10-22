# Planet fluids: water, lava, spray and gas

This guide describes the integrated planet fluid renderer and its gameplay boundary. The
[runtime architecture](architecture.md#rendering) describes its ownership alongside terrain and simulation.

Waves, spray and gas are presentation: gameplay never reads GPU simulation or graphics quality. Standing basin levels are solved from committed terrain by `src/game/liquids.ts` and supplied to the renderer for its initial fill. The same saved layout drives tank resistance, so loading a submerged save does not turn the current tank position into a new dry spawn.

`vehicle/liquid-motion.ts` measures submerged volume from the oriented body, both physical track envelopes and turret. Shallow track immersion has little effect; resistance rises smoothly toward 60% commanded speed when fully submerged in water and 30% in lava. Lava adds more drag. Forward, reverse and steering use the same factor for player and enemy tanks in both physics backends; force at the center of mass damps motion without overriding contacts or recoil. Dry ground restores normal handling. Gameplay samples resting basin levels; transient wakes, waves and water redistributed beyond the original basin footprint remain cosmetic.

Detached structural chunks also receive linear and angular resistance from the saved basin levels. The native
physics core estimates immersion from oriented collider bounds weighted by occupied volume; the compatibility
solver uses the same approximation. Dry chunks retain their normal damping, and the resistance does not wake
sleeping chunks or move bodies held by a terrain transaction. New liquid checkpoints carry `chunkDrag: true`;
older checkpoints without it retain their original structural dynamics.

Presentation feeds up to sixteen nearby structural/debris envelopes into the existing hull displacement, wake, foam and
spray passes, alongside the eight tanks. Cosmetic fragments use their actual oriented mesh bounds, not the smaller
radius used for splash effects. Large surface contacts take priority within the shared bound; no extra GPU slots or
dispatches are added for debris. Stable identities align previous poses through chunk removal, recuts and
selection changes, so a newly observed envelope does not invent a motion impulse. These are conservative oriented
boxes, not exact submerged polyhedra. The water remains a single surface layer; it does not erode terrain, provide
wave-driven structural forces, or simulate water carried inside a moving hollow chunk.

## Files

- `src/engine/passes/fluids/`
  - `fluids.ts`: the render module. It owns the passes, the `fluids` scene facet, the initial fill, the vents, the
    blasts and the looks per planet kind (`LIQUID_LOOKS`).
  - `fluids.wgsl.ts`: the bed march, the lighting cache, the composite and the depth write.
  - `liquid-params.ts`: the uniform layouts (`LIQUID_PARAMS`, `WATER_SIM`), the debug views and switches, and the
    shared constants.
  - `water.ts`, `water.wgsl.ts`: the shallow-water layer (water and lava) and its drawn surface. `WATER_TUNING` holds
    its constants; `hull-wake.ts` and `hull-wake.wgsl.ts` share the bounded water momentum coupling constants.
  - `spray.ts`, `spray.wgsl.ts`: spray particles (`SPRAY_TUNING`).
  - `gas.ts`, `gas.wgsl.ts`: gas domains (`GAS_PRESETS`), ported from Pinionfall's fluid fire.
  - `basin-job.ts`: the recipe solve, run in a worker.
- `src/world/basins.ts`: the recipes per planet kind, the basin solve and `pickVents`.
- `src/world/cube-grid.ts`: the cube-sphere grid, its neighbour table, its metric and its dual mesh.
- `src/game/presentation/fluid-presenter.ts`: feeds the facet the dry points, the hulls and the impacts.
- `src/game/view.ts`: `window.__tmtFluids`. `src/game/app/dev-panel.ts`: the engine playground (`?mode=dev`).
- `underwater.wgsl.ts`: submerged camera transport, near-plane crossings and Snell/Fresnel optics.
- `src/game/presentation/debris*.ts`: cosmetic Rapier shards, geometric contacts, buoyancy and water-entry effects.

## Frame order

| Pass (timing name) | Slot, order | Work |
|---|---|---|
| `fluids.params` | `upload` 45 | The liquid params: look, basins, time, debug view and switches |
| `fluids.water` (timed as `fluids.step` and `fluids.water`) | `compute.sim` 20 | The hulls and substeps; then flow, level rings, surface, atlas pack, cull |
| `fluids.spray` | `compute.sim` 22 | Spray bursts, grid emission and update |
| `fluids.gas` | `compute.sim` 24 | Gas obstacles and step (30 Hz) |
| `fluids.bed` | `compute.commit` 10 | The bed from the SDF, when it changed or a crater is pending |
| `fluids.cache` | `ao` 20 | The per-cell lighting cache, after the fog passes |
| `fluids.copy` | `transparent` −30 | A snapshot of `hdr` for refraction (`liquidHdr`) |
| `fluids.surface` | `transparent` −28 | The surface mesh, depth only, into `liquidZ` |
| `fluids.composite` | `transparent` −20 | Shades the liquid into `hdr`, and writes `liquidDepth` |
| `fluids.depth` | `transparent` −10 | Writes the liquid's depth and camera-motion velocity into the G-buffer's |
| `fluids.gasDraw` | `transparent` −5 | The gas raymarch into `hdr` |
| `fluids.spray` drawer | transparent drawers, order 10 | Spray streaks and mist |

`compute.commit` runs after `compute.sim`, so the water sees a new bed from the next frame.

## The grid and the bed

- **Grid:** the cube-sphere level map, 6·N² cells. N is 128 on Low and Medium and 256 on High and Ultra (`LIQUID_TIER_N`),
  giving cells of 0.22 u and 0.11 u at the water's radius.
- **Tables** (`cube-grid.ts`, built once per N):
  - `cubeGrid(n)`: the neighbour table. Each seam slot also names the neighbour's slot pointing back, so a flux across a
    face seam is subtracted from one cell and added to the other exactly.
  - `cubeGridMetric(n)`: each cell's area, its four face edges and its four centre distances, on the unit sphere. The
    water scales them to 17.5 u (`WATER_TUNING.radius`).
  - `cubeGridDualQuads(n)`: the surface mesh, one quad per grid corner joining the four cells around it. At the cube's
    8 corners only three cells meet. The mesh is watertight and outward-wound (6n² + 2 faces; tested).
- **Bed:** `fluids.bed` marches the planet SDF down each cell's radial line, pending craters included. It runs whenever
  the SDF changes and every frame while a crater is pending, so a crater floods from its impact frame.
  The coarse recipe sees the outer surface. After the solve, the fine bed starts at the sea or nearby lake level
  wherever that level lies in air below a roof, then marches to the submerged floor. Walls stay blocked. Cavities
  without basin labels fill only by connected flow; they are not automatically flooded.

## The initial fill

- **Gameplay layout:** `src/game/liquids.ts` solves resting basin labels/levels from committed terrain at initialization on a 6×128² grid. Spawn dry caps apply once; the layout is saved and restored with the world and supplied to the renderer. This keeps vehicle resistance independent of GPU quality and transient waves.
- **Renderer fallback:** without a gameplay layout, `basin-job.ts` solves the recipe in a worker from a coarse GPU bed readback. Its recorded cost was about 40 ms. This supports renderer diagnostics without making GPU output authoritative.
- **Fill:** the renderer fills from the labels and levels, then runs one second of warm-up substeps. Fine cells missed by coarse labels fill by flow.
- **After fill:** GPU flow owns visual redistribution; a new grid or explicit diagnostic refill starts from the retained layout. Waves and water outside the original basin footprint do not change gameplay's resting-water query.
- **Vents:** on a volcanic planet, `pickVents` chooses them from the bed after the solve.

The sea and lake recipes are retained. The [2026-10-13 basin diagnosis](evidence/basin-depth-diagnostic.md)
samples six deterministic seeds under every explicit world kind on the production 128 grid. Temperate and glacial
seas average 1.441 u and 1.643 u deep across their wet area; both already hit the sea-level cap on every sampled seed,
so increasing target coverage does not deepen them. Volcanic lava is shallower (0.263 u mean); raising its level also
removes a water lake in one sampled world. `minDepth` means potential spill depth before fill, not guaranteed final
depth. These analytic initial-bed measurements exclude GPU bed discretization, spawn dry caps and subsequent flow;
live depth probes and contact response must be checked before using them to tune a recipe.

## The water step (`fluids.step`)

Per cell:
- `state`: water depth, lava depth, foam, wetness;
- `flux` and `lflux`: four outflows each, one per face;
- `vel`: flow velocity and speed;
- `info`: the basin label of the fill, plus the flags `sea` and `lavaLake`;
- `hull`: the submerged hull thickness at current/previous poses, its closed share, and the open share of its neighbours
  during coupling. After `flow`, the fourth channel carries actual hull contact travel speed for spray;
- `heat`: the lava temperature;
- `lvlA` and `lvlB`: the level rings; `surf`: the drawn surface; `lap`: the filter's scratch.

Each frame:

1. **Hull coupling** (when there are hulls; Müller 2008).
   - The presenter supplies the kit's body/fender envelope and two narrow track boxes, in stable tank-id and
     body/left/right order. Only the tracks extend below the belly; the gap between them stays open. Water and gas
     accept eight tanks (24 boxes), sixteen structural envelopes and one optional developer hull. Stable identities
     align current and previous poses when that collection changes.
   - `couple_occupy`: a ray–box test along each column's radial line gives its submerged hull thickness, tapered over
     0.22 u across the box's sides.
   - `couple_share` and `couple_push`: the change since last frame is the volume the hull pushed aside or left behind.
     It goes to the column's open neighbours, which makes a bow wave, a trough astern and a wake. Both hull poses are
     evaluated against the same waterline: a wave under a parked tank cannot create another displacement impulse.
     Submerged motion decays exponentially with depth below the hull top. Hull foam and spray require waterline contact.
2. **Substeps**, each a `flux_step` then a `depth_step` (virtual pipes, Mei et al. 2007).
   - **Flux:** each outflow is accelerated by the drop in surface height to that neighbour, then scaled so no cell goes
     negative.
   - **Stability** (Chentanez & Müller 2010):
     - the depth in the flux is capped at 1.5 u;
     - the speed is capped at 0.5·dx/dt;
     - bottom friction is 0.02/h;
     - turbulent drag is 0.04 × speed/h, so a torrent into a crater settles instead of sloshing for long.
   - **Hulls:** a face is narrowed by the larger closed share of its two cells, so water goes around a hull.
     Tangential travel at the contact point drives outgoing water momentum toward the hull's velocity, clamped to
     3 u/s and the existing CFL speed limit. This also reacts when tracks skim shallow water while submerged occupancy
     stays constant. Only moving contact cells check the live SDF between columns before driving flow. The existing
     cell-volume limiter and reverse-neighbour exchange still own all depth changes; this adds no water or GPU buffers.
   - **Blasts:** up to 16 impulses accelerate the water outward for 0.15 s, at 0.8 u/s per u of blast radius at the
     centre, reaching 1.4 radii.
   - **Open sea:** sea cells deeper than 0.6 u relax toward the recipe level at 1/20 per s, a reservoir that craters
     cannot drain.
   - **Count:** as many substeps as the CFL limit (0.45 at √(g·1.5)) needs for the frame, at most 4. A longer frame
     runs in slow motion rather than unstable.
3. **Grid-scale filter** (`smooth_lap`, `smooth_apply`): a conservative biharmonic exchange between wet neighbours, 0.006
   per frame. It damps single-cell spikes by about 40% per frame, and waves longer than a few cells barely.

**Lava** flows in the same step, under the water (the water's ground is the bed plus the lava):
- **Flow:** a 0.002 u hot yield height (rising by up to 0.025 u as it cools), and a damping factor h²/(h² + 3·dt·ν) with ν = 0.24 u²/s × e^(4.5·(1 − T)). Lava
  creeps, thin sheets stick, and a cooling flow slows, crusts and stops (Costa & Macedonio 2005).
- **Temperature** T (0 cold … 1 molten), mixed from incoming fluxes once per frame. Newly flooded cells receive the
  incoming lava's heat instead of sampling zero from a previously dry atlas texel.
  - Lakes are held at 0.92, and vents pour in molten lava.
  - Everything else cools by radiation (0.02 × T⁴ per s, four times faster in thin sheets) and under water.
- **Quench:** water on hot lava boils off at up to 0.08 u/s, and the spray pass raises steam there.
- **Circulation and interaction:** a slowly evolving thermal pressure head drives conservative exchange in hot pools.
  This approximates convection within the shallow layer. Both lava and water use capped flux depth and velocity;
  blasts accelerate both layers, and hulls displace the exposed liquid rather than creating water over lava.
  The velocity atlas reports lava flow wherever lava is exposed. Moving hull contact also drags the viscous skin;
  translation and rotation are measured between poses, with a deadband for resting tanks.
- **Crust:** the foam channel on exposed lava stores broken crust. Hull contact and strong flow expose hot material;
  the damage advects with the flow and heals slowly. Cooler surfaces become rough neutral grey basalt.
- **Rims:** `lava_faces` samples the live SDF between neighbouring columns, finding the lowest open layer across each
  face. Both displaced lava and outgoing flux (including blast and hull momentum) respect the rim. It passes over the
  crest only once the source surface rises above it. Push weights temporarily reuse `lvlA` before level dilation.

## Flow, surface and atlas (`fluids.water`)

- **`flow`**, once per frame:
  - the velocity, from the last substep's fluxes;
  - the foam, carried along the flow through last frame's atlas (so it crosses seams). It fades at 0.35 per s. It grows
    with speed above 1.5 u/s and with surface slope above 0.35, where hulls push, and at blasts;
  - the wetness: 1 while wet, drying over about 25 s;
  - the lava temperature, the vents' output and the quench.
- **`ext_first` and `ext_next`:** the level of the nearest liquid spreads over dry cells one ring per pass. The drawn
  surface reads two rings and the wet band four (`WATER_SURFACE_RINGS`, `WATER_BAND_RINGS`).
- **`surface`:** the radius drawn per cell.
  - Over liquid it is the liquid's surface.
  - For two rings past the shore it continues flat; the terrain's depth cuts it at the true contour.
  - Where the ground there is lower than that level (a front running downhill), it dips 0.05 u under the bed, and the
    atlas marks the cell (`WATER_FRONT_MARK`) so the composite fades the water out toward it.
- **`pack`:** four atlases, each 3 × 2 tiles of (N + 2)² texels, with one-texel gutters from the neighbouring faces:

  | Atlas | Format | x | y | z | w |
  |---|---|---|---|---|---|
  | A | rgba32float | surface radius | ground radius (bed + lava) | water depth, or the front mark | lava depth |
  | N | rgba16float | normal x | normal y | normal z | foam |
  | F | rgba16float | flow x | flow y | flow z | wetness |
  | L | rgba16float | band level − radius (−1000 none) | band lava share | coverage | lava temperature |

- **`cull`:** dual-mesh quads with four surface vertices inside the view frustum go to an indexed indirect draw.
  Terrain depth handles occlusion; an approximate spherical horizon must not hide elevated volcanic slopes.
- **`volume`:** a reduction read back about twice a second: water, lava, and the open sea's mean level (dev and drift
  checks only).

## Drawing

- **Lighting cache** (`fluids.cache`): each cell with a surface traces the SDF sun and moon, a small AO and the fog
  hidden fraction from its surface. It updates half the cells per frame.
- **Surface** (`fluids.surface`): the culled mesh, displaced by the swell, depth only into `liquidZ`. The fragment
  shader discards where the scene is in front.
- **Composite** (`fluids.composite`): the compute entry `fluid_main`, linked after the lighting module and run with the
  lighting pass's bind groups. Per pixel:
  - **No liquid:** the wet band (damp ground within four rings, darkened by wetness) and debug views. Lava does not
    paint a constant orange glow onto nearby terrain or tank undersides.
  - **Lava:** opaque basalt crust with irregular molten ribbons, hot openings, fine relief and surface highlights.
    Two flow-advected texture phases crossfade without visible resets. Temperature controls glow and cooling;
    only the thin contact edge blends with the terrain for antialiasing. No water refraction is applied to lava.
    Where the coarse simulation bed differs slightly from a rendered terrain LOD, a wet thin film conforms to the
    actual upward-facing ground. This coating is excluded from vertical faces, ceilings and tank materials, and keeps
    caster shadows and the visibility veil.
  - **Water:** the resin look (`LIQUID_LOOKS`): absorption along the view path, refraction of the `hdr` snapshot and
    caustics.
    - The normal is the simulation's, tilted by the swell and a chop driven by the flow.
    - Foam lace appears where the water carries foam.
    - Thin films, fronts and terrain contact fade softly, and contact foam lines the shore.
  - **Veil:** hidden liquid is veiled like hidden terrain, from the cache's hidden fraction.
- **Depth** (`fluids.depth`): the liquid's depth and camera-motion velocity go into the G-buffer's, so DOF and TAA see
  the surface.
- **Swell**: render only, three plane waves of 2.3–5.1 u, 0.028 u together at scale 1. The scale is per planet kind:
  temperate 1, glacial 0.5, dune 0.6, volcanic 0.8.
  - The raster is displaced, and the composite tilts the normal by the exact gradient.
  - It fades to a third at the waterline, so shores lap. There is none on lava.

### Submerged camera

The camera can cross the two-sided surface. A local ray/surface solve supplements raster depth when the interface
falls inside the near plane. Underwater rays integrate RGB extinction and six samples of single scattering, including
depth-attenuated sunlight and terrain visibility. Opaque tanks, terrain, grass and debris share this transport and
receive caustics. Looking up uses water IOR 1.333, exact dielectric Fresnel and total internal reflection beyond the
48.6-degree critical angle. Reflected/refracted geometry comes from a bounded screen-space trace, with sky or water
scattering as its fallback; off-screen objects are not rendered by a second reflection camera.

Inside lava, short RGB extinction lengths hide distant geometry and transparent effects in an emissive medium.
The live interface is solved per ray when it crosses the camera near plane; the dev panel includes an Inside lava button.

The liquid remains a single radial layer per cell. It supports open water beneath a roof, not stacked independent
water bodies along the same radial column. Seagrass grows on gentle temperate beds in the shallow photic zone.

## Tanks and blasts

Terrain shards use their actual closed convex geometry in a cosmetic Rapier world. They collide with terrain,
other shards, mirrored tank hulls and moving structures, can break again on hard impacts, and dither away near the
end of their life. Their material textures come from the terrain arrays. GPU water probes provide the waterline and
flow; buoyancy uses material density and the shard's oriented radial span (an approximate submerged volume).
Drag scales inversely with density and size, so small/light fragments lose speed sooner. Moving debris probes
water every 75 ms; a sample follows the same radial column for at most half a second, with a 0.75 u lateral limit.
Selected debris also continuously displaces water and transfers wake momentum through the same hull coupling as tanks.
Entering or leaving the surface adds bounded foam and spray; fully submerged motion does not repeatedly splash. These contacts push the cosmetic debris, not the
authoritative tank physics.

Loaded tread footprints sweep the complete contact patch while retaining belt orientation. Sideways slip softens
the grouser pattern and reduces scuff pressure. A separate trample channel flattens grass even under a parked tank
and recovers over roughly 30 seconds. Grass roots form loose, randomly scattered spherical clusters rather than
cube-face rows. Seamless Cartesian habitat noise at two larger scales creates dense meadows, sparse transitions
and clearings, independently of the variable tuft size. Three curved blade profiles vary in width, height, tint and dry tips; central ribs and longitudinal
veins fade out below pixel resolution. Short, soft root-contact shadows replace the long projected clump capsules,
with footprint filtering and a distance fade to avoid landscape-wide streaks.

Blast scorch suppresses grass height, including roots regenerated when the crater commits. The persistent scorch
channel lets regrowth follow its slow decay instead of immediately repopulating fresh crater floors. Up to eight
overlapping blast pulses bend nearby blades outward along the sphere, followed by damped recovery; previous-frame
deformation is included in motion vectors. Both real impacts and the playground explosion preview trigger this response.

- **Hulls** (`fluid-presenter.ts`): three boxes per tank, ordered body, driver-left track, driver-right track, with
  tanks sorted by id. A cached kit-derived hull/fender envelope stops at the belly; two narrow boxes use the kit's
  belt width and running envelope length, and reach down to the current physical wheel-station support heights.
  The tracks stop at the belly plane, so their volumes do not overlap the body and the central underbelly remains
  open. At nominal suspension the tracks reach local Y = -0.5 and the belly stops at -0.28: 0.1 u-deep water touches
  both tracks while the hull stays dry. These are fluid approximations; tank mesh and collision geometry do not change.
  Root transforms use the same interpolated pose as the visible tank. A retained 4 mm corner-motion deadband includes
  suspension-dependent dimensions, suppressing solver chatter while accumulating slow real motion. All eight tanks
  fit in 24 slots, with one additional slot for the dev proxy. Hidden tanks are included (D7 as amended).
- **Dry points:** the tanks' positions at the start of a match.
- **Impacts:** every impact calls `fluids.impulse(point, radius, normal)`, which does three things:
  - a water impulse, with foam;
  - a spray burst of droplets, or glowing blobs in lava;
  - a gas domain: a fireball on land, a water burst under water, or a lava burst in lava.
- **Choosing the preset:** `underLiquid` reads the initial fill's labels. A blast in a crater that flooded later gets
  the land fireball.

## Spray (`fluids.spray`)

- **Pool:** a ring of particles (3 × vec4f each), overwritten oldest first through an atomic head. It holds 8k, 16k, 64k
  or 128k particles by tier.
- **Bursts:** 900 particles per u of blast radius on High, scaled by the tier's ring.
  - Water: about 60% crown, 28% column (5–8.5 u/s up) and 10% mist, started only where there is water.
  - Lava: glowing blobs, also used for the vents' fountains.
- **Grid emission:**
  - hulls pushing into water shallow enough for them to break the surface (25 droplets per u of push), plus
    sustained contact spray from measured hull travel. Emission fades in from the solver's 0.004 u wet threshold
    instead of dropping all water below 0.02 u. A stationary hull adds no contact travel, even under a passing wave;
  - torrents faster than 2.2 u/s;
  - steam puffs where water boils on lava;
  - sparse molten spatter where a moving hull breaks lava crust. Positions are sampled continuously within cells,
    with independent size, launch direction, heat and lifetime variation; there are no cube-shaped flakes.
  At most four water droplets emit per cell per frame into the existing bounded ring. Grid emission stops when
  the water does not advance, so a paused frame cannot repeatedly emit its cached contact motion.
- **Update:** ballistic, with radial gravity and air drag.
  - Water droplets merge into terrain/water. Lava particles conservatively sweep against the terrain SDF (including
    pending craters), rebound with restitution 0.42 and tangential damping 0.72, and rebound more softly on the live
    lava surface. The sweep stops safely if its iteration budget is exhausted. Small particles settle and fade.
  - Lava particles cool throughout their lives from yellow/orange through red to grey, independently of opacity.
  - Its sun visibility (a 16-step SDF march) and its fog hidden share are traced once per frame.
- **Draw:** raster quads bound raymarched ellipsoid volumes. Density integration ends at scene/water depth, so mist
  intersects the water smoothly instead of clipping a flat billboard. Droplets elongate along their motion.
- **Volume:** spray isn't taken from the water or given back.

## Gas (`fluids.gas`, `fluids.gasDraw`)

- **Pool:** one 3D atlas; each live domain is a slot. By tier it holds 4 × 24³, 8 × 32³, 8 × 48³ or 12 × 48³, with
  8, 12, 18 and 20 Jacobi iterations.
  - It is allocated at install, so the first blast does not hitch.
  - A full pool evicts the lowest-ranked slot: lower priority first, then farther, then older.
- **Domain:** preset-sized, turned to local up. Explosive clouds have eight radii of space (capped at 40 u);
  nuclear clouds use 5.8 radii (capped at 34 u). Rounded absorption and rendering fades hide domain boundaries.
- **Presets** (`GAS_PRESETS`):
  - fireball, 5 s: it bursts out of the surface, rolls dust and burns off into smoke;
  - water burst, 4 s: a white plume of spray and steam;
  - lava burst, 6 s: fire, then heavy dark smoke with embers.
  - nuclear, 14 s: rising toroidal crown and a sustained stem reaching the crater floor; accelerated evolution;
  - incendiary, 13 s: spreading fuel near the actual ground, low flames and rising cool smoke.
- **Step:** a fixed 30 Hz, at most one per frame.
  - Each step rebuilds the obstacles: the SDF with pending craters, the water below its surface (atlas A) and every
    tank's hull box, hidden tanks too.
  - Then curl, advect, divergence, Jacobi pressure and projection, each one dispatch over all slots.
- **Raymarch:** one instanced draw of the visible domains, far to near.
  - It runs after the liquid depth is in the scene depth, so gas stops at the water.
  - The step count follows the domain's cells.
  - Near obstacles the gas thins through a filtered fade.
  - Hidden air veils it through the fog volume.

### Vehicle smoke and fire

`presentation/vehicle-damage.ts` feeds sustained sources into the existing blast atlas through `vehicleFires`.
Smoke begins at damaged machinery; severe damage and wrecks burn. Each source is keyed by vehicle id and generation,
so repairing, retiring or recycling a vehicle stops feeding its old plume. Density remains in world space as a vehicle
moves, and fades through the volume renderer rather than opaque dithered meshes. Source heating, fuel combustion,
buoyancy and cooling produce the transition from flame to rising soot. Analytic preview worlds use the planet radius
when no resident terrain SDF exists.

Only the nearest half-atlas worth of vehicle sources are fed. Explosions outrank them; existing muzzle smoke keeps its
separate atlas. The source list is bounded and updating a sustained fire does not allocate or clear its GPU slot.

Vehicle machinery is authoritative in `game/rules/vehicle-damage.ts`: impact positions in the vehicle's local frame
select left/right running gear, power or weapons. Substantial damage reduces torque, failed tracks produce asymmetric
drive, failed weapons cannot fire, and powerless aircraft fall. Repairs restore module integrity. Staged bosses retain
their existing individual component rules. Geometry is presentation: localized subdivided dents and torn rims, shader
cracks and blast soot, and detached model parts simulated by the existing rigid-body debris world. It is a bounded
damage model, not a material-stress or arbitrary-cut fracture solver.

Inspect `/dev/kit.html?model=dragonfly`, `/dev/kit.html?damage=1`, or `/dev/kit.html?damage=1&model=dragonfly`.
Add `&burn=0` to inspect armor and broken running gear without the tank's low-hull fire. Tests cover module selection
under rotated gravity, disabled firing and repairs, unchanged healthy steering, bounded immutable mesh deformation,
detached-panel settling, sustained emission and explosion priority.

## Vents and lava light

- **Vents** (`LAVA_VENTS`, volcanic planets): two, from `pickVents`.
  - **Placement:** the highest smooth summits at least 0.6 u above the lava sea. They stay 0.3 rad from every dry point
    and 0.45 rad from each other.
  - **Smoothness:** no neighbour may drop more than 0.35 u; the bed holds buildings too.
  - **Eruptions:** each vent erupts for 12 s every 45–80 s, with its own period and phase. An eruption pours
    0.35 u/s of lava at the centre over 0.45 u, throws a fountain of blobs, and lights a shadowed point light that
    fades in and out.
- **Light:** lava lights the scene through the vents' shadowed point lights. Lava is not in the
  GI probes or the emission pyramid.

## Fog of war

- Liquid surfaces are veiled per pixel like terrain. Spray and gas are veiled by the fog volume.
- Fluids never block sight. Neither the simulation's rays nor the fog passes see them.
- Every tank disturbs the water, hidden ones included. A wake that reaches seen water gives its tank away, as it would in
  reality. It shows only where the water is seen.

## Tiers and cost

| | Low | Medium | High | Ultra |
|---|---|---|---|---|
| Water grid (`LIQUID_TIER_N`) | 6×128² (0.22 u) | 6×128² | 6×256² (0.11 u) | 6×256² |
| Spray ring (`SPRAY_TIER`) | 8k | 16k | 64k | 128k |
| Gas pool (`GAS_TIERS`) | 4 × 24³, 8 iterations | 8 × 32³, 12 | 8 × 48³, 18 | 12 × 48³, 20 |

A live tier change reallocates what changed size. A new grid refills the water from the last solve.

**Historical measurements** on 2026-09-28, before the graphics overhaul (RTX 3080, seed 7, `--perf --gpu-timings`). The display ran at a vsync-bound 120 fps and no
frame took over 8.5 ms, so the GPU total is the measure:

| View | GPU total, mean (p95), ms | Fluids, ms |
|---|---|---|
| High 1080p, following the tank, no water in view | 3.3 (3.4) | 0.84 |
| High 1080p, calm shore close-up | 3.7 (3.7) | 1.24 |
| High 1080p, calm planet view | 3.3 (3.4) | 1.21 |
| High 1080p, blast and flood in view | 5.2–5.3 (5.56) | 2.3 |
| Ultra 1080p, blast in view | 5.1 (5.1) | 2.2 |
| Low 1600×900, shore, then blast and flood | 2.6–3.0 (3.3) | up to 1.2 |
| Low 1600×900, volcanic, vent erupting | 2.3 (2.6) | 0.5 |

Passes with a blast in view, High 1080p (ms):

| step | water | spray | bed | cache | surface | composite | depth | gas | gasDraw |
|---|---|---|---|---|---|---|---|---|---|
| 0.29 | 0.34 | 0.04 | 0.05 | 0.13 | 0.01 | 0.64 | 0.03 | 0.10 | 0.70 |

- **Historical budget:** the frame gate (≤ 7.5 ms average, ≤ 9 ms p95) and the fluids' 4 ms both hold.
- **Scaling:** the step and the water passes cost the whole planet every frame, whatever is in view: about 0.6 ms on High
  and 0.12 ms on Low and Medium. The composite and the gas raymarch are per pixel, so they do not shrink with the tier.
  The composite costs almost nothing without liquid in view (0.07 ms).

These figures describe the 2026-09-28 implementation and do not establish current release or phone performance.

## Dev tooling

- **`?mode=dev`, Engine playground:** free driving, unlimited ammunition, all munition types, terrain blasts,
  effect previews, planet presets and live graphics settings. Inspect shoreline, Underwater camera and Inside lava choose actual
  wet cells from GPU probes. Liquid debug views/toggles remain accessible through the `fluids` scene facet.
- **`window.__tmtFluids`:**
  - reading: `stats`, `basins`, `seaLevel`, `volume`, `vents`, `probe(points)` (depths, ground, surface and foam at
    world points), `shorePoints(count, material)`;
  - fill: `resolve`, `refill`;
  - events: `pulse(point, radius)` (a blast without a crater), `breach(point, radius, hold)` (an impact without the
    simulation, its crater held pending), `testHull(from, to, speed)` (an undrawn hull, shown as an orange debug box);
  - setup: `setTier(tier)`, `lookAt(target, height, back, azimuth)`.
- **Capture plans** (`scripts/capture-plans/`): `fluid-water`, `fluid-settle`, `fluid-probe`, `fluid-planet`,
  `fluid-shores`, `fluid-wake`, `fluid-spray`, `fluid-lava`. They find their spots with `shorePoints` and `probe`.
- **Actual tank wake check:** `node --import tsx scripts/verify-track-wake.ts --seed 7` starts a local server and
  hardware WebGPU Chromium, finds shallow water, places the real observed tank with the playground control, then
  drives with `KeyW`. Named body/leftTrack/rightTrack probes avoid assuming tank ids or snapshot array order.
  It records centre-ray immersion and screenshots in `artifacts/startup-audio/water-wake`; review the driving
  screenshot for spray. `TMT_CHROME` overrides the executable and `--out` changes the output directory.

## Invariants

- One water layer for the whole planet. There is no second representation and nothing to blend at a boundary.
- The recipe sets the water once, at the fill. After that, only flow changes it.
- Face seams conserve volume exactly. A lake at rest stays still over any bed.
- Gameplay reads the saved resting basin layout, never GPU wave/spray/gas state; tiers never change gameplay.
- Fluids never block sight. Hidden liquid is veiled like terrain. Every tank makes wakes.

## Verification

The 2026-10-13 [recorded water-wake evidence](evidence/water-wake.json) confirms a dry sampled body column with an
immersed right track during real driving, visible contact spray, and zero pipeline or GPU validation errors.
The reusable verification script passed all five driving checks. The right-track water speed rose from 0.0024 to
0.6995 u/s. The sloping track column was 0.294 u deep before driving;
this is a centre-ray contact check, not proof that the whole body stayed dry or that the water was uniformly below
0.22 u. It is a desktop functional capture, not a mobile or performance measurement. The change remains visual:
it added no tank buoyancy, chassis drag or lava damage. Current standing-water resistance is a separate gameplay system described above.

The wake change adds no grid buffers, dispatches or particle capacity. Its 25-box capacity uses 3,824 bytes for the
water uniform and 1,616 bytes for the gas obstacle uniform. With eight tanks, the three boxes per tank require
48 broad-phase ray/box checks per water cell across current and previous poses, versus 16 with one box per tank;
the optional developer box raises that bound to 50. New terrain checks run only on moving wet contact faces with
nonzero open share, bounded by 24 SDF queries per face per existing substep (four faces, at most four substeps).
The eight-tank runtime cost has not been measured, and no phone frame budget has been verified. The existing
four-droplet per-cell emission bound and tier-specific particle rings remain unchanged.

The renderer has `graphics-underwater`, `graphics-tracks`, `graphics-grass`, `graphics-lava`, `graphics-final` and `graphics-interactions`
capture plans. The underwater plan executes the production floor-march and Fresnel WGSL against a suspended-roof
fixture, checks deep hull motion for spurious foam, and captures both sides of the near-plane waterline. The tracks
plan captures compression and recovery. The grass plan captures meadow/clearing distribution, an outward blast pulse
and a committed crater. The lava plan exercises seed 8's live GPU layer: ambient flow, blast depth/velocity response,
finite nonnegative depths and hull displacement without creating water. It also executes production ember collision
and rim-barrier WGSL against analytic floors, thin walls and a submerged rim: fast impacts rebound, embers settle,
sub-crest flux is zero and above-crest flow remains open. `graphics-lava-contact` captures sparse spatter and building
contacts from multiple angles with the fluid state frozen. Rapier shard tests cover real convex contacts, sleeping, tank pushes and
buoyancy; track tests cover lateral sweeps, ground phase in reverse and teleport discontinuities.

- `npm run check` and `npm run verify:fast`.
- `tests/world-cube-grid.test.ts`: the dual mesh is watertight and outward-wound, and the metric's areas sum to the
  sphere.
- `tests/world-basins.test.ts`: the recipe solve and the vents.
- `tests/fx-fluid-presenter.test.ts`: shallow track-only contact for every hull/gear pairing, independent suspension
  limits, translation/rotation and render interpolation, non-overlapping volumes, stable eight-tank slots and the
  suspension-shape deadband. These CPU tests establish contact geometry, not visible GPU wake quality.
- The visibility gates (`scripts/capture-plans/visibility-gates.js`, see
  [`visibility-architecture.md`](visibility-architecture.md)) must stay unchanged with fluids on.
- Behaviour, measured with the capture plans:
  - the volume holds to 1e-8 relative over 45 s;
  - a calm sea shows no flow;
  - a breach floods a shoreline crater and settles at the lake's level within 45 s.

## Not done

- **Gameplay coupling:** resting liquid levels affect vehicle resistance, but transient flow/waves and cosmetic debris buoyancy do not feed back into authoritative tank physics.
- **Performance:** the historical desktop measurements do not qualify current multi-tank or physical-phone workloads.
- **Spray:** its volume isn't conserved, and there is no surf spray at breaking waves.
- **Lighting:** lava is not in the GI probes or the emission pyramid.
- **Blast presets:** the choice reads the initial fill, not the live water.
