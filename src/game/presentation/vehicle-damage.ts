/** Damage sources feed the same pressure-projected volume renderer as explosions. */
import type { SceneRegistry } from '../../engine';
import type { VehicleFireSource } from '../../engine/passes/fluids/vehicle-fire';
import type { GameSnapshot, TankState, V3 } from '../contracts';
import { add, rotate } from '../math';
import { MODULE_DISABLED } from '../rules/vehicle-damage';
export function damageStage(health: number, max: number): number {
  if (health <= 0) return 4;
  const ratio = health / Math.max(1, max);
  return ratio > .75 ? 0 : ratio > .5 ? 1 : ratio > .25 ? 2 : 3;
}
export function wreckPresence(tank: TankState, tick: number): number {
  if (tank.retired) return 0;
  if (tank.health > 0 || tank.destroyedAt === undefined) return 1;
  return Math.max(0, Math.min(1, (25 * 60 - (tick - tank.destroyedAt)) / 120));
}
export function vehicleFireSource(t: TankState, tick: number): VehicleFireSource | null {
  const stage = damageStage(t.health, t.maxHealth ?? 130);
  const engine = t.machinery?.engine ?? 1;
  if (t.retired || wreckPresence(t, tick) <= 0 || stage < 2 && engine > .5) return null;
  const failed = t.components?.find(c => c.health <= 0);
  const site: V3 = failed ? [...failed.offset] : t.machinery ? [...t.machinery.impact] : [0, .32, -.48];
  site[1] = Math.max(.48, site[1] + .18);
  const position = add(t.position, rotate(site, t.rotation));
  return { key: `vehicle:${t.id}:${t.generation ?? 0}`, position, burning: stage >= 3 || engine <= MODULE_DISABLED,
    intensity: Math.min(1, Math.max(.25, stage * .23, 1 - engine)) * wreckPresence(t, tick) };
}
export class VehicleDamage {
  constructor(private readonly scene: SceneRegistry) {}
  update(state: GameSnapshot, _dt: number, visible: (tank: TankState) => boolean): void {
    const sources: VehicleFireSource[] = [];
    for (const tank of state.tanks) if (visible(tank)) {
      const source = vehicleFireSource(tank, state.tick); if (source) sources.push(source);
    }
    this.scene.get('fluids')?.vehicleFires(sources);
  }
  clear(): void { this.scene.get('fluids')?.vehicleFires([]); }
  dispose(): void { this.clear(); }
}
