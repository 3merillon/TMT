# Workshop

The workshop is a separate Y-up interior scene rendered by the existing WebGPU
engine. It uses the real kit assembly, posed component meshes and component SDF
shadow casters. A uniform 1.44 workshop presentation scale is applied consistently
to geometry, picking, grips and shadow casters; gameplay dimensions and stats do
not change. The gameplay renderer is paused
while this scene is visible. `scene.ts` owns its engine, animation frame, camera
listeners, room, texture arrays, mechanics, particles, and audio teardown.

The workshop honors saved and live graphics controls, including render scale,
shadow quality, ambient occlusion, bloom and grain. Low skips dynamic caster
shadows, contact AO, room haze/light shafts and decorative steam. High retains
100% render scale. Inspection keeps a rectilinear, sharp camera for exact painting.
The orbit shortens before actual room triangles (including pillars and pipes),
with lens clearance and wider framing when architecture limits zooming out.

## Interaction and saved builds

Drag to orbit, wheel or pinch to zoom, or use the inspection views. The focused
viewport also supports arrow keys, +/- zoom, and R/Home reset. Exact triangle
picking selects tank components; Components supplies an accessible alternative.
Contextual drawers show actual part geometry, compatibility, cost, and stat
changes. Previewing does not change a saved build. A successful installation
commits through the existing profile controller after the assembly is seated.

Changing a hull or turret preserves compatible fitted equipment and explicitly
lists required replacements before installation. Wedge with an Arc mortar previews
the Wedge and Field cannon together, with their combined cost and stat changes.
Matched components travel together through the robot and trolley service sequence;
their saved loadout commits atomically once seated. Cancellation returns the entire
original assembly. Direct weapon choices still show
an unsupported socket as an explicit error. Selecting a new Bastion includes its
reactive armor package in the preview, mass and cost; the Hull panel can remove it.
Older saved Bastions without an armor field remain standard armor until changed.

All three named builds and the active match loadout use the existing profile
schema. Rank 1 starts with a 10-point fitting budget; each rank adds two fitting
points. Special blueprints unlock through victories or an explicit scrap purchase.
Locked parts remain inspectable, and buying a blueprint does not automatically fit
it or bypass the fitting budget. Cosmetic appearance and ownership are
separate from kit IDs and gameplay stats.

### Paint and lighting

Open **Paint** for solid enamel, woodland, geometric camouflage and identification
stripes. Each finish has three editable colors and a shared scale. Left-drag paints
the visible metal surface; right-drag or Alt-drag orbits, and the wheel zooms. Touch
gestures orbit rather than leaving accidental marks. Tracks, rubber, glass and bare
hardware block the ray but cannot receive player paint.

The brush exposes color, radius, opacity and softness. Each dab rasterizes into
compressed RGBA texture tiles attached to the component's actual metal triangles.
There is no stroke-count limit. Eraser clears painted pixels; Reset clears the
custom drawing. Undo/redo (also Ctrl/Cmd-Z, Shift-Z or Y) retains the last 32 whole
gestures, including finish changes. The editor shows **Unsaved changes** until
Save succeeds. Closing, switching tools, leaving or starting a test offers
**Save design / Discard changes / Keep painting**; browser reload/close uses the
browser's unsaved-change warning. Storage failures retain the drawing. **Export
design** downloads the current profile and drawing for Settings → Profile import.
Sandbox Save lasts only for the current session.

Texture charts use 96/48/24 texels per tank unit for fine/mid/coarse geometry,
with two-texel edge gutters and a maximum 512×512 tile. Each rigid mesh packs its
charts into an atlas (maximum 4096×4096), with one additional mip level to keep
filtering inside the gutters. Saved pixels use lossless RGBA run/literal coding;
repainting replaces texels rather than adding runtime brush descriptors. The
shader samples one custom-paint texture per fragment, independently of gesture
count. Existing triangle/draw counts remain unchanged; separate triangle UVs
can duplicate vertices. Damage subdivision interpolates those UVs, keeping paint
attached to bent armor. Drawing refreshes affected meshes at most 12.5 times per
second; this upload work is distinct from ordinary gameplay sampling.

Paint follows each retained component and all three LODs. Replacing a component
hides its paint; refitting it restores the design. Old saved dabs migrate on use.
Dabs or tiles whose geometry no longer matches remain archived in the save/export,
with a visible editor notice; they are not silently discarded. Browser storage
quota and multiplayer payload limits still apply to the compressed artwork, and
are reported explicitly. Multiplayer sends compressed appearance content on
appearance changes, caches it by content hash, and keeps it out of simulation
snapshots. Match impact damage remains a separate temporary mark budget and is
never saved as base paint.

**Lights on/off** toggles the lenses and two mounted terrain-illuminating spots.
The choice follows the saved design into matches. Radar rotates on its pedestal;
paint mode pauses accessory motion so a surface stays under the cursor. Accessories
share the same gameplay contribution; sensor and defensive designs are cosmetic.
Point-defense is explicitly a visual preview and cannot intercept targets.

### Unrestricted experiments

**Sandbox** copies the current build and design into session-only memory. All parts,
finishes, weapons and the Bastion reactive armor option are available without fitting
budget or ownership restrictions. Physical socket incompatibilities stay disabled
with their actual reason. Installation, painting and lights use the existing
workshop controls. **Drive test** and **Combat test** launch the current sandbox
build in the normal match flow; their banner offers **Return to workshop**. These
tests never award or remove progression. **Exit sandbox** restores normal saved
builds, cosmetics and ownership. Reloading also clears the sandbox session.
The **Builds** panel offers complete **Aether Regent** and **Furnace Leviathan**
preset assemblies and their paint palettes. Both sets also remain selectable part
by part in the same five component categories.

Run `node node_modules/tsx/dist/cli.mjs scripts/verify-tank-customization.ts` for the
isolated-profile Chromium/WebGPU acceptance pass, screenshots and paint recording.
Use `--paint-only` for the 311-gesture texture, save/reload and unsaved-exit checks;
`--paint-exit-only` covers the mobile save dialog and browser reload protection.
Use `--utility-only` to exercise every accessory with animated and quick installs
across standard and fantasy hosts. Use `--fantasy-only` for explicit blueprint
purchases, fitting-budget enforcement, the animated Wedge/Cannon matched swap,
both complete Sandbox presets, actual Drive/Combat tests, and detail recordings.
The latter starts its isolated test profile with 2,000 scrap; it never modifies
the user's browser profile.

Hold either 3D arrow button on the front pillar's physical control panel to raise or lower
the bed through its 0–1.2 m travel. The 2.85 × 3.90 m grated bed docks flush with
the floor in a concrete service pit, leaving a clear route to the freight door.
The pillar baseplates stand entirely on the surrounding slab. Releasing the
pointer or key, losing focus, or hiding
the page stops it. Service operations move to their required height, then restore
the player's chosen height. Hover or keyboard focus highlights the physical
button with the same contrasting outline used for tank selection. Invisible
native button targets preserve keyboard and assistive-technology access without
painting an overlay over the control panel. Its cable routes around the baseplate
into a sealed floor conduit.
The bed rides on two parallel scissor linkages with fixed 2.1 m links, bored
bearings and shared pins. Separate guide rollers follow the rails at the sliding
ends; synchronized trapezoidal lead screws drive the lower carriage through
bronze nuts. The mechanism changes angle without stretching its links.

## Mechanisms

`mechanics.ts` drives an interruptible service timeline. The original component
is gripped, extracted, placed on a return trolley, and replaced from a delivery
trolley. Hull/turret dependents use overhead supports; running gear servicing
suspends the hull above its mounting. The lift, fasteners, clamp, wrist tool, and piston linkages follow the
timeline. The arm has five articulated degrees of freedom with analytical IK.
Its compact tool uses three sprung magnetic shoes aligned to actual part surfaces,
short fingers for narrow stems, and a retractable two-track pickup fixture. Shoes,
overhead magnetic lifting shoes, pistons and trolley contact are checked against the rendered meshes.
Crane shoes select exposed top patches with a supported footprint and a clear
access corridor; vertical suspension cables hang from adjustable overhead outriggers.
Their housings and cables are swept against the complete posed tank geometry,
including instanced running gear. This keeps suspension clear of fenders and occupied mounting interfaces.
Routine fits take 3.1 seconds and structural fits 3.8 seconds. Cancellation
reverses the service sequence; rapid requests retain only the latest queued fit.
Changing builds or disposing the scene aborts pending work without saving it.
Quick installation and either the saved or OS reduced-motion preference seat
components immediately and suppress ambient particle motion.

The workshop and skirmishes share the original "Copper Circuit" score and the
same `src/audio/electro-music.ts` synthesizer: a 96 BPM electro groove with a
recognizable two-bar hook, four-bar answer, syncopated bass, stereo delay and
sixteen-bar arrangement. The workshop uses restrained percussion; skirmish
intensity opens the synth filters and adds rhythmic drive without restarting
the phrase. WebAudio synthesis adds no media download. The existing Master, Music and Effects settings
control independent buses. Spatial fan, boiler and compressor beds sit beneath
continuous lift/arm/trolley motors driven by actual movement; release, clamp,
ratchet and seating transients follow the servicing timeline. Room ownership
suspends the match soundscape, visibility pauses audio, and disposal releases all
voices, nodes and listeners before restoring the game's audio context. Steam
hisses use camera-relative stereo positioning, distance attenuation and a
750–2100 Hz low-pass filter to keep them beneath the machinery and music.

## Room and asset sources

Run `scripts/blender/build-workshop.py` with Blender 5.2 in background mode to
rebuild the room, then `scripts/blender/render-workshop-probe.py` for its reflection
probe. Package the output with `scripts/workshop/pack-workshop-textures.py
--compact --remove-originals` and `node node_modules/tsx/dist/cli.mjs
scripts/workshop/pack-geometry.ts` (the archived full-detail package), then ship it with
`node node_modules/tsx/dist/cli.mjs scripts/workshop/pack-compact.ts`.

### Shipping package and load time

`pack-compact.ts` (Node only: sharp and meshoptimizer) rebuilds `public/workshop`
from `assets/workshop/runtime-source` and `texture-source`, which stay untouched.
Identical vertices are welded; props and the fan lose triangles within 8 mm and other
architecture within 4 mm (props may collapse across UV seams within that error); brick
courses are only welded. No vertex moves, and the packer fails if reordering changes any
triangle. Prop colour ships at 1K, packed normals at 512 (p95 ≈ 2.2°), ORM at 256,
surface and gauge maps at 512, and the RGBM probe at 128 per face, filtered in linear
radiance. Geometry and image filenames carry content hashes, and the manifest
names every runtime asset. The package is approximately 7.68 MB (7.32 MiB), 399k triangles,
and 60 MB of workshop textures on the GPU. The
[compact package report](../../../assets/workshop/runtime-source/compact-package-report.json)
records per-file errors and sizes.

The title prefetches the package at low priority once idle, or immediately when Workshop
is hovered or focused (Save-Data waits for that intent); `assets.ts` shares those
downloads with the loaders. Downloads and image/geometry decoding overlap `Engine.create`,
and the texture and probe uploads run together. Once the battle renderer has finished
compiling, the title also compiles the next workshop renderer on a detached canvas
(immediately when Workshop is hovered or focused); the scene adopts it, so entry skips
pipeline compilation. Starting a match frees a prepared renderer nobody adopted. `main.ts` must not top-level-await the
planet renderer: the lazily imported scene chunk depends on the entry chunk and would wait
for the whole warm-up. `scripts/workshop/measure-load.ts` times click-to-ready on a
production build with optional network and CPU throttling. The editable source is
`assets/workshop/workshop.blend`. The Blender script and manifest document world
coordinates, original texture layers, steam outlet, and lighting occluders.
`lamps.ts` owns the articulated runtime luminaires: nested link plates and shared
elbow pins, external head bearings, recessed optics and guarded wall fixtures.
The former static lamps are omitted from the Blender export. Bay links keep
their lengths and follow the lift; their spotlights share the optical transforms.
The atlas, references, visual target, prompts, Meshy source GLBs, and generation
receipts live under `assets/workshop`. Seven Meshy 7.1 jobs used 245 credits:
the boiler, lathe, tool cabinet, ordnance cart, fan rotor, compressor, and parts crate.
Repeated cabinets and crates share their original texture layers.
The optional `scripts/workshop/meshy-assets.mjs` generation helper reads
`MESHY_API_KEY` from the process environment (or Node's `--env-file` option).
It has no dependency on another checkout and retains receipts to prevent
duplicate paid submissions. Rebuilding the saved assets needs no API access.

### Archived full-detail package

The archived full-detail package retains all original prop triangles and UV seams.
Its version 2 meshes quantize positions to 16 bits within each mesh's bounds, encode unit normals
octahedrally, preserve material attributes and triangle order, and gzip the binary
payload. The engine decodes them through its existing mesh contract. Native
streaming decompression is bounded and abortable. That 545,910-triangle
room takes 8.09 MB of geometry instead of 64.08 MB, with a measured maximum
position error of 0.271 mm and normal error below 0.018 degrees. Source buffers,
readable manifests and the measurement report remain in `runtime-source`.

The full-detail PBR maps use 2K colour/normal and 1K ORM WebP images. Colour reduction
uses linear light, normals are renormalized, and roughness reduction averages
variance. Normal XY channels are packed as separate grayscale regions to avoid
WebP chroma cross-talk, with an exact sign channel. A one-time GPU unpack restores
the normal array before mip filtering. Quality 94 gives measured p95 angular
error below 1.89 degrees across all seven maps; the ordinary RGB lossy codec was
rejected. ORM values use six-bit scalar quantization (maximum error .007844) and
lossless WebP. Architectural maps use quality 94, the gauge quality 96, colour
atlases quality 90, and RGBM probe values remain byte-exact. The complete original maps remain in
`assets/workshop/texture-source`, and the Blender source links there. Runtime
image decoding uses a bounded worker pool and releases decoded bitmaps after
upload. Vite minifies JavaScript and CSS, and the runtime manifest is compact JSON.
The full-detail package described here is approximately 39.8 MB versus
330 MB of original runtime assets; source receipts record per-map codec error.
The compact package above is the current shipping version and applies further
mesh simplification and texture reduction to these sources.

### Room details

The machinist's stool has a coarse screw spindle, captive bronze nut and locking
lever, a positive seat shoulder, three splayed legs, floor pads and a joined
footrest. Its seat is supported by the spindle rather than an ornamental spring.

Separate compact authored maps supply fired-clay brick, old concrete, vault
masonry, military-green enamel and aged brass. Materials 15–19 add filtered
surface relief and varying roughness; painted mechanisms retain their texture
coordinates while moving. Workshop track contact pads use rubber; their remaining
steel uses a rough oxidized surface. Original gameplay tank materials are unaffected.
TAA and workshop-only specular filtering suppress unresolved highlight shimmer.
The grating's metallic finish is retained; its bearing bars, recessed transverse
ties, divider and rim have no overlapping visible top faces.

## Interior lighting limits

Planetary sun, moon, atmosphere, fluids, and GI are excluded. Local lamps shade
the room; authored solid bounds occlude walls, vault, and large equipment.
Tank and robot SDF bricks provide moving soft shadows, and screen-space contact
AO adds local grounding. Ambient bounce is artist-authored rather than a full
interior GI solve. Fine static props do not each cast mesh-accurate shadows.
The actual room is captured into a six-face RGBM32 HDR probe, decoded to half
float and GGX-prefiltered for roughness. Box projection grounds barrel, paint and
metal reflections in the workshop. It is a static environment probe: moving
tanks, arms and installation parts do not dynamically reflect one another.
Fog and wall-occluded lamp samples provide restrained aerial perspective.
The rear fan has an open wall aperture and duct. A local light behind its rotating
blades casts dusty shafts through that opening; the blade shadow mask is analytic,
while the visible rotor is the original generated mesh. Front overhead lamps
provide soft fill to keep tank materials readable. Architecture still blocks them.

The pressure gauge uses a separate, fitted ivory dial image and a geometric
needle, leaving the boiler's original atlases untouched. Its reading follows the
steam regulator's release cycle and responds to lift demand. Reduced motion
holds the gauge and fan still.

Short pressure plumes originate at the boiler vent, physical bleed fittings on two
copper header collars and the robot's pneumatic exhaust. Their hisses share the
same emission event. Expanding, advected billboards use animated turbulent density
and scene-depth fading to avoid hard intersection slices. They are bounded visual
effects rather than a full fluid simulation, and are suppressed by reduced motion.

## Verification

`node node_modules/tsx/dist/cli.mjs scripts/workshop/verify.ts` starts isolated
Chromium with WebGPU and tests the catalogue, five categories, budget/socket
enforcement, exact picking, camera controls, installation/cancellation, rapid
changes, three builds, persistence, reduced motion, exit, and the actual match
loadout. It also validates browser shaders, captures inspection angles, and
records installation video under `artifacts/workshop` by default.

Use the normal TypeScript, Vitest, shader/Naga, and Vite production checks too.
`window.__tmtWorkshop` provides read-only state, camera/component projections,
shader checking, and resource diagnostics for browser verification.

Desktop acceptance uses Chromium with an NVIDIA RTX 3080. Phone viewport checks
verify layout and touch behavior; they are not certification on a mobile GPU.
The detailed room is GPU-heavy; inspect frame timings and the resource ledger
for the chosen viewport and graphics tier rather than treating desktop results
as a mobile performance guarantee. Rare, uncached crane contact searches can
also cause a first-use CPU pause; their results are cached.

The workshop scene and gameplay renderer load lazily. Run `npm run verify:bundle`
to check both startup dependency graphs against the tracked budgets after packaging
changes. Historical interface proposals are background, not current assignments.
