/** freezeBodies selects exactly the bodies whose historical world AABB (every collider point, rotated with three.js
 * temporaries; kept below as the oracle) overlaps the cut bounds, although it now tests a bounding ball first. */
import { expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { Q4, TerrainQueryBounds, V3 } from '../src/game/contracts';
import type { BodyCandidate } from '../src/gpu/terrain/contracts';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { ResidentGameTerrain } from '../src/game/resident-terrain';
import { generatePlanetStructures } from '../src/game/terrain-structures';
import { StructuralPhysics } from '../src/game/structural-physics';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';

// ---- oracle: resident-terrain.ts bodyBounds and overlaps before the ball pre-test (93b8a7e) --------------------------
const rotate = (v: V3, q: Q4): V3 => new Vector3(...v).applyQuaternion(new Quaternion(...q)).toArray() as V3;
function bodyBounds(candidate: BodyCandidate, position: V3, rotation: Q4): TerrainQueryBounds {
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const collider of candidate.colliders) {
    const offset = collider.offset ?? [0, 0, 0];
    for (let i = 0; i < collider.vertices.length; i += 3) {
      const local: V3 = [collider.vertices[i] + offset[0], collider.vertices[i + 1] + offset[1], collider.vertices[i + 2] + offset[2]];
      const r = rotate(local, rotation), world: V3 = [position[0] + r[0], position[1] + r[1], position[2] + r[2]];
      for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], world[a]); max[a] = Math.max(max[a], world[a]); }
    }
  }
  return { min, max };
}
const overlaps = (a: TerrainQueryBounds, b: TerrainQueryBounds) => [0, 1, 2].every(i => a.min[i] <= b.max[i] && a.max[i] >= b.min[i]);
// ---------------------------------------------------------------------------------------------------------------------

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

it('freezes exactly the bodies the historical per-vertex bounds overlap', async () => {
  const structures = generatePlanetStructures(7, undefined, true), input = residentPlanet(7, structures, 'resident-f32-game-v3');
  const physics = await StructuralPhysics.create(input.planetCenter), resident = new ResidentTerrain(input, new GeometryGate().pages, physics, new FakeTerrainHost());
  const game = ResidentGameTerrain.adopt(resident, 7, structures, 'resident-f32-game-v3');
  try {
    await game.initialize();
    for (const structure of structures) {
      if (physics.bodies.size >= 6) break;
      if (!structure.axes || structure.halfSize[1] < 1.75) continue;
      const lift = 1.3 - structure.halfSize[1], center = structure.center.map((v, a) => v + structure.axes![1][a] * lift) as V3;
      await game.carve(center, 2);
    }
    expect(physics.bodies.size).toBeGreaterThan(2);
    const rng = random(17), tx = game.transactions;
    let frozen = 0, spared = 0;
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 40; i++) game.fixedStep();
      const bodies = [...physics.bodies].map(([id, { body, candidate }]) => {
        const p = body.translation(), q = body.rotation();
        return { id, candidate, position: [p.x, p.y, p.z] as V3, rotation: [q.x, q.y, q.z, q.w] as Q4 };
      });
      for (let i = 0; i < 60; i++) {
        const near = bodies[Math.floor(rng() * bodies.length)].position, radius = [.2, 1, 2, 4, 9][Math.floor(rng() * 5)];
        const center = near.map(v => v + (rng() * 2 - 1) * [0, 1, 3, 6][Math.floor(rng() * 4)]) as V3;
        const bounds = { min: center.map(v => v - radius) as V3, max: center.map(v => v + radius) as V3 };
        const expected = bodies.filter(b => overlaps(bodyBounds(b.candidate, b.position, b.rotation), bounds)).map(b => b.id);
        tx.freezeBodies(bounds, physics.tick + 1);
        expect(tx.frozenBodies.sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));
        frozen += expected.length; spared += bodies.length - expected.length;
        tx.release(physics.tick + 1);
        expect(tx.frozenBodies).toEqual([]);
      }
    }
    expect(frozen).toBeGreaterThan(50); expect(spared).toBeGreaterThan(50);
  } finally { game.dispose(); }
}, 180000);
