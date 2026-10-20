/**
 * SceneRegistry: drawer / caster / overlay registries, open facets, and the entry points of the part-mesh path and the
 * light list (attached by their core modules at install time).
 *
 * Overlay route (plan §4.5): overlay drawers normally draw in the forward 'overlay' pass, after TAA/DOF, so they stay
 * sharp. A post chain whose bloom and composite read their TAA result directly never sees what that pass writes to
 * 'hdr'; the overlays module detects it after a frame and switches the route to 'transparent', which appends the overlay
 * drawers to the forward 'transparent' pass (before TAA) so the ribbon and rings still reach the screen.
 */
import type {
  GBufferDrawer, InstanceHandle, InstanceInit, LightHandle, LightInit, MeshDesc, MeshHandle, OverlayDrawer, SceneFacets,
  SceneRegistry, ShadowCaster, TransparentDrawer,
} from '../contracts';

export interface MeshApi { create(desc: MeshDesc): MeshHandle; destroy(h: MeshHandle): void }
export interface InstanceApi { add(m: MeshHandle, i: InstanceInit): InstanceHandle; set(h: InstanceHandle, model: Float32Array, flags?: number): void; remove(h: InstanceHandle): void;
  setVisibility(h: InstanceHandle, visibility: number): void }
export interface LightApi { add(l: LightInit): LightHandle; update(h: LightHandle, l: Partial<LightInit>): void; remove(h: LightHandle): void }

function removeFrom<T>(list: T[], item: T, after?: () => void): () => void {
  return () => { const i = list.indexOf(item); if (i >= 0) { list.splice(i, 1); after?.(); } };
}

export type OverlayRoute = 'overlay' | 'transparent';
const NO_OVERLAYS: readonly OverlayDrawer[] = [];

export class Scene implements SceneRegistry {
  readonly gbufferDrawers: GBufferDrawer[] = [];
  readonly shadowCasters: ShadowCaster[] = [];
  private readonly transparentList: TransparentDrawer[] = [];
  private readonly overlayList: OverlayDrawer[] = [];
  private route: OverlayRoute = 'overlay';
  private transparentView: readonly TransparentDrawer[] = this.transparentList;
  private readonly facets = new Map<keyof SceneFacets, unknown>();
  private meshImpl: MeshApi | null = null;
  private instanceImpl: InstanceApi | null = null;
  private lightImpl: LightApi | null = null;

  readonly meshes: MeshApi = {
    create: desc => this.need(this.meshImpl, 'meshes').create(desc),
    destroy: h => this.need(this.meshImpl, 'meshes').destroy(h),
  };
  readonly instances: InstanceApi = {
    add: (m, i) => this.need(this.instanceImpl, 'instances').add(m, i),
    set: (h, model, flags) => this.need(this.instanceImpl, 'instances').set(h, model, flags),
    remove: h => this.need(this.instanceImpl, 'instances').remove(h),
    setVisibility: (h, v) => this.need(this.instanceImpl, 'instances').setVisibility(h, v),
  };
  readonly lights: LightApi = {
    add: l => this.need(this.lightImpl, 'lights').add(l),
    update: (h, l) => this.need(this.lightImpl, 'lights').update(h, l),
    remove: h => this.need(this.lightImpl, 'lights').remove(h),
  };

  private need<T>(impl: T | null, what: string): T {
    if (!impl) throw new Error(`scene.${what} is not available (its core module is not installed)`);
    return impl;
  }

  attachMeshes(meshes: MeshApi, instances: InstanceApi): void { this.meshImpl = meshes; this.instanceImpl = instances; }
  attachLights(lights: LightApi): void { this.lightImpl = lights; }

  addGBufferDrawer(d: GBufferDrawer): () => void {
    this.gbufferDrawers.push(d);
    this.gbufferDrawers.sort((a, b) => a.order - b.order);
    return removeFrom(this.gbufferDrawers, d);
  }
  addShadowCaster(c: ShadowCaster): () => void { this.shadowCasters.push(c); return removeFrom(this.shadowCasters, c); }
  addTransparentDrawer(d: TransparentDrawer): () => void {
    this.transparentList.push(d);
    this.transparentList.sort((a, b) => a.order - b.order);
    this.rebuildRoute();
    return removeFrom(this.transparentList, d, () => this.rebuildRoute());
  }
  addOverlayDrawer(d: OverlayDrawer): () => void {
    this.overlayList.push(d);
    this.rebuildRoute();
    return removeFrom(this.overlayList, d, () => this.rebuildRoute());
  }

  /** Drawers of the forward 'transparent' pass: the transparent drawers, then (route 'transparent') every overlay drawer. */
  get transparentDrawers(): readonly TransparentDrawer[] { return this.transparentView; }
  /** Drawers of the forward 'overlay' pass (none while the overlays are routed into the transparent pass). */
  get overlayDrawers(): readonly OverlayDrawer[] { return this.route === 'overlay' ? this.overlayList : NO_OVERLAYS; }
  get overlayRoute(): OverlayRoute { return this.route; }
  /** Since CC-013 the engine never reroutes: overlay pipelines carry no depth state (the overlay pass has no depth
   * attachment), so they are only valid in the 'overlay' pass. Route 'transparent' remains for drawers built for it. */
  setOverlayRoute(route: OverlayRoute): void { this.route = route; this.rebuildRoute(); }

  private rebuildRoute(): void {
    this.transparentView = this.route === 'overlay' ? this.transparentList
      : [...this.transparentList, ...this.overlayList.map(d => ({ name: `${d.name}@transparent`, order: Infinity, draw: d.draw.bind(d) }))];
  }

  drawersFor(slot: GBufferDrawer['slot']): GBufferDrawer[] { return this.gbufferDrawers.filter(d => d.slot === slot); }

  provide<K extends keyof SceneFacets>(k: K, v: SceneFacets[K]): void { this.facets.set(k, v); }
  get<K extends keyof SceneFacets>(k: K): SceneFacets[K] | undefined { return this.facets.get(k) as SceneFacets[K] | undefined; }
}
