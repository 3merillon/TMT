import { describe, expect, it } from 'vitest';
import { AudioManager } from '../src/audio/audio-manager';
import { mulberry32 } from '../src/audio/rng';
import { playExplosion } from '../src/audio/sfx/explosion';
import { playArmorHit } from '../src/audio/sfx/impacts';
import { playUi } from '../src/audio/sfx/ui';
import { playWeaponFire } from '../src/audio/sfx/weapons';
import { ShellWhistles } from '../src/audio/sfx/whistle';
import { LeakyBucket, MAX_SFX_VOICES, PRIORITY, STEAL_FADE_S, VoiceBudget, type BudgetVoice, type BusName } from '../src/audio/voice-select';
import { FakeAudioContext } from '../src/audio/testing/fake-audio-context';

class TestVoice implements BudgetVoice {
  stopped = -1; disposed = 0;
  constructor(readonly bus: BusName, readonly priority: number, readonly loudness: number, public endAt: number, readonly persistent = false) {}
  stop(now: number) { this.stopped = now; }
  dispose() { this.disposed++; }
}

describe('VoiceBudget', () => {
  it('admits up to MAX_SFX_VOICES voices, then steals the weakest (lowest priority, then quietest)', () => {
    const b = new VoiceBudget();
    expect(b.max).toBe(MAX_SFX_VOICES);
    expect(MAX_SFX_VOICES).toBe(56);
    const voices = Array.from({ length: MAX_SFX_VOICES }, (_, i) => new TestVoice('impacts', PRIORITY.impact, 0.1 + i / 100, 10));
    voices[17] = new TestVoice('ui', PRIORITY.ui, 0.9, 10);
    for (const v of voices) expect(b.admit(v, 0)).toBe(true);
    expect(b.size).toBe(MAX_SFX_VOICES);
    const boom = new TestVoice('explosions', PRIORITY.explosion, 0.5, 10);
    expect(b.admit(boom, 0)).toBe(true);
    expect(b.size).toBe(MAX_SFX_VOICES);
    expect(voices[17].stopped).toBe(0);                // the UI voice had the lowest priority
    const second = new TestVoice('explosions', PRIORITY.explosion, 0.5, 10);
    expect(b.admit(second, 0)).toBe(true);
    expect(voices[0].stopped).toBe(0);                 // then the quietest impact
    expect(b.stolen).toBe(2);
  });

  it('rejects a voice that every active voice outranks', () => {
    const b = new VoiceBudget(4);
    for (let i = 0; i < 4; i++) b.admit(new TestVoice('explosions', PRIORITY.explosion, 0.5, 10), 0);
    const tick = new TestVoice('ui', PRIORITY.tick, 1, 10);
    expect(b.admit(tick, 0)).toBe(false);
    expect(b.rejected).toBe(1);
    expect(b.size).toBe(4);
  });

  it('never lets a one-shot steal a persistent loop', () => {
    const b = new VoiceBudget(3);
    const loops = [0, 1, 2].map(() => new TestVoice('vehicles', PRIORITY.loop, 0.01, Infinity, true));
    for (const l of loops) b.admit(l, 0);
    expect(b.admit(new TestVoice('explosions', PRIORITY.kill + 5, 1, 5), 0)).toBe(false);
    expect(loops.every(l => l.stopped < 0)).toBe(true);
    // A loop may displace a one-shot to make room.
    const b2 = new VoiceBudget(2);
    const shot = new TestVoice('weapons', PRIORITY.weapon, 1, 5);
    b2.admit(shot, 0); b2.admit(new TestVoice('vehicles', PRIORITY.loop, 0.1, Infinity, true), 0);
    expect(b2.admit(new TestVoice('projectiles', PRIORITY.loop, 0.1, Infinity, true), 0)).toBe(true);
    expect(shot.stopped).toBe(0);
  });

  it('disposes ended and stolen voices exactly once, after the steal fade', () => {
    const b = new VoiceBudget(2);
    const a = new TestVoice('impacts', 1, 0.1, 1), c = new TestVoice('impacts', 1, 0.2, 5);
    b.admit(a, 0); b.admit(c, 0);
    b.admit(new TestVoice('impacts', 5, 0.5, 5), 0.5);   // steals a (weakest)
    expect(a.stopped).toBe(0.5);
    expect(a.disposed).toBe(0);
    b.prune(0.5 + STEAL_FADE_S / 2);
    expect(a.disposed).toBe(0);
    b.prune(0.5 + STEAL_FADE_S);
    expect(a.disposed).toBe(1);
    b.prune(6);
    b.prune(7);
    expect(a.disposed).toBe(1);
    expect(c.disposed).toBe(1);
    expect(b.size).toBe(0);
  });

  it('keeps the live count ≤ the cap through a random storm of 5000 voices', () => {
    const b = new VoiceBudget();
    const rand = mulberry32(99);
    const buses: BusName[] = ['weapons', 'explosions', 'impacts', 'vehicles', 'ui', 'projectiles'];
    let t = 0, admitted = 0, maxSize = 0;
    const all: TestVoice[] = [];
    for (let i = 0; i < 5000; i++) {
      t += rand() * 0.02;
      const persistent = rand() < 0.02 && all.filter(v => v.persistent && v.endAt > t).length < 10;
      const v = new TestVoice(buses[Math.floor(rand() * buses.length)], Math.floor(rand() * 9), rand(), persistent ? t + 3 : t + rand() * 4, persistent);
      all.push(v);
      if (b.admit(v, t)) admitted++;
      maxSize = Math.max(maxSize, b.size);
      expect(b.size).toBeLessThanOrEqual(MAX_SFX_VOICES);
    }
    expect(maxSize).toBe(MAX_SFX_VOICES);
    expect(admitted).toBeGreaterThan(1000);
    b.prune(t + 10);
    expect(all.every(v => v.disposed <= 1)).toBe(true);
  });

  it('counts live voices per bus', () => {
    const b = new VoiceBudget();
    b.admit(new TestVoice('weapons', 1, 1, 10), 0);
    b.admit(new TestVoice('weapons', 1, 1, 10), 0);
    b.admit(new TestVoice('vehicles', 1, 1, 10), 0);
    const counts = b.countByBus({} as Record<BusName, number>);
    expect(counts.weapons).toBe(2);
    expect(counts.vehicles).toBe(1);
    expect(counts.explosions).toBe(0);
  });
});

describe('LeakyBucket (per-bus burst cap)', () => {
  it('clips a burst and refills continuously', () => {
    const bucket = new LeakyBucket(6, 4);
    let ok = 0;
    for (let i = 0; i < 20; i++) if (bucket.tryTake(1)) ok++;
    expect(ok).toBe(6);
    expect(bucket.tryTake(1.1)).toBe(false);          // 0.4 tokens refilled
    expect(bucket.tryTake(1.3)).toBe(true);           // 1.2 tokens
    bucket.reset();
    expect(bucket.available).toBe(6);
  });
});

describe('the engine under load', () => {
  it('stays at ≤ the cap of SFX voices with loops, whistles and a barrage of one-shots', () => {
    const ctx = new FakeAudioContext();
    void ctx.resume();
    const m = new AudioManager(ctx.asAudioContext(), { dev: true });
    m.listener.update({ position: [0, 26, 8], target: [0, 18.4, 0], up: [0, 1, 0] }, [0, 18.4, 0], 1 / 60);
    const whistles = new ShellWhistles();
    const rand = mulberry32(5);
    for (let frame = 0; frame < 600; frame++) {
      const p: [number, number, number] = [rand() * 16 - 8, 18.5, rand() * 16 - 8];
      if (frame % 2 === 0) playWeaponFire(m, { weapon: 'cannon', power: rand(), seed: frame, position: p });
      if (frame % 3 === 0) playExplosion(m, { position: p, radius: 2 + rand() * 2.8, munition: 'heavy', seed: frame });
      playArmorHit(m, p, { damage01: rand(), direct: rand() > 0.5 }, frame);
      playUi(m, 'click');
      const shells = Array.from({ length: 10 }, (_, i) => ({ id: i + frame * 0, position: [i - 5, 21, 1] as [number, number, number], velocity: [2, -1, 0] as [number, number, number] }));
      whistles.update(m, shells, [0, 18.4, 0], ctx.currentTime);
      m.update();
      const v = m.voiceTelemetry();
      expect(v.total).toBeLessThanOrEqual(MAX_SFX_VOICES);
      expect(m.budget.size).toBeLessThanOrEqual(MAX_SFX_VOICES);
      ctx.advance(1 / 60);
    }
    expect(m.voiceTelemetry().peak.total).toBeLessThanOrEqual(MAX_SFX_VOICES);
    expect(whistles.count).toBe(6);
    expect(m.nanRejected).toBe(0);
    expect(m.dropped).toBeGreaterThan(0);              // the burst caps did their job
  });
});
