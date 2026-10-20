/** Campaign progress in the existing profile (src/game/campaign/README.md): `stars['campaign:<id>']` is 1 for a
 * cleared mission and 2 when its medal was earned too. Pure. */
import type { ProgressProfile } from '../meta/profile';
import type { MissionId } from './mission';
import { CAMPAIGN } from './catalog';

export const missionKey = (id: MissionId): string => `campaign:${id}`;
/** 0 = not cleared, 1 = cleared, 2 = cleared with the medal. */
export function missionStars(profile: Pick<ProgressProfile, 'stars'>, id: MissionId): number { return profile.stars[missionKey(id)] ?? 0; }
/** The first mission is always open; each later one opens when the one before it is cleared. */
export function missionUnlocked(profile: Pick<ProgressProfile, 'stars'>, id: MissionId): boolean {
  const index = CAMPAIGN.findIndex(m => m.id === id);
  const required = CAMPAIGN[index]?.requires;
  return required ? required.every(m => missionStars(profile, m) > 0) : index === 0 || (index > 0 && missionStars(profile, CAMPAIGN[index - 1].id) > 0);
}
/** The mission Campaign continues with: the first uncleared one, else the last. */
export function continueMission(profile: Pick<ProgressProfile, 'stars'>): MissionId {
  return (CAMPAIGN.find(m => missionUnlocked(profile, m.id) && missionStars(profile, m.id) === 0) ?? CAMPAIGN[CAMPAIGN.length - 1]).id;
}
/** A cleared mission keeps its best result. */
export function withMissionResult<P extends Pick<ProgressProfile, 'stars'>>(profile: P, id: MissionId, medal: boolean): P {
  const stars = Math.max(missionStars(profile, id), medal ? 2 : 1);
  return { ...profile, stars: { ...profile.stars, [missionKey(id)]: stars } };
}

/** Pay each reward once; replay improvements pay only their delta. */
export function campaignClearXP(id: MissionId): number { return id.startsWith('p') ? 75 : id.startsWith('1-') ? 55 : 60; }
export function campaignReward(profile: ProgressProfile, id: MissionId, result: { medal: boolean; optional: boolean; secrets: number; ending?: 'rewind' | 'release' | null }): ProgressProfile {
  const mission = CAMPAIGN.find(m => m.id === id)!;
  const key = `reward:campaign:${id}`;
  const medal = result.medal || missionStars(profile, id) >= 2;
  const optional = !!mission.optional && (result.optional || (profile.mastery[`${key}:optional`] ?? 0) > 0);
  const secrets = Math.max(profile.mastery[`${key}:secrets`] ?? 0, Math.max(0, Math.min(mission.secrets?.length ?? 0, Math.floor(Number.isFinite(result.secrets) ? result.secrets : 0))));
  const total = campaignClearXP(id) + (medal ? 15 : 0) + (optional ? 10 : 0) + secrets * 5;
  const paid = profile.mastery[key] ?? 0, earned = Math.max(0, total - paid), xp = profile.xp + earned;
  const unlocks = [...new Set([...profile.unlocks, ...(mission.unlocks ?? []),
    ...(result.optional && mission.optional ? [`gadget:${mission.optional.reward.toLowerCase().replaceAll(' ', '-')}`] : []),
    ...(result.ending ? [`ending:${result.ending}`] : [])])];
  return { ...withMissionResult(profile, id, result.medal), xp, rank: Math.max(profile.rank, Math.min(30, 1 + Math.floor(xp / 100))),
    scrap: profile.scrap + earned, mastery: { ...profile.mastery, [key]: Math.max(paid, total), [`${key}:optional`]: +optional, [`${key}:secrets`]: secrets }, unlocks };
}

/** Guests earn assistance currency, once per mission and improvement, without changing their campaign.
 * Save ownership never follows a simulation-host election. No remote profile is ever imported. */
export function cooperativeReward(profile: ProgressProfile, id: MissionId, result: Parameters<typeof campaignReward>[2], ownsCampaign: boolean): ProgressProfile {
  if (ownsCampaign) {
    const first = missionStars(profile, id) === 0;
    const rewarded = campaignReward(profile, id, result);
    return first ? { ...rewarded, stats: { matches: profile.stats.matches + 1, wins: profile.stats.wins + 1 } } : rewarded;
  }
  const key = `reward:assist:${id}`, mission = CAMPAIGN.find(m => m.id === id)!;
  const medal = result.medal || (profile.mastery[`${key}:medal`] ?? 0) > 0;
  const optional = !!mission.optional && (result.optional || (profile.mastery[`${key}:optional`] ?? 0) > 0);
  const secrets = Math.max(profile.mastery[`${key}:secrets`] ?? 0,
    Math.max(0, Math.min(mission.secrets?.length ?? 0, Math.floor(Number.isFinite(result.secrets) ? result.secrets : 0))));
  const total = 35 + +medal * 10 + +optional * 5 + secrets * 2, paid = profile.mastery[key] ?? 0;
  const earned = Math.max(0, total - paid), xp = profile.xp + earned;
  return { ...profile, xp, scrap: profile.scrap + earned, rank: Math.max(profile.rank, Math.min(30, 1 + Math.floor(xp / 100))),
    stats: paid ? profile.stats : { matches: profile.stats.matches + 1, wins: profile.stats.wins + 1 },
    mastery: { ...profile.mastery, [key]: Math.max(paid, total), [`${key}:medal`]: +medal, [`${key}:optional`]: +optional, [`${key}:secrets`]: secrets } };
}
