/**
 * The explicit cue API (docs/audio-continuity.md#game-and-campaign-integration). The cue types live in the sim layer (src/game/audio-cues.ts) so
 * campaign scripts can emit `{ type: 'audio', cue }` realtime events without importing the audio; presentation code
 * (HUD, session) may call `dispatchAudioCue` directly. Everything is optional: the engine also derives threat from the
 * snapshot, the Crawler's phase from component stages, and finale/boss phases from the mission runner's beat ids.
 * Explicit cues take precedence over derived state while they are set.
 */
export type { AudioCue, AudioUiSound } from '../game/audio-cues';
import type { AudioCue } from '../game/audio-cues';

export const AUDIO_CUE_EVENT = 'tmt:audio-cue';
/** Fire-and-forget cue from presentation code: a window event the audio entry listens for; a no-op without a window. */
export function dispatchAudioCue(cue: AudioCue): void {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent(AUDIO_CUE_EVENT, { detail: cue }));
}
