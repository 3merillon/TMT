/**
 * APPEND-ONLY Presenter registry (plan §5.5): how W2+ presentation features plug into the frozen GameView facade.
 * Add one line per presenter factory, tagged `// <STREAM-ID>`; conflicts resolve by union.
 *
 * The facade (view.ts) installs every presenter after the engine starts, in registration order, then per frame:
 *   onGameEvent(e, s)            for every game event (after the built-in presentation handled it)
 *   onUpdate(s, dt, interp?)     after the built-in tank/shell/label update
 *   frameInput(input, s)         just before engine.frame: adjust camera, focus, sun, pending cuts (registration order)
 * Presenters own their engine resources (scene.meshes / instances / lights / facets) and free them in dispose().
 * Presentation never feeds the simulation (N5).
 */
import type { CameraRig, Engine, FrameInput, SceneRegistry } from '../../engine';
import type { SimInterpolation } from '../api/extensions';
import type { GameEvent, GameSnapshot, V3, WorldQuery } from '../contracts';
import { fluidPresenter } from './fluid-presenter';
import type { WaterHull } from '../../engine/passes/fluids/water';

export interface ViewServices {
  engine: Engine;
  scene: SceneRegistry;
  worldToScreen(p: V3): [number, number] | null;
  camera(): CameraRig;
  addCameraConstraint(fn: (position: V3, target: V3) => V3): () => void;
  world(): WorldQuery | undefined;
  /** Cosmetic rigid bodies at their displayed poses, after the debris worker update. */
  debrisWaterHulls?(): readonly WaterHull[];
  /** W1 additive: the observed tank id (the follow camera's subject). */
  observer(): number;
  /** W1 additive: add camera shake (0..1, decays in about a second). */
  addTrauma(amount: number): void;
}

export interface Presenter {
  readonly name: string;
  install(v: ViewServices): void | Promise<void>;
  onGameEvent?(e: GameEvent, s: GameSnapshot): void;
  onUpdate?(s: GameSnapshot, dt: number, interp?: SimInterpolation): void;
  reset?(): void;
  /** Adjust camera/focus/sun/pending cuts (timeScale-free presentation), in registration order. */
  frameInput?(input: FrameInput, s: GameSnapshot | undefined): void;
  dispose?(): void;
}

export const PRESENTERS: (() => Presenter)[] = [
  /* append-only */
  () => fluidPresenter(), // FLUIDS
];
