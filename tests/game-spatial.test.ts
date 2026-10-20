import { describe, expect, it } from 'vitest';
import { assertTwoToOneFaces, cellContains, cellKey, cellsShareFace, childCells, dyadicCell, neighborCell, parentCell, parseCellKey, relativeCellBounds } from '../src/game/spatial';

describe('deep exact dyadic addressing', () => {
  it.each([0, 31, 52, 64, 96, 128])('round-trips depth %i without 32-bit or Number index truncation', depth => {
    const limit = 2n ** BigInt(depth), cell = dyadicCell(depth, limit - 1n, limit / 2n, 0n);
    expect(parseCellKey(cellKey(cell))).toEqual(cell);
    expect(neighborCell(cell, 'x', 1)).toBeNull();
    expect(neighborCell(cell, 'z', -1)).toBeNull();
    if (depth) expect(neighborCell(neighborCell(cell, 'x', -1)!, 'x', 1)).toEqual(cell);
  });

  it('preserves exact parent/child membership and face-neighbor relationships at depth 100', () => {
    const p = dyadicCell(99, 2n ** 98n + 17n, 2n ** 97n + 29n, 12345678901234567890n);
    const children = childCells(p);
    expect(new Set(children.map(cellKey)).size).toBe(8);
    for (const child of children) { expect(parentCell(child)).toEqual(p); expect(cellContains(p, child)).toBe(true); }
    expect(cellsShareFace(children[0], children[1])).toBe(true);
    expect(cellsShareFace(children[0], children[3])).toBe(false);
    expect(cellsShareFace(children[0], children[7])).toBe(false);
    expect(parentCell(dyadicCell(0, 0n, 0n, 0n))).toBeNull();
    expect(() => childCells(dyadicCell(128, 0n, 0n, 0n))).toThrow(/Maximum/);
  });

  it('subtracts huge integer addresses before making camera-relative doubles', () => {
    const base = 2n ** 79n + 213n, cameraCell = dyadicCell(80, base, base, base);
    const target = dyadicCell(80, base + 1n, base - 2n, base + 3n);
    // Absolute Number indices collapse here; the relative subtraction must not.
    expect(Number(base + 1n)).toBe(Number(base));
    const result = relativeCellBounds(target, { cell: cameraCell, offset: [.25, .5, .75] }, 2 ** 80);
    expect(result).toEqual({ min: [.75, -2.5, 2.25], max: [1.75, -1.5, 3.25], size: 1 });
    const parent = parentCell(cameraCell)!;
    const mixed = relativeCellBounds(parent, { cell: cameraCell, offset: [0, 0, 0] }, 2 ** 80);
    expect(mixed.size).toBe(2);
    expect(mixed.min).toEqual([-1, -1, -1]);
  });

  it('audits a bounded 2:1 face contract without claiming a complete LOD selector', () => {
    const coarse = dyadicCell(1, 0n, 0n, 0n);
    const fine = dyadicCell(2, 2n, 0n, 0n);
    expect(() => assertTwoToOneFaces([coarse, fine])).not.toThrow();
    const tooFine = dyadicCell(3, 4n, 0n, 0n);
    expect(() => assertTwoToOneFaces([coarse, tooFine])).toThrow(/2:1/);
    expect(() => assertTwoToOneFaces([coarse, childCells(coarse)[0]])).toThrow(/overlap/);
    expect(() => assertTwoToOneFaces([coarse, fine], 1)).toThrow(/budget/);
  });

  it('rejects malformed, overflowing and noncanonical keys and anchors', () => {
    for (const key of ['129/0/0/0', '3/8/0/0', '01/0/0/0', '1/-1/0/0', 'NaN/0/0/0', '1/0/0/0/0']) expect(() => parseCellKey(key)).toThrow();
    expect(() => dyadicCell(2.5, 0n, 0n, 0n)).toThrow();
    expect(() => relativeCellBounds(dyadicCell(1, 0n, 0n, 0n), { cell: dyadicCell(1, 0n, 0n, 0n), offset: [1, 0, 0] }, 48)).toThrow();
  });
});

