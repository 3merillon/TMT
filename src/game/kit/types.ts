// @contract v1 — docs/architecture.md#contracts-and-invariants
/**
 * Kit contract (plan §5.3). Changes only through the contract-change protocol (plan §7.4), additively.
 *
 * The five contract functions are declared here as function types. Their implementations live in
 * catalog.ts, assembly.ts, mesh-builder.ts and pose.ts and are re-exported by index.ts, which checks
 * them against these signatures at compile time. (A body-less `declare function` here would type-check
 * but fail at runtime if anyone imported it from this file.)
 *
 * Frames are expressed in their parent joint's rest frame: `turretRing`, `sensor` and `exhausts` in the
 * hull, `trunnion` and `utility` in the turret, `muzzle` in the cradle. Units are TMT units; +Y up,
 * +Z forward, driver-left is +X.
 */
import type { Loadout, TankState, V3, Q4 } from '../contracts';
export type SlotId = 'hull' | 'runningGear' | 'turret' | 'weapon' | 'utility';
export type HullId = 'skiff' | 'warden' | 'bastion' | 'aether_hull' | 'forge_hull'; export type GearId = 'scout' | 'grip' | 'crawler' | 'aether_drive' | 'forge_tracks';
export type TurretId = 'dome' | 'wedge' | 'cradle' | 'aether_crown' | 'forge_casemate'; export type WeaponId = 'mortar' | 'cannon' | 'rail' | 'autocannon' | 'arc_cannon' | 'forge_mortar';
export type UtilityId = 'antenna' | 'radar' | 'periscope' | 'smoke' | 'whip_short' | 'yagi' | 'point_defense' | 'aether_vane' | 'steam_sentinel';
export type ArmorId = 'standard' | 'reactive';
export interface KitLoadout { hull: HullId; runningGear: GearId; turret: TurretId; weapon: WeaponId; utility: UtilityId; /** Omitted in older saves; equivalent to standard. */ armor?: ArmorId }
export interface KitLoadoutIdsLike { hull: string; runningGear: string; turret: string; weapon: string; utility: string; armor?: string } // structurally == api/match KitLoadoutIds
export interface Frame { position: V3; rotation: Q4 }
export interface WheelStation { side: 1 | -1; z: number; y0: number; radius: number; arm?: { pivot: V3; length: number } }
export interface HullBox { center: V3; half: V3; rotation?: Q4 }
export interface JointDef { name: string; parent: string; kind: 'fixed' | 'yaw' | 'pitch' | 'slide' | 'spin' | 'spring2'; axis: V3; limits?: [number, number] }
export interface KitPartStats { cost: number; mass: number; hp: number; tempo: number; speed: number; fuel: number; climbDeg: number;
  traction: number; lateralTraction: number; minSpeed: number; maxSpeed: number; blastRadius: number; damage: number; recoil: number; mitigation: number }
export interface KitAssembly {
  key: string; loadout: KitLoadout;
  frames: { turretRing: Frame; trunnion: Frame; muzzle: Frame; sensor: Frame; exhausts: Frame[]; utility: Frame };
  weapon: { barrelLength: number; recoilTravel: number; boreRadius: number };
  running: { halfSpacing: number; trackWidth: number; stations: WheelStation[]; sprocket: { z: number; y: number; r: number }; idler: { z: number; y: number; r: number };
             returnRollers: { z: number; y: number; r: number }[]; tensionerTravel: number; topRunY: number; droop: number; compression: number; treadStations: number[] };
  proxies: { box: HullBox; parent: 'hull' | 'turret' | 'cradle' }[];
  massProps: { mass: number; com: V3; inertia: V3 };
  pitchLimits(yaw: number): { min: number; max: number };      // pure, derived from geometry, cached per 2°
  joints: JointDef[]; stats: KitPartStats;
}
export type AssembleKit = (l: KitLoadout) => KitAssembly;               // assembleKit: cached by key
export type KitLoadoutFromLegacy = (l: Loadout) => KitLoadout;          // kitLoadoutFromLegacy: Appendix A table
export type ValidateKitLoadout = (ids: KitLoadoutIdsLike) => KitLoadout; // validateKitLoadout: throws on unknown ids or socket mismatch
export interface PartMesh { part: string; joint: string; lod: 0 | 1 | 2;
  positions: Float32Array; normals: Float32Array; partLocal: Float32Array;       // partLocal = rest-pose position, for procedural materials
  primAxis: Uint32Array;  /* oct snorm16x2 anisotropy axis */ attrs: Uint32Array; /* edge u8 | ao u8 | matId u8 | flags u8 */
  indices: Uint32Array; instances?: Float32Array; /* mat3x4 per instance for repeated parts: wheels, links, bolts */ }
export interface KitMeshData { key: string; parts: PartMesh[] }
export type BuildKitMesh = (a: KitAssembly, lod: 0 | 1 | 2) => KitMeshData; // buildKitMesh: renderer-agnostic; no three
export interface KitPose { joints: Map<string, Float32Array /* mat4, column-major, tank-local */>; linkInstances: Float32Array; wheelInstances: Float32Array }
export type PoseKit = (a: KitAssembly, t: TankState, out: KitPose) => void; // poseKit

/** MatIds (plan §5.3): 0 paint, 1 dark steel, 2 rubber, 3 gunmetal, 4 brass, 5 signal/emissive, 6 glass, 7 chrome. */
export const MAT_ID = { paint: 0, darkSteel: 1, rubber: 2, gunmetal: 3, brass: 4, signal: 5, glass: 6, chrome: 7 } as const;
