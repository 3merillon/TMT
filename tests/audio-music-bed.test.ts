import { describe, expect, it, vi } from 'vitest';
import { AudioManager } from '../src/audio/audio-manager';
import { MusicBed } from '../src/audio/music-bed';
import { FakeAudioContext, type FakeNode, reachable } from '../src/audio/testing/fake-audio-context';
import { FakeLoader, settle, testManifest } from './helpers/score';

const rig = () => { const ctx = new FakeAudioContext(8000), manager = new AudioManager(ctx.asAudioContext()), manifest = testManifest(), loader = new FakeLoader(ctx, manifest); return { ctx, manager, loader, music: new MusicBed(manager, { manifest, loader }) }; };

describe('application score (music bed)', () => {
  it('does not start on a suspended clock and joins when it runs, without a second deck', async () => {
    vi.useFakeTimers();
    const { ctx, music } = rig();
    try {
      music.start(7); await settle(); vi.advanceTimersByTime(500); music.tick();
      expect(music.liveVoices).toBe(0);
      void ctx.resume(); music.tick(); expect(music.liveVoices).toBe(3); expect(music.snapshot().track).toBe('title');
      void ctx.suspend(); const sources = ctx.nodeCount('bufferSource'); vi.advanceTimersByTime(3000); music.tick();
      void ctx.resume(); ctx.advance(20); music.tick(); expect(ctx.nodeCount('bufferSource')).toBe(sources);
    } finally { music.dispose(); vi.useRealTimers(); }
  });
  it('keeps one timer and one transport across restarts, scenes and worlds; the latest world wins on a bar', async () => {
    vi.useFakeTimers();
    const { ctx, manager, music, loader } = rig();
    try {
      void ctx.resume(); music.start(1); await settle(); music.tick();
      expect(vi.getTimerCount()).toBe(1); expect(music.snapshot().track).toBe('title');
      music.start(2); music.start(3); await settle(); music.tick();
      expect(vi.getTimerCount()).toBe(1); expect(music.player.transitions).toBe(1);
      for (const scene of ['menu', 'workshop', 'setup'] as const) { music.setScene(scene); await settle(); ctx.advance(0.6); music.tick(); }
      expect(music.player.transitions).toBe(2); // title → workshop once; menu/setup/workshop share it
      music.setScene('loading', 'temperate'); music.setScene('loading', 'dune'); await settle(); ctx.advance(3); music.tick();
      expect(music.snapshot().track).toBe('cradle-explore');
      music.setScene('skirmish', 'dune'); music.setThreat(1); for (let i = 0; i < 40; i++) { ctx.advance(0.3); music.tick(); await settle(); }
      expect(music.snapshot().track).toBe('dune-combat'); expect(music.snapshot().tier).toBeGreaterThanOrEqual(2);
      music.setScene('pause'); ctx.advance(0.3); music.tick(); expect(music.snapshot().track).toBe('dune-combat'); expect(music.snapshot().plan?.level).toBe(0.5);
      music.setScene('skirmish'); music.setScene('results'); music.setOutcome('won'); await settle(); ctx.advance(0.3); music.tick();
      expect(music.player.stingers).toBe(1);
      music.setScene('menu'); await settle(); ctx.advance(3); music.tick(); expect(music.snapshot().track).toBe('workshop');
      expect(loader.loads.filter(f => f.startsWith('title')).length).toBe(3);
      expect(reachable(manager.buses.input.music as unknown as FakeNode).has(ctx.destination)).toBe(true);
      music.stop(); expect(vi.getTimerCount()).toBe(0); expect(music.playing).toBe(false);
      expect(manager.lastError).toBeNull();
    } finally { music.dispose(); vi.useRealTimers(); }
  });
  it('mutes without stopping the transport and disposes every node', async () => {
    const { ctx, music } = rig();
    void ctx.resume(); music.start(); await settle(); music.tick();
    music.setMuted(true); ctx.advance(6); music.tick(); expect(music.liveVoices).toBe(3); expect(music.notes).toBeGreaterThan(0);
    music.setMuted(false); music.dispose(); expect(music.liveVoices).toBe(0); expect(music.playing).toBe(false);
  });
});
