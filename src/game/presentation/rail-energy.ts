/** Bounded joint-local electrical/heat particles; accepted fire events trigger discharge. */
import type { InstanceHandle, LightHandle, MeshHandle, SceneRegistry, Vec3 } from '../../engine';
import { cylinder, lathe, alongZ, Shape } from '../kit/geometry/shapes';
import { RAIL_COILS } from '../kit/parts/weapons/rail';
import { MAT_ID, type WeaponId } from '../kit/types';

export const WEAPON_SPARK_LIMIT = 20;
function localModel(p: Float32Array, x: number, y: number, z: number, sx: number, sy: number, sz: number, out: Float32Array): Float32Array {
  for (let i = 0; i < 3; i++) { out[i] = p[i] * sx; out[4 + i] = p[4 + i] * sy; out[8 + i] = p[8 + i] * sz; out[12 + i] = p[12 + i] + p[i] * x + p[4 + i] * y + p[8 + i] * z; }
  out[3] = out[7] = out[11] = 0; out[15] = 1; return out;
}
export class RailEnergy {
  private meshes: MeshHandle[] = [];
  /** One instance per flicker variant while shown (only the current one without the partMeshes facet). */
  private arcs: (InstanceHandle | null)[] = [null, null, null];
  private ring: InstanceHandle | null = null;
  private particles: (InstanceHandle | null)[] = Array.from({ length: WEAPON_SPARK_LIMIT }, () => null);
  private light: LightHandle | null = null;
  private time = 0;
  private shot = 0;
  private recharge = 0;
  private ready = false;
  private variant = -1;
  private readonly model = new Float32Array(16);
  private readonly active: boolean;
  private readonly hot: boolean;
  private readonly color: Vec3;
  constructor(private readonly scene: SceneRegistry, private readonly weapon: WeaponId = 'rail') {
    this.active = weapon === 'rail' || weapon === 'arc_cannon' || weapon === 'forge_mortar';
    this.hot = weapon === 'forge_mortar'; this.color = this.hot ? [1, .24, .025] : weapon === 'arc_cannon' ? [.06, .85, 1] : [.20, .47, 1];
  }
  fire(): void { if (this.active) { this.shot = .32; this.recharge = 0; } }
  private build(): void {
    if (this.meshes.length) return;
    const c = this.weapon === 'arc_cannon' ? { from: .49, to: .92, count: 5, radius: .075 } : RAIL_COILS;
    for (let variant = 0; variant < 3; variant++) {
      const s = new Shape(); s.noHull = true; s.material(MAT_ID.signal);
      for (const side of [-1, 1]) for (let i = 0; i < c.count - 1; i++) {
        const a = c.from + (c.to - c.from) * i / (c.count - 1), b = c.from + (c.to - c.from) * (i + 1) / (c.count - 1);
        let last: [number, number, number] = [side * c.radius, 0, a];
        for (let j = 1; j <= 4; j++) {
          const end = j === 4, f = j / 4;
          const p: [number, number, number] = [side * (c.radius + (end ? 0 : .007 + Math.sin(j * 5.1 + i + variant * 2.3) * .006)), end ? 0 : Math.cos(j * 7 + i * 2 + variant) * .012, a + (b - a) * f];
          cylinder(s, null, last, p, .0018, 4); last = p;
        }
      }
      this.meshes.push(this.scene.meshes.create({ positions: Float32Array.from(s.mb.p), normals: Float32Array.from(s.mb.n), indices: Uint32Array.from(s.mb.idx), matId: MAT_ID.signal, label: `weapon:contact-arcs:${variant}` }));
    }
    // Shared particle volume; transforms supply velocity stretch and visibility supplies decay.
    const s = new Shape(); s.noHull = true;
    lathe(s, alongZ(0, 0, 0), [[0, -1], [.65, 0], [0, 1]], 6);
    this.meshes.push(this.scene.meshes.create({ positions: Float32Array.from(s.mb.p), normals: Float32Array.from(s.mb.n), indices: Uint32Array.from(s.mb.idx), matId: MAT_ID.signal, label: 'weapon:charged-particle' }));
    const r = new Shape(); r.noHull = true;
    lathe(r, alongZ(0, 0, 0), [[.94, 0], [1, 0], [1, .025], [.94, .025], [.94, 0]], 32, { caps: [false, false] });
    this.meshes.push(this.scene.meshes.create({ positions: Float32Array.from(r.mb.p), normals: Float32Array.from(r.mb.n), indices: Uint32Array.from(r.mb.idx), matId: MAT_ID.signal, label: 'weapon:muzzle-pressure-ring' }));
  }
  update(parent: Float32Array, dt: number, ready: boolean, visible: boolean, objectId: number): void {
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0; this.time += step; this.shot = Math.max(0, this.shot - step);
    if (ready && !this.ready) this.recharge = 0;
    this.ready = ready; this.recharge += step;
    if (!this.active || !visible || (!ready && this.shot === 0)) { this.hide(); return; }
    this.build();
    const discharge = this.shot / .32, pulse = .5 + .5 * Math.sin(this.time * 4.7);
    const charge = ready ? Math.min(1, this.recharge / .65) * (.30 + pulse * .25) : 0, strength = Math.max(charge, discharge);
    const variant = Math.floor(this.time * 24) % 3;
    if (!this.hot) {
      // The 24 Hz flicker keeps all three variants instanced (no draw-list rebuild per switch): a hidden one draws at
      // visibility 0, which discards every fragment as removal does, and the one shown again restarts its motion
      // history (prevModel = model), as the new instance that replaced it did.
      const facet = this.scene.get?.('partMeshes'), switched = this.variant !== variant;
      if (!facet && switched && this.variant >= 0) { const old = this.arcs[this.variant]; if (old) this.scene.instances.remove(old); this.arcs[this.variant] = null; }
      this.variant = variant;
      for (let v = 0; v < 3; v++) {
        const shown = v === variant, handle = this.arcs[v];
        if (!handle) { if (shown || facet) this.arcs[v] = this.scene.instances.add(this.meshes[v], { model: parent, tint: this.color, objectId, castShadow: false, visibility: shown ? strength : 0 }); }
        else if (shown) { this.scene.instances.set(handle, parent); this.scene.instances.setVisibility(handle, strength); if (switched) facet?.restart(handle); }
        else this.scene.instances.setVisibility(handle, 0);
      }
    }
    const from = this.weapon === 'arc_cannon' ? .43 : .38, length = this.weapon === 'arc_cannon' ? 1.16 : this.hot ? .84 : 1.4;
    const live = this.hot ? 8 : WEAPON_SPARK_LIMIT;
    for (let i = 0; i < live; i++) {
      const phase = (this.time * (this.hot ? .6 : 1.2) + i * .61803398875) % 1, angle = i * 2.399963 + this.time * (this.hot ? .3 : 1.7);
      const burst = discharge > 0, age = 1 - discharge, radius = this.hot ? .062 + phase * .055 : .068 + Math.sin(phase * Math.PI) * .02;
      const x = Math.cos(angle) * radius * (burst ? 1 + age * 3 : 1), y = Math.sin(angle) * radius + (this.hot ? phase * .12 : 0);
      const z = burst ? length + age * (.12 + (i % 5) * .085) : from + (length - from) * phase;
      const fade = (1 - phase) * strength, size = (this.hot ? .005 : .0035) * (burst ? 1.8 : 1);
      localModel(parent, x, y, z, size, size, size * (this.hot ? 1.5 : 6), this.model);
      if (!this.particles[i]) this.particles[i] = this.scene.instances.add(this.meshes[3], { model: this.model, tint: i % 4 === 0 && !this.hot ? [.8, .95, 1] : this.color, objectId, castShadow: false, visibility: fade });
      else { this.scene.instances.set(this.particles[i]!, this.model); this.scene.instances.setVisibility(this.particles[i]!, fade); }
    }
    if (discharge > 0) {
      const age = 1 - discharge, radius = .035 + age * .13;
      localModel(parent, 0, 0, length + age * .18, radius, radius, radius, this.model);
      if (!this.ring) this.ring = this.scene.instances.add(this.meshes[4], { model: this.model, tint: this.color, objectId, castShadow: false, visibility: discharge * .6 });
      else { this.scene.instances.set(this.ring, this.model); this.scene.instances.setVisibility(this.ring, discharge * .6); }
    } else if (this.ring) { this.scene.instances.remove(this.ring); this.ring = null; }
    const scale = Math.hypot(parent[0], parent[1], parent[2]);
    const position: Vec3 = [parent[12] + parent[8] * (length - .2), parent[13] + parent[9] * (length - .2), parent[14] + parent[10] * (length - .2)];
    const light = { position, color: this.color, intensity: (.7 * charge + discharge * 12) * scale * scale, range: .65 * scale, castShadow: false };
    try { if (this.light) this.scene.lights.update(this.light, light); else this.light = this.scene.lights.add({ type: 'point', ...light }); } catch { /* Light capacity does not suppress particles. */ }
  }
  hide(): void {
    this.arcs.forEach((a, i) => { if (a) this.scene.instances.remove(a); this.arcs[i] = null; });
    if (this.ring) this.scene.instances.remove(this.ring); this.ring = null;
    this.particles.forEach((p, i) => { if (p) this.scene.instances.remove(p); this.particles[i] = null; });
    if (this.light) this.scene.lights.remove(this.light); this.light = null;
  }
  dispose(): void { this.hide(); this.meshes.forEach(m => this.scene.meshes.destroy(m)); this.meshes = []; }
}
