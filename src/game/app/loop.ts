/** The rAF loop (split from main.ts): steps the session with the dt cap and the hook time scale, updates and
 * renders the view, gives FrameInfo to the GameHooks, and refreshes the HUD every 100 ms. */
import type { DriveInput } from '../contracts';
import type { AimTargetCollider } from '../rules/aim-target';
import { FIXED_DT } from '../simulation';
import type { GameView } from '../view';
import type { GameSession } from './session';
import { combinedTimeScale, dispatchFrame, hasFrameHooks } from './hooks';
import type { RenderBenchLoop } from './render-bench';

/** The longest wall-clock frame simulated in real time (20 fps); slower frames dilate time. */
export const MAX_SIM_FRAME = 3 * FIXED_DT;
/** Warm-up frames the GPU completes once the renderer reports its one-time match work done, before the match is shown. */
export const WARM_SETTLE_FRAMES = 2;
/** A warm-up that has not settled by then hands the match over anyway. */
export const WARM_LIMIT_MS = 4000;

export interface LoopShell {
  modalOpen(): boolean; driveInput(): DriveInput; fullPreview(): boolean;
  aimTargetCollider?(): AimTargetCollider | undefined;
  /** An independent full-screen scene owns the GPU while the world is hidden. */
  worldVisible?(): boolean;
  syncActive(): void; updateHud(): void; updateWorldIndicators?(): void; tickToast(now: number): void; diagnostics(): void;
}

/** The renderer has done its one-time match work: a full SDF build, no pipeline compiling, the water solved and filled
 * (or there is none to fill). */
export function rendererWarm(view: Pick<GameView, 'visibilityDebug' | 'fluidsDebug' | 'devControls'>): boolean {
  const parts = rendererWarmParts(view);
  return parts.sdf && parts.fluids && parts.compile;
}
/** rendererWarm's three conditions apart (the warm-up's breakdown). */
export function rendererWarmParts(view: Pick<GameView, 'visibilityDebug' | 'fluidsDebug' | 'devControls'>): { sdf: boolean; fluids: boolean; compile: boolean } {
  const visibility = view.visibilityDebug().stats(), fluids = view.fluidsDebug().stats(), compile = view.devControls().compileStats();
  return { sdf: !visibility.sdf || visibility.sdfValid, fluids: !fluids || (fluids.solves > 0 && (fluids.ready || fluids.basins === 0)),
    compile: !compile || compile.pending === 0 };
}

export function startLoop(game: GameSession, view: GameView, shell: LoopShell): void {
  let lastFrame = 0, lastHud = 0, lastBenchRender = 0, warmSince = 0, warmFrames = 0, warmInFlight = false;
  let warmTrace = { sdfMs: -1, fluidsMs: -1, compileMs: -1, frames: 0 };
  const resetClock = () => { lastFrame = performance.now(); };
  game.on('ready', resetClock);
  game.on('warming', () => { warmSince = performance.now(); warmFrames = 0; warmTrace = { sdfMs: -1, fluidsMs: -1, compileMs: -1, frames: 0 }; });
  // No frame runs in a hidden tab: a match warming there is handed over as it is.
  document.addEventListener('visibilitychange', () => { resetClock(); if (document.hidden && game.warming) game.endWarmup(); });
  /** The match exists but is not shown yet: its tick-0 snapshot is rendered with no time passing (no simulation step,
   * no hooks, no HUD), so the renderer's one-time work runs behind the loading screen and every presentation clock
   * starts where it would have without it. The loading screen hides the canvas, so nothing paces these frames: each
   * waits for the GPU to finish the one before, or the GPU queue would grow and drain on the first frame of play. The
   * match is handed over with the GPU idle. The fixed-step render bench paces every frame from ready itself. */
  function warm(now: number, bench: RenderBenchLoop | undefined): void {
    const state = game.snapshot;
    if (!state || bench?.stepSeconds !== undefined || now - warmSince > WARM_LIMIT_MS) { game.endWarmup(); return; }
    if (warmInFlight) return;
    if (warmFrames >= WARM_SETTLE_FRAMES) { game.endWarmup(); return; }
    const observer = game.observer, fullPreview = shell.fullPreview();
    view.update(state, observer, 0, () => game.previewPrediction(observer, fullPreview, shell.aimTargetCollider?.()),
      fullPreview, game.interpolation(), game.setup?.mode === 'drive');
    view.render(0);
    const parts = rendererWarmParts(view), at = performance.now() - warmSince;
    warmTrace.frames++;
    for (const k of ['sdf', 'fluids', 'compile'] as const) { const key = `${k}Ms` as const; if (parts[k] ? warmTrace[key] < 0 : true) warmTrace[key] = parts[k] ? at : -1; }
    game.noteWarm({ ...warmTrace });
    warmFrames = parts.sdf && parts.fluids && parts.compile ? warmFrames + 1 : 0;
    warmInFlight = true;
    const done = () => { warmInFlight = false; };
    view.terrainHost.device.queue.onSubmittedWorkDone().then(done, done);
  }
  function frame(now: number): void {
    const bench = typeof window === 'undefined' ? undefined : (window as unknown as { __tmtRenderBench?: RenderBenchLoop }).__tmtRenderBench;
    if (bench && game.ready && !bench.beforeFrame()) { lastFrame = now; requestAnimationFrame(frame); return; }
    const elapsed = lastFrame ? now - lastFrame : 16.67;
    lastFrame = now;
    const dt = bench?.stepSeconds ?? Math.min(.1, elapsed / 1000);
    if (!document.hidden && game.ready && game.snapshot) {
      const paused = shell.modalOpen() && !game.network;
      let simDt = 0;
      game.setPaused(paused);
      if (!paused) {
        // Local overload must not turn one expensive frame into many catch-up ticks on every following frame: the
        // match keeps real time down to 20 fps (3 ticks per frame) and only dilates below it, discarding the excess
        // wall time instead of accumulating a feedback loop.
        simDt = Math.min(dt, game.realtime ? 6 * FIXED_DT : MAX_SIM_FRAME) * combinedTimeScale() * (bench?.simulationScale ?? 1);
        game.command(game.observer, { k: 'drive', ...shell.driveInput() });
        game.step(simDt);
      }
      const state = game.snapshot;
      if (state && (shell.worldVisible?.() ?? true)) {
        if (state.phase === 'finished') game.settleWrecks(dt);
        shell.syncActive();
        const observer = game.observer, fullPreview = shell.fullPreview();
        view.update(state, observer, dt, () => game.previewPrediction(observer, fullPreview, shell.aimTargetCollider?.()),
          fullPreview, game.interpolation(), game.setup?.mode === 'drive');
        bench?.beforeRender();
        if (hasFrameHooks()) dispatchFrame({ realDt: dt, simDt, snapshot: state, camera: view.cameraRig(), focus: [...state.tanks[observer].position] });
        view.render(bench ? dt * 1000 : elapsed);
        shell.updateWorldIndicators?.();
        if (bench) {
          bench.afterFrame(lastBenchRender ? now - lastBenchRender : elapsed);
          lastBenchRender = now;
        }
        if (now - lastHud > 100) { shell.updateHud(); lastHud = now; shell.diagnostics(); }
      } else view.idle();
    } else if (!document.hidden && game.warming) warm(now, bench);
    else view.idle();
    shell.tickToast(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
