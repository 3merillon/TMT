/** Interruptible, frame-driven servicing. Only a successful job changes the displayed installed kit. */
import type { InstanceHandle, SceneRegistry, Vec3 } from '../../engine';
import { KIT_SLOTS, validateKitLoadout, type KitLoadoutIdsLike, type SlotId } from '../kit';
import { box, cylinder, Shape, sweep } from '../kit/geometry/shapes';
import { translate } from '../kit/geometry/math';
import { WorkshopAudio, type WorkshopSound, type WorkshopAudioSettings } from './audio';
import { add, lerp, shapeMesh, sub, transform, WorkshopGeometry } from './geometry';
import { ROBOT_PARK, WorkshopRobot } from './robot';
import { WorkshopTank, type ServiceGrip } from './tank';
import { WORKSHOP_LIFT_MAX, WORKSHOP_SERVICE_HEIGHT, WORKSHOP_TANK_ROOT } from './dimensions';
import type { TankAppearance } from '../meta/cosmetics';

export type WorkshopPalette = 'sage' | 'ochre';
const PALETTE: Record<WorkshopPalette, Vec3> = { sage: [.25, .39, .3], ochre: [.54, .30, .105] };
const ZERO: Vec3 = [0, 0, 0];
export const OLD_RACK: Vec3 = [-3.0, .84, -3.6], NEW_RACK: Vec3 = [-4.55, .84, 1.2];
/** Static load-bearing structure; the service side (negative X) is completely open. */
export const GANTRY_COLUMNS: readonly Vec3[] = [[2.22, 2.295, -2.30], [2.22, 2.295, 2.30]];
export const GANTRY_HEIGHT = 4.59;
const SHUTTER_HEIGHT = 1.25;
export const TROLLEY_PAD_COMPRESSION = .001;
export interface WorkshopMechanicsOptions {
  root?: Vec3; onPhase?: (phase: string) => void; reducedMotion?: boolean; quick?: boolean; audioVolume?: number; audioSettings?: WorkshopAudioSettings;
}
export interface WorkshopMechanicalState { busy: boolean; phase: string; progress: number; liftOffset: number }
export interface ServiceMotion { old: Vec3; replacement: Vec3; target: Vec3; grip: number; spanMix: number; support: number; tool: boolean; spin: number; phase: string }
const smooth = (t: number) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };
const ramp = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
interface Key { at: number; old: Vec3; replacement: Vec3; target: Vec3; grip: number; spanMix: number; phase: string }

/** A single continuous tool/payload path. The gripper stays coincident with each moving payload's anchor. */
export function serviceMotion(t: number, oldMount: Vec3, newMount: Vec3, oldRack: Vec3, newRack: Vec3, extraction: Vec3): ServiceMotion {
  const oldClear = add(oldMount, extraction), newClear = add(newMount, extraction);
  const travelRise = extraction[1] >= .47 ? .30 : 0; // The broad hull crosses above the pedestal's arm envelope.
  const oldAbove: Vec3 = [oldRack[0], Math.max(oldClear[1] + travelRise, oldRack[1] + .28), oldRack[2]];
  const newAbove: Vec3 = [newRack[0], Math.max(newClear[1] + travelRise, newRack[1] + .28), newRack[2]];
  const oldOut: Vec3 = [-1.25, oldAbove[1], oldClear[2]], newOut: Vec3 = [-1.25, newAbove[1], newClear[2]];
  const oldCorner: Vec3 = [-1.25, oldAbove[1], oldAbove[2]];
  // Mount extraction, side clearance, then fore/aft travel: a carried barrel never cuts diagonally through the turret.
  const keys: Key[] = [
    { at: 0, old: oldMount, replacement: newRack, target: ROBOT_PARK, grip: 0, spanMix: 0, phase: 'Securing service supports' },
    { at: .12, old: oldMount, replacement: newRack, target: ROBOT_PARK, grip: 0, spanMix: 0, phase: 'Lifting the supported assembly' },
    { at: .14, old: oldMount, replacement: newRack, target: add(oldMount, [-1.55, .22, 0]), grip: 0, spanMix: 0, phase: 'Approaching from the open service side' },
    { at: .16, old: oldMount, replacement: newRack, target: add(oldMount, [0, .22, 0]), grip: 0, spanMix: 0, phase: 'Approaching the mounting points' },
    { at: .18, old: oldMount, replacement: newRack, target: oldMount, grip: 0, spanMix: 0, phase: 'Releasing mounting fasteners' },
    { at: .23, old: oldMount, replacement: newRack, target: oldMount, grip: 1, spanMix: 0, phase: 'Clamping the installed component' },
    { at: .30, old: oldClear, replacement: newRack, target: oldClear, grip: 1, spanMix: 0, phase: 'Extracting the component' },
    { at: .34, old: oldOut, replacement: newRack, target: oldOut, grip: 1, spanMix: 0, phase: 'Clearing the service envelope' },
    { at: .39, old: oldCorner, replacement: newRack, target: oldCorner, grip: 1, spanMix: 0, phase: 'Passing behind the robot pedestal' },
    { at: .43, old: oldAbove, replacement: newRack, target: oldAbove, grip: 1, spanMix: 0, phase: 'Transferring to the return trolley' },
    { at: .46, old: oldRack, replacement: newRack, target: oldRack, grip: 1, spanMix: 0, phase: 'Seating on the return cradle' },
    { at: .49, old: oldRack, replacement: newRack, target: oldRack, grip: 0, spanMix: 0, phase: 'Releasing the return cradle' },
    { at: .53, old: oldRack, replacement: newRack, target: oldAbove, grip: 0, spanMix: 0, phase: 'Retracting the clamp' },
    { at: .59, old: oldRack, replacement: newRack, target: newAbove, grip: 0, spanMix: 1, phase: 'Collecting the replacement' },
    { at: .63, old: oldRack, replacement: newRack, target: newRack, grip: 0, spanMix: 1, phase: 'Gripping the replacement' },
    { at: .66, old: oldRack, replacement: newRack, target: newRack, grip: 1, spanMix: 1, phase: 'Lifting from the delivery cradle' },
    { at: .71, old: oldRack, replacement: newAbove, target: newAbove, grip: 1, spanMix: 1, phase: 'Transferring the replacement' },
    { at: .76, old: oldRack, replacement: newOut, target: newOut, grip: 1, spanMix: 1, phase: 'Approaching the open socket' },
    { at: .81, old: oldRack, replacement: newClear, target: newClear, grip: 1, spanMix: 1, phase: 'Aligning the mounting faces' },
    { at: .88, old: oldRack, replacement: newMount, target: newMount, grip: 1, spanMix: 1, phase: 'Seating the replacement' },
    { at: .90, old: oldRack, replacement: newMount, target: newMount, grip: 0, spanMix: 1, phase: 'Tightening mounting fasteners' },
    { at: .925, old: oldRack, replacement: newMount, target: newMount, grip: 0, spanMix: 1, phase: 'Checking the mounting' },
    { at: .95, old: oldRack, replacement: newMount, target: add(newMount, [-1.55, .22, 0]), grip: 0, spanMix: 1, phase: 'Withdrawing to the open service side' },
    { at: .965, old: oldRack, replacement: newMount, target: ROBOT_PARK, grip: 0, spanMix: 1, phase: 'Lowering the supported assembly' },
    { at: 1, old: oldRack, replacement: newMount, target: ROBOT_PARK, grip: 0, spanMix: 1, phase: 'Installation complete' },
  ];
  const p = Math.max(0, Math.min(1, t)), index = Math.max(0, keys.findIndex(k => k.at >= p) - 1), a = keys[index], b = keys[Math.min(keys.length - 1, index + 1)];
  const u = ramp(p, a.at, b.at), tool = (p >= .18 && p < .215) || (p >= .90 && p < .925);
  return { old: lerp(a.old, b.old, u), replacement: lerp(a.replacement, b.replacement, u), target: lerp(a.target, b.target, u),
    grip: a.grip + (b.grip - a.grip) * u, spanMix: a.spanMix + (b.spanMix - a.spanMix) * u,
    support: ramp(p, .04, .12) * (1 - ramp(p, .955, .985)), tool, spin: tool ? p * 360 : 0, phase: a.phase };
}

interface Job { returnClosed: boolean; next: WorkshopTank; slot: SlotId; payload: readonly SlotId[]; elapsed: number; duration: number; resolve: (success: boolean) => void; soundStep: number; reversing: boolean;
  oldMount: Vec3; newMount: Vec3; oldRack: Vec3; newRack: Vec3; extraction: Vec3; oldSpan: number; newSpan: number; oldGrip: ServiceGrip; newGrip: ServiceGrip }
interface Support { rods: InstanceHandle[]; pads: InstanceHandle[]; bodies: InstanceHandle[]; stems: InstanceHandle[]; outriggers: InstanceHandle[]; crossheads: InstanceHandle[]; carriers: InstanceHandle[] }

export class WorkshopMechanics {
  private installed: WorkshopTank;
  private previewTank: WorkshopTank | null = null;
  private previewSlot: SlotId | null = null;
  private deferredPreview: { ids: KitLoadoutIdsLike; slot: SlotId } | null = null;
  private returned: WorkshopTank | null = null;
  private job: Job | null = null;
  private queued: { ids: KitLoadoutIdsLike; slot: SlotId; quick?: boolean; resolve: (success: boolean) => void } | null = null;
  private readonly root: Vec3;
  private readonly audio: WorkshopAudio;
  private readonly geometry: WorkshopGeometry;
  readonly robot: WorkshopRobot;
  private readonly supports: Support;
  private readonly fasteners: InstanceHandle[] = [];
  private readonly trolleyCovers: InstanceHandle[][] = [];
  private readonly trolleyFrames: InstanceHandle[][] = [];
  private palette: WorkshopPalette = 'sage';
  private appearance: TankAppearance | null = null;
  private reducedMotion: boolean;
  private quick: boolean;
  private manualLift = 0;
  private liftInput: -1 | 0 | 1 = 0;
  private coverOpening = [1, 1];
  private audioLift = 0;
  private audioTip: Vec3 = [...ROBOT_PARK];
  private audioCovers = [1, 1];
  get liftHeight(): number { return this.state.liftOffset; }
  setLiftInput(direction: -1 | 0 | 1): void { if (!this.disposed) { this.liftInput = this.job ? 0 : direction; if (direction && !this.job) { this.audio.unlock(); this.audio.play('servo'); } } }
  private disposed = false;
  private highlightSlot: SlotId | null = null;
  readonly state: WorkshopMechanicalState = { busy: false, phase: 'Ready for inspection', progress: 0, liftOffset: 0 };
  get tank(): WorkshopTank { return this.installed; }

  constructor(private readonly scene: SceneRegistry, ids: KitLoadoutIdsLike, private readonly options: WorkshopMechanicsOptions = {}) {
    this.root = [...(options.root ?? WORKSHOP_TANK_ROOT)]; this.reducedMotion = options.reducedMotion ?? false; this.quick = options.quick ?? false;
    this.audio = new WorkshopAudio(options.audioSettings ?? options.audioVolume ?? .35);
    this.installed = new WorkshopTank(scene, ids, this.root); this.robot = new WorkshopRobot(scene);
    const g = this.geometry = new WorkshopGeometry(scene);
    this.supports = { rods: [], pads: [], bodies: [], stems: [], outriggers: [], crossheads: [], carriers: [] };
    // Two real rolled H columns on the far side leave the entire robot sweep unobstructed.
    // Webs, flanges, bolted baseplates and knee braces carry the cantilever into the slab.
    for (const [x,, z] of GANTRY_COLUMNS) {
      g.box([x, .065, z], [.70, .13, .72], 1);
      g.box([x, 2.315, z], [.065, 4.37, .34], 1);
      for (const side of [-1, 1]) g.box([x, 2.315, z + side * .19], [.34, 4.37, .055], 1);
      for (const dx of [-.26, .26]) for (const dz of [-.27, .27]) {
        g.cylinder([x + dx, .13, z + dz], [x + dx, .19, z + dz], .031, 7);
        g.cylinder([x + dx, .19, z + dz], [x + dx, .212, z + dz], .047, 4);
      }
      // H-section cantilever: continuous flanges with an inset upright web.
      g.box([.76, 4.59, z], [3.26, .26, .052], 1);
      for (const sy of [-1, 1]) g.box([.76, 4.59 + sy * .15, z], [3.26, .05, .24], 1);
      g.box([x - .04, 4.39, z], [.09, .66, .43], 4);
      for (const dx of [-.16, .16]) for (const dy of [-.24, -.08, .08, .24])
        g.cylinder([x - .095, 4.39 + dy, z + dx], [x - .145, 4.39 + dy, z + dx], .025, 7);
      for (const side of [-1, 1]) {
        const brace = g.box([0, 0, 0], [1, 1, 1], 1);
        g.setBeam(brace, [x - .13, 3.70, z + side * .11], [x - .95, 4.43, z + side * .11], .07, .11);
      }
    }
    for (const x of [-.46, .46]) {
      g.box([x, 4.58, 0], [.055, .15, 4.8], 1);
      for (const sy of [-1, 1]) g.box([x, 4.58 + sy * .09, 0], [.18, .04, 4.8], 7);
    }
    // Four wheels per rail run on the upper faces of the lower H flanges. Carrier
    // plates hang outside the flange edges; short stub axles never cross the web.
    const carrier = new Shape(); carrier.noHull = true;
    for (const x of [-.46, .46]) for (const side of [-1, 1]) {
      carrier.material(1); box(carrier, translate(x + side * .113, 4.483, 0), [.018, .23, .25], .005);
      for (const z of [-.075, .075]) {
        carrier.material(7); cylinder(carrier, null, [x + side * .040, 4.559, z], [x + side * .076, 4.559, z], .048, 28);
        carrier.material(4); cylinder(carrier, null, [x + side * .073, 4.559, z], [x + side * .126, 4.559, z], .016, 16);
        carrier.material(7); cylinder(carrier, null, [x + side * .124, 4.559, z], [x + side * .139, 4.559, z], .025, 6);

      }
      carrier.material(7); cylinder(carrier, null, [x + side * .113, 4.388, 0], [x + side * .134, 4.388, 0], .018, 6);
    }
    for (let i = 0; i < 2; i++) {
      this.supports.crossheads.push(g.box([0, 4.39, i ? -1.15 : 1.15], [1.18, .12, .16], 4));
      this.supports.carriers.push(g.addMesh(shapeMesh(carrier, 'workshop:crane-rail-carriers'), transform([0, 0, i ? -1.15 : 1.15])));
    }
    for (const rack of [OLD_RACK, NEW_RACK]) {
      // The authored Meshy cabinet and bolted riser frame end at .75; this removable bed closes the load path.
      g.box(add(rack, [0, -.06, 0]), [2.55, .06, 3.4], 1);
      // Continuous recessed elastomer mat supports narrow housings as well as both separated tracks.
      g.box(add(rack, [0, -.015, 0]), [2.50, .03, 3.25], 2);
      // Four thin telescoping shutters and a divided roof enclose the actual payload. Panels move
      // outside its envelope; no solid cover translates through the component when the trolley opens.
      const covers: InstanceHandle[] = [];
      for (const x of [-1.32, 1.32]) covers.push(g.box(add(rack, [x, .43, 0]), [.045, SHUTTER_HEIGHT, 3.48], 0, [.12, .21, .16]));
      for (const z of [-1.74, 1.74]) covers.push(g.box(add(rack, [0, .43, z]), [2.64, SHUTTER_HEIGHT, .045], 0, [.12, .21, .16]));
      for (const x of [-.66, .66]) covers.push(g.box(add(rack, [x, SHUTTER_HEIGHT - .03, 0]), [1.32, .035, 3.48], 1));
      for (let row = 0; row < 7; row++) {
        for (const side of [-1, 1]) covers.push(g.box(add(rack, [side * 1.345, .1 + row * .11, 0]), [.018, .018, 3.42], 7));
        for (const side of [-1, 1]) covers.push(g.box(add(rack, [0, .1 + row * .11, side * 1.765]), [2.60, .018, .018], 7));
      }
      const frame: InstanceHandle[] = [];
      for (const z of [-1.78, 1.78]) {
        frame.push(g.box(add(rack, [0, SHUTTER_HEIGHT - .09, z]), [2.80, .04, .065], 4));
        for (const x of [-1.37, 1.37]) frame.push(g.box(add(rack, [x, .42, z]), [.04, SHUTTER_HEIGHT - .05, .04], 7));
      }
      this.trolleyFrames.push(frame);
      g.box(add(rack, [-1.41, .20, .60]), [.14, .22, .32], 0, [.18, .24, .18]);
      g.cylinder(add(rack, [-1.54, .21, .60]), add(rack, [-1.47, .21, .60]), .092, 4);
      frame.push(g.cylinder(add(rack, [-1.35, .04, .43]), add(rack, [-1.35, SHUTTER_HEIGHT - .10, .43]), .021, 7));
      // One mandrel-bent tube runs between both bed mounts. Its swept elbows have
      // continuous surfaces and tangents instead of three capped pipes intersecting.
      const pushbar = new Shape().material(4); pushbar.noHull = true;
      sweep(pushbar, null, [[-.43, -.025, 1.65], [-.43, .25, 1.795], [.43, .25, 1.795], [.43, -.025, 1.65]], .026, 20, { bend: .11 });
      g.addMesh(shapeMesh(pushbar, 'workshop:trolley-bent-pushbar'), transform(rack));
      for (const x of [-.43, .43]) {
        g.box(add(rack, [x, -.008, 1.64]), [.16, .032, .17], 1);
        for (const dx of [-.055, .055]) g.cylinder(add(rack, [x + dx, .008, 1.64]), add(rack, [x + dx, .032, 1.64]), .014, 7);
      }
      g.box(add(rack, [-1.36, .11, .60]), [.16, .055, .36], 1);
      g.box(add(rack, [-1.28, .045, .60]), [.07, .16, .36], 1);
      for (const x of [-1.17, 1.17]) for (const z of [-1.35, .87]) {
        g.box(add(rack, [x, .004, z]), [.22, .025, .20], 4);
        g.cylinder(add(rack, [x, .018, z]), add(rack, [x, .039, z]), .024, 7);
      }
      for (const x of [-1.24, 1.24]) g.box(add(rack, [x, .012, 0]), [.018, .048, 3.18], 1);
      // Welded outriggers spread the larger cradle into the authored cabinet's bolted risers.
      for (const z of [-.72, .72]) {
        g.box(add(rack, [0, -.15, z]), [2.50, .13, .11], 1);
        for (const sign of [-1, 1]) {
          const brace = g.box([0, 0, 0], [1, 1, 1], 1);
          g.setBeam(brace, add(rack, [sign * .62, -.25, z]), add(rack, [sign * 1.2, -.07, z]), .055, .07);
        }
      }
      for (const x of [-.66, .66]) g.box(add(rack, [x, -.14, 0]), [.11, .14, 3.25], 1);
      this.trolleyCovers.push(covers);
    }
    for (let i = 0; i < 4; i++) {
      const outrigger = new Shape().material(1); outrigger.noHull = true; box(outrigger, null, [1, 1, 1], .02);
      this.supports.outriggers.push(g.addMesh(shapeMesh(outrigger, 'workshop:lifting-overhead-outrigger')));
      const cable = new Shape().material(7); cable.noHull = true; cylinder(cable, null, [0, 0, 0], [0, 0, 1], 1, 12);
      this.supports.rods.push(g.addMesh(shapeMesh(cable, 'workshop:lifting-cable')));
      const shoe = new Shape().material(1); shoe.noHull = true; cylinder(shoe, null, [0, 0, 0], [0, 0, 1], 1, 28);
      this.supports.pads.push(g.addMesh(shapeMesh(shoe, 'workshop:lifting-contact-shoe')));
      const coil = new Shape().material(0); coil.noHull = true; cylinder(coil, null, [0, 0, 0], [0, 0, 1], 1, 28);
      this.supports.bodies.push(g.addMesh(shapeMesh(coil, 'workshop:lifting-magnet-housing')));
      const stem = new Shape().material(4); stem.noHull = true; cylinder(stem, null, [0, 0, 0], [0, 0, 1], 1, 20);
      this.supports.stems.push(g.addMesh(shapeMesh(stem, 'workshop:lifting-pole-stem')));
      const bolt = new Shape().material(4); bolt.noHull = true; cylinder(bolt, null, [0, -.016, 0], [0, .016, 0], .025, 6);
      this.fasteners.push(g.addMesh(shapeMesh(bolt, 'workshop:service-fastener')));
    }
    this.restHardware();
  }

  occludes(origin: Vec3, direction: Vec3, distance: number): boolean { return this.geometry.occludes(origin, direction, distance) || this.robot.occludes(origin, direction, distance); }
  unlockAudio(): void { this.audio.unlock(); }
  setAudioListener(position: Vec3, target: Vec3): void { this.audio.setListener(position, target); }
  setAudioSettings(settings: WorkshopAudioSettings): void { this.audio.applySettings(settings); }
  playSteam(position: Vec3): void { this.audio.play('steam', position); }
  audioSnapshot() { return this.audio.snapshot(); }
  captureAudio(): MediaStream | undefined { return this.audio.captureStream(); }
  private updateAudioMotion(dt: number): void {
    const seconds = Math.max(.001, Math.min(.1, dt));
    const lift = Math.min(1, Math.abs(this.state.liftOffset - this.audioLift) / seconds / .35);
    const arm = this.job ? Math.min(1, Math.hypot(...sub(this.robot.pose.tip, this.audioTip)) / seconds / 5) : 0;
    const trolley = Math.min(1, Math.max(...this.coverOpening.map((v, i) => Math.abs(v - this.audioCovers[i]))) / seconds / 3);
    const movingCart = Math.abs(this.coverOpening[0] - this.audioCovers[0]) > Math.abs(this.coverOpening[1] - this.audioCovers[1]) ? OLD_RACK : NEW_RACK;
    this.audio.setMotion({ lift, arm, trolley }, { lift: [0, this.state.liftOffset, 0], arm: this.robot.pose.wrist, trolley: movingCart });
    this.audioLift = this.state.liftOffset; this.audioTip = [...this.robot.pose.tip]; this.audioCovers = [...this.coverOpening];
    this.audio.update();
  }
  setAudioVolume(volume: number): void { this.audio.setVolume(volume); }
  setQuick(quick: boolean): void { this.quick = quick; }
  setReducedMotion(reduced: boolean): void { this.reducedMotion = reduced; if (reduced && this.job) this.finish(!this.job.reversing); }
  setPalette(palette: WorkshopPalette): void {
    if (palette === this.palette) return; this.palette = palette;
    for (const tank of [this.installed, this.previewTank, this.returned, this.job?.next]) tank?.setTint(PALETTE[palette]);
  }
  setAppearance(appearance: TankAppearance): void {
    this.appearance = appearance;
    for (const tank of [this.installed, this.previewTank, this.returned, this.job?.next]) tank?.setAppearance(appearance);
  }
  highlight(slot: SlotId | null): void { this.highlightSlot = slot; this.installed.highlight(this.job ? null : slot); }
  private phase(message: string): void { if (message !== this.state.phase) { this.state.phase = message; this.options.onPhase?.(message); } }
  preview(ids: KitLoadoutIdsLike, slot: SlotId): void {
    if (this.disposed) return;
    if (this.job) { this.clearPreview(); this.deferredPreview = { ids: { ...ids }, slot }; return; }
    if (this.previewTank && this.previewSlot === slot && KIT_SLOTS.every(s => ids[s] === this.previewTank!.loadout[s]) && (ids.armor ?? 'standard') === (this.previewTank.loadout.armor ?? 'standard')) return;
    this.clearPreview();
    try {
      const bundled = KIT_SLOTS.filter(category => category === slot || ids[category] !== this.installed.loadout[category] || category === 'hull' && (ids.armor ?? 'standard') !== (this.installed.loadout.armor ?? 'standard'));
      const preview = this.previewTank = new WorkshopTank(this.scene, ids, this.root, bundled, PALETTE[this.palette]); this.previewSlot = slot;
      if (this.appearance) preview.setAppearance(this.appearance);
      const b = preview.categoryBounds(slot);
      preview.setRoot([NEW_RACK[0] - b.center[0], NEW_RACK[1] - TROLLEY_PAD_COMPRESSION - b.min[1], NEW_RACK[2] - b.center[2]]);
    } catch { this.clearPreview(); }
  }
  clearPreview(): void { this.deferredPreview = null; this.previewTank?.dispose(); this.previewTank = null; this.previewSlot = null; }
  setLoadout(ids: KitLoadoutIdsLike): void {
    if (this.disposed) return;
    validateKitLoadout(ids); this.clearQueue(); this.finish(false); this.clearPreview(); this.clearReturn();
    if (KIT_SLOTS.every(slot => ids[slot] === this.installed.loadout[slot]) && ids.armor === this.installed.loadout.armor) return;
    const next = new WorkshopTank(this.scene, ids, add(this.root, [0, this.manualLift, 0]), KIT_SLOTS, PALETTE[this.palette]);
    if (this.appearance) next.setAppearance(this.appearance);
    this.installed.dispose(); this.installed = next; this.installed.highlight(this.highlightSlot);
    this.clearPreview(); this.clearReturn();
  }
  install(ids: KitLoadoutIdsLike, slot: SlotId, options: { quick?: boolean } = {}): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    try { validateKitLoadout(ids); } catch { return Promise.resolve(false); }
    const dependent = KIT_SLOTS.filter(s => s !== slot && ids[s] !== this.installed.loadout[s]);
    const armorChanged = (ids.armor ?? 'standard') !== (this.installed.loadout.armor ?? 'standard');
    if (armorChanged && slot !== 'hull') return Promise.resolve(false);
    if (dependent.length && !dependent.every(s => slot === 'turret' ? s === 'weapon' : slot === 'hull' && (s === 'turret' || s === 'weapon'))) return Promise.resolve(false);
    // A matched host carries its dependent modules as one rigid payload. Both old
    // and replacement stay valid assemblies throughout the full servicing path.
    const payload: readonly SlotId[] = dependent.length ? slot === 'hull' ? ['hull', 'turret', 'weapon'] : ['turret', 'weapon'] : [slot];
    if (this.job) {
      this.clearQueue(); this.job.reversing = true; this.audio.cancel(); this.audio.play('servo');
      return new Promise(resolve => { this.queued = { ids: { ...ids }, slot, quick: options.quick, resolve }; });
    }
    if (ids[slot] === this.installed.loadout[slot]) {
      if (armorChanged) this.setLoadout(ids);
      return Promise.resolve(true);
    }
    if (options.quick || this.quick || this.reducedMotion) {
      this.audio.unlock(); this.setLoadout(ids); this.phase('Component seated'); this.audio.play('seat', this.root);
      return Promise.resolve(true);
    }
    this.audio.unlock(); this.clearPreview(); const returnClosed = Boolean(this.returned); this.clearReturn();
    const next = new WorkshopTank(this.scene, ids, this.root, KIT_SLOTS, PALETTE[this.palette]);
    if (this.appearance) next.setAppearance(this.appearance);
    for (const category of KIT_SLOTS) next.setVisible(category, payload.includes(category));
    this.installed.parkAccessories();
    let oldGrip: ReturnType<WorkshopTank['serviceGrip']>, newGrip: ReturnType<WorkshopTank['serviceGrip']>;
    try { oldGrip = this.installed.serviceGrip(slot); newGrip = next.serviceGrip(slot); }
    catch (error) { next.dispose(); throw error; }
    const oldMount = add(this.root, oldGrip.anchor), newMount = add(this.root, newGrip.anchor);
    const rackAnchor = (tank: WorkshopTank, mount: Vec3, rack: Vec3): Vec3 => {
      const boxes = payload.map(category => tank.categoryBounds(category));
      const lo = [0, 1, 2].map(axis => Math.min(...boxes.map(b => b.min[axis]))), hi = [0, 1, 2].map(axis => Math.max(...boxes.map(b => b.max[axis])));
      return add(mount, [rack[0] - this.root[0] - (lo[0] + hi[0]) / 2, rack[1] - TROLLEY_PAD_COMPRESSION - this.root[1] - lo[1], rack[2] - this.root[2] - (lo[2] + hi[2]) / 2]);
    };
    const extraction: Vec3 = slot === 'weapon' ? [0, .10, .58] : slot === 'runningGear' ? [0, .10, 0] : [0, slot === 'hull' ? .48 : .43, 0];
    this.state.busy = true; this.state.progress = 0; this.liftInput = 0; this.installed.highlight(null);
    const promise = new Promise<boolean>(resolve => {
      this.job = { returnClosed, next, slot, payload, elapsed: 0, duration: slot === 'hull' || slot === 'runningGear' || slot === 'turret' ? 3.8 : 3.1,
        resolve, soundStep: 0, reversing: false, oldMount, newMount, oldRack: rackAnchor(this.installed, oldMount, OLD_RACK), newRack: rackAnchor(next, newMount, NEW_RACK), extraction,
        oldSpan: oldGrip.span, newSpan: newGrip.span, oldGrip, newGrip };
    });
    if (options.quick || this.quick || this.reducedMotion) { this.finish(true); this.audio.play('seat', add(newMount, [0, this.manualLift, 0])); }
    else this.update(0, 0);
    return promise;
  }
  update(dt: number, _time: number): void {
    if (this.disposed) return;
    const job = this.job;
    if (!job) {
      if (this.liftInput) {
        this.manualLift = Math.max(0, Math.min(WORKSHOP_LIFT_MAX, this.manualLift + this.liftInput * Math.max(0, Math.min(.1, dt)) * .35));
        this.state.liftOffset = this.manualLift; this.installed.setRoot(add(this.root, [0, this.manualLift, 0]));
      }
      this.updateAudioMotion(dt);
      return;
    }
    job.elapsed = Math.max(0, job.elapsed + Math.max(0, Math.min(.1, dt)) * (job.reversing ? -1.6 : 1));
    const p = Math.min(1, job.elapsed / job.duration), support = ramp(p, .04, .12) * (1 - ramp(p, .955, .985));
    this.state.progress = p;
    const serviceLift = ramp(p, 0, .12) * (1 - ramp(p, .965, 1));
    this.state.liftOffset = this.manualLift * (1 - serviceLift) + WORKSHOP_SERVICE_HEIGHT * serviceLift;
    // The main lift carries the tank. Staged trolleys stay on the floor, so their offsets compensate for lift travel.
    const lift: Vec3 = [0, this.state.liftOffset, 0], worldRoot = add(this.root, lift);
    const motion = serviceMotion(p, add(job.oldMount, lift), add(job.newMount, lift), job.oldRack, job.newRack, job.extraction);
    this.installed.setRoot(worldRoot); job.next.setRoot(worldRoot);
    // Incoming stock enters only while the delivery enclosure is closed; empty trolleys park open.
    for (const category of job.payload) {
      job.next.setVisible(category, p >= .038);
      this.installed.setOffset(category, sub(sub(motion.old, job.oldMount), lift));
      job.next.setOffset(category, sub(sub(motion.replacement, job.newMount), lift));
    }
    const supported: readonly SlotId[] = job.slot === 'hull' ? ['turret', 'weapon', 'utility'] : job.slot === 'turret' ? ['weapon', 'utility'] : job.slot === 'runningGear' ? ['hull', 'turret', 'weapon', 'utility'] : [];
    for (const slot of KIT_SLOTS) if (!job.payload.includes(slot)) {
      const supportY = supported.includes(slot) ? motion.support * (job.slot === 'hull' ? 1.5 : job.slot === 'runningGear' ? 1.75 : 1.35) : 0;
      const oldCenter = this.installed.categoryBounds(slot).center, newCenter = job.next.categoryBounds(slot).center;
      const alignment = lerp(ZERO, sub(newCenter, oldCenter), ramp(p, .88, 1));
      this.installed.setOffset(slot, add(alignment, [0, supportY, 0]));
    }
    const span = job.oldSpan + (job.newSpan - job.oldSpan) * motion.spanMix;
    const contact = motion.spanMix < .5 ? job.oldGrip : job.newGrip;
    this.robot.update(motion.target, motion.grip, span, motion.spin, motion.tool, { ...contact, deployment: ramp(p, .02, .12) * (1 - ramp(p, .965, 1)) });
    this.serviceHardware(job, p, motion.support);
    this.phase(job.reversing ? 'Returning components · restoring original build' : motion.phase);
    const cues: [number, WorkshopSound][] = [[.05, 'servo'], [.18, 'ratchet'], [.23, 'clamp'], [.28, 'release'], [.35, 'servo'], [.46, 'seat'], [.59, 'servo'], [.66, 'clamp'], [.74, 'servo'], [.88, 'seat'], [.91, 'ratchet']];
    if (!job.reversing) while (job.soundStep < cues.length && p >= cues[job.soundStep][0]) this.audio.play(cues[job.soundStep++][1], this.robot.pose.tip);
    if (job.reversing && p <= 0) this.finish(false);
    else if (p >= 1) this.finish(true);
    this.updateAudioMotion(dt);
  }
  private serviceHardware(job: Job, p: number, support: number): void {
    const g = this.geometry, overhead = job.slot === 'hull' || job.slot === 'turret' || job.slot === 'runningGear';
    for (let i = 0; i < 4; i++) {
      const bundle = job.payload.length > 1;
      const category = bundle ? 'utility' : job.slot === 'runningGear' ? 'hull' : job.slot === 'hull' ? 'turret' : i < 2 ? 'weapon' : 'utility';
      const held = overhead && (!bundle || i >= 2);
      if (held) {
        const pair = bundle || job.slot === 'turret';
        const poles = this.installed.overheadContacts(category, pair ? 2 : 4), pole = poles[pair ? i % 2 : i];
        const contact = this.installed.attachmentPoint(category, pole.offset), n = pole.normal;
        const deployed = ramp(p, 0, .035) * (1 - ramp(p, .985, 1));
        const point = add(contact, [0, (4.12 - contact[1]) * (1 - deployed), 0]);
        const along = (height: number): Vec3 => add(point, n.map(v => v * height) as Vec3);
        const radius = pole.radius, bridgeZ = i < 2 ? 1.15 : -1.15;
        g.setCylinder(this.supports.pads[i], along(-.002), along(.013), radius);
        g.setCylinder(this.supports.bodies[i], along(.015), along(.060), radius * 1.28);
        g.setCylinder(this.supports.stems[i], along(.060), along(.105), Math.min(.015, radius * .6));
        const cableTop: Vec3 = [along(.105)[0], 4.34, along(.105)[2]];
        g.setCylinder(this.supports.rods[i], cableTop, along(.105), .006);
        g.setBeam(this.supports.outriggers[i], [cableTop[0], 4.34, bridgeZ], cableTop, .036, .036);
        if (i % 2 === 0) {
          const span = Math.max(...poles.map(pole => Math.abs(pole.offset[0]))) * 2 + .16;
          g.setBox(this.supports.crossheads[i / 2], [0, 4.39, bridgeZ], [Math.max(1.18, span), .12, .16]);
          g.setTransform(this.supports.carriers[i / 2], transform([0, 0, bridgeZ]));
        }
      }
      for (const part of [this.supports.rods[i], this.supports.pads[i], this.supports.bodies[i], this.supports.stems[i], this.supports.outriggers[i]]) g.visibility(part, held);
      const fastener = add(p < .5 ? job.oldMount : job.newMount, [i === 0 ? 0 : (i % 2 ? 1 : -1) * .095, this.state.liftOffset - .041, i === 0 ? 0 : (i < 2 ? 1 : -1) * .07]);
      const unfastened = ramp(p, .18, .23) * (1 - ramp(p, .90, .925));
      g.setTransform(this.fasteners[i], transform(add(fastener, [0, unfastened * .014, 0]), [1, 1, 1], [0, unfastened * Math.PI * 8, 0]));
      g.visibility(this.fasteners[i], p < .24 || p > .875);
    }
    // Shutters retract vertically into the trolley before the payload is touched, and close on the old part.
    for (let i = 0; i < 2; i++) {
      const opening = i ? 1 - ramp(p, 0, .035) + ramp(p, .04, .14) : (job.returnClosed ? ramp(p, 0, .10) : 1) * (1 - ramp(p, .96, 1));
      this.setCover(i, opening);
    }
  }
  private restHardware(): void {
    for (const h of [...this.supports.rods, ...this.supports.pads, ...this.supports.bodies, ...this.supports.stems, ...this.supports.outriggers, ...this.fasteners]) this.geometry.visibility(h, false);
    this.setCover(0, this.returned ? 0 : 1); this.setCover(1, 1);
  }
  private setCover(index: number, opening: number): void {
    this.coverOpening[index] = opening;
    const rack = index ? NEW_RACK : OLD_RACK, panels = this.trolleyCovers[index];
    const roofOpen = ramp(opening, 0, .32), sidesOpen = ramp(opening, .32, 1);
    const height = .035 + (SHUTTER_HEIGHT - .035) * (1 - sidesOpen), y = height / 2 - .045;
    const roofWidth = 1.32 - roofOpen * 1.29;
    for (let i = 0; i < 2; i++) {
      const sign = i ? 1 : -1;
      this.geometry.setBox(panels[i], add(rack, [sign * 1.32, y, 0]), [.045, height, 3.48]);
      this.geometry.setBox(panels[i + 2], add(rack, [0, y, sign * 1.74]), [2.64, height, .045]);
      this.geometry.setBox(panels[i + 4], add(rack, [sign * (1.32 - roofWidth / 2), height - .03, 0]), [roofWidth, .035, 3.48]);
    }
    for (let end = 0; end < 2; end++) {
      const z = (end ? 1 : -1) * 1.78, frame = this.trolleyFrames[index];
      this.geometry.setBox(frame[end * 3], add(rack, [0, height - .09, z]), [2.80, .04, .065]);
      for (let side = 0; side < 2; side++) this.geometry.setBox(frame[end * 3 + side + 1], add(rack, [(side ? 1 : -1) * 1.37, y, z]), [.04, Math.max(.02, height - .05), .04]);
    }
    this.geometry.setCylinder(this.trolleyFrames[index][6], add(rack, [-1.35, .015, .43]), add(rack, [-1.35, Math.max(.04, height - .10), .43]), .021);
    for (let row = 0; row < 7; row++) {
      const sy = -.03 + (row + .5) * height / 7;
      for (let side = 0; side < 2; side++) {
        const sign = side ? 1 : -1;
        this.geometry.setBox(panels[6 + row * 4 + side], add(rack, [sign * 1.345, sy, 0]), [.018, .018, 3.42]);
        this.geometry.setBox(panels[8 + row * 4 + side], add(rack, [0, sy, sign * 1.765]), [2.60, .018, .018]);
      }
    }
  }
  private clearReturn(): void { this.returned?.dispose(); this.returned = null; }
  private finish(success: boolean): void {
    const job = this.job; if (!job) return;
    this.job = null; this.state.busy = false; this.state.liftOffset = this.manualLift; this.state.progress = success ? 1 : 0;
    if (success) {
      // The old payload remains physically stored behind its closed return shutter until the next job.
      for (const slot of KIT_SLOTS) this.installed.setVisible(slot, job.payload.includes(slot));
      this.installed.setRoot(this.root); for (const slot of job.payload) this.installed.setOffset(slot, sub(job.oldRack, job.oldMount));
      this.returned = this.installed; this.installed = job.next;
      for (const slot of KIT_SLOTS) { this.installed.setOffset(slot, ZERO); this.installed.setVisible(slot, true); }
      this.installed.setRoot(add(this.root, [0, this.manualLift, 0])); this.phase('Installation complete');
    } else {
      job.next.dispose(); this.installed.setRoot(add(this.root, [0, this.manualLift, 0]));
      for (const slot of KIT_SLOTS) { this.installed.setOffset(slot, ZERO); this.installed.setVisible(slot, true); }
      this.phase('Installation cancelled · original build retained');
    }
    this.installed.highlight(this.highlightSlot); this.robot.update(ROBOT_PARK, 0, .4); this.restHardware(); this.audio.cancel(); job.resolve(success);
    const queued = this.queued; this.queued = null;
    const preview = this.deferredPreview; this.deferredPreview = null;
    if (queued) { if (this.disposed) queued.resolve(false); else void this.install(queued.ids, queued.slot, { quick: queued.quick }).then(queued.resolve); }
    else if (preview && !this.disposed) this.preview(preview.ids, preview.slot);
  }
  private clearQueue(): void { this.queued?.resolve(false); this.queued = null; }
  cancel(): void {
    this.clearQueue();
    if (!this.job) return;
    if (this.reducedMotion || this.quick) this.finish(false);
    else { this.job.reversing = true; this.audio.cancel(); this.audio.play('servo'); }
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.clearQueue(); this.finish(false); this.clearPreview(); this.clearReturn();
    this.installed.dispose(); this.robot.dispose(); this.geometry.dispose(); this.audio.dispose();
  }
}
