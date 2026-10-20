/** aim() clamps elevation to the kit's pitchLimits(yaw) (plan §5.3): a kit whose limits depend on the bearing (the
 * gun over the rear deck) must be honoured at every bearing. The kit barrel is wrapped so assemblies report a
 * yaw-dependent envelope; everything else is the real v1 assembly. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/game/kit', async original => {
  const kit = await original<typeof import('../src/game/kit')>();
  const wrapped = new Map<string, import('../src/game/kit').KitAssembly>();
  return {
    ...kit,
    assembleKit(loadout: import('../src/game/kit').KitLoadout) {
      const assembly = kit.assembleKit(loadout);
      let result = wrapped.get(assembly.key);
      if (!result) {
        // Over the rear deck (|yaw| > 2.5) the gun cannot depress below 0.1 rad nor rise above 1.0.
        result = { ...assembly, pitchLimits: (yaw: number) => Math.abs(yaw) > 2.5 ? { min: .1, max: 1 } : assembly.pitchLimits(yaw) };
        wrapped.set(assembly.key, result);
      }
      return result;
    },
  };
});

const { practiceSetup } = await import('../src/game/api/match');
const { GameSimulation, MAX_BARREL_PITCH, MIN_BARREL_PITCH } = await import('../src/game/simulation');
const { SphereWorld } = await import('./helpers/sphere-world');
const { assembleKit, kitLoadoutFromLegacy } = await import('../src/game/kit');

describe('pitchLimits clamp in aim()', () => {
  it('uses the envelope of the requested bearing', () => {
    const player = { tracks: 'scout', barrel: 'cannon', armor: 'light' } as const;
    const simulation = new GameSimulation(new SphereWorld(), practiceSetup({ seed: 1, mode: 'local', player }));
    const tank = simulation.state.tanks[0];
    // Front arc: the real assembly's envelope, inside the global barrel range (kit v2's Dome depresses to -15 deg by design).
    const front = assembleKit(kitLoadoutFromLegacy(player)).pitchLimits(0);
    expect(front.min).toBeGreaterThanOrEqual(MIN_BARREL_PITCH); expect(front.max).toBeLessThanOrEqual(MAX_BARREL_PITCH);
    simulation.aim(0, 0, -1, .5);
    expect(tank.barrelPitch).toBe(front.min);
    simulation.aim(0, 0, 2, .5);
    expect(tank.barrelPitch).toBe(front.max);
    simulation.aim(0, Math.PI, -1, .5);
    expect(tank.barrelPitch).toBe(.1);
    simulation.aim(0, -3, 1.3, .5);
    expect(tank.barrelPitch).toBe(1);
    // Bearings wrap before the lookup: 2π + π is the rear deck too.
    simulation.aim(0, 3 * Math.PI, -1, .5);
    expect(tank.barrelPitch).toBe(.1);
  });
});
