/** Actual deterministic shell flight and emitted hit, reused by the production-renderer visual check. */
import assert from 'node:assert/strict';
import { practiceSetup } from '../../src/game/api/match';
import { FIXED_DT, GameSimulation } from '../../src/game/simulation';
import { TANK_TARGET_RADIUS } from '../../src/game/rules/aim-target';
import type { ImpactEvent } from '../../src/game/contracts';
import { SphereWorld } from '../../tests/helpers/sphere-world';

export function tankCombatFixture() {
  const setup = practiceSetup({ seed: 7, mode: 'local', player: { tracks: 'scout', armor: 'light', barrel: 'cannon' } });
  setup.tanks[0].spawn = { up: [0, 1, 0], heading: 0 };
  setup.tanks[1].spawn = { up: [0, 1, .3], heading: Math.PI };
  setup.tanks[1].loadout = { hull: 'bastion', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna', armor: 'reactive' };
  const game = new GameSimulation(new SphereWorld(), setup), target = game.state.tanks[1];
  const aim = game.solveAimTarget(0, { point: [...target.position], object: { kind: 'tank', id: 'tank:1',
    collider: { shape: 'sphere', center: [...target.position], radius: TANK_TARGET_RADIUS } } }, { yaw: 0, pitch: -.08, power: .7 });
  assert.equal(aim.status, 'ready'); assert.ok(game.command(0, { k: 'aim', ...aim.aim! })); assert.ok(game.fire(0));
  let event: ImpactEvent | undefined;
  // Retain the hull pose at the emitted hit, before later blast motion or settling can move it.
  for (let i = 0; i < 360 && !game.stalledOn && !event; i++) {
    event = game.step(FIXED_DT).find((e): e is ImpactEvent => e.type === 'impact' && !!e.hits?.some(h => h.tank === 1 && h.direct && h.reactiveSpent === 1));
  }
  assert.ok(event); assert.equal(target.reactiveArmor, 1); assert.ok(target.health < target.maxHealth!);
  return { id: target.id, position: target.position, rotation: target.rotation, health: target.health, reactiveArmor: target.reactiveArmor!, event };
}
