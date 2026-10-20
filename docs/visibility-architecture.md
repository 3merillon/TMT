# Visibility, shadows and indirect light: the planet SDF architecture

This guide describes the integrated SDF visibility, shadow and indirect-light systems.
[Runtime architecture](architecture.md#rendering) records their ownership and renderer boundaries.

## One shared resource: the planet SDF

`src/engine/passes/sdf/` provides the reserved binding `sdf` (`volume`, `params`) and the scene facet `sdf`.

- **The volume.**
  - r16float over the ±24.5 u cube, negative inside rock. Without `texture-formats-tier1` it falls back to rgba16float.
  - Voxels per axis by tier: 128 on Low, 160 on Medium, 256 on High and Ultra (`?sdfSize=` overrides it for
    comparisons).
- **Built on the GPU from the resident static terrain pages** (`sdf-build.wgsl.ts`):
  - **Band.** Each triangle writes its exact point–triangle distance into the voxels within 4 voxels of it (`atomicMin`
    on the float bits). The terrain material id goes in the low 4 bits.
  - **Sign.** Every z-column gets one crossing bit per triangle whose xy projection contains the column centre. Edge
    functions use a canonical vertex order, so a shared edge is exactly antisymmetric and a tie is claimed once.
    - A prefix XOR turns the crossings into "inside".
    - A column with an odd count (an open mesh) is reset to outside and reported as `sdfOpenColumns`.
  - **Far field.** A jump flood on a 4× coarser grid, seeded by the cells that contain a surface-adjacent voxel. It
    gives a conservative lower bound, never below the band.
  - **Near field.** A chamfer grow extends near-exact distances to 3 u (÷1.08 for a lower bound). It runs after the
    flood and skips voxels the flood places beyond the near field.
- **Edits.**
  - The first commit builds the whole domain.
  - Each later `terrainCommitted` rebuilds its dirty box grown by the band, and redoes the coarse flood everywhere.
  - Edits only remove rock, so the far-field values outside the box stay valid lower bounds.
- **Pending craters** are carved analytically into every lookup (`max(d, r − |p − c|)`) from the engine's per-frame
  `pendingCutList`.
  - A cut that the commit retires stays carved until the next build completes, so a crater never flickers.
- **Not in the static planet SDF:** detached bodies and tanks; dynamic rendered groups use caster bricks.
- **`sdf.wgsl.ts` holds the one implementation of every query:**
  - `sdf_sample`, `sdf_normal` and `sdf_normal_smooth` (the gradient at a chosen scale, continuous across the coarse
    terrain's facets);
  - `sdf_vis_point` and `sdf_vis_dir`: the Quilez cone estimator with Aaltonen's triangulation, marching into
    negative distances so the 50% contour sits on the geometric boundary. `sdf_vis_dir_occ` also returns the distance
    to the occluder that shapes the penumbra;
  - `sdf_ao` and `sdf_ao_cheap`.

## Fog of war

`src/engine/passes/fog-of-war/` runs in slot `ao`, after the G-buffer. `view.ts` sets the sensors: the observer's
living team tanks. The engine keeps the nearest few to the camera focus: 2 on Low, 4 otherwise.

- **Penumbra.**
  - Behind an occluder at distance t, the width is `clamp(0.5 + 0.12·t, 0.5, 2.0)` u (`FOG_PENUMBRA`). Contact
    hardening in `sdf_vis_point`: the width starts at 0.4·w_min and reaches w_min 3·w_min along the ray. Otherwise a
    surface's own grazing ray reads as a half occluder, and each coarse facet greys out as a whole triangle.
  - A soft sensor-facing term (smoothstep over −0.25…0.15) hides back faces without a terminator seam. On the coarse
    terrain it uses the smooth SDF normal (`fog_surface_normal`), so the facets never show as a mosaic; buildings and
    rocks keep their own flat normals. The smooth normal is blended in only within about 20° of the facet's normal and
    is gone by 40°. At 0.5 u scale the gradient bends toward nearby walls and roofs: measured 45–60° on building walls,
    it hid upper walls a tank could see.
- **`fog.volume`** fills a world-space hidden-fraction volume over ±28.5 u, which covers the atmosphere's soft top at
  28.1 u.
  - One SDF trace toward each sensor per voxel, stopping once the voxel is fully seen.
  - Sizes: 64³ on Low, 96³ on Medium, 112³ on High, 128³ on Ultra.
  - Low and Medium update half the voxels per frame (checkerboard).
- **`fog.surface`** traces at half resolution, at one jittered pixel per 2×2 block, then resolves at full resolution.
  - The resolve blends only depth-compatible half-res samples.
  - Pixels with none, such as hidden building silhouettes, are traced at full resolution.
  - Ultra traces every pixel.
- **Lighting** (`lighting.wgsl.ts`):
  - Terrain-class surfaces, and objects with the G-buffer veil bit (`OBJECT_ID_VEIL`: enemy tanks), mix toward
    `war_fog_color` by the surface hidden fraction. The veil is sculpted, on the smooth normal for terrain, so hidden
    relief reads as shape:
    - By day: a light mist lit by the pixel's sun visibility, a moonlit term and the AO.
    - At night (`war_fog_night`): a matte grey of albedo 0.2 lit by the real night light (the night-sky floor, the
      moonlit sky, sky irradiance and the moon). It stays below what the team sees under the same light, so a seen
      face turned away from the moon never shows as a dark hole in brighter fog.
    - The volumetric mist uses the same colour.
  - Every camera ray (sky rays up to the atmosphere exit) then marches the volume, weighted by `atmo_density`, with
    jittered samples converged by TAA.
- **`probe(points)`** evaluates the same visibility at world points and reads it back. The gates use it through
  `window.__tmtVisibility`.

Everything is a function of world positions and sensor positions. Orbiting or zooming the camera changes only where
the field is sampled.

## Enemy tanks and the simulation

The simulation is the only truth (`updateContacts` in `src/game/simulation.ts`).

- **Team union.** A team sees an enemy when any living team tank's kit sensor has a clear ray to any of its sight
  points. The result is written into every team member's row.
- **Sight points** (`sightPoints`): the 8 hull-box corners inset 0.05 u, the hull centre, the legacy sight target, the
  turret centre and top (at the current yaw), the trunnion and the muzzle.
- **Unchanged:** the range is 1.65 R, rays stop 0.12 u short, and tanks never occlude.

Rendering (`presentation/tank-view.ts`):

- An enemy in fog is drawn only while its row says visible. It dissolves in over 0.15 s and out over 0.1 s (a dithered
  discard, smoothed by TAA).
- Its hidden parts are veiled, never clipped.
- Wrecks stay drawn and veiled.

## Shadows

Once the planet field is valid, world visibility uses the planet SDF and dynamic groups use caster bricks. Sun maps
and screen-space contact shadows provide the initial path before that field is ready.

- **Sun and moon.** Lighting traces `sdf_vis_dir` toward each. The source radii are miniature-exaggerated: tan 0.035
  and 0.045. The same cone estimator runs through the tank bricks (`casters_vis_dir`). Screen-space contact shadows
  apply only before the planet SDF is valid.
  - The sun maps (PlanetStatic, PlanetDynamic, Hero) supply sun visibility until the SDF exists.
- **Terrain is lit as a smooth surface.** The coarse terrain is shaded with smooth normals, but the SDF holds its flat
  triangles. So on terrain and grass:
  - the back-face gate is the shading normal's terminator alone (the flat-normal gate cut the light one triangle at
    a time near grazing);
  - world traces start from `terrain_shadow_origin`, lifted up to 0.25 u as the smooth surface nears its own
    terminator, and first stepped out of the field where a valley crease leaves the rendered surface inside it;
  - the tank bricks trace from the unlifted point.
- **Tanks** (`src/engine/passes/sdf/sdf-casters.ts`, facet `sdfCasters`).
  - `tank-view.ts` bakes one brick per rigid group per kit key: hull (with wheels and tracks), turret and gun, from
    LOD 2 in the joint frames.
  - Each brick is 32³ unsigned distances minus half a voxel of skin, baked on the GPU (one per frame) into an 8×4×2
    r16float atlas.
  - Every frame the three instances per drawn tank are placed at their joints. Up to 48 are uploaded as world→local
    affines with a bounding sphere; rays test the sphere before marching the brick.
  - A tank hidden in fog has no instances, so its shadow never gives it away.
  - The fog of war does not bind the bricks: tanks never occlude sight.
- **Local lights.** Lights with `castShadow` (shells, impacts, muzzle flashes) get `sdf_vis_point` through the world,
  capped at 2/8/16/32 shadowed lights per pixel by tier, times `casters_vis_point` through the bricks.

## Ambient occlusion and GI

- **AO.** `ao.sdf` (`src/engine/passes/ao/sdf-ao.ts`) writes the reserved `ao` texture at half resolution. Its cones see
  the tank bricks near each pixel as well as the planet SDF, so tanks darken the ground under them.
  - 6 cones × 5 steps out to 3 u, rotated per frame; the 5-tap variant on Low. On the terrain the cones follow the
    smooth SDF normal.
  - Lighting applies it to ambient light only.
- **GI.** `gi.probes` (`src/engine/passes/gi/`) runs on High (2048 probes per frame) and Ultra (4096).
  - A 32³ grid at 1.53 u spacing. A probe is active in air within 3.2 u of a surface; one in shallow rock is pushed
    out along the gradient.
  - Each updated probe traces 64 rays against the SDF. A hit reflects its material albedo × the sun with a soft SDF
    shadow, plus a dim sky term.
  - The results are stored as L1 irradiance SH (bounce, RGB) plus a cosine-convolved sky visibility, with hysteresis
    0.12.
  - Lighting blends the 8 surrounding probes with SDF occlusion taps on each segment. It multiplies the sky ambient by
    the visibility (strength 0.8) and adds the bounce.

## Dev panel (`?dev`)

`/?mode=drive&dev` drives freely with a live panel (`src/game/app/dev-panel.ts`) for isolating artifacts.

- **Views.** The final image, one lighting term or a G-buffer channel. The lighting terms are sun shadow, SDF sun,
  moon, direct, local lights, ambient, AO, GI, GI sky, GI bounce, SDF distance, fog hidden, veil and mist
  (`LIGHTING_DEBUG_VIEW_INFO` holds the tooltips).
  - The **SDF distance** view shows where the rendered surface and the SDF disagree. Black means they match; grey means
    the surface lies outside the SDF and red inside it, saturating at 2 voxels. The terrain's triangle edges show
    faintly, because the voxel field rounds creases; an object the SDF does not hold lights up.
- **Effect switches.** Fog veil, mist, AO, GI, ambient, sun, moon, tank, contact and local shadows
  (`LightingFacet.toggles` and the `LIGHTING_TERM` bits in `params.debug.x`), plus TAA, bloom and auto exposure.
- **Time of day.** A slider for the time-of-day offset.
- **Copy state.** Copies a URL (`?view=`, `?off=`, `?dayOffset=`) plus the tank and camera positions.
- **Keys.** \` hides the panel, `[` and `]` step through the views, and `\` returns to the final image.

## Invariants

- One SDF, one query library. No pass keeps its own copy of the terrain.
- Visibility never depends on the camera. The fog volume and the surface veil read world positions and sensors only.
- The renderer never reveals an enemy the simulation hides, and never cuts out one it shows.
- Only the simulation's CPU raycast decides sightings, so replays stay deterministic.
- A terrain edit reaches every consumer on the frame of the pending crater. It swaps to the committed geometry on the
  first frame after the rebuild.

## Verification

- `npm run check` and `npm run verify:fast`.
- `tests/rules-sightings.test.ts`: team union, living sensors, any portion.
- A browser capture with `--gpu-timings` using `scripts/capture-plans/visibility-gates.js`, which reports:
  - the SDF-at-surface mismatch (S3);
  - leaks against the simulation's exact rays outside the penumbra band (S4);
  - the 10–90% edge widths.
