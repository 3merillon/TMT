/**
 * Kit interference, full sweep (W1-KIT acceptance): 0 overlaps deeper than 1 mm across every legal assembly
 * and joint sweep: hull × running gear over 3^4 suspension combinations per side × 3 belt phases plus each pair
 * of neighbouring stations over a 7 × 7 grid of deflections (A), the
 * turret stack over yaw in 2° steps (B), the gun against its turret over pitch in 1° steps with the tube in and
 * recoiled, hatch and utility-head states (C), and the gun against the hull from pitchLimits(yaw).min to the
 * maximum, 1° steps, every 2° of yaw (D). Reports a 30 s CPU target separately from correctness;
 * npm run verify:performance explicitly enforces it on comparable hardware. Process CPU excludes time
 * spent waiting for other processes, but still depends on the processor, runtime and operating system.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { setValidatorClock, validateKit } from '../src/game/kit/validate';
import { reportPerformanceTarget } from './helpers/performance-target';

const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

describe('kit interference (full sweep)', () => {
  afterAll(() => setValidatorClock(() => 0));

  it('finds 0 overlaps > 1 mm across all 4680 legal assemblies and joint sweeps', () => {
    setValidatorClock(cpuMs);
    const wall = performance.now();
    const r = validateKit();
    const wallMs = performance.now() - wall;
    const list = r.overlaps.slice(0, 10).map(o => `${o.a} × ${o.b} ${(o.depth * 1000).toFixed(1)} mm @ ${o.state}`);
    expect(list).toEqual([]);
    expect(r.assemblies).toBe(4680);
    expect(r.states).toBeGreaterThan(1_800_000);
    const byCheck = { A: 0, B: 0, C: 0, D: 0 } as Record<string, number>;
    for (const [key, sweep] of Object.entries(r.byCheck)) byCheck[key[0]] += sweep.states;
    for (const check of ['A', 'B', 'C', 'D']) expect(byCheck[check], check).toBeGreaterThan(5000);
    console.info(`kit interference: ${r.states} states, ${r.ms.toFixed(0)} ms CPU, ${wallMs.toFixed(0)} ms wall`);
    reportPerformanceTarget({ name: 'Full kit collision sweep', value: r.ms, target: 30000, unit: 'ms CPU', comparison: '<=' });
  }, 180000);
});
