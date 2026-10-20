import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { GameSnapshot, ProjectileState, WorldQuery } from '../src/game/contracts';
import type { MeshDesc, SceneRegistry } from '../src/engine';
import { projectileMeshes, decodeWorkshopBomb, setWorkshopBomb, WORKSHOP_BOMB_URL } from '../src/game/presentation/projectile-models';
import { createFlightFrame, projectileMatrix } from '../src/game/presentation/projectile-frame';
import { ShellViews, SHELL_POOL_PER_TYPE } from '../src/game/presentation/shells';
import type { MunitionId } from '../src/game/munitions';

// The shipped asset itself, as the renderer fetches it.
const WORKSHOP_BOMB = new Uint8Array(readFileSync(new URL(`../public${WORKSHOP_BOMB_URL}`, import.meta.url)));
setWorkshopBomb(WORKSHOP_BOMB);
const kinds: MunitionId[] = ['explosive', 'heavy', 'incendiary', 'nuclear'];
const projectile = (munition: MunitionId = 'explosive'): ProjectileState => ({ id: 1, owner: 0, position: [0, 110, 0], velocity: [1, 3, 6], age: .4, munition });
const snapshot = (projectiles: ProjectileState[]): GameSnapshot => ({ tanks: [{ id: 0, position: [0, 100, 0] }], projectiles }) as GameSnapshot;

function mockScene() {
  let nextMesh = 0, nextInstance = 0;
  const active = new Map<number, Float32Array>();
  const meshes = { create: vi.fn((mesh: MeshDesc) => ({ id: nextMesh++, vertexCount: mesh.positions.length / 3, indexCount: mesh.indices.length, bounds: { center: [0, 0, 0], radius: 1 } })), destroy: vi.fn() };
  const instances = { add: vi.fn((_mesh, init) => { const id = nextInstance++; active.set(id, new Float32Array(init.model)); return { id }; }),
    set: vi.fn((h, model) => active.set(h.id, new Float32Array(model))), remove: vi.fn(h => active.delete(h.id)), setVisibility: vi.fn() };
  const lights = { add: vi.fn(), remove: vi.fn(), update: vi.fn() };
  return { scene: { meshes, instances, lights } as unknown as SceneRegistry, active, meshes, instances, lights };
}

describe('physical projectile assets', () => {
  it('shares four bounded, non-emissive, distinct physical meshes', () => {
    const models = projectileMeshes();
    expect(projectileMeshes()).toBe(models);
    const lengths: number[] = [];
    for (const kind of kinds) {
      const mesh = models[kind];
      expect(mesh.positions.length).toBe(mesh.normals.length);
      expect(mesh.partLocal?.length).toBe(mesh.positions.length);
      expect(mesh.indices.length % 3).toBe(0);
      expect(mesh.indices.length).toBeLessThan(60000);
      expect([...mesh.positions, ...mesh.normals, ...mesh.partLocal!].every(Number.isFinite)).toBe(true);
      expect([...mesh.indices].every(i => i < mesh.positions.length / 3)).toBe(true);
      expect([...mesh.attrs!].every(a => ((a >>> 16) & 255) !== 5)).toBe(true);
      const z = [...mesh.positions].filter((_, i) => i % 3 === 2);
      lengths.push(Math.max(...z) - Math.min(...z));
    }
    expect(new Set(lengths).size).toBe(4);
    expect(lengths[3]).toBeCloseTo(1.0125, 3);
  });

  it('keeps the workshop original unchanged, excludes the carrier and ships under one percent of its bytes', () => {
    const provenance = JSON.parse(readFileSync(new URL('../assets/projectiles/workshop-bomb.provenance.json', import.meta.url), 'utf8'));
    const source = readFileSync(new URL('../assets/workshop/meshy/inert-ordnance-cart/model.glb', import.meta.url));
    expect(createHash('sha256').update(source).digest('hex')).toBe(provenance.sourceSha256);
    expect(provenance.packedBytes).toBeLessThan(source.length / 100);
    expect(provenance.originalFinTriangles).toBeGreaterThan(100);
    expect(provenance.excluded).toContain('transport straps');
    // A carrier is below the bomb's axis and wider than its four-fin envelope.
    const mesh = projectileMeshes().nuclear;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      expect(Math.abs(mesh.positions[i])).toBeLessThan(.1);
      expect(Math.abs(mesh.positions[i + 1])).toBeLessThan(.1);
    }
    expect(provenance.packedBytes).toBe(WORKSHOP_BOMB.length);
    expect(() => decodeWorkshopBomb(new TextEncoder().encode('broken'))).toThrow();
    expect(() => setWorkshopBomb(new TextEncoder().encode('broken'))).toThrow();
    expect(projectileMeshes().nuclear).toBe(mesh);
  });

  it('decodes PMB2 into exactly the former PMB1 geometry, colors and materials', () => {
    // Fingerprinted with the PMB1 decoder before migration; array order is part
    // of the check, including the complete triangle winding/order and fin indices.
    const mesh = decodeWorkshopBomb(WORKSHOP_BOMB), fingerprint = createHash('sha256');
    for (const key of ['positions', 'normals', 'indices', 'partLocal', 'attrs'] as const) {
      const array = mesh[key]!;
      fingerprint.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    }
    expect(fingerprint.digest('hex')).toBe('f8b6b1df265be115b929bd706a5da8747d7ed22903a8db23337424300c666f15');
    expect(WORKSHOP_BOMB.length).toBe(129312);
  });

  it('rejects invalid compressed grid dimensions and out-of-range original fin indices', () => {
    for (const [offset, value] of [[12, 0], [16, 129], [20, 0]]) {
      const corrupt = Buffer.from(WORKSHOP_BOMB); corrupt.writeUInt32LE(value, offset);
      expect(() => decodeWorkshopBomb(corrupt)).toThrow('Invalid workshop bomb size');
    }
    const corrupt = Buffer.from(WORKSHOP_BOMB); corrupt.writeUInt16LE(65535, corrupt.length - 2);
    expect(() => decodeWorkshopBomb(corrupt)).toThrow('Invalid workshop bomb index');
  });
});

describe('transported projectile attitude', () => {
  it('keeps an orthonormal frame through a vertical apex including zero speed', () => {
    const frame = createFlightFrame(), matrix = new Float32Array(16);
    projectileMatrix(frame, [0, 110, 0], [0, 5, 0], [0, 1, 0], 1 / 60, matrix);
    const held = [...matrix];
    projectileMatrix(frame, [0, 110, 0], [0, 0, 0], [0, 1, 0], 1 / 60, matrix);
    expect([...matrix]).toEqual(held);
    for (let i = 0; i < 60; i++) {
      const previous = [...frame.forward];
      projectileMatrix(frame, [0, 110, 0], [0, -5, 0], [0, 1, 0], 1 / 60, matrix);
      expect([...matrix].every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...frame.forward)).toBeCloseTo(1, 6);
      expect(Math.hypot(...frame.right)).toBeCloseTo(1, 6);
      expect(frame.forward.reduce((n, v, j) => n + v * frame.right[j], 0)).toBeCloseTo(0, 6);
      expect(frame.forward.reduce((n, v, j) => n + v * previous[j], 0)).toBeGreaterThan(0);
    }
    expect(frame.forward[1]).toBeCloseTo(-1, 5);
  });

  it('does not roll when crossing the local-up look-at singularity', () => {
    const frame = createFlightFrame(); let previous = [0, 0, 0];
    for (let i = -100; i <= 100; i++) {
      projectileMatrix(frame, [1, 2, 3], [i * .004, 1, .0001], [0, 1, 0], 1 / 60);
      if (i > -100) expect(frame.right.reduce((n, v, j) => n + v * previous[j], 0)).toBeGreaterThan(.99);
      previous = [...frame.right];
    }
  });
});

describe('shell scene lifetime', () => {
  it('interpolates remote projectiles over the authoritative snapshot interval without altering physics', () => {
    const mock = mockScene(), views = new ShellViews(mock.scene), p = projectile();
    const canonical = structuredClone(p);
    views.update(snapshot([p]), 0, undefined, 1 / 60, { alpha: .5,
      projectiles: [{ id: p.id, previous: [-4, 108, 2], current: [...p.position] }] });
    const matrix = [...mock.active.values()][0];
    expect(Array.from(matrix).slice(12, 15)).toEqual([-2, 109, 1]);
    expect(p).toEqual(canonical);
    views.update(snapshot([]), 0, undefined);
    expect(views.count).toBe(0);
    views.dispose();
  });
  it('reuses the mesh resources and bounded records with no idle draw, light or restart leaks', () => {
    const mock = mockScene(), views = new ShellViews(mock.scene);
    for (let round = 0; round < 100; round++) for (const kind of kinds) {
      views.update(snapshot([projectile(kind)]), 0, undefined);
      expect(views.count).toBe(1); expect(mock.active.size).toBe(1);
      views.clear();
      expect(views.count).toBe(0); expect(mock.active.size).toBe(0);
    }
    expect(mock.meshes.create).toHaveBeenCalledTimes(4);
    expect(views.pooled).toBe(4);
    expect(views.pooled).toBeLessThanOrEqual(kinds.length * SHELL_POOL_PER_TYPE);
    expect(mock.lights.add).not.toHaveBeenCalled();
    views.dispose(); views.dispose();
    expect(mock.meshes.destroy).toHaveBeenCalledTimes(4);
    expect(views.pooled).toBe(0);
  });

  it('keeps the existing observer visibility rule and interpolates only behind canonical position', () => {
    const mock = mockScene(), views = new ShellViews(mock.scene), p = projectile();
    const world = { raycast: () => ({ distance: 1 }) } as unknown as WorldQuery;
    views.update(snapshot([{ ...p, owner: 1 }]), 0, world);
    expect(views.count).toBe(0);
    expect(views.trails.snapshot().particles).toBe(0);
    views.update(snapshot([p]), 0, world, 1 / 120, { alpha: .25 });
    expect(views.count).toBe(1);
    expect(views.trails.snapshot().emitters).toBe(1);
    const matrix = [...mock.active.values()][0];
    for (let i = 0; i < 3; i++) expect(matrix[12 + i]).toBeCloseTo(p.position[i] - p.velocity[i] / 60 * .75, 5);
    expect(p.position).toEqual([0, 110, 0]);
    views.update(snapshot([{ ...p, owner: 1 }]), 0, world);
    expect(views.count).toBe(0); expect(mock.active.size).toBe(0);
    expect(views.trails.snapshot().emitters).toBe(0);
    views.dispose();
  });
});
