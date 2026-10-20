import type { PlayerCommand } from '../api/session';
import type { NetworkSnapshot, Recovery } from './state';
import { sanitizeCommand, validateMatchCheckpoint } from '../rules/checkpoint';
import { validateMatchSetup } from '../rules/setup';
import { validateResidentCheckpoint } from '../resident-checkpoint';
import { validateKitLoadout } from '../kit';
import { MAX_REALTIME_UNITS } from '../realtime/rules';
import { validateLiquidCheckpoint } from '../liquids';

export function networkCommand(value: unknown): PlayerCommand {
  const c = value as PlayerCommand;
  if (c?.k === 'utility') {
    if (!['repair', 'headlights', 'ultimate', 'squad-follow', 'squad-hold', 'squad-rally', 'ending-rewind', 'ending-release'].includes(c.id)
      && !/^assign:(mags|brann|seraphine):[a-z0-9-]{1,32}$/.test(c.id)) throw new Error('Unknown utility.');
    return { k: 'utility', id: c.id };
  }
  const command = sanitizeCommand(value);
  if (command.k === 'drive') return { k: 'drive', throttle: Math.max(-1, Math.min(1, command.throttle)), steer: Math.max(-1, Math.min(1, command.steer)) };
  return command;
}
export function validateNetworkSnapshot(input: unknown): NetworkSnapshot {
  const v = input as NetworkSnapshot;
  if (!v || !v.state || !Number.isSafeInteger(v.state.tick) || v.state.tick < 0 || !Array.isArray(v.state.tanks)
    || v.state.tanks.length < 2 || v.state.tanks.length > MAX_REALTIME_UNITS || !Array.isArray(v.state.projectiles) || v.state.projectiles.length > 1024
    || !v.world || !Number.isSafeInteger(v.world.from) || v.world.from < 0 || !Number.isSafeInteger(v.world.count) || v.world.count < v.world.from
    || !Array.isArray(v.world.edits) || v.world.edits.length !== v.world.count - v.world.from || v.world.edits.length > 20_000
    || !Array.isArray(v.world.bodies) || v.world.bodies.length > 1024 || !Array.isArray(v.world.chassis) || v.world.chassis.length > MAX_REALTIME_UNITS) throw new Error('Invalid world snapshot.');
  for (const [i, tank] of v.state.tanks.entries()) {
    if (tank.id !== i || tank.position?.length !== 3 || tank.rotation?.length !== 4 || !Number.isFinite(tank.health)) throw new Error('Invalid tank snapshot.');
  }
  if (v.realtime && (v.realtime.units?.length !== v.state.tanks.length || v.realtime.state.tick !== v.state.tick)) throw new Error('Invalid NPC snapshot.');
  for (const unit of v.realtime?.units ?? []) validateKitLoadout(unit.spec.loadout);
  if (v.world.liquids) validateLiquidCheckpoint(v.world.liquids);
  finiteTree(v); return v;
}
export function validateRecovery(input: unknown): Recovery {
  const r = input as Recovery;
  if (!r || (!!r.turn === !!r.realtime)) throw new Error('Invalid recovery format.');
  if (!Array.isArray(r.terrain?.edits) || r.terrain.edits.length > 20_000) throw new Error('Recovery terrain history exceeds 20,000 edits.');
  const setup = validateMatchSetup(r.setup), terrain = validateResidentCheckpoint(r.terrain);
  if (setup.seed !== terrain.seed) throw new Error('Recovery planet mismatch.');
  if (r.turn) return { setup, terrain, turn: validateMatchCheckpoint(r.turn) };
  const rt = r.realtime!;
  if (!Array.isArray(rt.units) || rt.units.length < 2 || rt.units.length > MAX_REALTIME_UNITS || rt.state?.tanks?.length !== rt.units.length
    || !Array.isArray(rt.state.projectiles) || rt.state.projectiles.length > 1024 || !Array.isArray(rt.core) || !Array.isArray(rt.sightings)) throw new Error('Invalid realtime recovery.');
  rt.units.forEach(u => validateKitLoadout(u.spec.loadout)); finiteTree(rt);
  return { setup, terrain, realtime: rt };
}
function finiteTree(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error('Network data is nested too deeply.');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Network data contains a non-finite number.');
  if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid network object key.');
    finiteTree(v, depth + 1);
  }
}
