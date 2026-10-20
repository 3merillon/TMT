/**
 * Kit v2 build context and part geometry (W1-KIT). `kitContext` resolves a validated loadout into specs and
 * the shared derived dimensions; `kitGeometry` runs every part builder for one LOD and groups the resulting
 * shapes (render triangles + validation pieces) per rigid / instanced group. Part builds are cached by the
 * keys they depend on, so the thousands of legal assemblies share most of their geometry.
 */
import { Shape } from './geometry/shapes';
import { buildGear } from './parts/gear/common';
import { hullCrewAccess } from './parts/hulls/common';
import { GEARS, HULLS, TURRETS, UTILITIES, WEAPONS } from './parts';
import type { GroupId, GroupShapes, KitContext } from './parts/types';
import { gearRig } from './running';
import { RING_FRAME, RING_RADIUS, TRACK_CHANNEL_MARGIN, TURRET_RING_CLASS, WEAPON_CLASS, mantletRadius } from './sockets';
import type { KitLoadout, SlotId } from './types';

const contexts = new Map<string, KitContext>();

/** Resolved specs and derived dimensions for a (validated) loadout. */
export function kitContext(l: KitLoadout): KitContext {
  const key = `${l.hull}.${l.runningGear}.${l.turret}.${l.weapon}.${l.utility}.${l.armor ?? 'standard'}`;
  let ctx = contexts.get(key);
  if (ctx) return ctx;
  const hull = HULLS[l.hull].spec, gear = GEARS[l.runningGear], turret = TURRETS[l.turret].spec, weapon = WEAPONS[l.weapon].spec, utility = UTILITIES[l.utility].spec;
  const ringClass = TURRET_RING_CLASS[l.turret], c = gear.halfSpacing, w = gear.width;
  const rig = gearRig(gear);
  ctx = Object.freeze({
    loadout: Object.freeze({ ...l }), hull, gear, turret, weapon, utility,
    ringClass, ringRadius: RING_RADIUS[ringClass], weaponClass: WEAPON_CLASS[l.weapon],
    mantletRadius: mantletRadius(l.weapon, weapon.tubeRadius),
    lowerHalfWidth: c - w / 2 - TRACK_CHANNEL_MARGIN,
    beltInner: c - w * 0.49, beltOuter: c + w * 0.49,
    upperHalfWidth: c + w / 2 + hull.overhang,
    topRunY: rig.layout.topRunY,
    trunnionHull: [RING_FRAME[0] + turret.trunnion[0], RING_FRAME[1] + turret.trunnion[1], RING_FRAME[2] + turret.trunnion[2]],
  }) as KitContext;
  contexts.set(key, ctx);
  return ctx;
}

export const LOD_DETAIL: Readonly<Record<0 | 1 | 2, number>> = Object.freeze({ 0: 1, 1: 0.5, 2: 0.25 });

class Groups implements GroupShapes {
  readonly map = new Map<GroupId, Shape>();
  constructor(readonly detail: number) {}
  get(group: GroupId): Shape {
    let s = this.map.get(group);
    if (!s) { s = new Shape(); s.detail = this.detail; this.map.set(group, s); }
    return s;
  }
}

const partCache = new Map<string, Groups>();
function cachedPart(key: string, detail: number, build: (out: GroupShapes) => void): Groups {
  const full = `${key}@${detail}`;
  let g = partCache.get(full);
  if (!g) { g = new Groups(detail); build(g); partCache.set(full, g); }
  return g;
}

export interface KitGeometry {
  ctx: KitContext;
  lod: 0 | 1 | 2;
  /** Shapes per group, in build order (hull, gear, turret, weapon, utility). */
  groups: ReadonlyMap<GroupId, readonly Shape[]>;
  /** Source slot of each shape in groups. Workshop servicing splits the exact production meshes at these boundaries. */
  owners: ReadonlyMap<Shape, SlotId>;
}

const geometryCache = new Map<string, KitGeometry>();

/** All part geometry of an assembly at one LOD (cached). */
export function kitGeometry(ctx: KitContext, lod: 0 | 1 | 2): KitGeometry {
  const l = ctx.loadout, key = `${l.hull}.${l.runningGear}.${l.turret}.${l.weapon}.${l.utility}.${l.armor ?? 'standard'}#${lod}`;
  let geo = geometryCache.get(key);
  if (geo) return geo;
  const detail = LOD_DETAIL[lod];
  const layout = gearRig(ctx.gear).layout;
  const parts = [
    cachedPart(`hull:${l.hull}:${l.runningGear}:${ctx.ringClass}:${l.armor ?? 'standard'}:${ctx.turret.hatch ? 'turret-hatch' : 'hull-hatch'}`, detail, out => {
      HULLS[l.hull].build(ctx, out);
      hullCrewAccess(out.get('hull'), ctx);
    }),
    cachedPart(`gear:${l.runningGear}`, detail, out => buildGear(ctx, out, layout.pitch)),
    cachedPart(`turret:${l.turret}:${l.weapon}`, detail, out => TURRETS[l.turret].build(ctx, out)),
    cachedPart(`weapon:${l.weapon}:${l.turret}`, detail, out => WEAPONS[l.weapon].build(ctx, out)),
    cachedPart(`utility:${l.utility}:${l.turret}`, detail, out => UTILITIES[l.utility].build(ctx, out)),
  ];
  const groups = new Map<GroupId, Shape[]>();
  const owners = new Map<Shape, SlotId>();
  const slots: SlotId[] = ['hull', 'runningGear', 'turret', 'weapon', 'utility'];
  for (let partIndex = 0; partIndex < parts.length; partIndex++) for (const [group, shape] of parts[partIndex].map) {
    if (!shape.mb.vertexCount && !shape.hulls.length) continue;
    let list = groups.get(group);
    if (!list) { list = []; groups.set(group, list); }
    list.push(shape);
    owners.set(shape, slots[partIndex]);
  }
  geo = { ctx, lod, groups, owners };
  geometryCache.set(key, geo);
  return geo;
}
