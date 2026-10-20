/** Checkpoint v2 (plan §6 I9, W1-GAME step 8): the setup, the tick-stamped command log and the terrain edit log.
 * Resume and undo replay the log on the same build; the snapshot hash at save time proves the replay. The strict v1
 * state validator is gone: nothing but inputs is stored, so there is no hidden state to validate. Pure. */
import type { PlayerCommand } from '../api/session';
import type { MatchSetup } from '../api/match';
import { validMunition } from '../munitions';
import { validateMatchSetup } from './setup';

/** One accepted input, applied at the boundary after tick `tick` (before tick `tick + 1` runs). */
export interface MatchCommand { readonly tick: number; readonly tank: number; readonly c: PlayerCommand }
export interface MatchCheckpointV2 {
  readonly format: 'tmt-match';
  readonly version: 2;
  readonly setup: MatchSetup;
  readonly commands: readonly MatchCommand[];
  /** The tick at save time and the snapshot hash then (rules/hash.ts): a replay must reproduce both. */
  readonly tick: number;
  readonly hash: string;
  /** SimExtension snapshots at save time, by extension id (plan §5.5). */
  readonly extensions?: Readonly<Record<string, unknown>>;
  /** The terrain edit log: the resident checkpoint (session), or null for analytic worlds. */
  terrain: unknown | null;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const COMMAND_KINDS = ['aim', 'fire', 'munition', 'scan', 'endMove', 'drive', 'hold'] as const;

/** A well-formed copy of a logged command, or an explicit error. */
export function sanitizeCommand(value: unknown): PlayerCommand {
  const c = value as Record<string, unknown> | null;
  if (!c || typeof c !== 'object' || !COMMAND_KINDS.includes(c.k as typeof COMMAND_KINDS[number])) throw new Error(`Checkpoint command ${JSON.stringify(value)} is not replayable`);
  switch (c.k) {
    case 'aim':
      if (!finite(c.yaw) || !finite(c.pitch) || !finite(c.power)) throw new Error('Checkpoint aim command needs finite yaw, pitch and power');
      return { k: 'aim', yaw: c.yaw, pitch: c.pitch, power: c.power };
    case 'drive':
      if (!finite(c.throttle) || !finite(c.steer)) throw new Error('Checkpoint drive command needs finite throttle and steer');
      return { k: 'drive', throttle: c.throttle, steer: c.steer };
    case 'munition':
      if (!validMunition(c.id)) throw new Error(`Checkpoint munition command names an unknown munition ${String(c.id)}`);
      return { k: 'munition', id: c.id };
    default: return { k: c.k } as PlayerCommand;
  }
}

export function validateMatchCheckpoint(input: unknown): MatchCheckpointV2 {
  const data = input as MatchCheckpointV2 | null;
  if (!data || typeof data !== 'object' || data.format !== 'tmt-match' || data.version !== 2) throw new Error('Not a tmt-match v2 checkpoint');
  const setup = validateMatchSetup(data.setup);
  if (!Number.isSafeInteger(data.tick) || data.tick < 0) throw new Error('Checkpoint tick must be a non-negative integer');
  if (typeof data.hash !== 'string' || !/^[0-9a-f]{16}$/.test(data.hash)) throw new Error('Checkpoint hash must be 16 hex digits');
  if (!Array.isArray(data.commands)) throw new Error('Checkpoint commands must be an array');
  let last = 0;
  const commands = data.commands.map((entry, index) => {
    if (!entry || !Number.isSafeInteger(entry.tick) || entry.tick < last || entry.tick > data.tick) throw new Error(`Checkpoint command ${index} is out of order`);
    if (!Number.isSafeInteger(entry.tank) || entry.tank < 0 || entry.tank >= setup.tanks.length) throw new Error(`Checkpoint command ${index} names an unknown tank`);
    last = entry.tick;
    return { tick: entry.tick, tank: entry.tank, c: sanitizeCommand(entry.c) };
  });
  if (data.extensions !== undefined && (typeof data.extensions !== 'object' || data.extensions === null)) throw new Error('Checkpoint extensions must be an object');
  return { format: 'tmt-match', version: 2, setup, commands, tick: data.tick, hash: data.hash,
    ...(data.extensions ? { extensions: structuredClone(data.extensions) } : {}), terrain: data.terrain === undefined ? null : structuredClone(data.terrain) };
}
