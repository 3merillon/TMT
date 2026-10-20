/** Repeatable CPU preparation/edit timing; GPU and UI latency are measured in the browser. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { StructuralPhysics } from '../src/game/structural-physics';
import { FakeTerrainHost, GeometryGate } from '../tests/helpers/geometry-gate';

const started = performance.now(), input = residentPlanet(Number(process.env.TMT_SEED ?? 7), undefined, process.env.TMT_PROFILE === 'v1' ? 'resident-f32-game-v1' : 'resident-f32-game-v2');
const physics = await StructuralPhysics.create(input.planetCenter);
const terrain = new ResidentTerrain(input, new GeometryGate().pages, physics, new FakeTerrainHost());
const prepared = performance.now() - started;
try {
  await terrain.initialize();
  const initialization = performance.now() - started;
  console.log(JSON.stringify({ prepared, initialization, metrics: terrain.history[0].metrics }));
  for (let i = 0; i < 3; i++) await terrain.cut({ id: `profile-${i}`, center: [i * .5, 18, 0], radius: 2.6, repeat: 'impact' });
  const result = { timestamp: new Date().toISOString(), seed: input.name, prepared, initialization, edits: terrain.history, recipes: terrain.arrangement.vertices.length };
  mkdirSync('artifacts/resident-profile', { recursive: true }); writeFileSync(`artifacts/resident-profile/${process.env.TMT_RUN ?? 'latest'}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(terrain.history.slice(1).map(edit => edit.metrics)));
} finally { terrain.dispose(); }
