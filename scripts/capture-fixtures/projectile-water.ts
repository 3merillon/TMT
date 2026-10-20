/** Real resident gameplay in a natural basin; invoked by the projectile-water capture plan. */
import { session } from '../../src/game/api/session';
import { registerHooks } from '../../src/game/app/hooks';
import { cellDir } from '../../src/world/cube-grid';
import { add, mul, normalize, rotation, distance } from '../../src/game/math';
import { advanceFlight, FIXED_DT, type Flight } from '../../src/game/rules/ballistics';
import { projectileWater } from '../../src/game/rules/projectile-water';
import { GRAVITY_BALLISTIC } from '../../src/game/world-constants';
import type { V3 } from '../../src/game/contracts';

export async function prepareProjectileWater() {
  const w = window as any, game = session() as any, sim = game.simulation, world = game.world;
  if (!sim?.nativeMatch?.shots) throw new Error('Qualification requires resident live shots');
  let scale = 0;
  const samples: any[] = [], events: any[] = [];
  registerHooks('projectile-water-qualification', { timeScale: () => scale,
    onEvent(e) { if (e.type === 'impact') events.push(structuredClone(e)); },
    onFrame(f) { const p = f.snapshot?.projectiles[0]; if (p && samples.at(-1)?.age !== p.age) samples.push(structuredClone(p)); },
  });
  const basins = world.liquidBasins(), water = projectileWater(basins);
  if (!water) throw new Error('No canonical water');
  let best: { point: V3; depth: number; rank: number } | undefined;
  for (let c = 0; c < basins.labels.length; c += 11) {
    const b = basins.basins[basins.labels[c] - 1]; if (b?.material !== 'water') continue;
    const up = cellDir(basins.n, c), hit = world.surface(up); if (!hit) continue;
    const depth = b.level - Math.hypot(...hit.point);
    if (depth < 2.3 || depth > 5) continue;
    const rank = Math.abs(depth - 3) + (1 - up[1]) * 2;
    if (!best || rank < best.rank) best = { point: hit.point, depth, rank };
  }
  if (!best) throw new Error('No submerged firing site');
  const tank = sim.state.tanks[0], up = normalize(best.point);
  tank.position = add(best.point, mul(up, .65)); tank.rotation = rotation(up, 0); tank.heading = 0; tank.velocity = [0, 0, 0];
  world.relocateTank(tank); sim.nativeMatch.motion.restore(tank);
  let chosen: { yaw: number; pitch: number; points: V3[] } | undefined;
  for (let i = 0; i < 12; i++) for (const pitch of [.15, .35, .65]) {
    const yaw = i * Math.PI / 6; game.command(0, { k: 'aim', yaw, pitch, power: .8 });
    const points = sim.previewPrediction(0, true).points;
    if (!chosen || points.length > chosen.points.length) chosen = { yaw, pitch, points };
  }
  if (!chosen || chosen.points.length < 6) throw new Error('Submerged muzzle is obstructed');
  game.command(0, { k: 'aim', yaw: chosen.yaw, pitch: chosen.pitch, power: .8 });
  const preview = sim.previewPrediction(0, true);
  if (!preview.hit) throw new Error('Expected a terrain landing');
  if (!game.command(0, { k: 'fire' })) throw new Error('Fire rejected');
  const launch = structuredClone(sim.state.projectiles[0]);
  const muzzleDepth = water.levels[(await import('../../src/world/cube-grid')).cellOfDir(water.n, launch.position)] - Math.hypot(...launch.position);
  if (muzzleDepth < .25) throw new Error(`Muzzle is not underwater: ${muzzleDepth}`);
  w.__tmtFluids.lookAt(add(tank.position, mul(up, .7)), .25, 4, chosen.yaw);
  w.__projectileWater = { samples, events, launch, preview, siteDepth: best.depth, muzzleDepth,
    finish() {
      const sample = samples.find(p => p.age >= .2); if (!sample) throw new Error('No underwater flight sample');
      const initial = Math.hypot(...launch.velocity), current = Math.hypot(...sample.velocity);
      if (current >= initial * .55) throw new Error(`Insufficient drag: ${initial} -> ${current}`);
      const wet: Flight = { position: launch.position, vx: launch.velocity[0], vy: launch.velocity[1], vz: launch.velocity[2], age: 0, launchTick: launch.launchTick };
      const dry = structuredClone(wet), gravity = GRAVITY_BALLISTIC * game.setup.rules.gravityScale;
      for (let i = 0; i < Math.round(sample.age / FIXED_DT); i++) {
        advanceFlight(wet, { gravity, wind: null, windFactor: 0, water }); advanceFlight(dry, { gravity, wind: null, windFactor: 0 });
      }
      if (distance(wet.position, sample.position) > 1e-7) throw new Error('Resident live shot differs from shared water physics');
      const impact = events[0]; if (!impact || distance(impact.position, preview.points.at(-1)) > 1e-7) throw new Error('Live impact differs from preview');
      return { nativeLiveShots: true, siteDepth: best!.depth, muzzleDepth, initialSpeed: initial, speedAtSample: current, sampleAge: sample.age,
        dryDistance: distance(launch.position, dry.position), wetDistance: distance(launch.position, sample.position), previewImpactError: distance(impact.position, preview.points.at(-1)), samples: samples.length,
        validationErrors: w.__tmtGame.performance.validationErrors, compileErrors: w.__tmtGame.performance.compileErrors };
    },
  };
  scale = .2;
  return { siteDepth: best.depth, muzzleDepth, launch, preview };
}
