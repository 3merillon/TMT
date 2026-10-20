# `src/engine` — WebGPU renderer and scene systems

This is TMT's modular WebGPU renderer. `Engine.create` installs the frame graph and core rendering systems; callers add renderer modules and scene modules through `EngineOptions.modules`. The engine code does not import `src/game`. Its mesh, light, frame, and render-module contracts are useful beyond the game, while planetary terrain, fluids, weather, and campaign behavior remain TMT-specific systems.

For the wider runtime boundaries and ownership model, see [the architecture guide](../../docs/architecture.md).

## Frame

`Engine.frame(FrameInput)` updates the camera and `FrameState`, executes the declared frame graph, and submits one command buffer. It resolves timestamps and flushes the uniform ring before submission; afterward it maps queued readbacks, advances deferred GPU destruction with `ctx.tick()`, and emits `frameEnd`.

The core installed by `Engine.create` includes the G-buffer, planet SDF where applicable, fog of war, dynamic SDF caster bricks, SDF ambient occlusion, diffuse GI probes, part meshes, lights, deferred lighting, fluids, forward rendering, composite, shockwaves, and debug views/statistics. Planet-only systems are omitted for an interior environment. Additional factories are installed in the supplied order; the game currently passes `RENDER_MODULES` and then its scene modules.

| Factory or core system | Current responsibility |
|---|---|
| Core G-buffer and part meshes | Opaque/foliage geometry, material data, velocity, and mesh-backed casters |
| Planet and atmosphere modules | SDF, SDF AO, tier-limited GI, atmosphere, sky light, map shadows, vegetation, clouds, cloud shadows, and volumetrics |
| Fluids and forward systems | Exterior water and spray/gas effects, transparent draws, and shockwaves |
| Scene modules | Planet terrain, surface memory, overlays, and debug lines |
| Interior environment | Cartesian room lighting and materials; planet SDF, GI probes, and fluids are omitted |

The core install order and the optional factories are defined in [`engine.ts`](./engine.ts), [`modules.ts`](./modules.ts), and [`scene/index.ts`](./scene/index.ts). Pass order is determined by each pass's frame-graph slot and order, not by a static wave list.

## Conventions

- TMT units, planet centre at the origin, up = `normalize(p)`. Matrices: `Float32Array(16)`, column-major.
- Depth: `depth32float`, reversed-Z, clear 0, compare `greater`; `linear_depth(d) = near / d` with `near = proj[3][2]`.
  Shadow maps follow `SHADOW_DEPTH` (reversed-Z too; caster depth bias is negative).
- `@group(0) @binding(0)` is always `FrameUniforms` (512 B, `wgsl/common/frame.wgsl.ts`) through `ctx.layouts.frame`. The G-buffer
  pass binds it before every drawer, so drawers use groups 1–3. `viewport` = (internal w, h, display w, h).
- G-buffer encoding: `wgsl/common/gbuffer.wgsl.ts` — write with `gbuffer_pack(SurfaceSample, velocity)` and
  pipelines built with `GBUFFER_COLOR_TARGETS` / `GBUFFER_DEPTH_STENCIL`; read with `gbuffer_unpack`. TS mirror in the same file.
- Every GPU resource is freed with `ctx.deferDestroy`. Label resources `<category>:<name>`: the VRAM ledger reports by category.
- Pipelines: `ctx.pipelines.register(key, kind, build)` + `compile(key)` (async, de-duplicated, compile ms, `module:line` errors from
  the link line map); `get(key)` returns undefined while compiling — skip the draw that frame.
- Bind groups: `BindGroupResourceCache` keyed on the FULL resolved resource list (placeholders included).
- Timestamps: spread `c.timestampWrites(name)` into every pass descriptor, or the pass is silently untimed.

## Writing a module

```ts
export function myModule(): RenderModule {
  return { name: 'my-module', install(s) {
    s.graph.declareTexture('myTarget', { format: 'rgba16float', size: 'half', usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING });
    s.graph.addPass({ name: 'my-pass', slot: 'post.bloom', reads: ['hdr'], writes: ['myTarget'], run(c) { /* c.resources.view('hdr') … */ } });
  } };
}
```

- Declare every resource a pass touches in `reads`/`writes`; in dev the graph throws on read-before-write, on undeclared access and
  on undeclared history reads (`history:<name>` in `reads`, texture declared with `history: true`).
- Transient textures with disjoint lifetimes are aliased: the first writer in a frame must clear or fully overwrite.
- WGSL: `wgsl('name', [deps])\`...\`` or `makeModule`; `link(...)`; generate constants mirrored from TS with `tsConst`, uniform
  blocks with `wgslStruct` (layout + WGSL + packer from one field list). Add full shaders to `wgsl/naga-exports.ts`.
- Reserved bindings (`RESERVED_BINDING_LAYOUT` in `contracts.ts`): `s.bindings.provide(name, resources)`; consumers bind
  `s.bindings.get(name)` (1×1 placeholders until provided). The lighting pass binds all of them in `@group(2)`.

## Part meshes (tanks, props, sandbox geometry)

`scene.meshes.create(desc)` takes a `PartMesh` directly (vertex pulling from slice-arena storage; `attrs` = edge | ao | matId |
flags, low → high byte; `instances` = row-major 3×4 sub-part transforms). `scene.instances.add/set/remove` — prevModel is copied
automatically at the start of every frame (velocity). Material by matId: `materials/part-basic.wgsl.ts`. All instances with
`castShadow !== false` are drawn by the dynamic `ShadowCaster` `part-mesh`.

`MeshDesc.paintTexture` optionally supplies an RGBA atlas and one UV pair per
vertex. The part pass owns its `rgba8unorm-srgb` GPU texture, filtering sampler
and one additional mip level, and releases the texture through deferred GPU
destruction with the mesh. RGB stores sRGB-encoded premultiplied linear color;
alpha stores coverage. Mip generation filters decoded linear color and coverage.
The caller owns chart gutters and UV continuity; the engine validates dimensions,
RGBA byte count and UV stream length. The packed mesh header reserves word 11
for the UV stream offset (zero means no paint). Part-local material coordinates
remain independent. Paint uses one filtered texture sample before wear and damage
marks, with a shared transparent fallback for meshes without an atlas. This
contract contains no game-specific brush or save logic.

## Enclosed interiors

`Engine.create({ canvas, environment: 'interior', modules: [] })` opts into a Cartesian Y-up room. The default remains the
planet renderer. The room uses the same part meshes, G-buffer, GGX materials, local lights, caster bricks and post chain.
It does not allocate the planet SDF, planet GI probes or fluids. The shared war-fog binding is an inactive 1³ placeholder.
Use `scene.get('interior')` to set room indirect irradiance, background, light haze and at most 32 solid AABB occluders
(`scene/interior.ts`). All local lights respect these solids, whether or not their dynamic-shadow flag is enabled.
Ceilings, floors and walls must have matching occluders; the shader cannot infer architectural solids from mesh instances.
Large props may also use occluders. Use SDF caster bricks for moving tank groups and finely shaped silhouettes.

The interior shader branches before the planetary sun/moon, radial-up, sky IBL, probe GI, aerial atmosphere and visibility
fog. Room indirect light is an authored low-energy approximation, not baked or traced GI. Local lamp shadows combine exact
room segment tests with the existing soft caster-brick trace. Screen-space contact AO affects ambient terms only. Spotlights
among the first four local lights have restrained, wall-occluded volumetrics. A Y-up `CameraRig` uses the existing reversed-Z
camera unchanged. Do not install `RENDER_MODULES` (planet atmosphere, sun shadows, sky and vegetation) for a room.

Imported workshop material IDs 9–12 are stone, aged iron, aged brass and copper. They interpret `MeshDesc.partLocal` as
linear RGB vertex albedo, multiplied by the instance tint. This supports generated-image albedo baked onto CAD geometry
without adding texture bindings. Existing material IDs 0–8 retain their original stream semantics. `GBUFFER_FLAG.SELECTED`
adds a restrained amber edge and grazing-angle highlight in interior lighting only.

Material ID 13 retains original authored UV/PBR assets. `partLocal` stores `(u, 1-v, arrayLayer)` and
`loadWorkshopTextures(services, manifest.textures)` installs a dedicated `workshopTextures` scene facet. Source base-colour,
normal and glTF metallicRoughness images keep their packaged dimensions without runtime resampling; packed normals are
decoded during upload. The GPU uses an sRGB albedo array and
linear normal/roughness/metallic arrays, with mip levels filtered in the correct colour space. The derivative tangent frame
accounts for the flipped V coordinate; metallicRoughness red is unspecified and does not contribute AO. Material IDs 0–12
and the exterior terrain bindings keep their existing meaning. Dispose the returned texture owner before the engine.

Material IDs 15–17 are rough clay, cold concrete and matte limestone. Pass
`surfaces: WORKSHOP_SURFACE_TEXTURES` to the texture loader to upload five compact, separately authored seamless
maps as one small array, independent of the full-resolution prop maps. Architecture samples world-space triplanar
coordinates at physical scale; `partLocal` carries a near-white per-block tint. Central differences of the authored
surface detail perturb the normal through a projected surface gradient, with mip-aware footprints to limit shimmer.
These mineral materials have zero metalness and roughness at least 0.9.

IDs 18–19 use the final two layers for worn military paint and aged brass on workshop fixtures. Their albedo is
authoritative and ignores legacy instance tint. They project in scaled local rest coordinates, so wear travels with
articulated parts. Roughness, exposed metal chips and bump follow the bitmap detail. The production tank's material
IDs 0 and 4 retain their existing appearance. Asset dimensions come from the package; the shipping workshop uses five
512-square surface maps. See the [workshop package contract](../game/workshop/README.md#shipping-package-and-load-time)
for current download and GPU sizes.

`loadWorkshopReflection` installs a static reflection capture of the authored workshop at `[0, 1.7, 0]` into the
otherwise unused reserved cube and DFG slots. The six matching square RGBM32 faces decode into linear half-float before
the existing GGX importance-sampled prefilter and split-sum DFG integration. Interior lighting uses a bounded room
box for parallax correction and samples the roughness mip directly, without planetary rotation, sky or exposure.
The probe owns its GPU textures and must be disposed before the engine. It reflects the static room, not moving
tanks or robot links; one central probe is an approximation near occluding props and the curved vault. The shipping
workshop supplies 128-square faces; the loader derives resolution and mip count from the supplied images.

Material ID 14 is a flat printed instrument face: `partLocal.xy` holds UV with V down. The optional
`gaugeFace` loader filename uploads a separate sRGB 2D image at its original dimensions, with its own mip chain;
it does not consume another full PBR array layer. A fitted dial disc and animated geometric needle can cover the
source gauge face without modifying any original prop atlas or inheriting its baked needle normal.

Room owners remove instances, meshes, local lights and their transparent drawers before disposing the engine. Drawer-owned
buffers use `ctx.deferDestroy`; failed `Engine.create` initialization also disposes the partial engine and its GPU device.

## Sandbox and debug

`engine-sandbox.html?scene=<name>&gbuffer=<none|albedo|normal|geonormal|material|ids|velocity|depth>&tier=high&camera=<preset>&spin=<rad/s>`
loads `sandbox/<name>-scene.ts` (default-export a `SceneFactory`; add new scene files next to `test-scene.ts`, no edit to `main.ts`).
`window.__tmtEngineSandbox`: `ready`, `engine`, `telemetry()`, `imageStats(rect?)`, `setCamera(name)`, `setGBufferView(v)`,
`setSize(w, h)` / `resetSize()`, `shaderCheck()`, `lostEvents`, `frames`.
