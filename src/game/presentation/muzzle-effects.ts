/** Directional launch flash and the matching pressure-solved smoke source. Presentation only. */
import type { InstanceHandle, LightHandle, MeshDesc, MeshHandle, SceneRegistry, Vec3 } from '../../engine';
import { muzzleUnit, validMuzzleEmission, type MuzzleEmission } from '../../engine/passes/fluids/muzzle';

export type MuzzleShot = MuzzleEmission;

export const MUZZLE_FLASH = {
  explosive: { length: .48, width: .16, duration: .085, intensity: 135, color: [1, .44, .10] as Vec3 },
  heavy: { length: .62, width: .23, duration: .115, intensity: 195, color: [1, .32, .055] as Vec3 },
  incendiary: { length: .61, width: .18, duration: .145, intensity: 155, color: [1, .20, .025] as Vec3 },
  nuclear: { length: .72, width: .25, duration: .125, intensity: 230, color: [1, .59, .18] as Vec3 },
} as const;
const WEAPON_FLASH = {
  mortar: { length: .67, width: 1.25, duration: 1.2 },
  cannon: { length: 1, width: 1, duration: 1 },
  rail: { length: 1.6, width: .32, duration: .65 },
} as const;
export const MAX_MUZZLE_FLASHES = 8;

interface FlashSlot {
  age: number; duration: number; position: Vec3; direction: Vec3; up: Vec3;
  length: number; width: number; intensity: number; roll: number;
  outer: InstanceHandle | null; core: InstanceHandle | null; light: LightHandle | null;
}

/** Rounded, slightly curling flame volumes along +Z. Smooth lobes avoid a solid folded-cone silhouette.
 * The existing temporal dissolve provides partial coverage; neither volume is an opaque flash prop.
 */
function flashMesh(core: boolean): MeshDesc {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const sides = 24;
  const profile = core ? [[0, .10], [.07, .23], [.18, .29], [.32, .26], [.47, .18], [.61, .085], [.69, .02], [.71, 0]]
    : [[0, .12], [.08, .32], [.21, .57], [.38, .51], [.57, .35], [.73, .21], [.87, .09], [.97, .02], [1, 0]];
  for (let ring = 0; ring < profile.length; ring++) {
    const [z, radius] = profile[ring];
    for (let side = 0; side < sides; side++) {
      const angle = side / sides * Math.PI * 2;
      const petal = core ? 1 : .84 + .11 * Math.sin(angle * 3 + z * 5) + .05 * Math.cos(angle * 5 - z * 8);
      const bend = core ? 0 : Math.sin(z * 3.4) * .08;
      positions.push(Math.cos(angle) * radius * petal + bend, Math.sin(angle) * radius * petal + bend * .45, z);
      const before = profile[Math.max(0, ring - 1)], after = profile[Math.min(profile.length - 1, ring + 1)];
      const slope = (after[1] - before[1]) / Math.max(.001, after[0] - before[0]);
      const n = muzzleUnit([Math.cos(angle), Math.sin(angle), -slope]);
      normals.push(...n);
    }
  }
  for (let ring = 0; ring < profile.length - 1; ring++) for (let side = 0; side < sides; side++) {
    const a = ring * sides + side, b = ring * sides + (side + 1) % sides;
    indices.push(a, b, a + sides, b, b + sides, a + sides);
  }
  for (let side = 1; side < sides - 1; side++) indices.push(0, side + 1, side);
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices),
    matId: 5, label: core ? 'muzzle-white-core' : 'muzzle-flame-petals' };
}

/** Stable right-handed muzzle frame, including shots parallel to local up. */
export function muzzleTransform(position: Vec3, direction: Vec3, up: Vec3, width: number, length: number, roll: number, out: Float32Array): Float32Array {
  const f = muzzleUnit(direction);
  let rx = up[1] * f[2] - up[2] * f[1], ry = up[2] * f[0] - up[0] * f[2], rz = up[0] * f[1] - up[1] * f[0];
  if (Math.hypot(rx, ry, rz) < .001) {
    const other: Vec3 = Math.abs(f[0]) < .8 ? [1, 0, 0] : [0, 0, 1];
    rx = other[1] * f[2] - other[2] * f[1]; ry = other[2] * f[0] - other[0] * f[2]; rz = other[0] * f[1] - other[1] * f[0];
  }
  const r = muzzleUnit([rx, ry, rz]);
  const u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
  const c = Math.cos(roll), s = Math.sin(roll);
  out.fill(0);
  for (let i = 0; i < 3; i++) {
    out[i] = (r[i] * c + u[i] * s) * width;
    out[4 + i] = (u[i] * c - r[i] * s) * width;
    out[8 + i] = f[i] * length;
    out[12 + i] = position[i];
  }
  out[15] = 1;
  return out;
}

export class MuzzleEffects {
  private readonly outerMesh: MeshHandle;
  private readonly coreMesh: MeshHandle;
  private readonly model = new Float32Array(16);
  private readonly slots: FlashSlot[] = Array.from({ length: MAX_MUZZLE_FLASHES }, () => ({
    age: 0, duration: 0, position: [0, 0, 0], direction: [0, 0, 1], up: [0, 1, 0],
    length: 0, width: 0, intensity: 0, roll: 0, outer: null, core: null, light: null,
  }));
  private next = 0;
  total = 0;

  constructor(private readonly scene: SceneRegistry) {
    this.outerMesh = scene.meshes.create(flashMesh(false));
    this.coreMesh = scene.meshes.create(flashMesh(true));
  }

  fire(shot: MuzzleShot): void {
    if (!validMuzzleEmission(shot)) return;
    const slot = this.slots[this.next++ % this.slots.length];
    this.retire(slot);
    const ammo = MUZZLE_FLASH[shot.munition], weapon = WEAPON_FLASH[shot.weapon];
    slot.age = 0; slot.duration = ammo.duration * weapon.duration;
    slot.position = [shot.position[0], shot.position[1], shot.position[2]];
    slot.direction = muzzleUnit(shot.direction); slot.up = muzzleUnit(shot.up ?? shot.position);
    slot.length = ammo.length * weapon.length; slot.width = ammo.width * weapon.width;
    slot.intensity = ammo.intensity; slot.roll = ((shot.seed ?? this.total) * 2.399963229728653) % (Math.PI * 2);
    const color: Vec3 = shot.weapon === 'rail' ? [.55, .76, 1] : [...ammo.color];
    muzzleTransform(slot.position, slot.direction, slot.up, slot.width, slot.length, slot.roll, this.model);
    slot.outer = this.scene.instances.add(this.outerMesh, { model: this.model, tint: color, objectId: 902, castShadow: false, visibility: .42 });
    slot.core = this.scene.instances.add(this.coreMesh, { model: this.model, tint: [1, .82, .46], objectId: 902, castShadow: false, visibility: .82 });
    try { slot.light = this.scene.lights.add({ type: 'point', position: slot.position, color, intensity: slot.intensity, range: 4 + slot.length, castShadow: true }); }
    catch { /* Geometry and smoke remain when the bounded light pool is full. */ }
    this.scene.get('fluids')?.muzzle(shot);
    this.total++;
  }

  update(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    for (const slot of this.slots) {
      if (!slot.outer && !slot.core && !slot.light) continue;
      slot.age += dt;
      const t = slot.age / slot.duration;
      if (t >= 1) { this.retire(slot); continue; }
      const envelope = (1 - t) ** 1.5;
      const flicker = .88 + .12 * Math.sin(slot.age * 190 + slot.roll);
      muzzleTransform(slot.position, slot.direction, slot.up, slot.width * (.45 + .55 * envelope) * flicker,
        slot.length * (.24 + .76 * envelope) * flicker, slot.roll + t * .18, this.model);
      if (slot.outer) {
        this.scene.instances.set(slot.outer, this.model);
        this.scene.instances.setVisibility(slot.outer, .42 * Math.min(1, envelope * 1.6) * flicker);
      }
      if (slot.core) {
        this.scene.instances.set(slot.core, this.model);
        this.scene.instances.setVisibility(slot.core, .82 * Math.min(1, envelope * 2.0));
      }
      if (slot.light) this.scene.lights.update(slot.light, { intensity: slot.intensity * envelope * envelope });
    }
  }

  get active(): number { return this.slots.reduce((n, s) => n + (s.outer || s.core || s.light ? 1 : 0), 0); }

  private retire(slot: FlashSlot): void {
    if (slot.outer) this.scene.instances.remove(slot.outer);
    if (slot.core) this.scene.instances.remove(slot.core);
    if (slot.light) this.scene.lights.remove(slot.light);
    slot.outer = slot.core = null; slot.light = null;
  }

  clear(): void { for (const slot of this.slots) this.retire(slot); this.next = 0; }

  dispose(): void {
    this.clear();
    for (const mesh of [this.outerMesh, this.coreMesh]) try { this.scene.meshes.destroy(mesh); } catch { /* Engine already gone. */ }
  }
}
