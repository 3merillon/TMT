import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { campaignCorpus } from '../scripts/campaign-voice-corpus';
import { CampaignVoice, VOICE_CLIPS } from '../src/audio/campaign-voice';
import { voiceKey } from '../src/audio/campaign-voice-key';
import { verifyPronunciation } from '../scripts/campaign-voice-audit';
import { CAST, synthesisText } from '../scripts/campaign-voice-direction';

describe('baked campaign speech', () => {
  it('ships every authored line, briefing, intel and both endings as valid-sized Ogg files', () => {
    const corpus = campaignCorpus(); expect(corpus.length).toBeGreaterThan(100);
    expect(Object.keys(VOICE_CLIPS).sort()).toEqual(corpus.map(c => c.id).sort());
    for (const line of corpus) {
      const clip = VOICE_CLIPS[line.id]; expect(clip.text).toBe(line.text); expect(clip.seconds).toBeGreaterThan(.5);
      const bytes = readFileSync(`public/audio/campaign/${clip.file}`);
      expect(bytes.length).toBe(clip.bytes); expect(bytes.subarray(0, 4).toString()).toBe('OggS');
    }
    const { cast, version, performances, assembly, pronunciationHash } = JSON.parse(readFileSync('public/audio/campaign/manifest.json', 'utf8'));
    expect(version).toBe(3);
    expect(assembly).toBe('whole-phrases');
    expect(cast).toEqual(CAST);
    expect(pronunciationHash).toBe(createHash('sha256').update(readFileSync('scripts/campaign-pronunciation.json')).digest('hex'));
    expect(Object.keys(performances).sort()).toEqual(corpus.map(c => c.id).sort());
    for (const line of corpus) {
      const clip = VOICE_CLIPS[line.id];
      const digest = createHash('sha256').update(readFileSync(`public/audio/campaign/${clip.file}`)).digest('hex').slice(0, 12);
      expect(clip.file).toBe(`${line.id}-${digest}.ogg`);
      const sentences = performances[line.id];
      expect(sentences.map((s: any) => s.text).join(' ')).toBe(line.text);
      for (const s of sentences) {
        expect(s.end).toBeGreaterThan(s.start);
        expect(s.pauseAfterMs).toBeGreaterThanOrEqual(300);
        expect(s.phrases.map((p: any) => p.text).join(' ')).toBe(s.text);
        for (const p of s.phrases) {
          expect(p.synthesisText ?? p.text).toBe(synthesisText(p));
          expect(p.sourceHash).toMatch(/^[0-9a-f]{64}$/);
          expect(Math.round((p.end - p.start) * 24000)).toBe(p.sourceSamples);
          expect(() => verifyPronunciation(p, line.text), `${line.id}: ${p.text}`).not.toThrow();
        }
      }
      const last = sentences.at(-1);
      expect(clip.seconds - (last.end + last.pauseAfterMs / 1000)).toBeCloseTo(0, 1);
    }
    expect(new Set(Object.values(cast).map((c: any) => c.voiceId)).size).toBe(8);
  });
  it('rejects the reported Tidewell misreading and contextually wrong homographs', () => {
    expect(() => verifyPronunciation({ text: 'Tidewell.', pronunciation: [{ text: 'Tidewell.', phonemes: 'tɪdiwɛl.' }] }, 'Tidewell.')).toThrow('Wrong pronunciation');
    expect(() => verifyPronunciation({ text: 'Lead it:', pronunciation: [{ text: 'Lead', phonemes: 'lˈɛd' }, { text: 'it:', phonemes: 'ɪt:' }] }, 'Lead it:')).toThrow('Wrong pronunciation');
    expect(() => verifyPronunciation({ text: 'Wind the clock.', pronunciation: [
      { text: 'Wind', phonemes: 'wˈɪnd' }, { text: 'the', phonemes: 'ðə' }, { text: 'clock.', phonemes: 'klɑk.' },
    ] }, 'Wind the clock.')).toThrow('Unreviewed context');
    expect(() => verifyPronunciation({ text: 'Our ships.', pronunciation: [{ text: 'Our', phonemes: 'ɑɹ' }] }, 'Our ships.')).toThrow('lost words');
  });
  it('normalizes editorial punctuation without conflating speakers', () => {
    expect(voiceKey('Mags', 'We’re here…')).toBe(voiceKey('Mags', "We're here..."));
    expect(voiceKey('Mags', 'Ready')).not.toBe(voiceKey('Brann', 'Ready'));
  });
  const fixture = () => {
    const sources: any[] = [];
    const ctx = { currentTime: 0, decodeAudioData: vi.fn(async () => ({ duration: 8 })), createBufferSource: () => {
      const source = { start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), onended: null as (() => void) | null, buffer: null };
      sources.push(source); return source;
    } };
    const clip = Object.values(VOICE_CLIPS)[0];
    return { ctx, sources, clip, player: new CampaignVoice(ctx as unknown as AudioContext, {} as AudioNode) };
  };
  it('resumes at the saved offset and resolves only after the final sample', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })));
    const { ctx, sources, clip, player } = fixture();
    const done = player.play(clip.speaker, clip.text);
    await vi.waitFor(() => expect(sources.length).toBe(1));
    ctx.currentTime = 2.4; player.setPaused(true);
    expect(sources[0].stop).toHaveBeenCalledOnce(); ctx.currentTime = 30;
    expect(player.telemetry()).toMatchObject({ duration: 8, elapsed: 2.4, clip: clip.file });
    player.setPaused(false);
    expect(sources[1].start).toHaveBeenCalledWith(0, 2.4);
    sources[1].onended(); expect(await done).toBe(true);
    expect(player.telemetry().played).toBe(1); vi.unstubAllGlobals();
  });
  it('cannot play a cancelled decode after changing missions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })));
    const { ctx, sources, clip, player } = fixture();
    let decoded!: (value: any) => void;
    ctx.decodeAudioData.mockImplementation(() => new Promise(resolve => { decoded = resolve; }));
    const done = player.play(clip.speaker, clip.text);
    await vi.waitFor(() => expect(decoded).toBeTypeOf('function'));
    player.stop(); decoded({ duration: 8 }); expect(await done).toBe(false); expect(sources).toHaveLength(0);
    vi.unstubAllGlobals();
  });
  it('keeps subtitle fallback available when the audio request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    const { clip, player } = fixture();
    expect(await player.play(clip.speaker, clip.text)).toBe(false); expect(player.lastError).toContain('404');
    vi.unstubAllGlobals();
  });
});
