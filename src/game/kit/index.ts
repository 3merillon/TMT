/**
 * Kit public API (plan §5.3; W0-KIT, W1-KIT). All code reads a tank's kit through `tankKit(t)`.
 *
 * The five contract functions (types.ts, CC-003) are implemented in catalog.ts, assembly.ts, mesh-builder.ts
 * and pose.ts and re-exported here with their frozen signatures. Everything in src/game/kit is pure (no three,
 * no DOM, no clocks, no randomness), so simulation code may import this barrel. The validator
 * (./validate) and the part modules (./parts) are imported directly by the tools that need them.
 */
import type { TankState } from '../contracts';
import { assembleKit } from './assembly';
import { kitLoadoutFromLegacy, validateKitLoadout } from './catalog';
import { buildKitMesh } from './mesh-builder';
import { poseKit } from './pose';
import type { AssembleKit, BuildKitMesh, KitLoadout, KitLoadoutFromLegacy, KitLoadoutIdsLike, PoseKit, ValidateKitLoadout } from './types';

export * from './types';
export * from './armor';
export { assembleKit, kitKey, kitStats, kitRunningEnvelope, V1_PROXY } from './assembly';
export {
  KIT_PART_IDS, KIT_SLOTS, KIT_W0_PARTS, KitError, isLegalKitLoadout, kitLoadoutFromLegacy, kitLoadoutToLegacy, legalKitLoadouts, validateKitLoadout,
} from './catalog';
export { buildKitMesh, decodeAxis, encodeAxis, KIT_FLAG, kitMeshBudget, WHEEL_BUFFER_ORDER } from './mesh-builder';
export { createKitPose, instanceMatrix, INSTANCE_FLOATS, KIT_JOINTS, kitInstanceSource, kitJointNames, kitStateFromTank, poseKit, writeKitPose, type KitPresentationHints } from './pose';
export { FRONT_ARC } from './pitch';
export { socketMismatch, SOCKET_CLASSES, TURRET_RING_CLASS, TURRET_TRUNNION_RANGE, HULL_RING_RANGE, WEAPON_CLASS, type SocketClass } from './sockets';

/**
 * The kit loadout of a tank: its `kit` ids when present (validated), else the Appendix A mapping of the
 * deprecated v1 `loadout`. Structurally typed so it works before and after `TankState.kit` exists.
 */
export function tankKit(t: TankState & { kit?: KitLoadoutIdsLike }): KitLoadout {
  return t.kit ? validateKitLoadout(t.kit) : kitLoadoutFromLegacy(t.loadout);
}

// The implementations must keep the frozen contract signatures (types.ts).
void (assembleKit satisfies AssembleKit);
void (kitLoadoutFromLegacy satisfies KitLoadoutFromLegacy);
void (validateKitLoadout satisfies ValidateKitLoadout);
void (buildKitMesh satisfies BuildKitMesh);
void (poseKit satisfies PoseKit);
