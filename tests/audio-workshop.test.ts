import { describe, expect, it } from 'vitest';
import { FakeAudioContext } from '../src/audio/testing/fake-audio-context';
import { WorkshopAudio, workshopScoreStep, workshopSoundSamples, workshopSpatial, workshopCueSpatial, type WorkshopSound } from '../src/game/workshop/audio';
import { ElectroMusic } from '../src/audio/electro-music';

describe('workshop sound and score', () => {
  it('keeps machine directions camera-relative and attenuates distance', () => {
    expect(workshopSpatial([4, 1, 0], [0, 1, 6], [0, 1, 0]).pan).toBeGreaterThan(0);
    expect(workshopSpatial([4, 1, 0], [0, 1, -6], [0, 1, 0]).pan).toBeLessThan(0);
    expect(workshopSpatial([0, 1, 30], [0, 1, 0], [0, 1, 1]).gain).toBeLessThan(workshopSpatial([0, 1, 3], [0, 1, 0], [0, 1, 1]).gain);
  });
  it('reprises a distinct electro hook with harmonic answers, syncopated bass and a quieter breakdown', () => {
    const bars = Array.from({ length: 8 }, (_, i) => workshopScoreStep(i * 16));
    expect(new Set(bars.map(bar => bar.notes.join(','))).size).toBeGreaterThan(4);
    expect(bars.every(bar => bar.notes.length === 3 && bar.bass !== undefined)).toBe(true);
    expect(workshopScoreStep(256)).toEqual(workshopScoreStep(0));
    const hook = (start: number) => Array.from({ length: 32 }, (_, i) => workshopScoreStep(start + i).lead);
    expect(hook(128)).toEqual(hook(0)); expect(hook(64)).not.toEqual(hook(0));
    expect(hook(0).filter(v => v !== undefined).length).toBeGreaterThan(8);
    const hits = (bar: number) => Array.from({ length: 16 }, (_, i) => workshopScoreStep(bar * 16 + i).drums.length).reduce((a, b) => a + b, 0);
    expect(hits(12)).toBeLessThan(hits(8)); expect(workshopScoreStep(3).bass).toBeDefined();
  });
  it('makes steam substantially quieter, darker with distance and correctly panned', () => {
    const near = workshopCueSpatial('steam', [2, 1, 0], [0, 1, 0], [0, 1, -1]);
    const far = workshopCueSpatial('steam', [10, 1, 0], [0, 1, 0], [0, 1, -1]);
    expect(near.gain).toBeLessThan(.18); expect(far.gain).toBeLessThan(near.gain * .45);
    expect(far.cutoff).toBeLessThan(near.cutoff); expect(near.cutoff).toBeLessThan(1900); expect(far.pan).toBeGreaterThan(0);
    expect(near.gain).toBeLessThan(workshopCueSpatial('seat', [2, 1, 0], [0, 1, 0], [0, 1, -1]).gain * .3);
  });
  it('shares pooled noise and retains the same score across workshop and skirmish modes', () => {
    const ctx = new FakeAudioContext(), context = ctx.asAudioContext(), noise = context.createBuffer(1, 48000, 48000), output = context.createGain(), baseline = ctx.buffersCreated;
    void ctx.resume();
    const music = new ElectroMusic(context, output, { mode: 'skirmish', noise, maxVoices: 16 }); music.setIntensity(.9);
    for (let i = 0; i < 800; i++) { ctx.advance(.1); music.update(); expect(music.liveVoices).toBeLessThanOrEqual(16); }
    expect(ctx.buffersCreated).toBe(baseline); expect(music.notes).toBeGreaterThan(500); music.dispose(); expect(music.nodeCount).toBe(0);
  });
  it('bounds the complete electro arrangement over several repeating phrases', () => {
    const ctx = new FakeAudioContext(), audio = new WorkshopAudio(.6, { context: ctx.asAudioContext() }); audio.unlock();
    for (let i = 0; i < 1600; i++) { ctx.advance(.1); audio.update(); expect(audio.snapshot().voices).toBeLessThanOrEqual(32); expect(audio.snapshot().nodes).toBeLessThan(230); }
    expect(audio.snapshot().musicNotes).toBeGreaterThan(1000); audio.dispose(); expect(audio.snapshot().nodes).toBe(0);
  });
  it.each<WorkshopSound>(['servo', 'release', 'clamp', 'seat', 'ratchet', 'steam'])('%s has finite audible samples and a quiet endpoint', kind => {
    const samples = workshopSoundSamples(kind, 8000);
    let energy = 0, peak = 0;
    for (const sample of samples) { expect(Number.isFinite(sample)).toBe(true); energy += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
    expect(peak).toBeLessThan(1); expect(energy / samples.length).toBeGreaterThan(.00005); expect(Math.abs(samples.at(-1)!)).toBeLessThan(.01);
  });
  it('allocates no audio until a gesture and bounds rapid servicing voices', () => {
    const ctx = new FakeAudioContext(), audio = new WorkshopAudio({ master: .8, sfx: .9, music: .6 }, { context: ctx.asAudioContext() });
    audio.play('clamp'); expect(ctx.nodeCount()).toBe(0); expect(audio.snapshot().state).toBe('locked');
    audio.unlock(); const pools = ctx.buffersCreated;
    for (let i = 0; i < 150; i++) { audio.play('clamp'); audio.setMotion({ arm: .8 }); audio.update(); }
    expect(audio.snapshot().voices).toBeLessThanOrEqual(32); expect(ctx.buffersCreated).toBe(pools + 1);
    audio.dispose(); expect(audio.snapshot()).toMatchObject({ state: 'disposed', voices: 0, nodes: 0 });
    audio.unlock(); expect(audio.snapshot().nodes).toBe(0);
  });
  it('cancels motion and servicing while retaining music, with independent bus settings', () => {
    const ctx = new FakeAudioContext(), audio = new WorkshopAudio({ master: .8, sfx: .9, music: .6 }, { context: ctx.asAudioContext() });
    audio.unlock(); audio.setMotion({ lift: 1, arm: .5, trolley: .3 }); audio.play('ratchet'); audio.cancel();
    expect(audio.snapshot().motion).toEqual({ lift: 0, arm: 0, trolley: 0 }); expect(audio.snapshot().voices).toBeGreaterThan(0);
    const cues = audio.snapshot().cues, notes = audio.snapshot().musicNotes;
    audio.applySettings({ master: 1, music: .5, sfx: 0 }); audio.play('steam'); ctx.advance(.5); audio.update();
    expect(audio.snapshot().cues).toBe(cues); expect(audio.snapshot().musicNotes).toBeGreaterThan(notes);
    audio.applySettings({ master: 1, music: 0, sfx: .6 }); const mutedNotes = audio.snapshot().musicNotes;
    ctx.advance(2); audio.update(); audio.play('seat'); expect(audio.snapshot().musicNotes).toBe(mutedNotes); expect(audio.snapshot().cues).toBe(cues + 1);
    audio.dispose();
  });
  it('suspends hidden rooms and resumes without a burst of missed notes', async () => {
    const ctx = new FakeAudioContext(), audio = new WorkshopAudio(.6, { context: ctx.asAudioContext() });
    audio.unlock(); audio.setActive(false); expect(ctx.state).toBe('suspended'); const notes = audio.snapshot().musicNotes;
    ctx.advance(100); audio.update(); expect(audio.snapshot().musicNotes).toBe(notes);
    audio.setActive(true); expect(ctx.state).toBe('running'); audio.update(); expect(audio.snapshot().musicNotes - notes).toBeLessThan(9);
    audio.dispose();
  });
});
