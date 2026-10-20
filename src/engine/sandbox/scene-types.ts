/**
 * Sandbox scene contract (dev only). A scene file `src/engine/sandbox/<name>-scene.ts` default-exports a SceneFactory;
 * `dev/engine-sandbox.html?scene=<name>` loads it. W1+ streams add their own scene files next to test-scene.ts without
 * touching main.ts.
 */
import type { RenderModule, Vec3 } from '../contracts';

export interface OrbitPreset {
  /** Orbit target; default the scene focus. */
  target?: Vec3;
  distance: number;
  /** Radians around the focus's local up (0 = along the tangent T). */
  yaw: number;
  /** Radians above the local horizon. */
  pitch: number;
  fovY?: number;
}

export interface SandboxScene {
  readonly name: string;
  readonly module: RenderModule;
  /** Point the orbit camera revolves around (on the planet surface). */
  readonly focus: Vec3;
  /** Direction toward the sun. */
  readonly sun?: Vec3;
  /** Camera presets: at least boom6, boom17, boom36 and overview. */
  readonly cameras: Record<string, OrbitPreset>;
  readonly defaultCamera: string;
  /** Per-frame animation (seconds). */
  update?(time: number, dt: number): void;
}

export type SceneFactory = (params: URLSearchParams) => SandboxScene;
