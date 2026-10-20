/**
 * The pre-rendered effects banks: mono Opus files (public/audio/sfx/bank.ogg = core: UI, loops, impacts, small mechanics;
 * bank-heavy.ogg = weapons, explosions, destruction), each decoded ONCE into one AudioBuffer; every sound is a sprite
 * (bank, offset, seconds, variants, optional loop) in sfx-manifest.json. Playing a sprite is one AudioBufferSourceNode
 * reading a sub-range of its bank behind a budgeted spatial Voice. Until a bank has decoded, callers fall back to the
 * procedural recipes, so nothing is ever silent; the two banks load in parallel and independently.
 */
import type { AudioManager, PlayOptions } from './audio-manager';
import type { Voice } from './sfx/layers';
import manifest from './sfx-manifest.json';

export interface SfxSprite { id: string; bank?: number; variants: { offset: number; seconds: number }[]; loop?: boolean }
export interface SfxBankFile { file: string; seconds: number; samples: number; bytes: number }
export interface SfxManifest { version: number; file: string; sampleRate: number; seconds: number; samples: number; bytes: number; banks?: SfxBankFile[]; sprites: Record<string, SfxSprite> }
export const SFX_MANIFEST = manifest as unknown as SfxManifest;

export interface SampleOptions extends PlayOptions { variant?: number; rate?: number; loop?: boolean }
export interface BankLoader { load(file: string): Promise<AudioBuffer> }

export class SfxBank {
  readonly buffers: (AudioBuffer | null)[];
  loading: Promise<void> | null = null;
  lastError: string | null = null;
  played = 0;
  constructor(readonly manifest: SfxManifest = SFX_MANIFEST) { this.buffers = this.files.map(() => null); }
  /** The bank files (a v1 manifest has one). */
  get files(): SfxBankFile[] { return this.manifest.banks ?? [{ file: this.manifest.file, seconds: this.manifest.seconds, samples: this.manifest.samples, bytes: this.manifest.bytes }]; }
  /** The core bank's buffer (compatibility). */
  get buffer(): AudioBuffer | null { return this.buffers[0]; }
  /** Ready once the core bank has decoded (heavy sprites play as soon as theirs has). */
  get ready(): boolean { return this.buffers[0] !== null; }
  get decodedBytes(): number { return this.buffers.reduce((a, b) => a + (b ? b.length * b.numberOfChannels * 4 : 0), 0); }
  load(loader: BankLoader): Promise<void> {
    this.loading ??= Promise.all(this.files.map((f, i) => loader.load(f.file).then(b => { this.buffers[i] = b; }).catch(e => { this.lastError = `${f.file}: ${e instanceof Error ? e.message : String(e)}`; }))).then(() => { if (this.buffers[0] === null) this.loading = null; });
    return this.loading;
  }
  sprite(id: string): SfxSprite | undefined { return this.manifest.sprites[id]; }
  /** True when `id` exists and its bank has decoded. */
  has(id: string): boolean { const s = this.manifest.sprites[id]; return !!s && this.buffers[s.bank ?? 0] !== null; }
  /** Plays sprite `id` (variant chosen by `o.variant` modulo the take count) as one budgeted voice. */
  play(m: AudioManager, id: string, o: SampleOptions): Voice | null {
    const sprite = this.manifest.sprites[id];
    if (!sprite) return null;
    const buffer = this.buffers[sprite.bank ?? 0];
    if (!buffer) return null;
    const v = sprite.variants[((o.variant ?? 0) % sprite.variants.length + sprite.variants.length) % sprite.variants.length];
    const rate = Number.isFinite(o.rate) && o.rate! > 0 ? o.rate! : 1;
    const voice = m.playBuffer(buffer, v.offset, v.seconds, { ...o, rate, loop: o.loop ?? sprite.loop });
    if (voice) this.played++;
    return voice;
  }
}
/** Fetches `audio/sfx/<file>` and decodes it at the context's rate (effects keep full bandwidth). */
export class FetchBankLoader implements BankLoader {
  constructor(private readonly ctx: BaseAudioContext, private readonly baseUrl: string) {}
  async load(file: string): Promise<AudioBuffer> {
    const response = await fetch(`${this.baseUrl}audio/sfx/${file}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${file}`);
    return this.ctx.decodeAudioData(await response.arrayBuffer());
  }
}
