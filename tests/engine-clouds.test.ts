import { describe, expect, it } from 'vitest';
import { GAS_PRESETS, GAS_DOMAIN_PER_RADIUS } from '../src/engine/passes/fluids/gas';
import type { EngineServices, FrameState, PassContext, PassDecl, PlanetDesc, Vec3 } from '../src/engine/contracts';
import { CLOUD_FIELD, cloudFieldImpactLife, cloudFieldImpactReach } from '../src/engine/passes/clouds/field';
import { quatAxisAngle, quatMul, quatRotate } from '../src/engine/scene/wind';
import { cloudsModule, cloudShaders, CLOUD_COLOR, CLOUD_META, type CloudsFacet } from '../src/engine/passes/clouds/clouds';
import { CLOUD_PARAMS, CLOUD_PARAMS_BYTES, CLOUD_PRESETS, CLOUD_VISIBILITY, cloudLocalProtection, cloudHistoryValid, cloudImpactProfile, cloudShadowLookup, cloudShellIntervals, packCloudParams } from '../src/engine/passes/clouds/params';

function frame(overrides: Partial<FrameState> = {}): FrameState {
  const m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return { index: 1, time: 100, dt: 1 / 60, tier: 'high', internal: [1280, 720], display: [1280, 720], view: m, proj: m, viewProj: m, invViewProj: m, prevViewProj: m, viewProjNoJitter: m,
    eye: [0, 28, 16], jitter: [0, 0], sunDir: [0, 1, 0], focus: { world: [0, 18, 0], tilt: 0, distance: 17 }, ...overrides };
}
const planet: PlanetDesc = { radius: 18, seed: 1234, kind: 'temperate' };
const controls = { enabled: true, shadows: true, coverage: 1, density: 1 };
const field = (bytes: ArrayBuffer, name: string) => Array.from(new Float32Array(bytes, CLOUD_PARAMS.fields.find(f => f.name === name)!.offset, 4));

describe('miniature planet cloud chords', () => {
  it('keeps both near and far chords and clips to scene depth before the far band', () => {
    expect(cloudShellIntervals([0, 0, 30], [0, 0, -1], 21, 24)).toEqual([[6, 9], [51, 54]]);
    expect(cloudShellIntervals([0, 0, 30], [0, 0, -1], 21, 24, 12)).toEqual([[6, 9]]);
    expect(cloudShellIntervals([0, 0, 30], [0, 0, -1], 21, 24, 7)).toEqual([[6, 7]]);
    expect(cloudShellIntervals([0, 0, 30], [0, 0, -1], 21, 24, 5)).toEqual([]);
  });
  it('handles observers below, inside and above the cloud deck without negative marches', () => {
    expect(cloudShellIntervals([0, 0, 18], [0, 0, 1], 21, 24)).toEqual([[3, 6]]);
    expect(cloudShellIntervals([0, 0, 22], [0, 0, 1], 21, 24)).toEqual([[0, 2]]);
    expect(cloudShellIntervals([0, 0, 24], [0, 0, 1], 21, 24)).toEqual([]);
    expect(cloudShellIntervals([0, 0, 22], [0, 0, -1], 21, 24)).toEqual([[0, 1], [43, 46]]);
  });
  it('grazing ray that misses the inner sphere has a single continuous chord', () => {
    const bands = cloudShellIntervals([22, 0, 30], [0, 0, -1], 21, 24);
    expect(bands).toHaveLength(1);
    expect(bands[0][1] - bands[0][0]).toBeCloseTo(2 * Math.sqrt(24 * 24 - 22 * 22), 8);
    expect(cloudShellIntervals([25, 0, 30], [0, 0, -1], 21, 24)).toEqual([]);
  });
});
describe('cloud world registration and controls', () => {
  it('a blast forces the deck through its shock, burn and turbulence, longest for a nuclear shell', () => {
    const blast = { position: [0, 18, 0] as Vec3, radius: 2, time: 0, kind: 0 as const }, nuke = { ...blast, radius: 4, kind: 2 as const };
    expect(cloudFieldImpactLife(2)).toBeGreaterThan(cloudFieldImpactLife(0));
    // The shock shell grows at the front speed and is gone after 3.5 s; turbulence outlives it.
    const early = cloudFieldImpactReach(blast, 0.5), late = cloudFieldImpactReach(blast, 5);
    expect(early.length).toBeGreaterThan(late.length);
    expect(late.length).toBeGreaterThan(0);
    expect(cloudFieldImpactReach(blast, cloudFieldImpactLife(0) + 1)).toEqual([]);
    expect(Math.max(...cloudFieldImpactReach(nuke, 3).map(r => r[3]))).toBeGreaterThan(Math.max(...cloudFieldImpactReach(blast, 3).map(r => r[3])));
  });
  it('matches gas lifetimes and expands the shell of damaged rays for lifted cloud', () => {
    expect(cloudImpactProfile(2).domain).toBe(2 * GAS_DOMAIN_PER_RADIUS);
    expect(cloudImpactProfile(2).lifetime).toBe(GAS_PRESETS.fireball.lifetime);
    expect(cloudImpactProfile(4, 'nuclear').lifetime).toBe(GAS_PRESETS.nuclear.lifetime);
    expect(cloudImpactProfile(2, 'incendiary').lifetime).toBe(GAS_PRESETS.incendiary.lifetime);
    const bound = CLOUD_FIELD.padding;
    // An uplifted cloud at radius 25.4 is beyond its original ceiling but inside the expanded shell.
    expect(cloudShellIntervals([0, 0, 25.4], [0, 0, -1], 21 - bound, 24 + bound, 1.2)).toEqual([[0, 1.2]]);
    expect(cloudShellIntervals([0, 0, 25.4], [0, 0, -1], 21, 24, 1.2)).toEqual([]);
  });
  it('drift rotations compose and rotate like the wind field', () => {
    const q = quatAxisAngle([0, 1, 0], Math.PI / 2);
    quatRotate(q, [1, 0, 0]).forEach((v, i) => expect(v).toBeCloseTo([0, 0, -1][i], 12));
    const twice = quatMul(q, q);
    quatRotate(twice, [1, 0, 0]).forEach((v, i) => expect(v).toBeCloseTo([-1, 0, 0][i], 12));
  });
  it('every point on the same sun ray addresses the same whole-sphere shadow texel', () => {
    const sun: Vec3 = [0.6, 0.8, 0], p: Vec3 = [1, 18, 2];
    const a = cloudShadowLookup(p, sun, 24);
    for (const d of [0.25, 1, 3]) {
      const b = cloudShadowLookup(p.map((v, i) => v + sun[i] * d) as Vec3, sun, 24);
      b.forEach((v, i) => expect(v).toBeCloseTo(a[i], 12));
    }
  });
  it('packs a complete reserved uniform and physical cloud/weather parameters have no camera dependency', () => {
    expect(CLOUD_PARAMS.size).toBe(CLOUD_PARAMS_BYTES);
    const a = packCloudParams(planet, frame(), controls, false);
    const b = packCloudParams(planet, frame({ eye: [100, -40, 8] }), controls, false);
    expect(new Uint8Array(a)).toEqual(new Uint8Array(b));
    expect(field(a, 'shell')).toEqual([18, expect.closeTo(21.2, 4), expect.closeTo(24.2, 4), expect.closeTo(1.8, 4)]);
    expect(field(a, 'control').slice(0, 3)).toEqual([1, 1, 0]);
    expect(field(packCloudParams(planet, frame(), { ...controls, enabled: false }, true), 'control').slice(0, 3)).toEqual([0, 1, 1]);
  });
  it('weather is deterministic; still air keeps the deck where it is', () => {
    const a = packCloudParams(planet, frame(), controls, false);
    expect(new Uint8Array(a)).toEqual(new Uint8Array(packCloudParams(planet, frame(), controls, false)));
    expect(field(a, 'wind')).toEqual([0, 0, 0, 1]);
  });
  it('planet kinds deliberately differ in cover, layer shape, shell height and scattering tint', () => {
    expect(CLOUD_PRESETS.dune.coverage).toBeLessThan(CLOUD_PRESETS.temperate.coverage * 0.5);
    expect(CLOUD_PRESETS.glacial.highLayer).toBeGreaterThan(CLOUD_PRESETS.temperate.highLayer);
    expect(CLOUD_PRESETS.dune.base).toBeGreaterThan(CLOUD_PRESETS.temperate.base);
    expect(CLOUD_PRESETS.volcanic.tint[0]).toBeLessThan(0.7);
  });
  it('rejects history on camera/scene invalidation, disocclusion and offscreen reprojection', () => {
    expect(cloudHistoryValid(20, 20.2, false, true)).toBe(true);
    expect(cloudHistoryValid(20, 60000, false, true)).toBe(false);
    expect(cloudHistoryValid(60000, 20, false, true)).toBe(false);
    expect(cloudHistoryValid(20, 20, true, true)).toBe(false);
    expect(cloudHistoryValid(20, 20, false, false)).toBe(false);
  });
  it('keeps the focus readable through a worst-case opaque deck across chase/inspection/overview ranges', () => {
    const focus: Vec3 = [0, 18.15, 0];
    for (const boom of [8, 17, 35, 60]) {
      const eye: Vec3 = [0, 19 + boom * 0.55, boom * Math.sqrt(1 - 0.55 ** 2)];
      const delta = focus.map((v, i) => v - eye[i]), distance = Math.hypot(...delta), dir = delta.map(v => v / distance) as Vec3;
      const chords = cloudShellIntervals(eye, dir, 21.2, 24.2, distance);
      let local = 0, unprotected = 0;
      for (const [a, b] of chords) for (let t = a; t < b; t += 0.01) {
        const p = eye.map((v, i) => v + dir[i] * t) as Vec3;
        const tau = 1.8 * Math.min(0.01, b - t), protection = cloudLocalProtection(p, focus);
        local += tau * protection; unprotected += tau * (1 - protection);
      }
      const tau = unprotected + CLOUD_VISIBILITY.opticalDepth * (1 - Math.exp(-local / CLOUD_VISIBILITY.opticalDepth));
      expect(Math.exp(-tau)).toBeGreaterThan(0.83);
      expect(Math.exp(-tau)).toBeLessThan(0.9); // cloud remains visible in front of gameplay
    }
  });
  it('softens a local 3D region smoothly without a radial column or camera-distance cutoff', () => {
    const p: Vec3 = [6, 22, 0], f: Vec3 = [0, 18, 0];
    expect(cloudLocalProtection(f, f)).toBe(1);
    expect(cloudLocalProtection([0, 40, 0], f)).toBe(0);
    const a = cloudLocalProtection([6.001, 22, 0], f), b = cloudLocalProtection(p, f);
    expect(Math.abs(a - b)).toBeLessThan(0.001);
  });
  it('reveals entrained cloud only where real fluid departure grows, with smooth recovery', () => {
    const focus: Vec3 = [0, 18, 0], positions: Vec3[] = [focus, [0, 22, 0], [10, 22, 0], [0, 40, 0]];
    for (const p of positions) {
      const quiet = cloudLocalProtection(p, focus);
      expect(cloudLocalProtection(p, focus, 0)).toBe(quiet);
      expect(cloudLocalProtection(p, focus, 0.05)).toBe(quiet);
      expect(cloudLocalProtection(p, focus, 3)).toBeCloseTo(quiet * 0.4, 12);
      let previous = quiet;
      for (let d = 0; d <= 3; d += 0.01) { const protection = cloudLocalProtection(p, focus, d); expect(protection).toBeLessThanOrEqual(previous + 1e-12); expect(previous - protection).toBeLessThan(0.013); previous = protection; }
    }
    expect(cloudLocalProtection(focus, focus, 0.4)).toBeGreaterThan(cloudLocalProtection(focus, focus, 0.8));
  });
});

function fixture() {
  const textures: object[] = [], buffers: object[] = [], retired: unknown[] = [], passes: PassDecl[] = [], declarations = new Map();
  const facets = new Map<string, unknown>([['planet', { ...planet }], ['sun', { illuminance: 20 }], ['lighting', { view: 'none' }], ['fogOfWar', { volumeView: {}, paramsBuffer: {} }], ['sdfCasters', { atlasView: {}, listBuffer: {} }], ['gasCloudFlow', { displacementView: {}, paramsBuffer: {}, maxDisplacement: 0, velocityView: {}, resolution: 32, slots: 4, domains: [] }]]);
  const listeners = new Map<string, () => void>(), writes: ArrayBuffer[] = [], registered = new Map<string, unknown>(), unavailable = new Set<string>(), encoded: string[] = [];
  let unregistered = 0, draws = 0;
  const device = {
    createTexture: (d: unknown) => { const t = { desc: d, createView: () => ({ texture: t }) }; textures.push(t); return t; },
    createBuffer: (d: unknown) => { const b = { desc: d }; buffers.push(b); return b; },
    createSampler: () => ({}), createBindGroupLayout: () => ({}), createBindGroup: () => ({}), createPipelineLayout: () => ({}),
  };
  const s = { ctx: { device, queue: { writeBuffer: (_b: unknown, _o: unknown, data: ArrayBuffer) => writes.push(data.slice(0)) }, layouts: { frame: {} },
    deferDestroy: (r: unknown) => { if (r) retired.push(r); }, pipelines: { register: (k: string, _t: unknown, b: unknown) => registered.set(k, b), compile: () => Promise.resolve({}), get: (k: string) => unavailable.has(k) ? undefined : {}, shaderModule: () => ({}) } },
    scene: { get: (k: string) => facets.get(k), provide: (k: string, v: unknown) => facets.set(k, v) },
    events: { on: (k: string, cb: () => void) => { listeners.set(k, cb); return () => listeners.delete(k); } },
    bindings: { provide: () => {}, get: () => ({}) }, frameUniforms: {},
    graph: { declareTexture: (n: string, d: unknown) => declarations.set(n, d), addPass: (p: PassDecl) => { passes.push(p); return () => { unregistered++; }; } },
    settings: { tier: 'high', gbufferView: 'none' }, telemetry: { gauge: () => {} },
  } as unknown as EngineServices;
  const cp = { setPipeline: () => {}, setBindGroup: () => {}, dispatchWorkgroups: () => {}, end: () => {}, draw: () => { draws++; } };
  const c = { frame: frame(), encoder: { copyTextureToTexture: () => { encoded.push('copy'); }, beginComputePass: (d: { label: string }) => { encoded.push(d.label); return cp; }, beginRenderPass: () => cp }, timestampWrites: () => undefined,
    resources: { view: (n: string) => ({ name: n }), history: (n: string) => ({ history: n }), size: () => [1280, 720] } } as unknown as PassContext;
  const module = cloudsModule(); module.install(s);
  return { s, c, module, passes, textures, buffers, retired, writes, facets, listeners, declarations, registered, unavailable, encoded, get draws() { return draws; }, get unregistered() { return unregistered; },
    prepare: () => passes.find(p => p.name === 'clouds.prepare')!.run(c), run: () => passes.forEach(p => p.run(c)), advance: () => { c.frame.index++; c.frame.time += c.frame.dt; } };
}
describe('cloud frame graph and lifecycle', () => {
  it('keeps up to eight impacts, ages them out, and clears them on scene changes', () => {
    const f = fixture(); f.run(); const clouds = f.facets.get('clouds') as CloudsFacet;
    for (let i = 0; i < 10; i++) clouds.impact([i, 18, 0], 2);
    clouds.impact([NaN, 18, 0], 2); clouds.impact([0, 18, 0], -1);
    expect(clouds.shockCount).toBe(8);
    f.advance(); f.run(); let bytes = f.writes.at(-1)!;
    // The field integrates the forcing this frame, over a box, and remembers the damaged region.
    expect(field(bytes, 'shock_control')[0]).toBe(1);
    expect(field(bytes, 'field')[2]).toBeGreaterThan(0);
    expect(f.encoded).toContain('clouds.field');
    expect(field(bytes, 'control')[2]).toBe(1);
    f.c.frame.time += cloudFieldImpactLife(0) + 1; f.advance(); f.run(); bytes = f.writes.at(-1)!;
    expect(clouds.shockCount).toBe(0); expect(field(bytes, 'shock_control')[0]).toBe(0);
    // The deck stays damaged after the forcing ends, healing over minutes rather than springing back.
    expect(field(bytes, 'field')[2]).toBeGreaterThan(0); expect(field(bytes, 'control')[3]).toBeLessThan(1);
    clouds.impact([0, 18, 0], 2); f.listeners.get('planetChanged')!(); f.advance(); f.run();
    expect(field(f.writes.at(-1)!, 'shock_control')[0]).toBe(0); expect(field(f.writes.at(-1)!, 'field')[2]).toBe(0); f.module.dispose?.();
  });
  it('keeps a nuclear shell stirring the deck long after its shock, then lets the damage heal', () => {
    const f = fixture(); f.run(); const clouds = f.facets.get('clouds') as CloudsFacet;
    clouds.impact([0, 18, 0], 4, f.c.frame.time, 'nuclear'); f.c.frame.time += 7; f.advance(); f.run();
    expect(clouds.shockCount).toBe(1); expect(field(f.writes.at(-1)!, 'shock_control')[0]).toBe(1);
    f.c.frame.time += cloudFieldImpactLife(2); f.advance(); f.run(); expect(clouds.shockCount).toBe(0);
    expect(field(f.writes.at(-1)!, 'field')[2]).toBeGreaterThan(0);
    f.c.frame.time += CLOUD_FIELD.heal * Math.log(60) + 1; f.advance(); f.run(); expect(field(f.writes.at(-1)!, 'field')[2]).toBe(0);
    f.module.dispose?.();
  });
  it('reset clears the field and history even when restarting the same seed', () => {
    const f = fixture(); f.run(); const clouds = f.facets.get('clouds') as CloudsFacet;
    clouds.impact([0, 18, 0], 4); expect(clouds.shockCount).toBe(1);
    clouds.reset(); expect(clouds.shockCount).toBe(0); f.advance(); f.run();
    expect(field(f.writes.at(-1)!, 'shock_control')[0]).toBe(0); expect(field(f.writes.at(-1)!, 'field')[2]).toBe(0);
    expect(field(f.writes.at(-1)!, 'control')[2]).toBe(1); f.module.dispose?.();
  });
  it('turns the deck continuously with the wind aloft and reprojects through the last turn', () => {
    const f = fixture(); f.facets.set('wind', { axis: [0, 1, 0], bars: 2, speed: 0.44, aloft: 1.2 });
    f.run(); const a = field(f.writes.at(-1)!, 'wind'); f.advance(); f.run();
    const b = field(f.writes.at(-1)!, 'wind'), prev = field(f.writes.at(-1)!, 'wind_prev');
    prev.forEach((v, i) => expect(v).toBeCloseTo(a[i], 6));
    // About +Y the quaternion's y is sin(θ/2): two equal steps from rest advance it by about a half step each.
    expect(2 * (b[1] - a[1])).toBeCloseTo(1.2 / ((21.2 + 24.2) / 2) / 60, 6);
    f.module.dispose?.();
  });
  it('owns explicit ping-pong metadata/color and records the shadow bake before surface lighting', () => {
    const f = fixture();
    for (const name of ['cloudRaw', CLOUD_COLOR, CLOUD_META]) expect(f.declarations.get(name).size).toBe('internal');
    expect(f.declarations.get(CLOUD_COLOR).history).toBe(true);
    expect(f.declarations.get(CLOUD_META).history).toBe(true);
    expect(f.passes.find(p => p.name === 'clouds.shadow')?.slot).toBe('shadows');
    expect(f.passes.find(p => p.name === 'clouds.temporal')?.reads).toContain(`history:${CLOUD_META}`);
    expect(f.passes.find(p => p.name === 'clouds.composite')?.writes).toEqual(['hdr']);
    f.module.dispose?.();
    expect(new Set(f.retired)).toEqual(new Set([...f.textures, ...f.buffers]));
    expect(f.listeners.size).toBe(0); expect(f.unregistered).toBe(f.passes.length);
    f.module.dispose?.(); expect(f.unregistered).toBe(f.passes.length);
  });
  it('disabling, interior scenes and diagnostic views publish an identity shadow uniform', () => {
    const f = fixture(); f.prepare(); expect(field(f.writes.at(-1)!, 'control')[0]).toBe(1);
    (f.facets.get('clouds') as CloudsFacet).enabled = false; f.prepare(); expect(field(f.writes.at(-1)!, 'control')[0]).toBe(0);
    (f.facets.get('clouds') as CloudsFacet).enabled = true; f.facets.set('interior', {}); f.prepare(); expect(field(f.writes.at(-1)!, 'control')[0]).toBe(0);
    f.facets.delete('interior'); f.facets.set('lighting', { view: 'sdf-sun' }); f.prepare(); expect(field(f.writes.at(-1)!, 'control')[0]).toBe(0);
    f.module.dispose?.();
  });
  it('tier changes replace the cube with deferred destruction and reset cloud history', () => {
    const f = fixture(); f.prepare(); const oldCube = f.textures[1]; const before = f.textures.length;
    f.c.frame = frame({ tier: 'ultra' }); f.prepare();
    expect(f.retired).toContain(oldCube); expect(f.textures).toHaveLength(before + 1);
    expect(field(f.writes.at(-1)!, 'control')[2]).toBe(1);
    f.module.dispose?.(); expect(new Set(f.retired)).toEqual(new Set([...f.textures, ...f.buffers]));
  });
  it('never composites an unresolved frame and discards history after a skipped temporal pass', () => {
    const f = fixture(); f.run(); expect(f.draws).toBe(1); f.advance(); f.prepare();
    expect(field(f.writes.at(-1)!, 'control')[2]).toBe(0);
    f.unavailable.add('clouds:temporal');
    for (const p of f.passes.filter(p => p.slot === 'clouds')) p.run(f.c);
    expect(f.draws).toBe(1);
    f.unavailable.clear(); f.advance(); f.run();
    expect(field(f.writes.at(-1)!, 'control')[2]).toBe(1); expect(f.draws).toBe(2);
    f.advance(); f.run(); expect(field(f.writes.at(-1)!, 'control')[2]).toBe(0);
    f.module.dispose?.();
  });
  it('re-enabling clouds, geometry edits, snaps, resize and time jumps reject old samples', () => {
    const f = fixture(); f.run(); f.advance(); f.run(); expect(field(f.writes.at(-1)!, 'control')[2]).toBe(0);
    const clouds = f.facets.get('clouds') as CloudsFacet;
    clouds.enabled = false; f.advance(); f.run(); expect(f.draws).toBe(2);
    clouds.enabled = true; f.advance(); f.run(); expect(field(f.writes.at(-1)!, 'control')[2]).toBe(1);
    for (const event of ['terrainCommitted', 'resize', 'planetChanged']) {
      f.advance(); f.run(); expect(field(f.writes.at(-1)!, 'control')[2]).toBe(0);
      f.listeners.get(event)!(); f.advance(); f.run(); expect(field(f.writes.at(-1)!, 'control')[2]).toBe(1);
    }
    f.advance(); f.c.frame.snap = true; f.run(); expect(field(f.writes.at(-1)!, 'control')[2]).toBe(1); f.c.frame.snap = false;
    f.advance(); f.run(); expect(field(f.writes.at(-1)!, 'control')[2]).toBe(0);
    f.advance(); f.c.frame.time += 100; f.run(); expect(field(f.writes.at(-1)!, 'control')[2]).toBe(1);
    f.module.dispose?.();
  });
  it('shadow-only switching preserves visible clouds and bakes fresh shadow data on re-enable', () => {
    const f = fixture(); f.run(); const clouds = f.facets.get('clouds') as CloudsFacet;
    const n = () => f.encoded.filter(x => x === 'clouds.shadow').length;
    expect(n()).toBe(1); clouds.shadows = false; f.advance(); f.run(); expect(n()).toBe(1); expect(f.draws).toBe(2);
    expect(field(f.writes.at(-1)!, 'control').slice(0, 2)).toEqual([1, 0]);
    clouds.shadows = true; f.advance(); f.run(); expect(n()).toBe(2); expect(f.draws).toBe(3);
    f.module.dispose?.();
  });
  it('all production kernels link with one shared physical density definition', () => {
    const shaders = cloudShaders(); expect(Object.keys(shaders)).toHaveLength(5);
    expect(shaders.shadow.modules).toContain('cloud-density'); expect(shaders.raymarch.modules).toContain('cloud-density');
    expect(shaders.raymarch.code).toContain('frame.inv_view_proj');
    expect(shaders.temporal.code).toContain('cloud_qrot(cp.wind_prev,cloud_qunrot(cp.wind,point))');
    expect(shaders.raymarch.modules).toContain('cloud-field-binding:1:18'); expect(shaders.shadow.modules).toContain('cloud-field-binding:0:4');
    expect(shaders.temporal.modules.some(m => m.startsWith('cloud-field-binding'))).toBe(false);
  });
});
