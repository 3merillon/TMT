/** Bootstrap only: mounts the shell, the view and the match session, hands the front end (ui/controller.ts) the
 * flow, then starts the frame loop once the renderer is warm. The plain URL boots to the title; ?mode / ?seed deep
 * links start a match straight away. Match logic lives in app/, DOM behaviour in ui/, presentation in view.ts. */
import './game.css';
import { GameView } from './view';
import { GameSession } from './app/session';
import { devFlags } from './app/dev-flags';
import { startLoop } from './app/loop';
import { installTelemetry } from './app/telemetry';
import { installDevPanel } from './app/dev-panel';
import './app/composition';
import { element, renderShell } from './ui/dom';
import { UiController } from './ui/controller';
import { parseLaunch } from './ui/launch';
import { bindGameBrowserInput } from './ui/input/browser';

const unbindBrowserInput = bindGameBrowserInput(window);
if (import.meta.hot) import.meta.hot.dispose(unbindBrowserInput);
performance.mark('tmt:modules-ready');
const bootStarted = performance.now();
const launch = parseLaunch(location.search);
const root = renderShell();
const view = new GameView(element('viewport'));
const game = new GameSession(view, launch.deepLink?.mode ?? devFlags.mode);
view.setDevSightQuery((observer, target) => game.devCanSee(observer, target));
const residentDiagnostics = installTelemetry(game, view);
performance.measure('tmt:shell-and-view', { start: bootStarted });
if (new URLSearchParams(location.search).has('renderbench')) {
  const { installRenderBench } = await import('./app/render-bench');
  installRenderBench(game, view);
}
let removeDevPanel: (() => void) | undefined, panelMode = '';
function syncDevPanel(screen = 'boot'): void {
  const params = new URLSearchParams(location.search);
  const mode = params.has('renderbench') ? '' : params.get('mode') === 'dev' && screen === 'match' ? 'playground' : params.has('dev') ? 'diagnostics' : '';
  if (mode === panelMode) return;
  removeDevPanel?.(); removeDevPanel = undefined; panelMode = mode;
  if (mode) removeDevPanel = installDevPanel(view, { blast: (radius, munition) => game.devBlast(radius, munition), placeTank: () => game.devPlaceTank(),
    selectMunition: id => game.command(game.observer, { k: 'munition', id }),
    selectedMunition: () => game.snapshot?.tanks.find(tank => tank.id === game.observer)?.munition });
}
window.addEventListener('tmt:navigation', event => syncDevPanel((event as CustomEvent).detail.screen));
syncDevPanel();
const ui = new UiController({ root, game, view, launch });
view.onDeviceLost(() => { game.invalidate(); ui.fatal('The graphics device disconnected. Reload the game to reconnect to WebGPU.'); });

const rendererStarted = performance.now();
const warm = view.initialize().then(() => { performance.measure('tmt:renderer-initialize', { start: rendererStarted }); });
ui.boot(warm);
// Not a top-level await: lazily imported screens (the workshop) depend on this entry chunk, and would wait for the
// whole renderer warm-up before their import resolved.
warm.then(() => startLoop(game, view, ui.loopShell(residentDiagnostics))).catch(error => {
  game.invalidate();
  ui.fatal(error instanceof Error ? error.message : String(error));
  console.error(error);
});
