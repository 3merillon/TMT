/** Reproducible headless CPU measurements, using the game's real Rapier tank bridge. GPU is measured separately.
 * Run: node --import tsx scripts/bench-tank-designs.ts */
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { assembleKit, type KitLoadout } from '../src/game/kit';
import { withWorld, tilt } from '../tests/helpers/vehicle-world';
import { armorResponse } from '../src/game/rules/armor';

const common = { runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' } as const;
const builds: KitLoadout[] = ['skiff', 'warden', 'bastion'].map(hull => ({ ...common, hull } as KitLoadout));
builds.push({ ...common, hull: 'bastion', armor: 'reactive' });
const fantasy: KitLoadout[] = [
  { hull: 'aether_hull', runningGear: 'aether_drive', turret: 'aether_crown', weapon: 'arc_cannon', utility: 'aether_vane' },
  { hull: 'forge_hull', runningGear: 'forge_tracks', turret: 'forge_casemate', weapon: 'forge_mortar', utility: 'steam_sentinel' },
];
builds.push(...fantasy);
const rows = [];
for (const build of builds) rows.push(await withWorld(w => {
  w.addPlane();
  const t = w.addTank({ kit: build, position: [0, .6, 0] }), kit = assembleKit(build);
  w.run(120); w.run(30, () => ({ throttle: 1, steer: 0 }));
  const speedAtHalfSecond = t.velocity[2];
  w.run(90, () => ({ throttle: 1, steer: 0 }));
  const speed = t.velocity[2], stopFrom = t.position[2];
  w.run(90); const stopDistance = t.position[2] - stopFrom;
  w.run(120, () => ({ throttle: 0, steer: 1 })); const pivot = Math.abs(t.yawVelocity);
  w.run(120, () => ({ throttle: 1, steer: 1 }));
  const response = armorResponse({ position: [0, 0, 0], rotation: [0, 0, 0, 1] }, kit,
    { point: [0, 0, .7], direct: true, weapon: 'cannon', munition: 'explosive' });
  return { build, cost: kit.stats.cost, mass: kit.stats.mass, hp: kit.stats.hp, damage: kit.stats.damage, tempo: kit.stats.tempo, fuel: kit.stats.fuel, inertia: kit.massProps.inertia, speedAtHalfSecond, speed,
    stopDistance, pivot, movingTurn: Math.abs(t.yawVelocity), upDot: tilt(t).upDot, cannonFrontDamage: Math.round(70 * response.multiplier) };
}));
const costs = [];
const scenarios = [
  ...(['standard', 'reactive'] as const).map(armor => ({ name: armor, armor, build: { ...common, hull: 'bastion', armor } as KitLoadout })),
  ...fantasy.map(build => ({ name: build.hull, armor: 'standard' as const, build })),
];
for (const count of [1, 4, 8]) for (const scenario of scenarios) costs.push(await withWorld(w => {
  w.addPlane();
  const input = Array.from({ length: count }, () => ({ throttle: 1, steer: .3 }));
  for (let i = 0; i < count; i++) w.addTank({ kit: scenario.build, position: [i * 12, .6, 0] });
  w.run(120); w.run(240, () => input);
  const times = [];
  for (let tick = 0; tick < 1200; tick++) {
    const start = performance.now(); w.step(input); times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { count, scenario: scenario.name, armor: scenario.armor, ticks: times.length, medianMs: times[Math.floor(times.length * .5)], p95Ms: times[Math.floor(times.length * .95)],
    meanMs: times.reduce((a, b) => a + b, 0) / times.length, maxMs: times.at(-1) };
}));
const result = { environment: { node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length }, rows, costs };
mkdirSync('artifacts/tank-designs', { recursive: true });
writeFileSync('artifacts/tank-designs/armor-benchmark.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
