import { PROLOGUE } from './prologue';
import { OPERATIONS } from './acts';
import type { MissionDef, MissionId } from './mission';
export const CAMPAIGN: readonly MissionDef[] = Object.freeze([...PROLOGUE, ...OPERATIONS]);
export function missionById(id: MissionId): MissionDef {
  const mission = CAMPAIGN.find(m => m.id === id);
  if (!mission) throw new Error(`Unknown mission '${id}'`);
  return mission;
}
