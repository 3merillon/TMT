/** What every screen gets from the UI controller: the flow, the profile and the actions it may take. */
import type { KitLoadoutIds } from '../../api/match';
import type { ProgressProfile } from '../../meta/profile';
import type { SettingsPatch } from '../../meta/settings';
import type { FlowEvent, FlowState } from '../flow';
import type { SkirmishOptions } from '../skirmish-setup';
import type { MissionId } from '../../campaign/mission';

export interface MatchSummary {
  title: string;
  eyebrow: string;
  detail: string;
  stats: { label: string; value: string }[];
  outcome: 'win' | 'loss' | 'draw' | 'forfeit' | 'other';
  /** Campaign: the mission a "Next mission" action starts. */
  next?: MissionId;
  /** Campaign: a lost mission has a checkpoint, so the card offers both a checkpoint retry and a restart. */
  checkpoint?: boolean;
}
export interface ScreenContext {
  readonly flow: FlowState;
  readonly profile: ProgressProfile;
  /** The renderer finished warming up. */
  readonly viewReady: boolean;
  readonly skirmish: SkirmishOptions;
  readonly summary: MatchSummary | null;
  /** The running match is a campaign mission. */
  readonly campaign?: boolean;
  readonly online?: boolean;
  readonly onlineEnded?: boolean;
  leaveOnline?(): void;
  resumeOnline?(): void;
  validateOnlineBuild?(): void;
  readonly onlineHost?: boolean;
  rematchOnline?(mission?: MissionId): void;
  go(event: FlowEvent): void;
  setSkirmish(options: SkirmishOptions): void;
  startSkirmish(): void;
  startWorkshopTest?(mode: 'drive' | 'bot'): void;
  openWorkshop?(): void;
  startPlayground?(): void;
  /** Start a campaign mission with the active build. */
  startMission?(id: MissionId): void;
  setProfile(profile: ProgressProfile): void;
  /** Commit only after browser storage succeeds; editors can retain unsaved work on quota failure. */
  saveProfile?(profile: ProgressProfile): boolean;
  setLoadout(index: number, kit: KitLoadoutIds, name?: string): void;
  setActiveLoadout(index: number): void;
  updateSettings(patch: SettingsPatch): void;
  toast(message: string, seconds?: number): void;
  forfeit(): void;
  /** Re-renders the current screen (local UI state changed). */
  refresh(): void;
}
