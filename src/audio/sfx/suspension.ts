/**
 * Suspension thumps: per-wheel compression rates from `wheelSuspension` (eight compressions, 0.5 nominal), measured
 * per simulation tick so the display rate never changes the result. A wheel compressing faster than the threshold
 * plays a thump at the tank (the loudest wheel sets the intensity; several at once, a landing, hit harder).
 */
import type { AudioManager } from '../audio-manager';
import { hash32 } from '../rng';
import { PRIORITY } from '../voice-select';
import { suspensionThumpRecipe, THUMP_RATE_THRESHOLD, thumpIntensity } from './tank-sfx-math';

export interface SuspendedTank { position: readonly [number, number, number]; wheelSuspension: readonly number[] }

const SIM_HZ = 60;
/** Tanks farther than this from the listener are not analysed (u). */
const THUMP_RANGE = 26;
/** Minimum gap between two thumps of one tank (s). */
const THUMP_GAP = 0.07;

interface WheelState { tick: number; wheels: number[]; last: number }

export class SuspensionThumps {
  private readonly state = new Map<number, WheelState>();
  thumps = 0;

  reset(): void { this.state.clear(); }

  update(m: AudioManager, tanks: readonly SuspendedTank[], tick: number, now: number): void {
    for (let i = 0; i < tanks.length; i++) {
      const tank = tanks[i], wheels = tank.wheelSuspension;
      if (!wheels?.length) continue;
      let st = this.state.get(i);
      if (!st) { st = { tick, wheels: [...wheels], last: -1 }; this.state.set(i, st); continue; }
      if (st.tick === tick) continue;
      const dt = (tick - st.tick) / SIM_HZ;
      let peakRate = 0, count = 0;
      if (dt > 0 && dt <= 0.25) {
        for (let w = 0; w < wheels.length && w < st.wheels.length; w++) {
          const rate = (wheels[w] - st.wheels[w]) / dt;
          if (rate > THUMP_RATE_THRESHOLD) { count++; if (rate > peakRate) peakRate = rate; }
        }
      }
      st.tick = tick;
      for (let w = 0; w < wheels.length; w++) st.wheels[w] = wheels[w];
      if (!count || now - st.last < THUMP_GAP) continue;
      const s = m.spatialize(tank.position);
      if (s.distance > THUMP_RANGE) continue;
      const intensity = Math.min(1, thumpIntensity(peakRate) * (1 + 0.12 * (count - 1)) + 0.05 * (count - 1));
      if (m.play(suspensionThumpRecipe(intensity, hash32(tick, i, count)), { bus: 'vehicles', priority: PRIORITY.thump, position: tank.position, burst: true })) {
        st.last = now;
        this.thumps++;
      }
    }
  }
}
