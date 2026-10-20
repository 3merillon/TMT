import { describe, expect, it } from 'vitest';
import { damagedDrive, damageVehicle, impactModule, repairVehicle, validMachinery, vehicleFailureMask, weaponOperational } from '../src/game/rules/vehicle-damage';
import { add, rotate } from '../src/game/math';
import { realtimeRun, realtimeSetup, site, unit } from './helpers/realtime';
import type { TankState, V3 } from '../src/game/contracts';

const tank = (): TankState => ({ position: [0, 18.5, 0], rotation: [0, 0, 0, 1], health: 100, maxHealth: 100 } as TankState);
describe('localized vehicle machinery', () => {
  it('selects the same struck machinery at every planetary orientation', () => {
    const t = tank();
    for (const q of [[0, 0, 0, 1], [.5, .5, .5, .5], [0, Math.SQRT1_2, 0, Math.SQRT1_2]] as const) {
      t.rotation = [...q];
      for (const [local, expected] of [[[.8, -.1, .2], 'leftTrack'], [[-.8, -.1, .2], 'rightTrack'], [[0, .1, -.7], 'engine'], [[0, .6, .4], 'weapon']] as [V3, string][]) {
        expect(impactModule(t, add(t.position, rotate(local, t.rotation)))).toBe(expected);
      }
    }
  });
  it('spares machinery when armor/friendly-fire rules prevented damage', () => {
    const t = tank(); damageVehicle(t, [0, 19, 0], 0, true); expect(t.machinery).toBeUndefined();
    damageVehicle(t, [0, 19, 0], NaN, true); expect(t.machinery).toBeUndefined();
  });
  it('breaks only the struck belt, preserving the other side and hull accounting', () => {
    const t = tank(); damageVehicle(t, [.8, 18.4, 0], 35, true);
    expect(t.health).toBe(100); expect(vehicleFailureMask(t)).toBe(1);
    expect(damagedDrive(t, { throttle: 1, steer: 0 })).toEqual({ throttle: .5, steer: -.5 });
    damageVehicle(t, [-.8, 18.4, 0], 35, true);
    expect(damagedDrive(t, { throttle: 1, steer: 1 })).toEqual({ throttle: 0, steer: 0 });
  });
  it('preserves full steering when the only damaged module is the gun', () => {
    const t = tank(); damageVehicle(t, [0, 19.1, 0], 60, true);
    expect(weaponOperational(t)).toBe(false);
    expect(damagedDrive(t, { throttle: 1, steer: .7 })).toEqual({ throttle: 1, steer: .7 });
    repairVehicle(t, 50); expect(weaponOperational(t)).toBe(true); expect(vehicleFailureMask(t)).toBe(0);
  });
  it('splash damages machinery less than a penetrating contact', () => {
    const direct = tank(), blast = tank();
    damageVehicle(direct, [0, 18.6, -.7], 30, true); damageVehicle(blast, [0, 18.6, -.7], 30, false);
    expect(blast.machinery!.engine).toBeGreaterThan(direct.machinery!.engine);
  });
  it('recognizes aircraft power and lift units, and validates checkpoint integrity', () => {
    const t = tank(); t.visualKind = 'dragonfly'; expect(impactModule(t, [0, 19.3, -.1])).toBe('engine');
    t.visualKind = 'skimmer'; expect(impactModule(t, [-.7, 18.2, .4])).toBe('rightTrack');
    expect(validMachinery(undefined)).toBe(true);
    damageVehicle(t, [-.7, 18.2, .4], 10, true); expect(validMachinery(t.machinery)).toBe(true);
    t.machinery!.engine = NaN; expect(validMachinery(t.machinery)).toBe(false);
  });
  it('separates the gunship intake lips, rear rocket pods and rotor drivetrain', () => {
    const t = tank(); t.visualKind = 'dragonfly';
    for (const q of [[0, 0, 0, 1], [.5, .5, .5, .5]] as const) {
      t.rotation = [...q];
      for (const [local, expected] of [[[.36, .38, .07], 'engine'], [[-.35, .38, .03], 'engine'], [[.3, .36, -.30], 'engine'], [[-.3, .36, -.30], 'engine'],
        [[.6, -.1, -.4], 'weapon'], [[-.6, -.1, -.4], 'weapon'], [[0, .8, -.34], 'engine'], [[.15, .45, -2.2], 'engine']] as [V3, string][]) {
        expect(impactModule(t, add(t.position, rotate(local, t.rotation)))).toBe(expected);
      }
    }
  });
  it('blocks actual launch and restores it with a repair command, including at full hull health', () => {
    const run = realtimeRun(realtimeSetup(), { units: [unit(1, site(12), { unarmed: true })] }), m = run.match, t = m.state.tanks[0];
    damageVehicle(t, add(t.position, rotate([0, .6, 0], t.rotation)), t.maxHealth!, true);
    expect(m.canFire(0)).toBe(false); expect(m.command(0, { k: 'fire' })).toBe(false);
    expect(m.command(0, { k: 'utility', id: 'repair' })).toBe(true);
    expect(m.canFire(0)).toBe(true); expect(m.command(0, { k: 'fire' })).toBe(true);
    m.dispose();
  });
});
