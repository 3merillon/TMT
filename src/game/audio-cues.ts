/**
 * Audio cues the simulation and campaign scripts can EMIT (as `{ type: 'audio', cue }` realtime events) without
 * importing the audio engine: this file is pure types in the sim layer; src/audio/cues.ts re-exports them and the audio
 * entry consumes the events. Cues are presentation only: fire-and-forget, never read back by gameplay.
 */
export type AudioUiSound =
  | 'click' | 'confirm' | 'cancel' | 'open' | 'close' | 'denied'
  | 'objective-new' | 'objective-done' | 'objective-failed' | 'checkpoint' | 'banner' | 'alarm' | 'incoming'
  | 'overheat' | 'repair' | 'capture-tick' | 'reload-ready' | 'depot-ping';

export type AudioCue =
  /** A boss fight is active; `phase` rises as the fight progresses (0 = opening). Repeats are ignored. */
  | { type: 'boss'; id: 'crawler' | 'leviathan' | 'titan' | 'rustcrown' | string; phase: number }
  /** The boss is dead or the fight is over (music returns to the world set). */
  | { type: 'boss-end' }
  /** Finale phases of 3-3 (null clears). */
  | { type: 'finale'; phase: 'duel' | 'core' | 'escape' | 'choice' | null }
  /** Fleet-launch defence escalation (ii-7): pads launched so far, 0..3. */
  | { type: 'escalation'; stage: number }
  /** The ending the player chose (plays its treatment through the results screen). */
  | { type: 'ending'; choice: 'rewind' | 'release' }
  /** A named musical stinger: victory, defeat, mission-start, checkpoint, boss-phase, escalation, undermined. */
  | { type: 'stinger'; id: string }
  /** A UI/feedback sound by name. */
  | { type: 'ui'; sound: AudioUiSound }
  /** A scripted threat override 0..1 held for `seconds` (an ambush, a scripted calm), then the measured estimate resumes. */
  | { type: 'threat'; value: number; seconds?: number }
  /** A checkpoint was saved. */
  | { type: 'checkpoint' };
