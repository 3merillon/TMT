import { expect, it, vi } from 'vitest';
import type RAPIER from '@dimforge/rapier3d-compat';
import { DEFAULT, HEAVY, IDLE, TICK, VehicleWorld, flatTank } from './helpers/vehicle-world';
import type { DriveInput } from '../src/game/contracts';
import type { TankTouch } from '../src/game/vehicle/drive-model';
import type { ResidentTanks } from '../src/game/resident-tanks';
interface Entry { body: RAPIER.RigidBody; touch: TankTouch; shaped: { throttle: number; steer: number }; recovery: { righting: number; flipped: number }; assists: { recovery(): void; righting(): void; selfRightStep(): void } }
interface Internals { chassis: Map<number, Entry>; entries: Entry[]; probeTankContacts(tanks: VehicleWorld['tanks']): void }
const internals = (bridge: ResidentTanks) => bridge as unknown as Internals;

it('reconciles an already-created native chassis without registering a second controller', async () => {
  vi.stubEnv('TMT_NATIVE_PHYSICS', '1'); const w = await VehicleWorld.create();
  try {
    w.addPlane(); flatTank(w, DEFAULT); w.run(60);
    const tank = structuredClone(w.tanks[0]), motion = w.bridge.motions();
    w.run(20, () => ({ throttle: 1, steer: .4 }));
    Object.assign(w.tanks[0], tank); w.bridge.restore(motion);
    expect(w.bridge.motions()).toEqual(motion);
    // Repeated authoritative updates preserve native control state and remain driveable.
    w.bridge.restore(motion); w.run(10, () => ({ throttle: 1, steer: 0 }));
    expect(w.tanks[0].position.every(Number.isFinite)).toBe(true);
    expect(w.bridge.motions()[0].drive!.throttle).toBeGreaterThan(0);
  } finally { w.dispose(); vi.unstubAllEnvs(); }
});

it('drives fourteen resident chassis and removes a retired body without a six-slot ceiling', async () => {
  vi.stubEnv('TMT_NATIVE_PHYSICS', '1'); const w = await VehicleWorld.create();
  try {
    w.addPlane();
    for (let i = 0; i < 14; i++) flatTank(w, DEFAULT, [(i % 7 - 3) * 3.5, 0, Math.floor(i / 7) * 5]);
    w.run(90);
    const start = w.tanks.map(t => t.position[2]);
    w.run(120, () => w.tanks.map(() => ({ throttle: .6, steer: 0 })));
    expect(internals(w.bridge).chassis.size).toBe(14);
    for (const t of w.tanks) { expect(t.position.every(Number.isFinite)).toBe(true); expect(t.position[2] - start[t.id]).toBeGreaterThan(.5); }
    const removed = w.tanks.pop()!; w.bridge.remove(removed.id); w.run(1);
    expect(internals(w.bridge).chassis.size).toBe(13); expect(w.physics.actors.size).toBe(13);
  } finally { w.dispose(); vi.unstubAllEnvs(); }
});
function close(a: number[], b: number[], tolerance: number) { expect(a.length).toBe(b.length); for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i]), `word ${i}`).toBeLessThan(tolerance); }

it('batches two chassis without host contact/assist calls; rejects a bad batch before changing the first body', async () => {
  vi.stubEnv('TMT_NATIVE_PHYSICS', '1'); const w = await VehicleWorld.create();
  try {
    w.addPlane(); flatTank(w, DEFAULT); flatTank(w, HEAVY, [0, 0, 4]); w.run(120);
    const entries = [...internals(w.bridge).chassis.values()], fail = () => { throw new Error('Host chassis callback'); };
    for (const e of entries) { vi.spyOn(e.assists, 'recovery').mockImplementation(fail); vi.spyOn(e.assists, 'righting').mockImplementation(fail); vi.spyOn(e.assists, 'selfRightStep').mockImplementation(fail); }
    const native = w.physics.native!, call = native.call.bind(native), calls: number[] = [];
    const boundary = vi.spyOn(native, 'call').mockImplementation((op, id, words) => {
      calls.push(op); if ([12, 13, 40, 41, 42, 61, 62, 63].includes(op)) throw new Error(`Per-body host call ${op}`); return call(op, id, words);
    });
    for (let i = 0; i < 180; i++) { calls.length = 0; w.step([{ throttle: 1, steer: i > 120 ? -.4 : 0 }, IDLE]); expect(calls).toEqual([70, 71, 50, 52]); }
    boundary.mockRestore();
    const body = entries[0].body, before = native.call(12, body.handle).slice();
    const command = [body.handle, 1, 1, 0, 1, 1, 1, .8, 100, 0, 0];
    expect(() => native.call(71, 0, [TICK, ...w.physics.planetCenter, 2, ...command, 0xffffffff, ...command.slice(1)])).toThrow('Unknown native body');
    expect(native.call(12, body.handle)).toEqual(before);
    // Poison only the host mirrors. Native persistent input/recovery remains valid.
    entries[0].shaped.throttle = NaN; entries[0].recovery.righting = NaN; w.step(IDLE);
    const drive = w.bridge.motions()[0].drive!; expect(Object.values(drive).every(Number.isFinite)).toBe(true);
  } finally { w.dispose(); vi.unstubAllEnvs(); }
});

it('matches the original manifold aggregation on real ramming contacts', async () => {
  vi.stubEnv('TMT_NATIVE_PHYSICS', '1'); const w = await VehicleWorld.create();
  try {
    w.addPlane(); flatTank(w, DEFAULT); flatTank(w, HEAVY, [0, 0, 3]); w.run(120);
    let touched = 0;
    for (let i = 0; i < 200; i++) {
      const bridge = internals(w.bridge); bridge.probeTankContacts(w.tanks);
      const oracle = bridge.entries.map(e => structuredClone(e.touch));
      w.step([{ throttle: 1, steer: i > 120 ? -1 : 0 }, IDLE]);
      bridge.entries.forEach((e, j) => { const t = oracle[j]; touched += +(t.count > 0); expect(e.touch.count).toBe(t.count); close([e.touch.total, e.touch.force, ...Object.values(e.touch.moment)], [t.total, t.force, ...Object.values(t.moment)], 1e-8); });
    }
    expect(touched).toBeGreaterThan(20);
  } finally { w.dispose(); vi.unstubAllEnvs(); }
});

it.each([false, true])('preserves prior chassis behavior and drive state through native batch, recovery=%s', async recover => {
  vi.stubEnv('TMT_NATIVE_PHYSICS', '1'); const a = await VehicleWorld.create(), b = await VehicleWorld.create(); a.physics.nativeChassis = false;
  try {
    for (const w of [a, b]) { w.addPlane(); if (recover) w.addTank({ position: [0, 1.4, 0], rotation: [0, 0, 1, 0] }); else flatTank(w, DEFAULT); }
    for (let i = 0; i < 420; i++) {
      const input: DriveInput = recover ? { throttle: 0, steer: 0, selfRight: i === 120 } : i < 120 ? IDLE : i < 240 ? { throttle: 1, steer: -.4 } : { throttle: -.37, steer: .25 };
      a.step(input); b.step(input);
      const x = a.tanks[0], y = b.tanks[0]; close([...y.position, ...y.velocity, ...y.rotation, ...y.trackSpeeds], [...x.position, ...x.velocity, ...x.rotation, ...x.trackSpeeds], .002);
      const old = a.bridge.motions()[0].drive!, now = b.bridge.motions()[0].drive!;
      close([now.throttle, now.steer, now.common], [old.throttle, old.steer, old.common], 1e-7); expect([now.righting, now.flipped]).toEqual([old.righting, old.flipped]);
    }
  } finally { a.dispose(); b.dispose(); vi.unstubAllEnvs(); }
});
