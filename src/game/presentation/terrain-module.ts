/**
 * Presentation-side terrain glue for the engine scene (facade-internal):
 * - the planet: provides the selected kind's `terrainPlanetWGSL` and calls `engine.setPlanet` with the same kind
 *   (the terrain pipeline recompiles asynchronously; an omitted kind retains the historical seed mapping);
 * - pending cuts: an impact adds `event.cut` when W1-GAME provides it, else `craterProfile(position, normal, radius)`;
 *   a `terrain-commit` event commits them by id (a `setTerrain` call commits all of them on the legacy serial carve path,
 *   which emits no commit events); they reach the engine through
 *   `FrameInput.pendingCuts` (pending-crater terrain modifier);
 * - the Surface Memory Cube: a scorch per blast, ramping in with the fireball (SCORCH.ramp), kept through the commit, which clears the other marks
 *   inside the committed sphere (a fresh crater has no old tracks); a new world clears the whole cube; track stamps are
 *   forwarded from the tank view.
 */
import type { Engine } from '../../engine';
import { PendingCutSet } from '../../engine/scene/pending-cuts';
import type { SmcStamp, SurfaceMemoryFacet } from '../../engine/scene/surface-memory';
import type { ImpactEvent, TerrainUpdate, V3 } from '../contracts';
import { planetNormalWGSL, planetType, type PlanetType } from '../planet-field';
import { craterProfile } from '../rules/crater';
import { TERRAIN_RADIUS } from '../terrain-config';

/** Scorch stamp radius per blast radius (the crater rim lands near half of it), strength, inner-core softness, and the
 *  seconds it takes to spread to that radius and strength (re-stamped each frame; the cube blends with MAX). */
export const SCORCH = { impactScale: 2.0, strength: 0.85, soft: 0.35, ramp: 0.5 } as const;

export class TerrainPresentation {
  readonly pending = new PendingCutSet();
  private seed: number | null = null;
  private spherical = false;
  private kind?: PlanetType;
  private planetReady: Promise<void> = Promise.resolve();
  private impacts = 0;
  /** Committed cuts waiting for the SMC (cleared + re-scorched in the next frame, after the pages flipped). */
  private committed: { center: V3; radius: number }[] = [];
  /** Scorches still spreading: stamped a little wider and darker every frame until SCORCH.ramp has passed. */
  private scorches: { center: V3; halfWidth: number; t0: number }[] = [];
  /** True once a `terrain-commit` event (W1-GAME's non-blocking terrain) retired cuts by id in this world. */
  private commitEvents = false;

  constructor(private readonly engine: Engine) {}

  private get smc(): SurfaceMemoryFacet | undefined { return this.engine.services.scene.get('surfaceMemory'); }

  /** Provide the per-seed planet normal facet and switch the engine planet (no-op for the current seed). */
  setSeed(seed: number, spherical = false, kind: PlanetType = planetType(seed)): Promise<void> {
    if (seed === this.seed && spherical === this.spherical && kind === this.kind) return this.planetReady;
    this.seed = seed;
    this.spherical = spherical;
    this.kind = kind;
    this.engine.services.scene.provide('terrainPlanetWGSL', planetNormalWGSL(seed, spherical, kind));
    this.planetReady = this.engine.setPlanet({ seed, kind, radius: TERRAIN_RADIUS });
    return this.planetReady;
  }

  get currentSeed(): number | null { return this.seed; }

  /** An impact: pending crater (+ scorch) now, geometry at commit. */
  impact(event: ImpactEvent, time: number): void {
    this.impacts++;
    let cut: { center: V3; radius: number };
    try { cut = event.cut ? { center: [...event.cut.center] as V3, radius: event.cut.radius } : craterProfile(event.position, event.normal, event.radius); }
    catch { cut = { center: [...event.position] as V3, radius: Math.max(0.5, event.radius) }; }
    const id = event.cut?.id ?? `impact:${this.impacts}`;
    this.pending.add(id, cut.center, cut.radius, time, event.cut?.shells);
    this.scorches.push({ center: [...event.position] as V3, halfWidth: event.radius * SCORCH.impactScale, t0: time });
  }

  /** A `terrain-commit` event: the listed cuts are now real geometry. */
  commit(cutIds?: readonly string[]): void {
    if (cutIds) this.commitEvents = true;
    for (const c of this.pending.commit(cutIds)) this.committed.push({ center: [...c.center] as V3, radius: c.radius });
  }

  /**
   * A full terrain update (initial world, carve result or restore). On the legacy serial carve path (no `terrain-commit`
   * events, as before W1-GAME) the update IS the commit of every pending cut; once commit events flow, they retire cuts by
   * id and a later still-pending crater survives an unrelated update.
   */
  setTerrain(update: TerrainUpdate, firstOfWorld: boolean): void {
    if (firstOfWorld) { this.pending.clear(); this.committed = []; this.scorches = []; this.commitEvents = false; this.smc?.clearAll(); return; }
    if (!this.commitEvents) this.commit();
    void update;
  }

  /** Replace the pending list explicitly (GameView.setPendingCuts). */
  replace(cuts: readonly { center: V3; radius: number; t0: number }[]): void {
    this.pending.clear();
    cuts.forEach((c, i) => this.pending.add(`external:${i}`, c.center, c.radius, c.t0));
  }

  /** Per frame: spread the young scorches, apply SMC work for committed cuts and forward track stamps. */
  frame(trackStamps: readonly SmcStamp[], time: number): void {
    const smc = this.smc;
    if (!smc) return;
    if (this.scorches.length) {
      // The ground darkens as the blast spreads, not in the impact frame: wider and stronger each frame (ease-out).
      smc.stamp('scorch', this.scorches.map(s => {
        const e = 1 - (1 - Math.min(Math.max((time - s.t0) / SCORCH.ramp, 0), 1)) ** 2;
        return { center: s.center, halfWidth: s.halfWidth * (0.3 + 0.7 * e), strength: SCORCH.strength * e, soft: SCORCH.soft };
      }));
      this.scorches = this.scorches.filter(s => time - s.t0 < SCORCH.ramp);
    }
    for (const c of this.committed.splice(0)) {
      smc.clearSphere(c.center, c.radius * 1.02);
    }
    if (trackStamps.length) {
      // Held: a parked belt submits the same contact every frame, which the SMC draws only after a decay or a clear.
      smc.stamp('tracks', trackStamps, true);
      smc.stamp('trample', trackStamps.map(s => ({ ...s, tread: undefined, strength: Math.min(1, s.strength * 1.35) })), true);
    }
  }

  reset(): void { this.pending.clear(); this.committed = []; this.scorches = []; this.commitEvents = false; this.smc?.clearAll(); }
}
