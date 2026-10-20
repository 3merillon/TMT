import { describe, expect, it } from 'vitest';
import { dopplerRatio, SPEED_OF_SOUND, whistleBaseHz } from '../src/audio/sfx/tank-sfx-math';
import { predictLanding, ShellWhistles } from '../src/audio/sfx/whistle';
import { AudioManager } from '../src/audio/audio-manager';
import { FakeAudioContext, type FakeBiquad } from '../src/audio/testing/fake-audio-context';

type V = [number, number, number];
const O: V = [0, 0, 0];

describe('dopplerRatio (manual doppler, c = 60 u/s)', () => {
  it('raises the pitch when the source approaches and lowers it when it recedes', () => {
    const lis: V = [0, 0, 0];
    const approaching = dopplerRatio([-10, 0, 0], [15, 0, 0], lis, O);
    const receding = dopplerRatio([-10, 0, 0], [-15, 0, 0], lis, O);
    expect(approaching).toBeGreaterThan(1);
    expect(receding).toBeLessThan(1);
    expect(approaching).toBeCloseTo(SPEED_OF_SOUND / (SPEED_OF_SOUND - 15), 12);
    expect(receding).toBeCloseTo(SPEED_OF_SOUND / (SPEED_OF_SOUND + 15), 12);
  });

  it('uses the velocity relative to the listener', () => {
    // A listener moving toward a still source hears it higher; moving with the source cancels the shift.
    expect(dopplerRatio([10, 0, 0], O, [0, 0, 0], [12, 0, 0])).toBeGreaterThan(1);
    expect(dopplerRatio([-10, 0, 0], [8, 0, 0], [0, 0, 0], [8, 0, 0])).toBeCloseTo(1, 12);
  });

  it('is 1 for perpendicular motion and for co-located or invalid input', () => {
    expect(dopplerRatio([0, 5, 0], [20, 0, 0], O, O)).toBeCloseTo(1, 12);
    expect(dopplerRatio(O, [20, 0, 0], O, O)).toBe(1);
    expect(dopplerRatio([NaN, 0, 0], [1, 0, 0], O, O)).toBe(1);
    expect(dopplerRatio([1, 0, 0], [NaN, 0, 0], O, O)).toBe(1);
  });

  it('is clamped to [0.5, 2], including supersonic sources', () => {
    expect(dopplerRatio([-10, 0, 0], [59.9, 0, 0], O, O)).toBe(2);
    expect(dopplerRatio([-10, 0, 0], [60, 0, 0], O, O)).toBe(2);
    expect(dopplerRatio([-10, 0, 0], [500, 0, 0], O, O)).toBe(2);
    expect(dopplerRatio([-10, 0, 0], [-500, 0, 0], O, O)).toBe(0.5);
    for (let v = -100; v <= 100; v += 5) {
      const r = dopplerRatio([-10, 0, 0], [v, 0, 0], O, O);
      expect(r).toBeGreaterThanOrEqual(0.5);
      expect(r).toBeLessThanOrEqual(2);
    }
  });

  it('is monotone in the closing speed', () => {
    let prev = 0;
    for (let v = -40; v <= 40; v += 2) { const r = dopplerRatio([-10, 0, 0], [v, 0, 0], O, O); expect(r).toBeGreaterThanOrEqual(prev); prev = r; }
  });
});

describe('shell whistles', () => {
  const camera = { position: [0, 26, 8] as V, target: [0, 18.4, 0] as V, up: [0, 1, 0] as V };
  const focus: V = [0, 18.4, 0];
  function rig() {
    const ctx = new FakeAudioContext();
    void ctx.resume();
    const m = new AudioManager(ctx.asAudioContext(), { dev: true });
    m.listener.update(camera, focus, 1 / 60);
    return { ctx, m, whistles: new ShellWhistles() };
  }
  const filterOf = (w: ShellWhistles, id: number) => (w as unknown as { live: Map<number, { bp: FakeBiquad }> }).live.get(id)!.bp;
  const lastTarget = (bp: FakeBiquad) => bp.frequency.events.filter(e => e.type === 'target').at(-1)?.value ?? bp.frequency.value;

  it('pitch an approaching shell above its base frequency and a receding one below', () => {
    const { ctx, m, whistles } = rig();
    const lis = m.listener.position;
    const incomingP: V = [lis[0] - 6, lis[1] + 2, lis[2]], outgoingP: V = [lis[0] + 6, lis[1] + 2, lis[2]];
    whistles.update(m, [{ id: 1, position: incomingP, velocity: [12, 0, 0] }, { id: 2, position: outgoingP, velocity: [12, 0, 0] }], focus, ctx.currentTime);
    ctx.advance(1 / 60);
    whistles.update(m, [{ id: 1, position: incomingP, velocity: [12, 0, 0] }, { id: 2, position: outgoingP, velocity: [12, 0, 0] }], focus, ctx.currentTime);
    const base = whistleBaseHz(12);
    expect(lastTarget(filterOf(whistles, 1))).toBeGreaterThan(base * 1.1);
    expect(lastTarget(filterOf(whistles, 2))).toBeLessThan(base * 0.9);
  });

  it('keep at most 6 whistles, nearest first', () => {
    const { ctx, m, whistles } = rig();
    const lis = m.listener.position;
    const shells = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, position: [lis[0] + 1 + i, lis[1] + 3, lis[2]] as V, velocity: [0, 0, 5] as V }));
    whistles.update(m, shells, focus, ctx.currentTime);
    expect(whistles.count).toBe(6);
    expect(m.voiceTelemetry().buses.projectiles).toBe(6);
    whistles.update(m, [], focus, ctx.currentTime + 0.02);
    expect(whistles.count).toBe(0);
    expect(m.voiceTelemetry().buses.projectiles).toBe(0);
  });

  it('predict landings under the central gravity and give incoming shells the descending glissando', () => {
    // A shell dropped straight above the focus lands on it.
    const landing = predictLanding([0, 26, 0], [0, 0, 0], 7.5, 18.1)!;
    expect(landing).not.toBeNull();
    expect(Math.hypot(landing[0], landing[1] - 18.1, landing[2])).toBeLessThan(0.5);
    expect(predictLanding([0, 26, 0], [0, 40, 0], 7.5, 18.1)).toBeNull();   // escaping: never lands within 8 s
    // The same fall heard by the same listener twice: once aimed at the focus (incoming), once at the far side of the
    // planet (not incoming). The ratio isolates the glissando from the doppler of the passing shell.
    const run = (target: V) => {
      const { ctx, m, whistles } = rig();
      const fs: number[] = [];
      for (let k = 0; k < 40; k++) {
        const position: V = [0.5, 18.4 + 6 - k * 0.14, 0.3];
        whistles.update(m, [{ id: 7, position, velocity: [0, -4, 0] }], target, ctx.currentTime);
        fs.push(lastTarget(filterOf(whistles, 7)));
        ctx.advance(0.11);
      }
      return { fs, incoming: whistles.incomingCount };
    };
    const hot = run(focus), cold = run([0, -18.4, 0]);
    expect(hot.incoming).toBe(1);
    expect(cold.incoming).toBe(0);
    const ratio = hot.fs.map((f, i) => f / cold.fs[i]);
    // Parameter writes pass a 0.2 % deadband, hence the small tolerance.
    for (let i = 3; i < ratio.length; i++) expect(ratio[i]).toBeLessThanOrEqual(ratio[i - 1] + 0.005);
    expect(ratio[2]).toBeGreaterThan(0.97);
    expect(ratio.at(-1)!).toBeLessThan(0.8);
    expect(ratio.at(-1)!).toBeGreaterThanOrEqual(0.75 - 1e-9);
  });
});
