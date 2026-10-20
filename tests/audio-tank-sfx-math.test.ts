import { describe, expect, it } from 'vitest';
import {
  armorClankRecipe, blastMagnitude01, ENGINE_FULL_SPEED, engineParams, gearOf, GEARS, explosionPlan, incomingPitch, killAccentRecipe, MAX_SOUND_DELAY,
  MAX_TREAD_RATE, NUKE_PRE_ROLL, perceivedMagnitude, RAIL_CHARGE_S, recipeDuration, RELOAD_CLUNK_AT, rubbleSettleRecipe, shotSeed,
  soundDelay, SPEED_OF_SOUND, suspensionThumpRecipe, THUMP_RATE_THRESHOLD, thumpIntensity, uiRecipe, validateRecipe, WEAPON_VOICES,
  weaponFireRecipe, weaponVoiceOf, whistleBaseHz, whistleGain, type Layer, type NoiseLayer, type Recipe, type UiSound,
} from '../src/audio/sfx/tank-sfx-math';

const SEEDS = Array.from({ length: 24 }, (_, i) => (i * 2654435761) >>> 0);
const MUNITIONS = ['explosive', 'heavy', 'incendiary', 'nuclear'] as const;
const noises = (r: Recipe) => r.layers.filter((l): l is NoiseLayer => l.kind === 'noise');
const allNumbers = (value: unknown, out: number[] = []): number[] => {
  if (typeof value === 'number') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => allNumbers(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => allNumbers(v, out));
  return out;
};

describe('weapon fire layer tables', () => {
  it('produce valid recipes for every weapon, power and seed (finite, in range, no NaN)', () => {
    for (const weapon of WEAPON_VOICES) for (const power of [0, 0.25, 0.5, 1]) for (const seed of SEEDS) {
      const r = weaponFireRecipe(weapon, power, seed);
      expect(validateRecipe(r), `${weapon} p=${power} seed=${seed}`).toEqual([]);
      expect(allNumbers(r).every(Number.isFinite)).toBe(true);
      expect(recipeDuration(r)).toBeGreaterThan(RELOAD_CLUNK_AT[weapon]);
    }
  });

  it('are deterministic per shot id and varied across shot ids', () => {
    for (const weapon of WEAPON_VOICES) {
      expect(weaponFireRecipe(weapon, 0.6, 1234)).toEqual(weaponFireRecipe(weapon, 0.6, 1234));
      const a = JSON.stringify(weaponFireRecipe(weapon, 0.6, shotSeed(100, 0, 1)));
      const b = JSON.stringify(weaponFireRecipe(weapon, 0.6, shotSeed(101, 0, 2)));
      expect(a).not.toBe(b);
    }
    expect(shotSeed(10, 0, 1)).not.toBe(shotSeed(10, 1, 1));
  });

  it('keep the recoil pitch jitter within ±4 %', () => {
    // The cannon crack's f0 is 2500·pitch·(1 ± 5 %): across seeds it stays inside 2500·[0.96·0.95, 1.04·1.05].
    for (const seed of SEEDS) {
      const crack = noises(weaponFireRecipe('cannon', 0.5, seed))[0];
      expect(crack.f0).toBeGreaterThanOrEqual(2500 * 0.96 * 0.95 - 1e-6);
      expect(crack.f0).toBeLessThanOrEqual(2500 * 1.04 * 1.05 + 1e-6);
    }
  });

  it('get louder monotonically with power', () => {
    for (const weapon of WEAPON_VOICES) {
      const gains = [0, 0.3, 0.6, 1].map(p => weaponFireRecipe(weapon, p, 7).gain);
      for (let i = 1; i < gains.length; i++) expect(gains[i]).toBeGreaterThan(gains[i - 1]);
    }
  });

  it('shape each weapon: mortar thunk, cannon crack + sub + breech clank, rail whine rising to a crack', () => {
    const mortar = weaponFireRecipe('mortar', 0.5, 3);
    const thunk = mortar.layers.find(l => l.kind === 'tone')!;
    expect(thunk.kind === 'tone' && thunk.f0 > thunk.f1 && thunk.f1 < 100).toBe(true);
    const cannon = weaponFireRecipe('cannon', 0.5, 3);
    const crack = noises(cannon)[0];
    expect(crack.filter).toBe('bandpass');
    expect(crack.f0).toBeGreaterThan(crack.f1);
    expect(crack.dur).toBeLessThan(0.08);
    const clank = cannon.layers.find(l => l.kind === 'partials')!;
    expect(clank.delay).toBeCloseTo(0.12, 6);
    const rail = weaponFireRecipe('rail', 0.5, 3);
    const whine = rail.layers.find(l => l.kind === 'whine')!;
    expect(whine.kind === 'whine' && whine.f1 > whine.f0).toBe(true);
    const railCrack = noises(rail).find(l => l.filter === 'bandpass' && l.peak >= 0.9)!;
    expect(railCrack.delay).toBeCloseTo(RAIL_CHARGE_S, 9);
    expect(whine.delay).toBeLessThan(railCrack.delay);
    expect(rail.layers.some(l => l.kind === 'ring')).toBe(true);
  });

  it('map kit ids to voices (unknown ids sound like the cannon)', () => {
    expect(weaponVoiceOf('mortar')).toBe('mortar');
    expect(weaponVoiceOf('rail')).toBe('rail');
    expect(weaponVoiceOf('cannon')).toBe('cannon');
    expect(weaponVoiceOf('laser')).toBe('cannon');
    expect(weaponVoiceOf(undefined)).toBe('cannon');
  });
});

describe('explosions (playThunder at 60 u/s)', () => {
  it('delay d/60 s capped at 0.8 s', () => {
    expect(SPEED_OF_SOUND).toBe(60);
    expect(soundDelay(0)).toBe(0);
    expect(soundDelay(12)).toBeCloseTo(0.2, 12);
    expect(soundDelay(48)).toBeCloseTo(0.8, 12);
    expect(soundDelay(56)).toBe(MAX_SOUND_DELAY);
    expect(soundDelay(NaN)).toBe(0);
    let prev = -1;
    for (let d = 0; d <= 80; d += 2) { const v = soundDelay(d); expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
  });

  it('produce valid plans for every munition, radius, distance and seed', () => {
    for (const munition of MUNITIONS) for (const radius of [0.5, 2, 2.25, 3.5, 4.8, 7]) for (const distance of [0, 3, 12, 30, 56, 200]) for (const seed of SEEDS.slice(0, 6)) {
      const plan = explosionPlan({ munition, radius, distance, seed });
      expect(validateRecipe(plan.recipe), `${munition} r=${radius} d=${distance}`).toEqual([]);
      expect(allNumbers(plan).every(Number.isFinite)).toBe(true);
      expect(plan.start).toBeGreaterThanOrEqual(0);
    }
  });

  it('never produce NaN from garbage input', () => {
    const plan = explosionPlan({ munition: 'nonsense', radius: NaN, distance: NaN, seed: NaN });
    expect(validateRecipe(plan.recipe)).toEqual([]);
    expect(allNumbers(plan).every(Number.isFinite)).toBe(true);
  });

  it('grow monotonically with the blast radius: longer, deeper, louder rumble and denser debris rain', () => {
    const radii = [1, 2, 2.6, 3.5, 4.2, 4.8];
    const plans = radii.map(radius => explosionPlan({ munition: 'explosive', radius, distance: 8, seed: 42 }));
    const rumble = (r: Recipe) => noises(r).find(l => l.noise === 'brown' && l.lfo)!;
    const ticks = (r: Recipe) => r.layers.filter(l => l.kind === 'ticks').reduce((n, l) => n + (l.kind === 'ticks' ? l.times.length : 0), 0);
    for (let i = 1; i < plans.length; i++) {
      const a = plans[i - 1], b = plans[i];
      expect(b.magnitude).toBeGreaterThanOrEqual(a.magnitude);
      expect(b.recipe.gain).toBeGreaterThanOrEqual(a.recipe.gain);
      // The rumble length carries a ±6 % seeded jitter; the trend across the radius range dominates it.
      expect(rumble(b.recipe).f1).toBeLessThanOrEqual(rumble(a.recipe).f1);
      expect(ticks(b.recipe)).toBeGreaterThanOrEqual(ticks(a.recipe));
    }
    expect(rumble(plans[5].recipe).dur).toBeGreaterThan(rumble(plans[0].recipe).dur * 2);
    expect(blastMagnitude01(4.8)).toBe(1);
  });

  it('lose the crack and the highs with distance while the rumble carries', () => {
    const at = (distance: number) => explosionPlan({ munition: 'explosive', radius: 2.5, distance, seed: 9 });
    const crackPeak = (r: Recipe) => noises(r).find(l => l.noise === 'white' && l.filter === 'bandpass' && l.dur <= 0.21)?.peak ?? 0;
    const rumbleF0 = (r: Recipe) => noises(r).find(l => l.noise === 'brown' && l.lfo)!.f0;
    let prevCrack = Infinity, prevF0 = Infinity, prevStart = -1;
    for (const d of [0, 5, 10, 20, 29, 40, 60]) {
      const p = at(d);
      expect(crackPeak(p.recipe)).toBeLessThanOrEqual(prevCrack);
      expect(rumbleF0(p.recipe)).toBeLessThanOrEqual(prevF0);
      expect(p.start).toBeGreaterThanOrEqual(prevStart);
      prevCrack = crackPeak(p.recipe); prevF0 = rumbleF0(p.recipe); prevStart = p.start;
    }
    expect(crackPeak(at(40).recipe)).toBe(0);
  });

  it('give the nuclear round a suck-back pre-swell that crests at the boom', () => {
    const near = explosionPlan({ munition: 'nuclear', radius: 4.8, distance: 6, seed: 1 });
    expect(near.preRoll).toBe(NUKE_PRE_ROLL);
    const swell = noises(near.recipe).find(l => l.swell && l.delay === 0)!;
    expect(swell.attack + swell.delay).toBeCloseTo(NUKE_PRE_ROLL - 0.01, 9);
    expect(swell.f1).toBeGreaterThan(swell.f0);
    // Near: the pre-swell starts at the impact and the boom lands at the pre-roll. Far: the boom lands at d/60.
    expect(near.start).toBe(0);
    const far = explosionPlan({ munition: 'nuclear', radius: 4.8, distance: 45, seed: 1 });
    expect(far.start + far.preRoll).toBeCloseTo(soundDelay(45), 12);
    expect(noises(near.recipe).some(l => l.delay > 1.5 && l.swell)).toBe(true);   // the air rushing back
  });

  it('scale the ducking magnitude down with distance', () => {
    let prev = Infinity;
    for (const d of [0, 4, 8, 16, 32]) { const v = perceivedMagnitude(4, d); expect(v).toBeLessThan(prev); prev = v; }
    expect(perceivedMagnitude(2.25, 3)).toBeGreaterThan(0.4);
    expect(perceivedMagnitude(2.25, 30)).toBeLessThan(0.4);
    expect(perceivedMagnitude(4.8, 20)).toBeGreaterThan(0.4);
  });
});

describe('impacts, suspension and UI recipes', () => {
  it('armour clank decays 0.4-1.2 s with the damage and rings louder on direct hits', () => {
    const decay = (d: number) => armorClankRecipe(d, false, 5).layers.find(l => l.kind === 'partials')!;
    const d0 = decay(0), d1 = decay(1);
    expect(d0.kind === 'partials' && d0.decay).toBeGreaterThan(0.35);
    expect(d1.kind === 'partials' && d1.decay).toBeLessThan(1.35);
    expect(d1.kind === 'partials' && d0.kind === 'partials' && d1.decay > d0.decay).toBe(true);
    const peak = (direct: boolean) => { const l = armorClankRecipe(0.5, direct, 5).layers.find(x => x.kind === 'partials')!; return l.kind === 'partials' ? l.peaks[0] : 0; };
    expect(peak(true)).toBeGreaterThan(peak(false));
    for (const seed of SEEDS) for (const d of [0, 0.5, 1, 3, NaN]) expect(validateRecipe(armorClankRecipe(d, seed % 2 === 0, seed))).toEqual([]);
    for (const seed of SEEDS) { expect(validateRecipe(killAccentRecipe(seed))).toEqual([]); expect(validateRecipe(rubbleSettleRecipe(2 + (seed % 3), seed))).toEqual([]); }
  });

  it('thump intensity is 0 below the threshold, monotone above it, and capped at 1', () => {
    expect(thumpIntensity(0)).toBe(0);
    expect(thumpIntensity(THUMP_RATE_THRESHOLD)).toBe(0);
    expect(thumpIntensity(NaN)).toBe(0);
    let prev = 0;
    for (let r = THUMP_RATE_THRESHOLD + 0.1; r < 20; r += 0.5) { const v = thumpIntensity(r); expect(v).toBeGreaterThanOrEqual(prev); expect(v).toBeLessThanOrEqual(1); prev = v; }
    for (const i of [0, 0.3, 1]) for (const seed of SEEDS) expect(validateRecipe(suspensionThumpRecipe(i, seed))).toEqual([]);
  });

  it('UI recipes are valid and the aim tick rises with the slider', () => {
    const kinds: UiSound[] = ['click', 'hover', 'confirm', 'cancel', 'open', 'close', 'aim', 'turn', 'turn-other', 'denied', 'victory', 'defeat'];
    for (const kind of kinds) for (const v of [0, 0.5, 1]) expect(validateRecipe(uiRecipe(kind, v, 3)), kind).toEqual([]);
    const f = (v: number) => (uiRecipe('aim', v).layers[0] as Extract<Layer, { kind: 'tone' }>).f0;
    expect(f(0)).toBeLessThan(f(0.5));
    expect(f(0.5)).toBeLessThan(f(1));
  });
});

describe('whistle and engine parameters', () => {
  it('whistle frequency rises with speed, the incoming glissando descends, gain falls with distance', () => {
    expect(whistleBaseHz(0)).toBe(900);
    expect(whistleBaseHz(10)).toBe(1300);
    expect(whistleBaseHz(23)).toBeCloseTo(1820, 9);
    expect(whistleBaseHz(NaN)).toBe(900);
    expect(incomingPitch(1)).toBe(1);
    expect(incomingPitch(0)).toBe(0.75);
    expect(incomingPitch(0.5)).toBeLessThan(incomingPitch(0.9));
    expect(whistleGain(0)).toBe(1);
    expect(whistleGain(3)).toBeCloseTo(0.5, 12);
    expect(whistleGain(10)).toBeLessThan(whistleGain(5));
    expect(whistleGain(NaN)).toBe(0);
  });

  it('engine pitch climbs within a gear and drops at each shift, the tread rate follows speed and is capped, garbage input stays finite', () => {
    let prevF = 0, prevT = -1, prevGear = 0, shifts = 0;
    for (let v = 0; v <= 8; v += 0.05) {
      const p = engineParams({ speed: v, accel: 0, slip: 0, contact: 1, turretRate: 0 }), gear = gearOf(v);
      if (gear === prevGear) expect(p.fundamental).toBeGreaterThanOrEqual(prevF - 1e-9);
      else { expect(p.fundamental).toBeLessThan(prevF); shifts++; }
      expect(p.tread).toBeGreaterThanOrEqual(prevT);
      expect(p.tread).toBeLessThanOrEqual(MAX_TREAD_RATE);
      prevF = p.fundamental; prevT = p.tread; prevGear = gear;
    }
    expect(shifts).toBe(GEARS - 1);
    expect(engineParams({ speed: ENGINE_FULL_SPEED, accel: 0, slip: 0, contact: 1, turretRate: 0 }).fundamental).toBeGreaterThan(engineParams({ speed: 0, accel: 0, slip: 0, contact: 1, turretRate: 0 }).fundamental + 40);
    // Hard turns at speed clatter; a pivot at rest barely; low health switches on the misfire mode.
    expect(engineParams({ speed: 2, accel: 0, slip: 0, contact: 1, turretRate: 0, yawRate: 2 }).turn).toBeGreaterThan(0.5);
    expect(engineParams({ speed: 2, accel: 0, slip: 0, contact: 1, turretRate: 0, yawRate: 0.1 }).turn).toBe(0);
    expect(engineParams({ speed: 2, accel: 0, slip: 0, contact: 1, turretRate: 0, health: 0.1 }).damage).toBeGreaterThan(0.5);
    expect(engineParams({ speed: 2, accel: 0, slip: 0, contact: 1, turretRate: 0, health: 0.8 }).damage).toBe(0);
    expect(engineParams({ speed: ENGINE_FULL_SPEED * 3, accel: 0, slip: 0, contact: 1, turretRate: 0 }).tread).toBe(MAX_TREAD_RATE);
    const idle = engineParams({ speed: 0, accel: 0, slip: 0, contact: 1, turretRate: 0 });
    expect(idle.tread).toBe(0);
    expect(idle.level).toBeGreaterThan(0);
    const accelerating = engineParams({ speed: 1, accel: 3, slip: 0, contact: 1, turretRate: 0 });
    expect(accelerating.load).toBeGreaterThan(engineParams({ speed: 1, accel: 0, slip: 0, contact: 1, turretRate: 0 }).load);
    expect(engineParams({ speed: 0, accel: 0, slip: 1.2, contact: 0, turretRate: 0 }).slip).toBe(0);   // no ground, no squeal
    expect(engineParams({ speed: 0, accel: 0, slip: 0, contact: 1, turretRate: 2 }).servo).toBe(1);
    const junk = engineParams({ speed: NaN, accel: Infinity, slip: NaN, contact: NaN, turretRate: -Infinity });
    expect(Object.values(junk).every(Number.isFinite)).toBe(true);
  });
});
