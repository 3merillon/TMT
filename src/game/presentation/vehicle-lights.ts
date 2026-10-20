import type { LightHandle, LightInit, Vec3 } from '../../engine/contracts';
import type { SceneRegistry } from '../../engine';
import { kitContextOf } from '../kit/assembly';
import type { KitAssembly } from '../kit/types';
import { headlightMounts } from '../kit/parts/hulls/common';

/** Two physical, shadowed spots per visible vehicle (8 vehicles = 16 of the existing 64-light pool). */
export class VehicleLights {
  private handles: LightHandle[] = [];
  private readonly mounts: readonly Vec3[];
  /** The inputs the lamps were last placed with: equal inputs place them identically, so they are left as they are. */
  private readonly model = new Float64Array(16).fill(NaN);
  private scale = NaN;
  private caster = NaN;
  private projector?: LightHandle;
  constructor(private readonly scene: SceneRegistry, private readonly assembly: KitAssembly) {
    this.mounts = headlightMounts(kitContextOf(assembly));
  }
  update(model: ArrayLike<number>, enabled: boolean, scale = 1, sourceCasterId = 0): void {
    if (!enabled) { for (const handle of this.handles) this.scene.lights.remove(handle); this.handles = []; return; }
    if (Object.is(scale, this.scale) && Object.is(sourceCasterId, this.caster) && this.placed(model)) return;
    const point = (p: Vec3): Vec3 => [model[0] * p[0] + model[4] * p[1] + model[8] * p[2] + model[12], model[1] * p[0] + model[5] * p[1] + model[9] * p[2] + model[13], model[2] * p[0] + model[6] * p[1] + model[10] * p[2] + model[14]];
    const d: Vec3 = [model[8] - model[4] * .17, model[9] - model[5] * .17, model[10] - model[6] * .17];
    const length = Math.hypot(...d); const direction = d.map(x => x / length) as Vec3;
    this.mounts.forEach((p, i) => {
      const light: LightInit = { type: 'spot', position: point([p[0], p[1], p[2] + .039]), direction,
        color: [1, .88, .66], intensity: 7.5 * scale * scale, range: 6.5 * scale, innerAngle: .22, outerAngle: .48, castShadow: true, sourceCasterId };
      if (this.handles[i]) this.scene.lights.update(this.handles[i], light);
      else { try { this.handles[i] = this.scene.lights.add(light); } catch { /* Fixed pool prioritizes existing effects. */ } }
    });
    for (let i = 0; i < 16; i++) this.model[i] = model[i];
    this.scale = scale; this.caster = sourceCasterId;
  }
  /** Whether every lamp exists and `model` is the matrix they were last placed with, bit for bit. */
  private placed(model: ArrayLike<number>): boolean {
    for (let i = 0; i < this.mounts.length; i++) if (!this.handles[i]) return false;
    for (let i = 0; i < 16; i++) if (!Object.is(model[i], this.model[i])) return false;
    return true;
  }
  get count(): number { return this.handles.length; }
  searchlight(light: { origin: Vec3; direction: Vec3; range: number; angle: number } | undefined, sourceCasterId = 0): void {
    if (!light) { if (this.projector) this.scene.lights.remove(this.projector); this.projector = undefined; return; }
    const data: LightInit = { type: 'spot', position: light.origin, direction: light.direction, range: light.range, color: [1, .83, .48], intensity: 35,
      innerAngle: light.angle * .8, outerAngle: light.angle, castShadow: true, sourceCasterId };
    if (this.projector) this.scene.lights.update(this.projector, data);
    else try { this.projector = this.scene.lights.add(data); } catch { /* Fixed light budget. */ }
  }
  clear(): void { for (const handle of this.handles) this.scene.lights.remove(handle); this.handles = []; this.searchlight(undefined); }
  dispose(): void { this.clear(); }
}
