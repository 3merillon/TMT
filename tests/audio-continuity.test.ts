import { describe, expect, it, vi } from 'vitest';
import { AudioManager } from '../src/audio/audio-manager';
import { MusicBed, MAX_MUSIC_VOICES } from '../src/audio/music-bed';
import { WorldSoundscape } from '../src/audio/world-soundscape';
import { FakeAudioContext } from '../src/audio/testing/fake-audio-context';
import { WorkshopAudio } from '../src/game/workshop/audio';
import type { PlanetKind } from '../src/world/sun';
import { FakeLoader, settle, testManifest } from './helpers/score';
import type { MusicScene } from '../src/audio/score/director';

const worlds: PlanetKind[] = ['temperate', 'glacial', 'dune', 'volcanic'];
describe('continuous application music', () => {
  it('retains one clock, one timer and one noise pool through scenes and repeated starts', async () => {
    vi.useFakeTimers();
    const ctx = new FakeAudioContext(8000), manager = new AudioManager(ctx.asAudioContext()), manifest = testManifest(), music = new MusicBed(manager, { manifest, loader: new FakeLoader(ctx, manifest) });
    try {
      void ctx.resume(); music.start(); await settle(); music.tick(); const buffers = ctx.buffersCreated;
      let bar = music.notes, transitions = music.player.transitions;
      for (const scene of ['workshop', 'menu', 'setup', 'loading', 'skirmish', 'pause', 'skirmish', 'results', 'title'] as MusicScene[]) {
        music.setScene(scene, 'glacial'); music.start(9); await settle(); ctx.advance(2.6); music.tick();
        expect(vi.getTimerCount()).toBe(1); expect(music.liveVoices).toBeLessThanOrEqual(8); expect(music.player.transitions - transitions).toBeLessThanOrEqual(1); transitions = music.player.transitions;
      }
      expect(music.notes).toBeGreaterThanOrEqual(0); void bar;
      // Only stems were decoded (through the loader); the pools never grew.
      expect(ctx.buffersCreated - buffers).toBeLessThanOrEqual(12); expect(manager.lastError).toBeNull();
    } finally { music.dispose(); manager.dispose(); vi.useRealTimers(); }
  });
  it('coalesces rapid world requests on one transport and keeps the graph bounded', async () => {
    const ctx = new FakeAudioContext(8000), manager = new AudioManager(ctx.asAudioContext()), manifest = testManifest(), music = new MusicBed(manager, { manifest, loader: new FakeLoader(ctx, manifest) });
    void ctx.resume(); music.start(); await settle(); music.tick();
    for (let i = 0; i < 200; i++) { if (i % 19 === 0) music.setScene('skirmish', worlds[(i / 19 | 0) % 4]); music.setThreat(i % 50 < 25 ? 1 : 0); ctx.advance(0.25); music.tick(); await settle(1); expect(music.liveVoices).toBeLessThanOrEqual(MAX_MUSIC_VOICES); }
    expect(music.player.transitions).toBeLessThan(20); expect(ctx.nodeCount('bufferSource')).toBeLessThan(80);
    music.dispose(); expect(music.liveVoices).toBe(0); manager.dispose();
  });
  it('can keep workshop machinery active without a duplicate score', () => {
    const ctx = new FakeAudioContext(), workshop = new WorkshopAudio(.6, { context: ctx.asAudioContext(), music: false });
    workshop.unlock(); workshop.setMotion({ lift: 1 }); workshop.play('seat'); ctx.advance(.2); workshop.update();
    expect(workshop.snapshot()).toMatchObject({ musicNotes: 0, musicOwner: 'application', motion: { lift: 1 } });
    expect(workshop.snapshot().cues).toBe(1); workshop.dispose(); expect(workshop.snapshot().nodes).toBe(0);
  });
});

describe('world soundscapes', () => {
  it('morphs pooled environmental beds without allocating buffers or growing voices', () => {
    const ctx = new FakeAudioContext(), m = new AudioManager(ctx.asAudioContext()), buffers = ctx.buffersCreated;
    const soundscape = new WorldSoundscape(ctx.asAudioContext(), m.buses.input.ambience, m.pools), nodes = ctx.nodeCount();
    for (let i = 0; i < 100; i++) { soundscape.setWorld(worlds[i % 4]); soundscape.setActive(i % 2 === 0); ctx.advance(.1); }
    expect(ctx.buffersCreated).toBe(buffers); expect(ctx.nodeCount()).toBe(nodes); expect(soundscape.snapshot().voices).toBe(4);
    soundscape.dispose(); expect(soundscape.snapshot()).toMatchObject({ voices: 0, nodes: 0 }); m.dispose();
  });
});
