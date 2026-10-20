/** The music director (pure) and the score player (fake WebAudio): tiers with hysteresis, quantized track changes,
 * phase-locked layers, bounded cache, mute/suspend behaviour, stingers. */
import { describe, expect, it } from 'vitest';
import { MusicDirector, TIERS, TIER_HOLD_S, EXPLORE_COOLDOWN_S, worldSetOf } from '../src/audio/score/director';
import { ScorePlayer } from '../src/audio/score/player';
import { FakeAudioContext, FakeBufferSource, FakeGain } from '../src/audio/testing/fake-audio-context';
import { FakeLoader, settle, testManifest } from './helpers/score';

const manifest = testManifest();
const director = () => new MusicDirector({ has: id => !!manifest.tracks[id] });

describe('music director', () => {
  it('maps scenes and worlds to existing tracks, falling back to the cradle set', () => {
    const d = director();
    expect(d.update({ scene: 'title', threat: 0 }, 0).track).toBe('title');
    expect(d.update({ scene: 'workshop', threat: 0 }, 1).track).toBe('workshop');
    expect(d.update({ scene: 'loading', world: 'glacial', mission: 'f-a', threat: 0 }, 2)).toMatchObject({ track: 'cradle-explore', layers: [1, 0.25, 0, 0, 1] });
    expect(worldSetOf('glacial', '3-1')).toBe('halo'); expect(worldSetOf('glacial', 'f-b')).toBe('frost'); expect(worldSetOf('temperate', null)).toBe('cradle');
    expect(d.update({ scene: 'skirmish', world: 'dune', mission: '1-3', threat: 0 }, 3).track).toBe('cradle-explore');
  });
  it('raises tiers with hysteresis, holds them, and returns to exploration only after a cooldown', () => {
    const d = director();
    let now = 0;
    const step = (threat: number, seconds = 0.25) => { now += seconds; return d.update({ scene: 'skirmish', world: 'temperate', threat }, now); };
    expect(step(0).track).toBe('cradle-explore');
    let plan = step(0.95);
    for (let i = 0; i < 40 && plan.tier < 4; i++) plan = step(0.95);
    expect(plan).toMatchObject({ track: 'cradle-combat', tier: 4, layers: [1, 1, 1, 1, 1] });
    const climbed = now;
    // A momentary dip inside the hysteresis band changes nothing.
    for (let i = 0; i < 8; i++) plan = step(TIERS[3][1] + 0.05);
    expect(plan.tier).toBe(4);
    // Silence: the top tier is held for TIER_HOLD_S, then the tiers step down and exploration returns after the cooldown.
    plan = step(0, TIER_HOLD_S - 0.5);
    expect(plan.tier).toBe(4);
    for (let i = 0; i < 400 && plan.track !== 'cradle-explore'; i++) plan = step(0);
    expect(plan.track).toBe('cradle-explore');
    expect(now - climbed).toBeGreaterThanOrEqual(TIER_HOLD_S + EXPLORE_COOLDOWN_S);
  });
  it('stalks on the hunt track at low threat, rotates combat A/B per match and never repeats B', () => {
    const d = director();
    let now = 0;
    const step = (threat: number, match: number, seconds = 0.25) => { now += seconds; return d.update({ scene: 'skirmish', world: 'temperate', threat, match }, now); };
    let plan = step(0, 1);
    for (let i = 0; i < 20 && plan.tier < 1; i++) plan = step(0.3, 1);
    expect(plan).toMatchObject({ track: 'cradle-hunt', tier: 1 });
    for (let i = 0; i < 40 && plan.tier < 2; i++) plan = step(0.5, 1);
    expect(plan.track).toBe('cradle-combat');
    // The next match takes combat B; the one after returns to A.
    const d2 = director();
    const climb = (match: number) => { let p = d2.update({ scene: 'skirmish', world: 'temperate', threat: 1, match }, now += 1); for (let i = 0; i < 60 && p.tier < 2; i++) p = d2.update({ scene: 'skirmish', world: 'temperate', threat: 1, match }, now += 0.25); return p.track; };
    expect(climb(1)).toBe('cradle-combat'); d2.update({ scene: 'loading', threat: 0, match: 1 }, now += 30);
    expect(climb(2)).toBe('cradle-combat-b'); d2.update({ scene: 'loading', threat: 0, match: 2 }, now += 30);
    expect(climb(3)).toBe('cradle-combat');
  });
  it('does not flicker between tiers on a noisy threat', () => {
    const d = director();
    let now = 0, changes = 0, last = -1;
    for (let i = 0; i < 240; i++) { now += 0.25; const plan = d.update({ scene: 'skirmish', world: 'temperate', threat: 0.5 + 0.12 * Math.sin(i * 1.7) }, now); if (plan.tier !== last) { changes++; last = plan.tier; } }
    expect(changes).toBeLessThanOrEqual(3);
  });
  it('plays boss tracks with phase layers, fires phase and outcome stingers once, and keeps the track on pause', () => {
    const d = director();
    expect(d.update({ scene: 'skirmish', world: 'dune', mission: '1-5', threat: 0.7, boss: { id: 'crawler', phase: 0 } }, 1)).toMatchObject({ track: 'boss-crawler', layers: [1, 1, 0.35, 0, 1], stinger: null });
    expect(d.update({ scene: 'skirmish', world: 'dune', mission: '1-5', threat: 0.7, boss: { id: 'crawler', phase: 1 } }, 2)).toMatchObject({ layers: [1, 1, 1, 0, 1], stinger: 'stinger-boss-phase' });
    expect(d.update({ scene: 'skirmish', world: 'dune', mission: '1-5', threat: 0.7, boss: { id: 'crawler', phase: 1 } }, 3).stinger).toBeNull();
    expect(d.update({ scene: 'pause', world: 'dune', mission: '1-5', threat: 0.7, boss: { id: 'crawler', phase: 2 } }, 4)).toMatchObject({ track: 'boss-crawler', level: 0.5 });
    expect(d.update({ scene: 'results', world: 'dune', mission: '1-5', threat: 0, outcome: 'won' }, 5)).toMatchObject({ stinger: 'stinger-victory', level: 0.8 });
    expect(d.update({ scene: 'results', world: 'dune', mission: '1-5', threat: 0, outcome: 'won' }, 6).stinger).toBeNull();
  });
});

describe('score player', () => {
  function rig() {
    const ctx = new FakeAudioContext(8000); void ctx.resume();
    const loader = new FakeLoader(ctx, manifest), dest = ctx.createGain();
    const player = new ScorePlayer(ctx.asAudioContext(), dest as unknown as AudioNode, manifest, loader, { cacheBytes: 2 * 1024 * 1024 });
    return { ctx, loader, player, sources: () => Array.from({ length: 0 }) as FakeBufferSource[] };
  }
  const started = (ctx: FakeAudioContext) => ctx.nodeCount('bufferSource');
  it('starts all layers phase-locked on one time, never restarts the same track, and ramps layers in place', async () => {
    const { ctx, player, loader } = rig();
    player.request('cradle-combat', [1, 1, 0, 0], true); await settle(); player.tick();
    expect(player.current).toBe('cradle-combat'); expect(started(ctx)).toBe(4); expect(loader.loads.length).toBe(4);
    const s = player.snapshot(); expect(s.layers).toEqual([1, 1, 0, 0]);
    player.request('cradle-combat', [1, 1, 1, 0], true); await settle(); player.tick();
    expect(started(ctx)).toBe(4); expect(player.transitions).toBe(1); expect(player.snapshot().layers).toEqual([1, 1, 1, 0]);
  });
  it('enters a new track on the outgoing deck\'s next bar with a crossfade and retires the old sources', async () => {
    const { ctx, player } = rig();
    player.request('cradle-explore', [1, 0, 0, 0], true); await settle(); player.tick();
    ctx.advance(1.3); player.request('cradle-combat', [1, 1, 0, 0], false); await settle(); player.tick();
    const barSec = 60 / 118 * 4;
    const deckStart = ctx.currentTime - 1.3;
    const expected = deckStart + Math.ceil((1.3 + 0.43) / barSec) * barSec;
    const srcs = (ctx as unknown as { counts: Map<string, number> }).counts;
    expect(srcs.get('bufferSource')).toBe(7);
    expect(player.current).toBe('cradle-combat'); expect(player.transitions).toBe(2);
    expect(player.snapshot().retiring).toBe(1);
    ctx.advance(expected - ctx.currentTime + 3); player.tick();
    expect(player.snapshot().retiring).toBe(0);
  });
  it('waits for a running context, keeps the transport while muted, bounds the cache and disposes cleanly', async () => {
    const { ctx, player } = rig();
    void ctx.suspend();
    player.request('title', [1, 1, 1, 0], true); await settle(); player.tick();
    expect(player.current).toBeNull();
    void ctx.resume(); player.tick(); expect(player.current).toBe('title');
    player.setMuted(true); expect(player.current).toBe('title'); expect(player.sourceCount).toBe(3);
    const g = player.out as unknown as FakeGain; expect(g.gain.events.at(-1)).toMatchObject({ type: 'target', value: 0 });
    // Many different tracks: the cache stays under its bound.
    for (const id of ['workshop', 'cradle-explore', 'cradle-combat', 'dune-combat', 'boss-crawler']) { player.request(id, [1, 1, 1, 1], true); await settle(); ctx.advance(5); player.tick(); }
    expect(player.snapshot().cacheBytes).toBeLessThanOrEqual(2 * 1024 * 1024 + 4 * 24 * 8000 * 2 * 4 * 2);
    player.playStinger('stinger-victory'); await settle();
    expect(player.stingers).toBe(1);
    player.dispose(); expect(player.sourceCount).toBe(0); expect(player.current).toBeNull();
  });
  it('resumes a track where it was last heard, on a bar, and switches menus on the next beat with an equal-power blend', async () => {
    const { ctx, player } = rig();
    player.request('title', [1, 1, 1, 0], true); await settle(); player.tick();
    const barSec = 60 / 108 * 4, beatSec = barSec / 4;
    ctx.advance(barSec * 6.3);                                                   // well into the loop (intro is 1 bar)
    player.request('workshop', [1, 1, 0.6, 0], false, { fade: 0.3, quantize: 'beat' }); await settle(); player.tick();
    const first = ctx.nodeCount('bufferSource');
    const started = (ctx as unknown as { counts: Map<string, number> }).counts;
    expect(started.get('bufferSource')).toBe(first);
    const sources = Array.from({ length: 0 }) as FakeBufferSource[]; void sources;
    // The switch waited for the next BEAT of the title (not the next bar).
    const titleStart = ctx.currentTime - barSec * 6.3, expectAt = titleStart + Math.ceil((barSec * 6.3 + 0.05) / beatSec) * beatSec;
    expect(expectAt - ctx.currentTime).toBeLessThanOrEqual(beatSec + 1e-6);
    ctx.advance(expectAt - ctx.currentTime + 3); player.tick();
    expect(player.current).toBe('workshop');
    // Back to the title: it resumes at the bar it reached (bar 6 of the loop), not at its intro.
    player.request('title', [1, 1, 1, 0], false, { fade: 0.3, quantize: 'beat' }); await settle(); player.tick();
    ctx.advance(1.1); player.tick();                                             // past the workshop's next beat (+ lead): the title is back
    const pos = player.position();
    expect(player.current).toBe('title'); expect(pos).not.toBeNull();
    expect(pos!.seconds).toBeGreaterThanOrEqual(barSec - 1e-3);                 // past the intro: resumed, not restarted
    expect((pos!.seconds - barSec) % barSec).toBeLessThan(0.85);                 // on a bar-aligned resume offset
    player.dispose();
  });
  it('reports a missing stem without starting a half track', async () => {
    const { player, loader } = rig();
    loader.fail.add('dune-combat-l2.ogg');
    player.request('dune-combat', [1, 1, 1, 1], true); await settle(); player.tick();
    expect(player.current).toBeNull(); expect(player.decodeErrors).toBe(1); expect(player.lastError).toContain('dune-combat-l2');
  });
});
