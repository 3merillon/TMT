/**
 * Engine sandbox (dev only): `dev/engine-sandbox.html?scene=test&gbuffer=<view>&tier=high`.
 * Loads `./<scene>-scene.ts`, runs the engine on the full-window canvas with a mouse orbit camera (drag = orbit,
 * wheel = zoom) and exposes `window.__tmtEngineSandbox` for the capture harness.
 */
import type { CameraRig, GBufferView, QualityTier, Vec3 } from '../contracts';
import { mipSmokeModule } from '../debug/mip-smoke';
import { shadowSmokeModule } from '../debug/shadow-smoke';
import { Engine } from '../engine';
import { RENDER_MODULES } from '../modules';
import type { ImageStats, StatsRect } from '../debug/image-stats';
import type { OrbitPreset, SandboxScene, SceneFactory } from './scene-types';
import { surfaceFrame } from './geometry';

interface SandboxApi {
  ready: boolean;
  error: string | null;
  scene: string;
  engine: Engine | null;
  frames: number;
  lostEvents: number;
  camera: string;
  imageStats(rect?: StatsRect): Promise<ImageStats>;
  telemetry(): unknown;
  setCamera(name: string): string;
  setGBufferView(view: GBufferView): void;
  setSize(width: number, height: number): void;
  resetSize(): void;
  shaderCheck(): Promise<unknown>;
}

declare global { interface Window { __tmtEngineSandbox?: SandboxApi } }

const SCENES = import.meta.glob<{ default: SceneFactory }>('./*-scene.ts');
const GBUFFER_VIEWS: readonly GBufferView[] = ['none', 'albedo', 'normal', 'geonormal', 'material', 'ids', 'velocity', 'depth'];
const TIERS: readonly QualityTier[] = ['low', 'medium', 'high', 'ultra'];

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('engine-canvas') as HTMLCanvasElement;
const status = document.getElementById('sandbox-status') as HTMLDivElement;

const api: SandboxApi = {
  ready: false, error: null, scene: params.get('scene') ?? 'test', engine: null, frames: 0, lostEvents: 0, camera: '',
  imageStats: () => Promise.reject(new Error('engine not ready')),
  telemetry: () => null,
  setCamera: () => '',
  setGBufferView: () => undefined,
  setSize: (w, h) => { canvas.style.width = `${w}px`; canvas.style.height = `${h}px`; },
  resetSize: () => { canvas.style.width = ''; canvas.style.height = ''; },
  shaderCheck: () => Promise.reject(new Error('engine not ready')),
};
window.__tmtEngineSandbox = api;

function fail(message: string): void {
  api.error = message;
  status.textContent = message;
  status.dataset.error = 'true';
}

type V3 = [number, number, number];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: readonly number[], b: readonly number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: readonly number[], s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: readonly number[]): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

class OrbitCamera {
  yaw = 0; pitch = 0.5; distance = 17; target: V3 = [0, 0, 0]; fovY = 47 * Math.PI / 180;
  constructor(private readonly focus: Vec3) { this.target = [...focus]; }

  apply(p: OrbitPreset): void {
    this.target = [...(p.target ?? this.focus)];
    this.distance = p.distance; this.yaw = p.yaw; this.pitch = p.pitch;
    if (p.fovY) this.fovY = p.fovY;
  }

  rig(): CameraRig {
    const { u, t, b } = surfaceFrame(this.focus);
    const cp = Math.cos(this.pitch);
    const dir = add(scale(add(scale(t, Math.cos(this.yaw)), scale(b, Math.sin(this.yaw))), cp), scale(u, Math.sin(this.pitch)));
    const position = add(this.target, scale(dir, this.distance));
    // Up: the local radial up, made orthogonal to the view direction (stable at any pitch below 90°).
    const fwd = norm(sub(this.target, position));
    const right = norm(cross(fwd, u));
    const up = cross(right, fwd);
    return { position, target: [...this.target], up, fovY: this.fovY };
  }
}

async function main(): Promise<void> {
  const loader = SCENES[`./${api.scene}-scene.ts`];
  if (!loader) { fail(`unknown scene "${api.scene}" (have: ${Object.keys(SCENES).map(k => k.slice(2, -9)).join(', ')})`); return; }
  const factory = (await loader()).default;
  const scene: SandboxScene = factory(params);
  const gview = (params.get('gbuffer') ?? 'none') as GBufferView;
  if (!GBUFFER_VIEWS.includes(gview)) { fail(`unknown gbuffer view "${gview}"`); return; }
  const tierParam = params.get('tier') ?? 'high';
  const tier = (TIERS as readonly string[]).includes(tierParam) ? tierParam as QualityTier : 'high';

  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * devicePixelRatio));
  canvas.height = Math.max(1, Math.round(rect.height * devicePixelRatio));
  const engine = await Engine.create({
    canvas, tier, dev: true, settings: { gbufferView: gview },
    modules: [...RENDER_MODULES, () => shadowSmokeModule(), () => mipSmokeModule(), () => scene.module],
  });
  api.engine = engine;
  engine.resize(rect.width, rect.height, devicePixelRatio);
  new ResizeObserver(entries => {
    const r = entries[0].contentRect;
    engine.resize(r.width, r.height, devicePixelRatio);
  }).observe(canvas);

  const orbit = new OrbitCamera(scene.focus);
  const setCamera = (name: string): string => {
    const preset = scene.cameras[name];
    if (!preset) throw new Error(`unknown camera "${name}" (have: ${Object.keys(scene.cameras).join(', ')})`);
    orbit.apply(preset);
    api.camera = name;
    return name;
  };
  setCamera(params.get('camera') ?? scene.defaultCamera);

  let dragging: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', e => { dragging = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    orbit.yaw -= (e.clientX - dragging.x) * 0.005;
    orbit.pitch = Math.min(1.45, Math.max(-0.2, orbit.pitch + (e.clientY - dragging.y) * 0.005));
    dragging = { x: e.clientX, y: e.clientY };
  });
  const endDrag = () => { dragging = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', e => { e.preventDefault(); orbit.distance = Math.min(120, Math.max(2, orbit.distance * Math.exp(e.deltaY * 0.001))); }, { passive: false });

  api.imageStats = r => engine.imageStats(r);
  api.telemetry = () => engine.telemetry();
  api.setCamera = setCamera;
  api.setGBufferView = v => { engine.services.settings.gbufferView = v; };
  api.shaderCheck = () => engine.shaderCheck();

  let running = true;
  engine.onLost(() => { api.lostEvents++; running = false; status.textContent = 'device lost'; });

  // ?spin=<rad/s>: auto-orbit (camera motion for the velocity view and TAA work).
  const spin = Number(params.get('spin') ?? 0) || 0;
  const start = performance.now();
  let last = start;
  const tick = (now: number) => {
    if (!running) return;
    const time = (now - start) / 1000;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    orbit.yaw += spin * dt;
    scene.update?.(time, dt);
    engine.frame({
      time, dt, camera: orbit.rig(), sun: scene.sun ? { dirToward: scene.sun } : undefined,
      focus: { world: [...scene.focus], tilt: 0.5, distance: orbit.distance }, pendingCuts: [],
    });
    api.frames++;
    if (!api.ready && api.frames >= 10) api.ready = true;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

main().catch(error => {
  console.error('[sandbox] failed to start', error);
  fail(`sandbox failed: ${error instanceof Error ? error.message : String(error)}`);
});
