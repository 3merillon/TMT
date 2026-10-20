import type { TankComponent, TankState, V3 } from '../contracts';
import { add, rotate } from '../math';

export const CRAWLER_COMPONENTS: readonly TankComponent[] = [
  ...([-1, 1] as const).flatMap(side => ([-1, 1] as const).map(end => ({
    id: `drive-${side}-${end}`, name: `${side > 0 ? 'Left' : 'Right'} ${end > 0 ? 'front' : 'rear'} drive`, kind: 'drive' as const,
    offset: [side * .85, -.12, end * .65] as V3, radius: .27, stage: 0, health: 45, maxHealth: 45,
  }))),
  ...([-1, 1] as const).map(side => ({ id: `pod-${side}`, name: `${side > 0 ? 'Left' : 'Right'} mortar feed`, kind: 'weapon' as const,
    offset: [side * .54, .5, -.22] as V3, radius: .27, stage: 1, health: 70, maxHealth: 70 })),
  { id: 'core', name: 'Exposed furnace core', kind: 'core', offset: [0, .35, -.66], radius: .3, stage: 2, health: 160, maxHealth: 160 },
];
export function componentPoint(tank: Pick<TankState, 'position' | 'rotation'>, component: TankComponent): V3 {
  return add(tank.position, rotate(component.offset, tank.rotation));
}
export function componentStage(tank: Pick<TankState, 'components'>): number {
  return Math.min(...(tank.components ?? []).filter(c => c.health > 0).map(c => c.stage));
}
export function activeComponents(tank: Pick<TankState, 'components'>): TankComponent[] {
  const stage = componentStage(tank);
  return (tank.components ?? []).filter(c => c.health > 0 && c.stage === stage);
}
/** Stored checkpoints cross a trust boundary before any records are packed into WASM. */
export function validComponents(value: unknown): value is TankComponent[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return false;
  const ids = new Set<string>();
  return value.every(c => {
    if (!c || typeof c.id !== 'string' || !c.id || ids.has(c.id) || typeof c.name !== 'string' || !['drive', 'weapon', 'core'].includes(c.kind)
      || !Array.isArray(c.offset) || c.offset.length !== 3 || !c.offset.every(Number.isFinite)
      || !Number.isFinite(c.radius) || c.radius <= 0 || !Number.isSafeInteger(c.stage) || c.stage < 0
      || !Number.isFinite(c.health) || !Number.isFinite(c.maxHealth) || c.health < 0 || c.maxHealth <= 0 || c.maxHealth < c.health) return false;
    ids.add(c.id); return true;
  });
}
export function validComponentState(tank: Pick<TankState, 'health' | 'components'>, template: readonly TankComponent[] | undefined): boolean {
  const parts = tank.components;
  if (!template) return parts === undefined;
  return validComponents(parts) && validComponents(template) && template.length === parts.length && parts.every((c, i) => {
    const original = template[i];
    return c.id === original.id && c.kind === original.kind && c.stage === original.stage && c.radius === original.radius
      && c.maxHealth === original.maxHealth && c.offset.every((v, axis) => v === original.offset[axis]);
  }) && Math.abs(parts.reduce((sum, c) => sum + c.health, 0) - tank.health) < 1e-4;
}
