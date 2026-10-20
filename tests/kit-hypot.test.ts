/**
 * The allocation-free hypot ports (kit/geometry/hypot.ts) must return exactly what this engine's Math.hypot returns:
 * the belt solver, the pose cache and the presentation replaced the builtin with them on that promise.
 */
import { describe, expect, it } from 'vitest';
import { hypot2, hypot3, hypot4 } from '../src/game/kit/geometry/hypot';

const SPECIAL = [0, -0, 1, -1, Infinity, -Infinity, NaN, 5e-324, -5e-324, 2.2250738585072014e-308, 1e-308, 1e308, 1.7976931348623157e308, 0.1, 3, 4, 1e-160, 1e160];
const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
function bits(value: number): string { f64[0] = value; return `${u32[1]}:${u32[0]}`; }
function same(a: number, b: number): boolean { return Number.isNaN(a) ? Number.isNaN(b) : bits(a) === bits(b); }

describe('hypot ports', () => {
  it('match Math.hypot bit for bit on special values', () => {
    for (const x of SPECIAL) for (const y of SPECIAL) {
      expect(same(hypot2(x, y), Math.hypot(x, y)), `${x}, ${y}`).toBe(true);
      for (const z of SPECIAL) {
        expect(same(hypot3(x, y, z), Math.hypot(x, y, z)), `${x}, ${y}, ${z}`).toBe(true);
        expect(same(hypot4(x, y, z, x - y), Math.hypot(x, y, z, x - y)), `${x}, ${y}, ${z}, ${x - y}`).toBe(true);
      }
    }
  });

  it('match Math.hypot bit for bit on random magnitudes and raw bit patterns', () => {
    let seed = 0x2545f491;
    const random = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
    const value = () => {
      const kind = random();
      if (kind < 0.5) return (random() - 0.5) * 4;
      if (kind < 0.8) return (random() - 0.5) * 10 ** Math.floor(random() * 60 - 30);
      u32[0] = Math.floor(random() * 4294967296); u32[1] = Math.floor(random() * 4294967296); return f64[0];
    };
    let mismatches = 0;
    for (let i = 0; i < 300000; i++) {
      const x = value(), y = value(), z = value(), w = value();
      if (!same(hypot2(x, y), Math.hypot(x, y))) mismatches++;
      if (!same(hypot3(x, y, z), Math.hypot(x, y, z))) mismatches++;
      if (!same(hypot4(x, y, z, w), Math.hypot(x, y, z, w))) mismatches++;
    }
    expect(mismatches).toBe(0);
  });
});
