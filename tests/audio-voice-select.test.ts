import { describe, expect, it } from 'vitest';
import { LOOP_ENTER_RANGE_MUL, LOOP_KEEP_RANGE_MUL, selectLoopVoices, type LoopCandidate } from '../src/audio/voice-select';
import { ENGINE_RANGE, MAX_ENGINE_LOOPS } from '../src/audio/loops';
import { MAX_WHISTLES } from '../src/audio/sfx/tank-sfx-math';

// Ported from Pinionfall src/audio/fire-voice-select.test.ts: the selector now voices engine loops (nearest 4 tanks)
// and shell whistles (≤ 6), so the cases are phrased for tanks.
const R = ENGINE_RANGE;
const c = (id: number, dist: number, live = false, range = R): LoopCandidate => ({ id, dist, range, live });

describe('selectLoopVoices', () => {
  it('handles empty, in-range, out-of-range and invalid candidates', () => {
    expect(selectLoopVoices([], 4).size).toBe(0);
    expect(selectLoopVoices([c(1, R * 0.5)], 4).has(1)).toBe(true);
    expect(selectLoopVoices([c(1, R * LOOP_ENTER_RANGE_MUL + 0.01)], 4).has(1)).toBe(false);
    expect(selectLoopVoices([c(1, NaN)], 4).size).toBe(0);
    expect(selectLoopVoices([c(1, 0, false, 0)], 4).size).toBe(0);
    expect(selectLoopVoices([c(1, -1)], 4).size).toBe(0);
  });

  it('voices exactly the cap, and the nearest ones, in a crowded battle', () => {
    const crowd: LoopCandidate[] = [];
    for (let i = 0; i < 16; i++) crowd.push(c(100 + i, 2 + ((i * 7) % 16) * 1.7));
    const pick = selectLoopVoices(crowd, MAX_ENGINE_LOOPS);
    expect(pick.size).toBe(MAX_ENGINE_LOOPS);
    const nearest = [...crowd].sort((a, b) => a.dist - b.dist || a.id - b.id).slice(0, MAX_ENGINE_LOOPS).map(x => x.id);
    for (const id of nearest) expect(pick.has(id)).toBe(true);
    expect(selectLoopVoices(crowd, MAX_WHISTLES).size).toBe(MAX_WHISTLES);
    expect(selectLoopVoices(crowd, 0).size).toBe(0);
  });

  it('applies hysteresis: enter at 1.25× range, keep until 1.4×', () => {
    const edge = R * (LOOP_ENTER_RANGE_MUL + LOOP_KEEP_RANGE_MUL) / 2;
    expect(selectLoopVoices([c(1, edge)], 4).has(1)).toBe(false);
    expect(selectLoopVoices([c(1, edge, true)], 4).has(1)).toBe(true);
    expect(selectLoopVoices([c(1, R * LOOP_KEEP_RANGE_MUL + 0.01, true)], 4).has(1)).toBe(false);
  });

  it('biases toward sounding loops: a barely nearer newcomer does not evict one, a much nearer one does', () => {
    const full = Array.from({ length: MAX_ENGINE_LOOPS }, (_, i) => c(i + 1, 10, true));
    expect(selectLoopVoices([...full, c(99, 9.5)], MAX_ENGINE_LOOPS).has(99)).toBe(false);
    const pick = selectLoopVoices([...full, c(99, 2)], MAX_ENGINE_LOOPS);
    expect(pick.has(99)).toBe(true);
    expect(pick.size).toBe(MAX_ENGINE_LOOPS);
  });

  it('ranks by distance as a fraction of range (a louder source carries further)', () => {
    expect(selectLoopVoices([c(1, 20), c(2, 26, false, 60)], 1).has(2)).toBe(true);
  });

  it('is deterministic: equal ranks break by id, and input order never matters', () => {
    expect([...selectLoopVoices([c(5, 10), c(3, 10)], 1)][0]).toBe(3);
    const a = [c(1, 5), c(2, 7), c(3, 3), c(4, 9), c(5, 1)];
    const forward = [...selectLoopVoices(a, 3)].sort(), backward = [...selectLoopVoices([...a].reverse(), 3)].sort();
    expect(forward).toEqual(backward);
  });

  it('reuses the output set it is given', () => {
    const out = new Set<number>([42]);
    const got = selectLoopVoices([c(1, 1)], 4, out);
    expect(got).toBe(out);
    expect([...out]).toEqual([1]);
  });
});
