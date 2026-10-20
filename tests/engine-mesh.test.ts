/**
 * Part-mesh path, CPU side: mesh packing for vertex pulling, instance buffer packing, the automatic prevModel copy,
 * draw lists (one instanced draw per mesh, sub-instance expansion, shadow filtering) and the attrs byte layout.
 */
import { describe, expect, it } from 'vitest';
import { MATERIAL_CLASS } from '../src/engine/contracts';
import { packPartAttrs, partBasicWgsl, PART_MATERIALS } from '../src/engine/materials/part-basic.wgsl';
import { meshCommonWgsl } from '../src/engine/passes/gbuffer/mesh.pass';
import { INSTANCE_BYTES, INSTANCE_FLOATS, InstanceTable, meshBounds, MESH_HEADER_WORDS, NO_STREAM, packMeshData } from '../src/engine/passes/gbuffer/part-mesh-data';
import { Scene } from '../src/engine/scene/scene-registry';
import { EventBus } from '../src/engine/events';

describe('scene registry and events', () => {
  it('orders G-buffer drawers, filters by slot, unregisters, and keeps facets', () => {
    const scene = new Scene();
    const d = (name: string, order: number, slot: 'gbuffer.opaque' | 'gbuffer.foliage' = 'gbuffer.opaque') => ({ name, order, slot, draw() { /* */ } });
    scene.addGBufferDrawer(d('parts', 100));
    const off = scene.addGBufferDrawer(d('terrain', 0));
    scene.addGBufferDrawer(d('grass', 0, 'gbuffer.foliage'));
    expect(scene.drawersFor('gbuffer.opaque').map(x => x.name)).toEqual(['terrain', 'parts']);
    expect(scene.drawersFor('gbuffer.foliage').map(x => x.name)).toEqual(['grass']);
    off();
    expect(scene.drawersFor('gbuffer.opaque').map(x => x.name)).toEqual(['parts']);
    const offOverlay = scene.addOverlayDrawer({ name: 'ring', draw() { /* */ } });
    scene.addTransparentDrawer({ name: 'b', order: 5, draw() { /* */ } });
    scene.addTransparentDrawer({ name: 'a', order: 1, draw() { /* */ } });
    expect(scene.transparentDrawers.map(x => x.name)).toEqual(['a', 'b']);
    offOverlay();
    expect(scene.overlayDrawers).toHaveLength(0);
    scene.provide('planet', { seed: 7, kind: 'temperate', radius: 18 });
    expect(scene.get('planet')?.radius).toBe(18);
    expect(scene.get('sun')).toBeUndefined();
    expect(() => scene.meshes.create({ ...tri })).toThrow(/not available/);
  });

  it('delivers typed events to live listeners only and survives a throwing listener', () => {
    const bus = new EventBus();
    const got: number[] = [];
    const off = bus.on('terrainCommitted', e => { got.push(e.epoch); });
    bus.on('terrainCommitted', () => { throw new Error('listener bug'); });
    const warn = console.warn; console.warn = () => undefined;
    try {
      bus.emit('terrainCommitted', { dirtyBounds: { min: [0, 0, 0], max: [1, 1, 1] }, epoch: 3 });
      off();
      bus.emit('terrainCommitted', { dirtyBounds: { min: [0, 0, 0], max: [1, 1, 1] }, epoch: 4 });
    } finally { console.warn = warn; }
    expect(got).toEqual([3]);
  });
});

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const translate = (x: number, y: number, z: number) => { const m = identity(); m[12] = x; m[13] = y; m[14] = z; return m; };

const tri = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
};

describe('mesh packing', () => {
  it('writes a self-describing header and the vertex streams', () => {
    const p = packMeshData({ ...tri, matId: 4 });
    const w = p.words, f = new Float32Array(w.buffer);
    expect(w[0]).toBe(3);
    expect(w[1]).toBe(MESH_HEADER_WORDS);
    expect(w[2]).toBe(MESH_HEADER_WORDS + 9);
    expect(w[3]).toBe(w[1]); // partLocal falls back to positions
    expect([w[4], w[5]]).toEqual([NO_STREAM, NO_STREAM]);
    expect(w[7]).toBe(0);
    expect(w[8]).toBe(packPartAttrs(0, 255, 4));
    expect(Array.from(f.subarray(w[1], w[1] + 9))).toEqual(Array.from(tri.positions));
    expect(Array.from(f.subarray(w[2], w[2] + 9))).toEqual(Array.from(tri.normals));
    expect(p.words.length).toBe(MESH_HEADER_WORDS + 18);
  });

  it('packs every PartMesh stream and repeated sub-instances', () => {
    const attrs = new Uint32Array([packPartAttrs(255, 200, 3, 1), packPartAttrs(0, 255, 3), packPartAttrs(10, 128, 7)]);
    const primAxis = new Uint32Array([1, 2, 3]);
    const partLocal = new Float32Array([5, 5, 5, 6, 6, 6, 7, 7, 7]);
    const instances = new Float32Array([1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, -2, 0, 1, 0, 0, 0, 0, 1, 0]); // two translations ±2 x
    const p = packMeshData({ ...tri, attrs, primAxis, partLocal, instances });
    const w = p.words, f = new Float32Array(w.buffer);
    expect(Array.from(f.subarray(w[3], w[3] + 9))).toEqual(Array.from(partLocal));
    expect(Array.from(w.subarray(w[4], w[4] + 3))).toEqual([1, 2, 3]);
    expect(Array.from(w.subarray(w[5], w[5] + 3))).toEqual(Array.from(attrs));
    expect(w[7]).toBe(2);
    expect(Array.from(f.subarray(w[6], w[6] + 24))).toEqual(Array.from(instances));
    expect(p.subCount).toBe(2);
    expect(p.bounds.radius).toBeGreaterThan(2);
  });

  it('rejects malformed meshes', () => {
    expect(() => packMeshData({ ...tri, indices: new Uint32Array([0, 1, 5]) })).toThrow(/out of range/);
    expect(() => packMeshData({ ...tri, normals: new Float32Array(3) })).toThrow(/normals/);
    expect(() => packMeshData({ ...tri, attrs: new Uint32Array(2) })).toThrow(/attrs/);
    expect(() => packMeshData({ ...tri, indices: new Uint32Array([0, 1]) })).toThrow(/indices/);
  });

  it('bounds cover every vertex, including transformed sub-instances', () => {
    const b = meshBounds(tri.positions);
    for (let i = 0; i < 3; i++) {
      const d = Math.hypot(tri.positions[i * 3] - b.center[0], tri.positions[i * 3 + 1] - b.center[1], tri.positions[i * 3 + 2] - b.center[2]);
      expect(d).toBeLessThanOrEqual(b.radius + 1e-9);
    }
    const sub = meshBounds(tri.positions, new Float32Array([3, 0, 0, 10, 0, 3, 0, 0, 0, 0, 3, 0]));
    expect(sub.center[0]).toBeCloseTo(11.5, 6);
    expect(sub.radius).toBeCloseTo(b.radius * 3, 6);
  });
});

describe('instance table', () => {
  it('packs model, prevModel, tint and ids into 160 B records', () => {
    expect(INSTANCE_BYTES).toBe(160);
    const t = new InstanceTable(4);
    const slot = t.add(7, { model: translate(1, 2, 3), tint: [0.5, 0.25, 0.125], objectId: 1500, flags: 0x7f, classId: MATERIAL_CLASS.STRUCTURE });
    const o = slot * INSTANCE_FLOATS;
    const u = new Uint32Array(t.data.buffer);
    expect(Array.from(t.data.subarray(o + 12, o + 15))).toEqual([1, 2, 3]);
    expect(Array.from(t.data.subarray(o + 28, o + 31))).toEqual([1, 2, 3]); // prev = model on add
    expect(Array.from(t.data.subarray(o + 32, o + 36))).toEqual([0.5, 0.25, 0.125, 1]);
    expect([u[o + 36], u[o + 37], u[o + 38]]).toEqual([1500 & 0x3ff, 0x3f, MATERIAL_CLASS.STRUCTURE]);
    const d = t.add(1, { model: identity() });
    expect(Array.from(t.data.subarray(d * INSTANCE_FLOATS + 32, d * INSTANCE_FLOATS + 35)).map(v => Math.round(v * 100) / 100)).toEqual([0.6, 0.6, 0.6]);
    expect(u[d * INSTANCE_FLOATS + 38]).toBe(MATERIAL_CLASS.METAL);
  });

  it('copies prevModel automatically each frame', () => {
    const t = new InstanceTable();
    const s = t.add(1, { model: translate(0, 0, 0) });
    t.set(s, translate(5, 0, 0)); // moved before its first drawn frame: no velocity on the first frame
    t.beginFrame();
    expect(t.prevModel(s)[12]).toBe(5);
    expect(t.model(s)[12]).toBe(5);
    t.set(s, translate(6, 0, 0));
    t.beginFrame();
    expect([t.prevModel(s)[12], t.model(s)[12]]).toEqual([5, 6]);
    t.dataDirty = false;
    t.beginFrame(); // not moved: prev catches up, velocity becomes zero
    expect([t.prevModel(s)[12], t.model(s)[12]]).toEqual([6, 6]);
    expect(t.dataDirty).toBe(true);
    t.dataDirty = false;
    t.beginFrame();
    expect(t.dataDirty).toBe(false); // settled: nothing to upload
    t.set(s, translate(6, 0, 0), 3);
    expect(new Uint32Array(t.data.buffer)[s * INSTANCE_FLOATS + 37]).toBe(3);
  });

  it('reuses freed slots, grows past capacity and rejects unknown slots', () => {
    const t = new InstanceTable(2);
    const a = t.add(1, { model: identity() }), b = t.add(1, { model: identity() });
    const c = t.add(2, { model: translate(9, 0, 0) });
    expect(t.slotCapacity).toBe(4);
    expect(t.model(c)[12]).toBe(9);
    t.remove(b);
    expect(t.add(3, { model: identity() })).toBe(b);
    expect(t.count).toBe(3);
    t.remove(a);
    expect(() => t.set(a, identity())).toThrow(/unknown slot/);
    expect(() => t.remove(99)).toThrow();
  });

  it('builds one draw range per mesh, expands sub-instances and filters shadow casters', () => {
    const t = new InstanceTable();
    const a0 = t.add(2, { model: identity() });
    const b0 = t.add(1, { model: identity(), castShadow: false });
    const a1 = t.add(2, { model: identity() });
    const lists = t.buildDrawLists(new Map([[1, 0], [2, 3]]));
    expect(lists.draws).toEqual([{ mesh: 1, first: 0, count: 1 }, { mesh: 2, first: 1, count: 6 }]);
    expect(Array.from(lists.entries.subarray(0, 14))).toEqual([b0, 0, a0, 0, a0, 1, a0, 2, a1, 0, a1, 1, a1, 2]);
    const shadow = t.buildDrawLists(new Map([[1, 0], [2, 3]]), true);
    expect(shadow.draws).toEqual([{ mesh: 2, first: 0, count: 6 }]);
    expect(t.membershipDirty).toBe(true);
  });
});

describe('part attrs and the basic material', () => {
  it('uses edge | ao | matId | flags from low to high byte, in TS and WGSL', () => {
    const a = packPartAttrs(0x11, 0x22, 0x33, 0x44);
    expect(a).toBe(0x44332211);
    expect(partBasicWgsl.code).toContain('fn part_attr_ao(attrs: u32) -> f32 { return f32((attrs >> 8u) & 0xFFu) / 255.0; }');
    expect(partBasicWgsl.code).toContain('fn part_attr_mat(attrs: u32) -> u32 { return (attrs >> 16u) & 0xFFu; }');
    expect(meshCommonWgsl.code).toContain('struct Instance');
  });

  it('preserves the eight part MatIds and appends nonmetallic rubble', () => {
    expect(PART_MATERIALS.slice(0, 9).map(m => m.name)).toEqual(['paint', 'dark steel', 'rubber', 'gunmetal', 'brass', 'signal', 'glass', 'chrome', 'rubble']);
    const rm = PART_MATERIALS.map(m => [m.roughness, m.metalness]);
    expect(rm[0]).toEqual([0.45, 0]); expect(rm[1]).toEqual([0.35, 1]); expect(rm[2]).toEqual([0.8, 0]);
    expect(rm[3]).toEqual([0.3, 1]); expect(rm[4]).toEqual([0.35, 1]); expect(rm[7]).toEqual([0.08, 1]);
    expect(PART_MATERIALS[5].emissive).toBeGreaterThan(0);
    expect(rm[8]).toEqual([0.95, 0]);
    for (let id = 0; id < 8; id++) expect(partBasicWgsl.code).toContain(`case ${id}u:`);
  });
});
