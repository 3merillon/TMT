/** The shipped score and effects manifests: every file exists under public/audio, loop points are sane, every track the
 * director can choose exists, and every sprite the runtime names is in the bank. */
import { describe, expect, it } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SCORE_MANIFEST } from '../src/audio/music-bed';
import { SFX_MANIFEST } from '../src/audio/sfx-bank';
import { MusicDirector, worldSetOf } from '../src/audio/score/director';
import { ACTOR_LOOPS } from '../src/audio/actor-loops';

const music = join(process.cwd(), 'public/audio/music'), sfx = join(process.cwd(), 'public/audio/sfx');
describe('score manifest', () => {
  it('ships every layer file with sane loop points and bounded sizes', () => {
    const tracks = Object.values(SCORE_MANIFEST.tracks);
    expect(tracks.length).toBeGreaterThanOrEqual(20);
    let bytes = 0;
    for (const t of tracks) {
      expect(t.bpm).toBeGreaterThan(60); expect(t.stems.length).toBeGreaterThan(0); expect(t.stems.length).toBeLessThanOrEqual(5);
      for (const s of t.stems) { const p = join(music, s.file); expect(existsSync(p), s.file).toBe(true); expect(statSync(p).size).toBe(s.bytes); bytes += s.bytes; }
      if (t.kind === 'loop') { expect(t.loopEndSec).toBeCloseTo(t.seconds, 3); expect(t.loopStartSec).toBeLessThan(t.loopEndSec); expect(t.loopStartSec).toBeCloseTo(t.introBars * 60 / t.bpm * t.beatsPerBar, 3); }
      expect(t.truePeakDb).toBeLessThanOrEqual(-0.8);
    }
    expect(bytes).toBeLessThan(80 * 1024 * 1024);
    // Decoded memory per track at the runtime's 32 kHz stereo float decode: under 75 MB.
    for (const t of tracks) expect(t.seconds * 32000 * 2 * 4 * t.stems.length / 1048576, t.id).toBeLessThan(75);
  });
  it('resolves every scene, world set, boss and phase the director can ask for', () => {
    const d = new MusicDirector({ has: id => !!SCORE_MANIFEST.tracks[id] });
    const expectTrack = (plan: ReturnType<MusicDirector['update']>, id: string) => expect(plan.track).toBe(id);
    expectTrack(d.update({ scene: 'title', threat: 0 }, 0), 'title');
    expectTrack(d.update({ scene: 'workshop', threat: 0 }, 1), 'workshop');
    for (const [world, mission, set] of [['temperate', 'p1', 'cradle'], ['dune', '1-3', 'dune'], ['glacial', 'f-a', 'frost'], ['volcanic', 'c-a', 'forge'], ['glacial', '3-1', 'halo']] as const) {
      expect(worldSetOf(world, mission)).toBe(set);
      const dd = new MusicDirector({ has: id => !!SCORE_MANIFEST.tracks[id] });
      expectTrack(dd.update({ scene: 'skirmish', world, mission, threat: 0 }, 1), `${set}-explore`);
      let plan = dd.update({ scene: 'skirmish', world, mission, threat: 1 }, 2);
      for (let t = 2; t < 20 && plan.track !== `${set}-combat`; t += 0.25) plan = dd.update({ scene: 'skirmish', world, mission, threat: 1 }, t);
      expectTrack(plan, `${set}-combat`);
    }
    for (const [id, mission, world] of [['crawler', '1-5', 'dune'], ['leviathan', 't-b', 'temperate'], ['titan', 'f-b', 'glacial'], ['rustcrown', '3-3', 'glacial']] as const) expectTrack(d.update({ scene: 'skirmish', world, mission, threat: 0.8, boss: { id, phase: 1 } }, 10), `boss-${id}`);
    expectTrack(d.update({ scene: 'skirmish', world: 'temperate', mission: 'ii-7', threat: 0.5, escalation: 1 }, 11), 'fleet-launch');
    expectTrack(d.update({ scene: 'skirmish', world: 'glacial', mission: '3-3', threat: 0.5, phase: 'escape' }, 12), 'finale-escape');
    expectTrack(d.update({ scene: 'skirmish', world: 'glacial', mission: '3-3', threat: 0, phase: 'choice' }, 13), 'finale-choice');
    expectTrack(d.update({ scene: 'results', world: 'glacial', mission: '3-3', threat: 0, ending: 'rewind', outcome: 'won' }, 14), 'ending-rewind');
    expectTrack(d.update({ scene: 'results', world: 'glacial', mission: '3-3', threat: 0, ending: 'release', outcome: 'won' }, 15), 'ending-release');
    for (const s of ['victory', 'defeat', 'mission-start', 'checkpoint', 'boss-phase', 'escalation', 'undermined']) expect(SCORE_MANIFEST.tracks[`stinger-${s}`]?.kind, s).toBe('stinger');
  });
});
describe('effects manifest', () => {
  it('ships both banks (core + heavy, each under 130 s) with every sprite the runtime names', () => {
    const banks = SFX_MANIFEST.banks ?? [{ file: SFX_MANIFEST.file, seconds: SFX_MANIFEST.seconds, samples: SFX_MANIFEST.samples, bytes: SFX_MANIFEST.bytes }];
    expect(banks.length).toBe(2);
    for (const b of banks) { expect(existsSync(join(sfx, b.file)), b.file).toBe(true); expect(statSync(join(sfx, b.file)).size).toBe(b.bytes); expect(b.seconds).toBeLessThan(130); }
    expect(SFX_MANIFEST.file).toBe(banks[0].file);
    const needed = ['cannon', 'cannon-mid', 'cannon-far', 'mortar', 'mortar-mid', 'mortar-far', 'rail', 'rail-mid', 'rail-far', 'autocannon', 'autocannon-mid', 'arc', 'arc-mid', 'arc-crackle', 'forge-mortar', 'forge-mortar-far',
      'coax', 'coax-burst', 'coax-loop', 'coax-tail', 'snap', 'reload', 'reload-heavy',
      'he-small', 'he', 'he-soil', 'he-rock', 'he-concrete', 'he-metal', 'he-large', 'heavy', 'incendiary', 'nuclear', 'he-far', 'heavy-far', 'ricochet', 'ric-rock', 'ric-concrete', 'ric-soil', 'ric-water',
      'penetrate', 'penetrate-heavy', 'shield-hit', 'emp', 'ear-ring', 'destruction', 'destruction-big', 'wreck-pops', 'turret-ring',
      'metal-creak', 'rubble', 'rubble-large', 'thump', 'thump-hard', 'landing', ...Object.values(ACTOR_LOOPS).map(k => k.sprite),
      ...['click', 'hover', 'confirm', 'cancel', 'open', 'close', 'denied', 'aim', 'objectiveNew', 'objectiveDone', 'objectiveFailed', 'checkpoint', 'banner', 'alarm', 'incoming', 'overheat', 'repair', 'captureTick', 'reloadReady', 'depotPing'].map(n => `ui-${n}`)];
    for (const id of needed) {
      const s = SFX_MANIFEST.sprites[id]; expect(s, id).toBeDefined();
      const bank = banks[s.bank ?? 0]; expect(bank, `${id} bank`).toBeDefined();
      for (const v of s.variants) { expect(v.offset).toBeGreaterThanOrEqual(0); expect(v.offset + v.seconds).toBeLessThanOrEqual(bank.seconds + 1e-6); }
    }
    for (const k of Object.values(ACTOR_LOOPS)) expect(SFX_MANIFEST.sprites[k.sprite].loop).toBe(true);
    expect(SFX_MANIFEST.sprites['coax-loop'].loop).toBe(true);
    // Weapons, explosions and destruction live in the heavy bank; loops, UI and machine guns in the core bank.
    for (const id of ['cannon', 'he', 'destruction']) expect(SFX_MANIFEST.sprites[id].bank).toBe(1);
    for (const id of ['coax-loop', 'ui-click', 'wreck-fire']) expect(SFX_MANIFEST.sprites[id].bank ?? 0).toBe(0);
  });
});
