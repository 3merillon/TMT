/**
 * Kit sandbox scene (dev only, W1-KIT): `dev/kit.html` → scripts/kit/kit-page.ts builds the tanks with the kit and
 * hands this module plain render data (the engine never imports src/game). It draws them through the W0
 * part-mesh path (`scene.meshes` / `scene.instances`) on a studio plate on the planet, draws validator
 * overlaps as red boxes, runs an orbit camera and exposes `window.__tmtKit = { ready, overlaps, ... }`.
 *
 * Studio frame: tanks are placed in plate-local coordinates (x right, y up, z forward) on a flat plate
 * tangent to the planet at the focus; the tank root sits 0.5 above the plate (the kit's ground is y = −0.5).
 */
import { MATERIAL_CLASS } from '../contracts';
import type { CameraRig, MeshDesc, RenderModule, Vec3 } from '../contracts';
import { Engine } from '../engine';
import { RENDER_MODULES } from '../modules';
import { add3, boxMesh, fbm, mul4, norm, planetMesh, plateMesh, scale3, surfaceFrame } from './geometry';
import type { OrbitPreset } from './scene-types';

export interface KitScenePart {
  /** A PartMesh-compatible description (instances already posed for repeated parts). */
  mesh: MeshDesc;
  /** Joint transform in the tank frame (column-major); identity for repeated parts. */
  joint: Float32Array;
}
export interface KitSceneTank {
  label: string;
  /** Position on the studio plate (x, z) and heading (radians, about the plate's up). */
  at: [number, number];
  heading: number;
  tint: Vec3;
  parts: KitScenePart[];
  /** Validator overlaps at this pose: tank-frame boxes. */
  overlaps: { min: Vec3; max: Vec3 }[];
}
export interface KitSceneSetup {
  /** Optional dev fixture step; the scene stays independent of game simulation. */
  animate?: (engine: Engine, roots: Float32Array[], time: number, dt: number) => void;
  tanks: KitSceneTank[];
  /** Camera presets in the studio frame (target in plate coordinates). */
  cameras: Record<string, OrbitPreset & { targetLocal?: Vec3 }>;
  camera: string;
  /** Total validator overlaps across the scene (the capture probe). */
  overlaps: number;
  /** Extra data exposed on window.__tmtKit. */
  info?: Record<string, unknown>;
  /** Show DOM labels under the tanks. */
  labels?: boolean;
}

interface KitWindowApi { ready: boolean; overlaps: number; error: string | null; frames: number; tanks: number; info: Record<string, unknown>; engine: Engine | null }
declare global { interface Window { __tmtKit?: KitWindowApi } }

const RADIUS = 18;
const FOCUS_DIR = norm([0.32, 0.86, 0.4]);

/** Column-major studio transform: plate-local (x, y, z) → world. */
function studioMatrix(focus: Vec3): { m: Float32Array; u: Vec3; t: Vec3; b: Vec3 } {
  const { u, t, b } = surfaceFrame(focus);
  // Right-handed plate axes: x = t, y = u, z = t × u = b.
  const m = new Float32Array([t[0], t[1], t[2], 0, u[0], u[1], u[2], 0, b[0], b[1], b[2], 0, focus[0], focus[1], focus[2], 1]);
  return { m, u, t, b };
}

function tankRoot(studio: Float32Array, at: [number, number], heading: number): Float32Array {
  const c = Math.cos(heading), s = Math.sin(heading);
  const local = new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, at[0], 0.5, at[1], 1]);
  return mul4(studio, local);
}

function applyM(m: Float32Array, p: readonly number[]): Vec3 {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}

/** The render module for a kit scene. */
export function kitSceneModule(setup: KitSceneSetup): { module: RenderModule; focus: Vec3; studio: Float32Array; roots: Float32Array[] } {
  const focus = scale3(FOCUS_DIR, RADIUS) as Vec3;
  const { m: studio } = studioMatrix(focus);
  const roots = setup.tanks.map(t => tankRoot(studio, t.at, t.heading));
  const module: RenderModule = {
    name: 'sandbox.kit-scene',
    install(s) {
      const sc = s.scene;
      // Planet for horizon context, and a studio plate.
      const flat = (d: readonly number[]) => {
        const dist = Math.acos(Math.min(1, d[0] * FOCUS_DIR[0] + d[1] * FOCUS_DIR[1] + d[2] * FOCUS_DIR[2])) * RADIUS;
        const k = Math.min(1, Math.max(0, (dist - 9) / 6));
        return RADIUS - 0.02 + fbm(d, 3) * 0.6 * k * k;
      };
      const planet = sc.meshes.create(planetMesh(6, flat));
      sc.instances.add(planet, { model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), tint: [0.28, 0.36, 0.2], classId: MATERIAL_CLASS.TERRAIN, objectId: 1 });
      const plate = sc.meshes.create(plateMesh(0, 16));
      sc.instances.add(plate, { model: mul4(studio, new Float32Array([16, 0, 0, 0, 0, 1, 0, 0, 0, 0, 16, 0, 0, 0.004, 0, 1])), tint: [0.5, 0.47, 0.42], classId: MATERIAL_CLASS.STRUCTURE, objectId: 2 });
      // Tanks.
      const cache = new Map<MeshDesc, ReturnType<typeof sc.meshes.create>>();
      setup.tanks.forEach((tank, i) => {
        const root = roots[i];
        for (const part of tank.parts) {
          let h = cache.get(part.mesh);
          if (!h) { h = sc.meshes.create(part.mesh); cache.set(part.mesh, h); }
          sc.instances.add(h, { model: mul4(root, part.joint), tint: tank.tint, objectId: 10 + i, classId: MATERIAL_CLASS.METAL });
        }
      });
      // Overlap boxes (signal red, emissive matId 5).
      const red = sc.meshes.create(boxMesh(5, 'kit-overlap'));
      setup.tanks.forEach((tank, i) => {
        for (const o of tank.overlaps) {
          const c = [(o.min[0] + o.max[0]) / 2, (o.min[1] + o.max[1]) / 2, (o.min[2] + o.max[2]) / 2];
          const size = [Math.max(0.02, o.max[0] - o.min[0]), Math.max(0.02, o.max[1] - o.min[1]), Math.max(0.02, o.max[2] - o.min[2])];
          const local = new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, c[0], c[1], c[2], 1]);
          sc.instances.add(red, { model: mul4(roots[i], local), tint: [1, 0.05, 0.02], objectId: 1000, classId: MATERIAL_CLASS.EMISSIVE, castShadow: false });
        }
      });
      // A warm key light and a cool rim light near the studio.
      const { u, t, b } = surfaceFrame(focus);
      sc.lights.add({ type: 'point', position: add3(focus, add3(scale3(u, 4), add3(scale3(t, -5), scale3(b, 4)))), color: [1, 0.85, 0.7], intensity: 14, range: 16 });
      sc.lights.add({ type: 'point', position: add3(focus, add3(scale3(u, 3), add3(scale3(t, 6), scale3(b, -3)))), color: [0.6, 0.75, 1], intensity: 8, range: 14 });
    },
  };
  return { module, focus, studio, roots };
}

class Orbit {
  yaw = 0; pitch = 0.5; distance = 6; target: Vec3; fovY = 38 * Math.PI / 180;
  constructor(private readonly focus: Vec3, private readonly studio: Float32Array) { this.target = [...focus] as Vec3; }
  apply(p: OrbitPreset & { targetLocal?: Vec3 }): void {
    this.target = p.targetLocal ? applyM(this.studio, p.targetLocal) : [...(p.target ?? this.focus)] as Vec3;
    this.distance = p.distance; this.yaw = p.yaw; this.pitch = p.pitch;
    if (p.fovY) this.fovY = p.fovY;
  }
  rig(): CameraRig {
    // Studio axes: x = column 0, up = column 1, z = column 2 of the studio matrix.
    const s = this.studio, x: Vec3 = [s[0], s[1], s[2]], u: Vec3 = [s[4], s[5], s[6]], z: Vec3 = [s[8], s[9], s[10]];
    const cp = Math.cos(this.pitch);
    // yaw 0 looks from +z (the tanks' front) toward −z.
    const dir = add3(scale3(add3(scale3(z, Math.cos(this.yaw)), scale3(x, Math.sin(this.yaw))), cp), scale3(u, Math.sin(this.pitch)));
    const position = add3(this.target, scale3(dir, this.distance));
    const fwd = norm([this.target[0] - position[0], this.target[1] - position[1], this.target[2] - position[2]]);
    const right = norm([fwd[1] * u[2] - fwd[2] * u[1], fwd[2] * u[0] - fwd[0] * u[2], fwd[0] * u[1] - fwd[1] * u[0]]);
    const up: Vec3 = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    return { position, target: [...this.target] as Vec3, up, fovY: this.fovY };
  }
}

/** Boot the kit page: engine, scene, orbit camera, labels and window.__tmtKit. */
export async function bootKitScene(canvas: HTMLCanvasElement, setup: KitSceneSetup, status?: HTMLElement | null): Promise<KitWindowApi> {
  const api: KitWindowApi = { ready: false, overlaps: setup.overlaps, error: null, frames: 0, tanks: setup.tanks.length, info: setup.info ?? {}, engine: null };
  window.__tmtKit = api;
  try {
    const { module, focus, studio, roots } = kitSceneModule(setup);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * devicePixelRatio));
    canvas.height = Math.max(1, Math.round(rect.height * devicePixelRatio));
    const engine = await Engine.create({ canvas, tier: 'high', dev: true, modules: [...RENDER_MODULES, () => module] });
    api.engine = engine;
    engine.resize(rect.width, rect.height, devicePixelRatio);
    new ResizeObserver(entries => { const r = entries[0].contentRect; engine.resize(r.width, r.height, devicePixelRatio); }).observe(canvas);
    const orbit = new Orbit(focus, studio);
    orbit.apply(setup.cameras[setup.camera] ?? Object.values(setup.cameras)[0]);
    let drag: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      orbit.yaw -= (e.clientX - drag.x) * 0.005;
      orbit.pitch = Math.min(1.45, Math.max(-0.1, orbit.pitch + (e.clientY - drag.y) * 0.005));
      drag = { x: e.clientX, y: e.clientY };
    });
    const end = () => { drag = null; };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', e => { e.preventDefault(); orbit.distance = Math.min(80, Math.max(1, orbit.distance * Math.exp(e.deltaY * 0.001))); }, { passive: false });
    // Labels under each tank.
    const labels: HTMLDivElement[] = [], labelRoots = setup.tanks.map(t => tankRoot(studio, t.at, 0));
    if (setup.labels) for (const tank of setup.tanks) {
      const el = document.createElement('div');
      el.className = 'kit-label';
      el.textContent = tank.label;
      document.body.appendChild(el);
      labels.push(el);
    }
    const { u } = surfaceFrame(focus);
    const sun = norm(add3(scale3(u, 0.75), add3(scale3([studio[0], studio[1], studio[2]], -0.45), scale3([studio[8], studio[9], studio[10]], 0.5))));
    const start = performance.now();
    let last = start;
    const tick = (now: number) => {
      const time = (now - start) / 1000, dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      setup.animate?.(engine, roots, time, dt);
      engine.frame({ time, dt, camera: orbit.rig(), sun: { dirToward: [sun[0], sun[1], sun[2]] }, focus: { world: [...orbit.target] as Vec3, tilt: 0.5, distance: orbit.distance }, pendingCuts: [] });
      labels.forEach((el, i) => {
        // Anchored in the plate frame (not turned with the tank's heading), on the ground just in front of the tank.
        const p = engine.project(applyM(labelRoots[i], [0, -0.5, 1.12]));
        el.style.display = p.visible ? '' : 'none';
        el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, 0)`;
      });
      api.frames++;
      if (!api.ready && api.frames >= 12) api.ready = true;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    if (status) status.textContent = `${setup.tanks.length} tank(s) · validator overlaps: ${setup.overlaps}`;
  } catch (error) {
    api.error = error instanceof Error ? error.message : String(error);
    if (status) { status.textContent = `kit sandbox failed: ${api.error}`; status.dataset.error = 'true'; }
    console.error('[kit] failed to start', error);
  }
  return api;
}

/** dev/engine-sandbox.html?scene=kit is not the kit sandbox: the scene needs kit data, which dev/kit.html builds. */
const notHere = (): never => { throw new Error('the kit sandbox runs from dev/kit.html (scripts/kit/kit-page.ts)'); };
export default notHere;
