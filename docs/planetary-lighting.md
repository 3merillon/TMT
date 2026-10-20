# Planetary lighting

The exterior renderer combines planet-scale clouds and their surface shadows, shadowed world-space haze and source-dependent post-process optics. These are presentation systems; [runtime architecture](architecture.md#rendering) describes ownership and quality boundaries. The workshop uses its separate interior lighting path.

## Recorded terrain-shadow diagnosis — 14 October 2026

The reported sharp triangular patches were reproduced before changing the renderer, in the actual seed-7 temperate Drive test. The saved case uses High/native rendering at 1600×1000, solar time 42 seconds, camera height 3/back 7, and azimuths 3.14 and 4.71. Grass is disabled to expose the receiver. Exact camera vectors, sun, settings and state accompany every screenshot in `artifacts/planetary-lighting/diagnosis-before/seed7-failing.json`; `scripts/capture-plans/planetary-shadow-diagnosis.json` reproduces the diagnostic sequence. A second time, 60 seconds, checks another low-sun angle.

The composed **Sun-shadow** view contains the triangles. They remain with **Sun shadows** disabled (the SDF contribution), but disappear with **Contact shadow** disabled. The **SDF-sun**, **SDF**, geometric-normal and direct-light views separate the active SDF path from the screen-space contribution. This was not a shadow-map resolution defect.

`contact_shadow` interpreted a depth sample on the receiver's own sloping triangle as the front of an occluding depth column. Smooth terrain normals can face the sun while that geometric face grazes it, making this error look like polygon-level acne. The fix reconstructs the sampled world position with the same jittered inverse projection as the receiver and rejects samples at or below its geometric tangent plane, using the existing contact tolerance. A sample must protrude above that plane before the existing ray/depth-thickness test can darken the receiver.

The repair preserved material relief, geometric terminators, SDF escape behavior, the 0.25-unit terrain lift and 128/160/256/256 SDF sizes. In the current renderer, screen-space contact shadows are used before the planet SDF becomes valid; the SDF and caster path owns normal world visibility afterward.

Local-only matched evidence (not included in the repository):

- `planetary-lighting/diagnosis-before/seed7-failing-3-14-Sun-shadow.png` → `planetary-lighting/shadow-fix/seed7-failing-3-14-Sun-shadow.png`.
- `planetary-lighting/diagnosis-before/seed7-failing-4-71-final.png` → `planetary-lighting/shadow-fix/seed7-failing-4-71-final.png`.
- `planetary-lighting/shadow-fix/contact-comparison.json`: strongly darkened pixels fall from 53.733% to 0.0044% on the ridge, and 30.229% to 0.1439% on the left slope. Mean positive contact-related sRGB darkening falls by 97.62% and 99.33%. Sun directions match exactly; maximum recorded camera delta is 0.000088 units.

The regression requires a nontrivial failing baseline (>5% strongly darkened pixels), then <1% strongly darkened pixels and <0.01 mean positive darkening in each fixed bare-terrain region. These are image-difference measurements with exposure/TAA, not physical visibility errors. They deliberately exclude tanks and buildings; contact grounding and shadow operation need the separate unchanged lighting checks and visual inspection. A shallow legitimate protrusion below the existing contact tolerance can be rejected; SDF/caster bulk shadows still operate. This is not a universal artifact-freedom claim.

```powershell
node node_modules/tsx/dist/cli.mjs scripts/capture.ts --plan planetary-shadow-diagnosis --strict --out artifacts/planetary-lighting/diagnosis-repeat
node node_modules/tsx/dist/cli.mjs scripts/check-terrain-shadow-comparison.ts artifacts/planetary-lighting/diagnosis-before artifacts/planetary-lighting/shadow-fix
```

## Clouds and weather

The cloud shell/profile, noise and atmosphere integration designs were adapted from the same author's Planets renderer. Source headers retain that provenance.

TMT uses miniature-unit spherical decks, a 64³ periodic noise texture with Worley billows, broad empty weather regions, varied tower heights and a thin upper layer. Temperate has fuller neutral cumulus; glacial has thinner cool layered clouds; dune has sparse higher warm clouds; volcanic has subdued ash-colored forms. A deterministic prevailing wind rotates the density field around the planet, with no cube-face or longitude seam. View marching has sun self-shadow, forward scattering, powder response, atmospheric sun color, multiple-scattering fill and aerial perspective.

Cloud color, depth metadata and history render at full internal resolution on every tier. At native scale this is display resolution. Each ray clips against that exact pixel's scene depth, and compositing loads the same pixel without low-resolution upscaling. Reprojection follows the previous wind rotation, rejects geometry/cloud-depth and opacity disagreement, and clamps history to the current neighborhood. Resize, tier/preset changes, scene changes, terrain commits, feature toggles and camera snaps invalidate relevant history.

The separate world-anchored cube stores cloud transmittance along sun rays over the whole sphere. The real deferred direct-sun path samples it, including the water material path; moon and local light colors are not multiplied by a sun-cloud shadow. Minimum-limit adapters fall back to the existing 16-sampled-texture lighting variant, omitting GI, AO and **surface cloud shadows**. Cloud rendering and haze retain their own bounded passes.

Clouds use smoothly bounded local optical depth inside a 3D region around the focus to preserve play visibility. Sky and geometry rays use the same treatment. Scene depth clips foreground clouds without a low-resolution background-depth veto; live terrain SDF visibility allows light through excavated sections.

The current cloud memory is a persistent field in the wind-advected frame (`src/engine/passes/clouds/field.ts`).
Each texel stores a departure vector and log-density change. A semi-Lagrangian step integrates gas-solver velocity,
blast pressure, turbulence and heat-driven thinning. Disturbed clouds remain displaced after the original gas domain
expires, drift with the weather, and relax with a 120-second healing time constant. This is one-way presentation
coupling: clouds do not feed momentum, combustion or condensation back into gameplay or the gas solver.

Field resolution is 72³/96³/112³/128³ by tier. Updates touch only the active forcing box; undisturbed rays retain
a calm path. Up to eight impacts and four merged damaged-region spheres bound the work. Displacement is clamped to
two world units, with 1.5 units of shell padding and at most 40% additional march steps on affected rays. Reset,
planet changes and field reallocation clear the stored disturbance. Local play-visibility protection is smoothly
relaxed inside strongly displaced cloud; undisturbed weather retains its usual treatment.

Clouds also scatter actual point and spot lights from the existing 64-light pool. Range/cone admission selects at most 2/2/3/4 sources per ray by tier. Their range, color, intensity, world/caster occlusion, fog visibility and cloud self-extinction determine the result. The original impact flash still supplies the initial impulse. A separate GPU reduction samples the live gas temperature field on a 16³ grid, using the shared flame response to derive a persistent burning-gas light with its luminous centroid, color and power. That source follows the hot gas and fades with its measured emission, rather than expiring on the flash timer. Each live non-steam blast reserves one existing pool slot; reset, eviction and scene disposal release it. Field and light-reduction resources are bounded and preallocated by tier; their ownership is released with the scene.

Explosion and muzzle smoke now receive live terrain/caster/cloud sunlight visibility, altitude-dependent sky illumination and at most two shadowed local lights per sample. The old unconditional sun brightness and sun-derived ambient floor made cooled smoke white even on the night side. Heat remains independently emissive. Smoke illumination is reused over at most four ray samples or 0.2 world units; the ambient sky still uses the reference atmospheric LUT. Gas emission is approximated by one point source per domain, rather than an extended volumetric emitter.

| Tier | View / sun samples | Shadow cube face | Shadow samples |
| --- | ---: | ---: | ---: |
| Low | 20 / 2 | 48² | 12 |
| Medium | 28 / 3 | 48² | 16 |
| High | 40 / 4 | 64² | 20 |
| Ultra | 64 / 5 | 96² | 28 |

Local-only actual-game capture filenames include `cloud-kinds/temperate-overview-end.png`, `cloud-overviews/glacial-overview-end.png`, `cloud-overviews/volcanic-overview-end.png` and `cloud-kinds/dune-day-end.png`, under the original `artifacts/planetary-lighting/` layout. These files are not included in the public source tree.

## Haze and optics

The new quarter-resolution haze integrates current-frame scattering up to scene depth through an exponentially layered near-ground medium. Sun visibility uses the world SDF, dynamic tank bricks and cloud transmittance. Local scattering selects the strongest ray-overlapping lights from the existing 64-light pool, then applies their real range, inverse-square falloff, cone angles, color and mounts. World and tank traces occlude each lit air sample; exhausted world traces conservatively return dark. Fog-of-war checks suppress unseen emitters and hidden portions of beams. Low/Medium/High/Ultra use 12/16/20/28 view samples and at most 2/4/6/8 local lights per ray.

Depth-aware reconstruction avoids borrowing a beam across a tank silhouette. There is no private persistent haze history; shared TAA receives the current HDR result, and setting changes invalidate it. The workshop continues to use its own specialized interior haze and fixture shafts. Planetary cloud/haze resources are omitted there.

The close-headlight follow-up exposed bands from uniform sampling across the entire atmosphere chord: a narrow beam could receive only one or two samples, and background depth moved that sampling pattern. Local scattering now clips each source's range sphere and forward cone to scene depth, then uses equiangular samples concentrated near the emitter (8/9/12/16 by tier). Sunlight and extinction retain their original counts; an interpolated optical-depth prefix attenuates local light. Power, cone, range, visibility checks and quarter-resolution targets are unchanged. Numerical regressions include 72,000 cone-membership comparisons, parallel/tangent/inside/backwards cases, background-independent sample positions and integration against a dense reference. Matched 180-frame recordings in `headlight-banding-before-valid` and `headlight-banding-after` show the terraces removed, with zero browser/GPU errors.

The mounted headlights initially disappeared in their own coarse caster brick. Its conservative half-voxel-diagonal triangle skin enclosed the real emitter despite the visible lens being outside the hull. Lights now carry their exact mounting caster ID. Only that caster's initial connected skin can be escaped, within 0.3 units and a voxel-scaled bound; another caster, deep embedding, failure to exit, and re-entry remain opaque. Surface and volume lights share this rule. The GPU fixtures and actual mounted-light probes cover clear, wrong-owner, foreign-occluder, buried and re-entry rays.

Excavated air is supported below the original surface datum. Near-ground haze no longer fades out merely because its radius is below the nominal surface. The atmosphere's continuous radial density profile extends into exposed depths, with actual depth and SDF air/rock support replacing the old fixed inner core and intact-sphere sunlight occlusion in world-space integration. Atmospheric reference LUTs and ambient/reflection lighting remain analytic approximations. The weather datum and atmospheric gas do not instantly disappear when rock is removed; this pass does not simulate gravitational gas escape or changing planetary mass.

Optical visibility is measured from the actual resolved HDR scene and jitter-corrected depth. The sun requires a visible disc; there is no original-radius horizon veto that would hide a disc exposed through destroyed terrain. A local flare requires an active spot facing the eye and a bright visible emitter. Local image-background subtraction prevents a bright foreground cloud from masquerading as a lamp. Screen-edge and angular fades, bounded intensity, and sparse ghosts/halos/streaks keep the effect restrained. Optics are added after TAA, before tone mapping, so flare cannot feed its own history.

**Sun rays** is a separate optional 12-tap screen-space radial effect. It complements the world-space shadowed haze; it is not itself volumetric sunlight. Haze is an artistic near-ground medium layered over the existing atmosphere LUT, not a unified multiple-scattering atmosphere solution. Cloud shadows remain a soft low-resolution cube approximation. Haze remains quarter-resolution and can lose small detail at thin silhouettes; cloud view rendering is full-resolution.

## Controls and qualification

Graphics settings expose **Clouds**, **Light in haze**, **Sun rays** and **Lens flare**, independently. Old saved profiles receive defaults; explicit opt-outs persist. The development panel additionally isolates cloud shadows, sun haze and local haze. Normal driving/aiming bindings remain WASD, left-click/drag aim, right-drag camera, wheel trim while aiming/zoom otherwise, and Space fire.

[Development validation](development.md#validation) describes browser tooling and evidence requirements.
Preserve source hashes, camera/settings, warmup, raw samples and workload when comparing revisions. GPU allocation
ledger totals measure tracked resources, not driver VRAM. Screenshots, videos and raw reports belong in ignored
artifacts or external working storage; none of the local report names below are public download links.

The shader packer preserves WGSL token/interpolation boundaries and diagnostic newlines while removing redundant
whitespace/comments and compressing repeated tokens. Static fragments expand once during module initialization.
The recorded 230-fragment Node diagnostic measured 1.22 ms median / 2.08 ms p95 decode over 100 trials
(`wgsl-packing-cpu.json`); this is a historical CPU diagnostic, not browser startup timing.

At the 14 October lighting checkpoint, recorded ground-aim verification passed 19 checks, tank/workshop acceptance
12 groups and headlight acceptance eight groups with zero browser errors. The final focused cloud/gas/volume/shader
follow-up passed 69 tests in seven files; three `cloud-flow-final` scenes completed with zero errors. These are
dated checkpoint results, not a fresh check of later renderer or native-runtime revisions.

Recorded thermal probes sampled the gas light at 1, 2 and 4 seconds after a nuclear impact, after the initial flash.
The luminous centroid rose with the field; emission was zero at eight seconds and the slot was released after expiry.
Paired ordinary-blast captures showed dark cooled smoke at midnight and pale smoke at noon. The low-power upward
spotlight/cloud fixture remained inconclusive (at most one 8-bit level), so it did not establish a strong visible
spot-through-cloud effect. Mounted near-ground headlight haze was demonstrated separately.

The recorded optical probes reported sun visibility about 1 when clear, 0.40 when partly hidden and 0 behind terrain.
Facing lamps produced about 0.733 optical strength and vanished from that buffer when disabled or viewed sideways.
Evolving histories prevented those screenshots from being pixel-parity evidence. A cleared-crater fixture placed an
air camera below the original radius, but frozen physics and a sky-heavy frame did not qualify tank support.

The original provisional lighting repeat passed grounding/acne/shimmer/commit probes but failed terminator ratios
and several timing gates. Later repeats during live source edits were invalid as aggregate timing evidence.
[The dated performance comparison](performance-pass.md) distinguishes inherited failures from measured changes;
[release readiness](release-readiness.md) records the current checks and remaining device/performance limits.
