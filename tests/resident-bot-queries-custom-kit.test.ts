/** A custom kit's public pitchLimits callback stays a host contract under engine v16: the resident controller returns
 * only that elevation request to the host and resumes in the engine with its answer. Every kit in this file is a
 * value-preserving custom wrapper, so the engine holds no clearance table for any of them. */
import { expect, it, vi } from 'vitest';
import { GameSimulation } from '../src/game/simulation';
import { botWorld, botSetup, play } from './helpers/rust-resident';

const calls = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/game/kit', async original => {
  const kit = await original<typeof import('../src/game/kit')>(), wrapped = new WeakMap<object, unknown>();
  return { ...kit, assembleKit: ((loadout: Parameters<typeof kit.assembleKit>[0]) => {
    const a = kit.assembleKit(loadout); let custom = wrapped.get(a);
    if (!custom) wrapped.set(a, custom = { ...a, pitchLimits: (yaw: number) => { calls.count++; return a.pitchLimits(yaw); } });
    return custom;
  }) as typeof kit.assembleKit };
});

it.each(['rusty', 'cyborg'] as const)('v16 %s resumes in the engine after the host answers a custom kit elevation callback', async profile => {
  const a = await botWorld(1), b = await botWorld(1); b.botQuery = () => undefined;
  const sa = new GameSimulation(a, botSetup(profile)), sb = new GameSimulation(b, botSetup(profile));
  try {
    const host = sa as unknown as { trace: unknown; meteredWorld: unknown };
    host.trace = () => { throw new Error('host trace called'); }; host.meteredWorld = () => { throw new Error('host metered query called'); };
    const before = calls.count; await play(sa, 900); const resident = calls.count - before;
    await play(sb, 900);
    expect(sa.aiTelemetry().decisions).toBeGreaterThanOrEqual(1); expect(resident).toBeGreaterThan(0);
    expect(sa.state).toEqual(sb.state); expect(sa.commandLog()).toEqual(sb.commandLog()); expect(sa.aiTelemetry()).toEqual(sb.aiTelemetry());
  } finally { sa.dispose(); sb.dispose(); a.dispose(); b.dispose(); }
}, 120000);
