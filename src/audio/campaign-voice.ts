import catalog from './campaign-voice-manifest.json';
import { voiceKey } from './campaign-voice-key';
export interface VoiceClip { speaker: string; text: string; file: string; seconds: number; bytes: number }
export const VOICE_CLIPS: Readonly<Record<string, VoiceClip>> = catalog;
export const voiceClip = (speaker: string, text: string) => VOICE_CLIPS[voiceKey(speaker, text)];

/** One speaker, at most 12 decoded buffers. Cancellation during fetch/decode cannot
 * resurrect a line from an earlier mission. Pausing preserves the sample offset. */
export class CampaignVoice {
  private cache = new Map<string, AudioBuffer>();
  private serial = 0;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private clip: VoiceClip | null = null;
  private offset = 0;
  private started = 0;
  private complete: (() => void) | null = null;
  private paused = false;
  private abort: AbortController | null = null;
  played = 0;
  lastError: string | null = null;
  constructor(private ctx: AudioContext, private destination: AudioNode, private speaking: (active: boolean) => void = () => {}) {}
  async play(speaker: string, text: string): Promise<boolean> {
    this.stop();
    const clip = voiceClip(speaker, text); if (!clip) return false;
    const serial = this.serial, abort = new AbortController(); this.abort = abort;
    const timeout = setTimeout(() => abort.abort(), 12000);
    try {
      let buffer = this.cache.get(clip.file);
      if (!buffer) {
        const response = await fetch(`${import.meta.env.BASE_URL}audio/campaign/${clip.file}`, { signal: abort.signal });
        if (!response.ok) throw new Error(`Voice HTTP ${response.status}: ${clip.file}`);
        buffer = await this.ctx.decodeAudioData(await response.arrayBuffer());
        if (serial !== this.serial) return false;
        this.cache.set(clip.file, buffer);
        while (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value!);
      }
      if (serial !== this.serial) return false;
      clearTimeout(timeout);
      this.buffer = buffer; this.clip = clip; this.offset = 0;
      await new Promise<void>(resolve => { this.complete = resolve; if (!this.paused) this.start(); });
      return serial === this.serial;
    } catch (error) {
      if (serial === this.serial) this.lastError = String(error);
      return false;
    } finally { clearTimeout(timeout); }
  }
  private start(): void {
    if (!this.buffer || this.source) return;
    const source = this.ctx.createBufferSource(); source.buffer = this.buffer;
    source.connect(this.destination); this.source = source; this.started = this.ctx.currentTime;
    source.onended = () => {
      if (this.source !== source) return;
      source.disconnect(); this.source = null; this.buffer = null; this.clip = null; this.played++;
      this.speaking(false);
      this.complete?.(); this.complete = null;
    };
    source.start(0, Math.min(this.offset, Math.max(0, this.buffer.duration - .001)));
    this.speaking(true);
  }
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused && this.source) {
      this.offset += this.ctx.currentTime - this.started;
      const source = this.source; this.source = null; source.onended = null; source.stop(); source.disconnect();
      this.speaking(false);
    } else if (!paused) this.start();
  }
  stop(): void {
    this.serial++; this.abort?.abort(); this.abort = null;
    if (this.source) { this.source.onended = null; this.source.stop(); this.source.disconnect(); }
    this.source = null; this.buffer = null; this.clip = null; this.offset = 0;
    this.speaking(false);
    this.complete?.(); this.complete = null;
  }
  telemetry() {
    const duration = this.buffer?.duration ?? 0;
    const elapsed = this.buffer ? Math.min(duration, this.offset + (this.source ? this.ctx.currentTime - this.started : 0)) : 0;
    return { playing: !!this.buffer, paused: this.paused, played: this.played, cached: this.cache.size,
      clip: this.clip?.file ?? null, duration, elapsed, lastError: this.lastError };
  }
}
