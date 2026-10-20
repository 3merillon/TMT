/** Scene owner for the enclosed workshop. No planetary camera, atmosphere or world resources are shared. */
import { Engine, type CameraRig } from '../../engine';
import { decodeWorkshopTextureImages, loadWorkshopTextures, WORKSHOP_SURFACE_TEXTURES } from '../../engine/materials/workshop-textures';
import { decodeWorkshopReflection, loadWorkshopReflection } from '../../engine/materials/workshop-reflection';
import type { KitLoadoutIds } from '../api/match';
import { currentSettings, SETTINGS_EVENT, type AudioSettings, type GraphicsSettings, type ProgressSettings } from '../meta/settings';
import { engineGraphicsSettings } from '../presentation/graphics-settings';
import { applyWorkshopGraphics } from './graphics';
import { KIT_SLOTS, type SlotId } from '../kit';
import { fitPart, replacementKit } from '../ui/workshop-model';
import { createWorkshopAtmospherics } from './atmospherics';
import { cameraRay, categoryView, centeredTankView, copyOrbit, easeOrbit, HERO, inspectionView, workshopCamera, WorkshopPreviewFraming, type WorkshopView } from './camera';
import { WorkshopMechanics, type WorkshopPalette } from './mechanics';
import { loadWorkshopRoom, WorkshopRoom, workshopOccluders } from './room';
import { workshopAsset, workshopManifest } from './assets';
import { RoomPickingGrid } from './picking';
import { WORKSHOP_LIFT_CONTROL_POINT, WORKSHOP_LIFT_MAX } from './dimensions';
import { LIFT_BUTTON_POINTS } from './control-panel';
import type { TankAppearance } from '../meta/cosmetics';
import type { PaintBrush, PaintSurfaceHit } from './paint';
export interface WorkshopSceneOptions {
  kit: KitLoadoutIds; reducedMotion: boolean; palette: WorkshopPalette; audioVolume: number;
  audioSettings?: Pick<AudioSettings, 'master' | 'music' | 'sfx'>;
  graphics?: GraphicsSettings;
  signal?: AbortSignal;
  onSelect(slot: SlotId): void; onStatus(message: string): void;
  onPaint?(hit: PaintSurfaceHit | null, phase: 'start' | 'move' | 'end'): void;
}
export interface WorkshopScene {
  setKit(kit: KitLoadoutIds): void; setPreview(slot: SlotId, id: string | null): void; focus(slot: SlotId): void;
  install(slot: SlotId, id: string, options?: { quick?: boolean; sandbox?: boolean; budget?: number }): Promise<boolean>; cancelInstall(): void;
  setLiftInput(direction: -1 | 0 | 1): void; readonly liftHeight: number;
  setAudioSettings(settings: Pick<AudioSettings, 'master' | 'music' | 'sfx'>): void;
  setGraphicsSettings(settings: GraphicsSettings): void;
  setPalette(palette: WorkshopPalette): void; setReducedMotion(value: boolean): void; setView(view: WorkshopView): void; dispose(): void;
  setAppearance(appearance: TankAppearance): void; setPaintMode(brush: PaintBrush | null): void;
  clearSelection(): void; setPresentation(value: boolean): void;
}
interface WorkshopProbe {
  ready: boolean; frames: number; error: string | null; readonly busy: boolean; readonly phase: string; readonly progress: number;
  readonly kit: KitLoadoutIds; readonly camera: CameraRig; readonly components: Record<string, { x: number; y: number; visible: boolean }>;
  readonly liftHeight: number; setLiftInput(direction: -1 | 0 | 1): void;
  captureAudio(): MediaStream | undefined;
  paintTarget(x: number, y: number): PaintSurfaceHit | null;
  readonly appearance: TankAppearance | null;
  engine: Engine; setView(view: WorkshopView): void; shaderCheck: Engine['shaderCheck']; snapshot(): unknown; readonly resourceCounts: unknown;
}
declare global { interface Window { __tmtWorkshop?: WorkshopProbe } }

function workshopCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'ws-canvas'; canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
  canvas.setAttribute('aria-hidden', 'true');
  return canvas;
}
const createWorkshopEngine = (canvas: HTMLCanvasElement, graphics = currentSettings().graphics) =>
  Engine.create({ canvas, environment: 'interior', tier: 'high', modules: [], dev: import.meta.env.DEV, settings: { exposure: .85, ...engineGraphicsSettings(graphics) } });

// Pipeline compilation is most of the workshop's start-up. The title builds one renderer ahead of time on a detached
// canvas and the next scene adopts it; each scene still disposes its own renderer, so no state outlives a visit.
let warm: { canvas: HTMLCanvasElement; engine: Promise<Engine> } | undefined;
/** Compiles the next workshop renderer in the background. Safe to call repeatedly. */
export function prewarmWorkshopEngine(): void {
  if (warm) return;
  const canvas = workshopCanvas(), entry = { canvas, engine: createWorkshopEngine(canvas) };
  entry.engine.catch(() => { if (warm === entry) warm = undefined; });
  warm = entry;
}
/** Frees a renderer prepared but not adopted (a match is starting). */
export function releaseWorkshopEngine(): void {
  const entry = warm; warm = undefined;
  entry?.engine.then(engine => engine.dispose(), () => {});
}

export async function createWorkshopScene(host: HTMLElement, options: WorkshopSceneOptions): Promise<WorkshopScene> {
  const adopted = warm; warm = undefined;
  const canvas = adopted?.canvas ?? workshopCanvas();
  host.append(canvas);
  let engine: Engine | undefined, room: WorkshopRoom | undefined, mechanics: WorkshopMechanics | undefined;
  let atmosphere: ReturnType<typeof createWorkshopAtmospherics> | undefined;
  let textures: Awaited<ReturnType<typeof loadWorkshopTextures>> | undefined;
  let reflection: Awaited<ReturnType<typeof loadWorkshopReflection>> | undefined;
  const listeners = new AbortController();
  const liftControls = document.createElement('div'); liftControls.className = 'ws-lift-controls';
  liftControls.setAttribute('role', 'group'); liftControls.setAttribute('aria-label', 'Service lift controls'); host.append(liftControls);
  let observer: ResizeObserver | undefined, disposed = false, initializing = true, raf = 0;
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  let userReduced = options.reducedMotion, reduced = userReduced || media.matches;
  let graphics = options.graphics ?? currentSettings().graphics;
  let kit = { ...options.kit }, revision = 0, selected: SlotId | null = null, presentation = false;
  let goal = copyOrbit(HERO), orbit = reduced ? copyOrbit(HERO) : { ...copyOrbit(HERO), yaw: HERO.yaw + .28, distance: 9.2, pitch: .39 };
  const previewFraming = new WorkshopPreviewFraming();
  let intro = !reduced, elapsed = 0, last = performance.now();
  let paintBrush: PaintBrush | null = null, pendingAppearance: TankAppearance | null = null, lastPaintUpload = -1;
  let visibleAppearance: TankAppearance | null = null;
  const stop = () => {
    if (disposed) return;
    disposed = true; revision++; cancelAnimationFrame(raf); listeners.abort(); observer?.disconnect();
    options.signal?.removeEventListener('abort', abortLoading);
    const probe = window.__tmtWorkshop;
    if (probe && probe.engine === engine) probe.ready = false;
    atmosphere?.dispose(); mechanics?.dispose(); room?.dispose(); reflection?.dispose(); textures?.dispose(); engine?.dispose(); canvas.remove(); liftControls.remove();
  };
  // Unwind partial uploads before destroying the device so allocations share its final destroy flush.
  const abortLoading = () => { listeners.abort(); if (!initializing) stop(); };
  options.signal?.addEventListener('abort', abortLoading, { once: true });
  // Downloads and image/geometry decoding run while the engine compiles its pipelines; only GPU uploads wait for it.
  const signal = listeners.signal, fetchAsset = workshopAsset;
  const manifest = workshopManifest(signal);
  const roomData = manifest.then(m => loadWorkshopRoom(signal, m));
  const textureImages = manifest.then(m => m.textures?.length ? decodeWorkshopTextureImages(m.textures, { signal, fetch: fetchAsset,
    gaugeFace: m.gaugeFace ?? 'gauge-face.webp', surfaces: m.surfaces ?? WORKSHOP_SURFACE_TEXTURES }) : undefined);
  const probeImages = manifest.then(m => decodeWorkshopReflection({ signal, fetch: fetchAsset, faces: m.reflection?.faces }));
  // Decoded images not handed to an upload are released however loading ends.
  const release = () => { textureImages.then(images => images?.close(), () => {}); probeImages.then(faces => { for (const face of faces) face.close(); }, () => {}); };
  for (const pending of [roomData, textureImages, probeImages]) pending.catch(() => {});
  try {
    options.signal?.throwIfAborted();
    // A prepared renderer that failed or lost its device is replaced by a fresh one on the same canvas.
    const prepared = adopted && await adopted.engine.catch(() => undefined);
    if (prepared?.services.ctx.lost) prepared.dispose();
    engine = prepared && !prepared.services.ctx.lost ? prepared : await createWorkshopEngine(canvas, graphics);
    signal.throwIfAborted();
    if (!host.isConnected) throw new Error('Workshop closed while loading.');
    const data = await roomData;
    if (!host.isConnected) throw new Error('Workshop closed while loading.');
    const e = engine, sc = e.services.scene;
    sc.provide('interior', { ambient: [.19, .22, .24], background: [.004, .006, .008], fogColor: [.035, .045, .055], fogDensity: .0025, occluders: data.manifest.occluders ?? workshopOccluders(),
      fan: { center: [0, 4.22, -8.9], radius: 1.48, angle: 0, blades: 7, emitter: [0, 5.12, -10], strength: 48 } });
    const post = sc.get('post');
    if (post) Object.assign(post, { tonemap: 'neutral', autoExposure: false, grade: false, grain: .008, bloomStrength: .12, exposureEv: 0 });
    // Both uploads settle before a failure is reported, so stop() releases whatever either one created.
    const uploads = await Promise.allSettled([
      textureImages.then(images => images && data.manifest.textures?.length ? loadWorkshopTextures(e.services, data.manifest.textures, { signal, images }) : undefined).then(t => { textures = t; }),
      probeImages.then(images => loadWorkshopReflection(e.services, { signal, images })).then(r => { reflection = r; }),
    ]);
    for (const upload of uploads) if (upload.status === 'rejected') throw upload.reason;
    if (!host.isConnected) throw new Error('Workshop closed while loading.');
    room = new WorkshopRoom(sc, data);
    const picking = new RoomPickingGrid(data.meshes);
    let lastCameraOrbit = copyOrbit(orbit), resolvedCamera: CameraRig | undefined;
    const cameraRig = () => {
      const delta = Math.abs(orbit.yaw - lastCameraOrbit.yaw) + Math.abs(orbit.pitch - lastCameraOrbit.pitch)
        + Math.abs(orbit.distance - lastCameraOrbit.distance) + Math.abs((orbit.fovDegrees ?? 43) - (lastCameraOrbit.fovDegrees ?? 43))
        + orbit.target.reduce((sum, v, i) => sum + Math.abs(v - lastCameraOrbit.target[i]), 0);
      if (!resolvedCamera || delta > .0005) {
        lastCameraOrbit = copyOrbit(orbit);
        resolvedCamera = workshopCamera(orbit, (origin, direction, distance) => picking.distance(origin, direction, distance));
      }
      return resolvedCamera;
    };
    atmosphere = createWorkshopAtmospherics(e.services, data.manifest.steamVent, position => mechanics?.playSteam(position));
    mechanics = new WorkshopMechanics(sc, kit, { reducedMotion: reduced, audioVolume: options.audioVolume, audioSettings: options.audioSettings,
      onPhase: phase => {
        options.onStatus(phase);
        if (phase === 'Extracting the component' || phase === 'Checking the mounting') {
          const outlet = mechanics?.robot.steamOutlet;
          if (outlet) atmosphere?.release(outlet, mechanics!.robot.steamDirection, .4);
        }
      } });
    const m = mechanics, r = room, a = atmosphere;
    m.setPalette(options.palette);
    // Entering the workshop is a deliberate user action; browsers retain their autoplay permission gate.
    m.unlockAudio();
    const resize = () => { const rect = host.getBoundingClientRect(); if (rect.width && rect.height) e.resize(rect.width, rect.height, Math.min(2, devicePixelRatio)); };
    const applyGraphics = (next: GraphicsSettings) => { graphics = next; applyWorkshopGraphics(e.services, next); resize(); };
    applyGraphics(graphics);
    window.addEventListener(SETTINGS_EVENT, event => { const next = (event as CustomEvent<ProgressSettings>).detail?.graphics; if (next) applyGraphics(next); }, { signal: listeners.signal });
    resize(); observer = new ResizeObserver(resize); observer.observe(host);
    const applyMotion = () => { reduced = userReduced || media.matches; m.setReducedMotion(reduced); if (reduced) { intro = false; orbit = copyOrbit(goal); } };
    media.addEventListener('change', applyMotion, { signal: listeners.signal });
    const interact = () => { intro = false; m.unlockAudio(); };
    let heldLiftButton = -1;
    const stopLift = () => { heldLiftButton = -1; m.setLiftInput(0); };
    const liftButtons: HTMLButtonElement[] = [];
    for (const [direction, label] of [[1, 'Raise'], [-1, 'Lower']] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.id = `workshop-lift-${direction > 0 ? 'up' : 'down'}`;
      button.setAttribute('aria-label', `${label} lift - hold`); button.title = `Hold to ${label.toLowerCase()} lift`;
      button.addEventListener('pointerdown', event => {
        if (event.button !== 0 || m.state.busy) return;
        event.preventDefault(); event.stopPropagation(); button.focus({ preventScroll: true }); button.setPointerCapture(event.pointerId); interact(); heldLiftButton = direction > 0 ? 0 : 1; m.setLiftInput(direction);
      }, { signal: listeners.signal });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) button.addEventListener(type, stopLift, { signal: listeners.signal });
      button.addEventListener('keydown', event => {
        if (![' ', 'Enter'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); if (!event.repeat) { interact(); heldLiftButton = direction > 0 ? 0 : 1; m.setLiftInput(direction); }
      }, { signal: listeners.signal });
      button.addEventListener('keyup', event => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); stopLift(); } }, { signal: listeners.signal });
      liftControls.append(button); liftButtons.push(button);
    }
    window.addEventListener('blur', stopLift, { signal: listeners.signal });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopLift(); }, { signal: listeners.signal });
    const clearPreview = () => { m.clearPreview(); goal = previewFraming.end(goal); if (reduced) orbit = copyOrbit(goal); };
    const setView = (view: WorkshopView) => { interact(); previewFraming.forget(); goal = inspectionView(view); goal.target[1] += m.liftHeight; if (reduced) orbit = copyOrbit(goal); };
    const focus = (slot: SlotId) => { interact(); clearPreview(); selected = slot; m.highlight(presentation ? null : slot); goal = categoryView(slot, m.tank.categoryCenter(slot)); if (reduced) orbit = copyOrbit(goal); };
    const pick = (x: number, y: number) => {
      const rect = canvas.getBoundingClientRect(), ray = cameraRay(cameraRig(), x - rect.left, y - rect.top, rect.width, rect.height);
      const hit = m.tank.raycast(ray.origin, ray.direction);
      return hit && !picking.occludes(ray.origin, ray.direction, hit.distance) && !r.occludes(ray.origin, ray.direction, hit.distance) && !m.occludes(ray.origin, ray.direction, hit.distance) ? hit.slot : null;
    };
    const paintHit = (x: number, y: number) => {
      const rect = canvas.getBoundingClientRect(), ray = cameraRay(cameraRig(), x - rect.left, y - rect.top, rect.width, rect.height);
      const hit = m.tank.paintRaycast(ray.origin, ray.direction);
      return hit && !picking.occludes(ray.origin, ray.direction, hit.distance) && !r.occludes(ray.origin, ray.direction, hit.distance) && !m.occludes(ray.origin, ray.direction, hit.distance) ? hit : null;
    };
    let lastDab: PaintSurfaceHit | null = null;
    const stamp = (x: number, y: number, phase: 'start' | 'move') => {
      const hit = paintHit(x, y);
      if (phase === 'move' && hit && lastDab && hit.group === lastDab.group && hit.partId === lastDab.partId && Math.hypot(...hit.position.map((v, i) => v - lastDab!.position[i])) < (paintBrush?.radius ?? .1) * .3) return;
      lastDab = hit; options.onPaint?.(hit, phase);
    };
    const pointers = new Map<number, { x: number; y: number; startX: number; startY: number; moved: boolean; painting: boolean }>();
    canvas.addEventListener('contextmenu', event => event.preventDefault(), { signal: listeners.signal });
    canvas.addEventListener('pointerdown', ev => {
      if (ev.button !== 0 && ev.button !== 2 && ev.button !== 1) return;
      interact(); host.focus({ preventScroll: true }); canvas.setPointerCapture(ev.pointerId);
      const painting = !!paintBrush && ev.button === 0 && !ev.altKey && !ev.shiftKey && ev.pointerType !== 'touch' && !m.state.busy;
      if (!painting) m.highlight(null);
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, startX: ev.clientX, startY: ev.clientY, moved: false, painting });
      if (painting) { ev.preventDefault(); goal = copyOrbit(orbit); lastDab = null; stamp(ev.clientX, ev.clientY, 'start'); }
      if (pointers.size > 1) for (const p of pointers.values()) p.moved = true;
    }, { signal: listeners.signal });
    canvas.addEventListener('pointermove', ev => {
      const p = pointers.get(ev.pointerId);
      if (p) {
        if (p.painting) { if (paintBrush) stamp(ev.clientX, ev.clientY, 'move'); p.moved = true; return; }
        const other = [...pointers.entries()].find(([id]) => id !== ev.pointerId)?.[1];
        if (other) {
          const oldDistance = Math.hypot(p.x - other.x, p.y - other.y), nextDistance = Math.hypot(ev.clientX - other.x, ev.clientY - other.y);
          if (nextDistance > 5) goal.distance = Math.max(2, Math.min(11, goal.distance * oldDistance / nextDistance));
        } else {
          goal.yaw -= (ev.clientX - p.x) * .005; goal.pitch = Math.max(.03, Math.min(1.4, goal.pitch + (ev.clientY - p.y) * .005));
        }
        p.moved ||= Math.hypot(ev.clientX - p.startX, ev.clientY - p.startY) > 5;
        p.x = ev.clientX; p.y = ev.clientY; if (reduced) orbit = copyOrbit(goal);
      } else if (!m.state.busy) { const slot = paintBrush ? null : pick(ev.clientX, ev.clientY); m.highlight(paintBrush || presentation ? null : slot ?? selected); canvas.style.cursor = paintBrush ? 'crosshair' : slot ? 'pointer' : 'grab'; }
    }, { signal: listeners.signal });
    const end = (ev: PointerEvent) => {
      const p = pointers.get(ev.pointerId); pointers.delete(ev.pointerId);
      if (p?.painting) { options.onPaint?.(null, 'end'); lastDab = null; }
      if (!paintBrush && ev.type === 'pointerup' && p && !p.painting && !p.moved && !m.state.busy) { const slot = pick(ev.clientX, ev.clientY); if (slot) options.onSelect(slot); }
      if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    };
    canvas.addEventListener('pointerup', end, { signal: listeners.signal }); canvas.addEventListener('pointercancel', end, { signal: listeners.signal });
    canvas.addEventListener('pointerleave', () => { if (!pointers.size) m.highlight(presentation ? null : selected); }, { signal: listeners.signal });
    canvas.addEventListener('wheel', ev => {
      ev.preventDefault(); interact(); goal.distance = Math.max(2, Math.min(11, goal.distance * Math.exp(ev.deltaY * .001))); if (reduced) orbit = copyOrbit(goal);
    }, { passive: false, signal: listeners.signal });
    host.addEventListener('keydown', ev => {
      if ((ev.target as HTMLElement).closest('button')) return;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'r', 'R', 'Home'].includes(ev.key)) return;
      ev.preventDefault(); ev.stopPropagation(); interact();
      if (ev.key === 'ArrowLeft') goal.yaw -= .13;
      if (ev.key === 'ArrowRight') goal.yaw += .13;
      if (ev.key === 'ArrowUp') goal.pitch = Math.min(1.4, goal.pitch + .10);
      if (ev.key === 'ArrowDown') goal.pitch = Math.max(.03, goal.pitch - .10);
      if (ev.key === '+' || ev.key === '=') goal.distance = Math.max(2, goal.distance - .4);
      if (ev.key === '-') goal.distance = Math.min(11, goal.distance + .4);
      if (['r', 'R', 'Home'].includes(ev.key)) { previewFraming.forget(); goal = copyOrbit(HERO); goal.target[1] += m.liftHeight; }
      if (reduced) orbit = copyOrbit(goal);
    }, { signal: listeners.signal });
    const probe: WorkshopProbe = {
      ready: false, frames: 0, error: null, engine: e,
      get busy() { return m.state.busy; }, get phase() { return m.state.phase; }, get progress() { return m.state.progress; },
      get liftHeight() { return m.liftHeight; }, setLiftInput: direction => m.setLiftInput(direction),
      captureAudio: () => m.captureAudio(),
      paintTarget: (x, y) => paintHit(x, y),
      get appearance() { return visibleAppearance ? structuredClone(visibleAppearance) : null; },
      get kit() { return { ...kit }; }, get camera() { return cameraRig(); },
      get components() {
        const rect = canvas.getBoundingClientRect();
        return Object.fromEntries(KIT_SLOTS.map(slot => { const p = e.project(m.tank.categoryCenter(slot)); return [slot, { ...p, x: p.x + rect.left, y: p.y + rect.top }]; }));
      },
      get resourceCounts() { return { roomTriangles: r.triangles, textureBytes: textures?.bytes ?? 0, vram: e.telemetry().vram, draws: e.telemetry().draws }; },
      setView, shaderCheck: () => e.shaderCheck(),
      snapshot() { return { ready: this.ready, frames: this.frames, error: this.error, busy: this.busy, phase: this.phase, progress: this.progress, kit: this.kit, camera: this.camera, reducedMotion: reduced, liftHeight: this.liftHeight, robot: m.robot.pose, atmosphere: a.snapshot(), audio: m.audioSnapshot(), resources: this.resourceCounts, telemetry: e.telemetry() }; },
    };
    window.__tmtWorkshop = probe;
    e.onLost(() => { if (!disposed) { probe.error = 'Graphics device lost. Leave and reopen the workshop.'; options.onStatus(probe.error); probe.ready = false; } });
    last = performance.now();
    const tick = (now: number) => {
      if (disposed) return;
      try {
        const dt = Math.min(.05, Math.max(0, (now - last) / 1000)); last = now; elapsed += dt;
        if (!document.hidden) {
          orbit = reduced ? copyOrbit(goal) : easeOrbit(orbit, goal, 1 - Math.exp(-dt * (intro ? 2.4 : 8)));
          if (intro && elapsed > 1.65) { intro = false; options.onStatus('Service bay ready - select a component or drag to explore.'); }
          const camera = cameraRig();
          m.setAudioListener(camera.position, camera.target);
          m.update(dt, elapsed); r.update(m.state.liftOffset, elapsed, reduced); a.update(dt, elapsed, reduced || graphics.hazeQuality === 0);
          m.tank.animate(elapsed, reduced || m.state.busy || !!paintBrush);
          if (pendingAppearance && elapsed - lastPaintUpload >= .08) { m.setAppearance(pendingAppearance); pendingAppearance = null; lastPaintUpload = elapsed; }
          e.frame({ time: elapsed, dt, camera: cameraRig(), sun: { dirToward: [0, 1, 0], illuminance: 0 }, moon: { dirToward: [0, 1, 0], illuminance: 0 }, focus: { world: [...orbit.target], tilt: 0, distance: orbit.distance }, pendingCuts: [] });
          const controlsPoint = e.project(WORKSHOP_LIFT_CONTROL_POINT);
          liftControls.style.left = `${controlsPoint.x}px`; liftControls.style.top = `${controlsPoint.y}px`;
          liftControls.hidden = !controlsPoint.visible || cameraRig().position[2] <= WORKSHOP_LIFT_CONTROL_POINT[2] + .025;
          liftControls.setAttribute('aria-label', m.state.busy ? 'Service lift - automatic positioning' : `Service lift - ${Math.round(m.liftHeight * 100)} centimeters above base`);
          for (const [index, button] of liftButtons.entries()) {
            const p = e.project(LIFT_BUTTON_POINTS[index]);
            button.style.left = `${p.x - controlsPoint.x}px`; button.style.top = `${p.y - controlsPoint.y}px`;
            button.disabled = m.state.busy || (index === 0 ? m.liftHeight >= WORKSHOP_LIFT_MAX - .0001 : m.liftHeight <= .0001);
            r.setLiftButtonState(index, !button.disabled && !liftControls.hidden && button.matches(':hover,:focus-visible'), !button.disabled && heldLiftButton === index);
          }
          probe.frames++; probe.ready = probe.frames > 8 && !probe.error;
        }
        raf = requestAnimationFrame(tick);
      } catch (error) { probe.error = String(error); probe.ready = false; options.onStatus(`Workshop stopped: ${error}`); }
    };
    raf = requestAnimationFrame(tick); initializing = false;
    return {
      setKit(ids) { if (disposed) return; revision++; clearPreview(); kit = { ...ids }; m.setLoadout(kit); },
      setPreview(slot, id) {
        if (disposed) return;
        if (id) {
          m.preview(replacementKit(kit, slot, id), slot);
          goal = previewFraming.begin(goal, host.clientWidth < 600);
          if (reduced) orbit = copyOrbit(goal);
        } else clearPreview();
      }, focus,
      async install(slot, id, settings = {}) {
        if (disposed) return false;
        const next = fitPart(kit, slot, id, settings.sandbox ? Infinity : settings.budget); if (next[slot] !== id || kit[slot] === id) return false;
        const token = ++revision; interact(); const ok = await m.install(next, slot, settings);
        if (disposed || token !== revision || !ok) return false;
        kit = { ...next }; clearPreview();
        if (selected === slot) { goal.target = categoryView(slot, m.tank.categoryCenter(slot)).target; if (reduced) orbit = copyOrbit(goal); }
        return true;
      },
      setLiftInput(direction) { if (!disposed) { interact(); m.setLiftInput(direction); } }, get liftHeight() { return m.liftHeight; },
      setAudioSettings(settings) { if (!disposed) m.setAudioSettings(settings); },
      setGraphicsSettings(settings) { if (!disposed) applyGraphics(settings); },
      cancelInstall() { revision++; m.cancel(); clearPreview(); }, setPalette(palette) { if (!disposed) m.setPalette(palette); },
      setAppearance(appearance) { visibleAppearance = appearance; pendingAppearance = appearance; },
      setPaintMode(brush) { paintBrush = brush; m.highlight(brush || presentation ? null : selected); canvas.style.cursor = brush ? 'crosshair' : 'grab'; },
      setPresentation(value) { presentation = value; m.highlight(value || paintBrush ? null : selected); },
      clearSelection() {
        const framedComponent = selected !== null || previewFraming.active;
        // Closing the drawer keeps its pending Install/Discard action and trolley candidate available.
        // Only its inspection framing is dismissed here; setPreview(null) owns actual preview removal.
        goal = previewFraming.end(goal); selected = null; m.highlight(null);
        if (framedComponent) goal = centeredTankView(goal, m.liftHeight);
        if (reduced) orbit = copyOrbit(goal);
      },
      setReducedMotion(value) { userReduced = value; if (!disposed) applyMotion(); }, setView, dispose: stop,
    };
  } catch (error) { stop(); release(); throw error; }
}
