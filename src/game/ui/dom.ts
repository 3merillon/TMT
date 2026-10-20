/**
 * The play shell: the view host, the HUD (`.game-shell`, which capture --hide-ui hides), the screen layer, the
 * toast and the loading/error overlay. Static markup only; screens and HUD contents are built with components/el.
 *
 * The HUD keeps the world clear: edge chips at the top (tanks, phase, wind, menu), a match-info drawer opened from the
 * tank chip, the floating joystick zone (touch only) and the fire dock. `#game[data-input]` dresses the dock for touch
 * (thumb buttons, vertical power) or a mouse (compact panel with key hints); hud-layout.ts decides what each context shows.
 *
 * Ids other tools rely on: #viewport, #bearing/#elevation/#power (range inputs with 'input' listeners: the terrain
 * capture plan sets them), #fire, #phase-tag, #pause-open, #toast, #perf/#terrain-perf (capture probes), #loading(.error),
 * #loading-title, #loading-copy (the capture 'game' wait preset reports them on failure).
 */
import { MIN_BARREL_PITCH, MAX_BARREL_PITCH } from '../simulation';
import { byId } from './components/el';

const degrees = (radians: number) => Math.round(radians * 180 / Math.PI * 2) / 2;

export function renderShell(root: HTMLElement = document.querySelector<HTMLElement>('#game')!): HTMLElement {
  root.innerHTML = `
  <div class="canvas-host" id="viewport" tabindex="0" aria-label="Planetary battlefield"></div>
  <div class="game-shell" id="hud" hidden>
    <svg class="drag-guide" id="drag-guide" aria-hidden="true" hidden><line id="drag-line" x1="0" y1="0" x2="0" y2="0"/><circle id="drag-ring" r="10" cx="0" cy="0"/><text id="drag-text" x="0" y="0"></text></svg>
    <header class="hud-top">
      <button type="button" class="hud-chip roster hud-cover" id="roster" aria-expanded="false" aria-controls="match-info" aria-label="Match info: tanks, objective and wind"></button>
      <div class="hud-chip phase-chip hud-cover" id="banner" aria-live="polite">
        <span class="banner-turn" id="turn-number">TURN 01</span><span class="banner-tag" id="phase-tag">YOUR SHOT</span>
        <span class="aim-timer" id="aim-timer" title="Aim time left" hidden></span><span class="move-left" id="movement-left" hidden></span>
        <span class="phase-meter" id="move-meter" hidden><span id="move-progress"></span></span>
      </div>
      <div class="hud-chip wind-chip hud-cover" id="wind-chip" title="Wind"><span class="meta-icon" aria-hidden="true">≋</span><span id="wind">Calm</span></div>
      <button type="button" class="hud-round hud-cover" id="pause-open" title="Pause (Esc)" aria-label="Pause"><span aria-hidden="true" class="glyph-menu"></span></button>
    </header>
    <section class="match-info hud-cover" id="match-info" aria-label="Match info" hidden>
      <div class="info-head"><div><div class="eyebrow" id="info-turn">TURN 01</div><h2 class="info-title" id="turn-title">Find your angle.</h2></div>
        <button type="button" class="hud-round small" id="match-info-close" aria-label="Close match info">✕</button></div>
      <p class="info-detail" id="turn-detail"></p>
      <div class="info-roster" id="info-roster"></div>
      <dl class="info-facts"><div><dt>Objective</dt><dd id="objective">Last tank standing</dd></div><div><dt>Wind</dt><dd id="wind-detail">Calm</dd></div></dl>
    </section>
    <div class="stick-zone" id="stick-zone" aria-hidden="true" hidden><span class="stick-base hud-cover" id="stick-base"><span class="stick-needle" id="stick-needle" hidden></span><span class="stick-knob" id="stick-knob"></span></span></div>
    <div class="hud-bottom">
    <footer class="dev-bar" id="dev-bar" hidden>
      <div class="dev-buttons">
        <button type="button" id="drive-test" aria-pressed="false">Dev: Drive test</button>
        <button type="button" id="restart">↻ Reset test</button>
        <button type="button" id="vehicle-debug" aria-pressed="false">Vehicle debug: Off</button>
        <button type="button" id="surface-relief" aria-pressed="true">Surface relief: On</button>
      </div>
      <div class="telemetry"><div id="perf">INITIALIZING WEBGPU</div><div id="terrain-perf">TMT · PERSISTENT TERRAIN</div></div>
    </footer>
    <aside class="hud-dock" id="aim-panel" aria-label="Fire control">
      <div class="fine-aim paper hud-cover" id="fine-aim" hidden>
        <div class="panel-head"><span id="weapon-name">ARC MORTAR</span><span>Fine aim</span></div>
        <div class="munitions" id="munitions" role="radiogroup" aria-label="Ammunition"></div>
        <label class="aim-field"><span class="field-row"><span class="field-label">Bearing</span><output id="bearing-value">0°</output></span>
          <input class="range" id="bearing" type="range" min="-180" max="180" step="0.5" value="0" aria-label="Bearing"></label>
        <label class="aim-field"><span class="field-row"><span class="field-label">Elevation</span><output id="elevation-value">45°</output></span>
          <input class="range" id="elevation" type="range" min="${degrees(MIN_BARREL_PITCH)}" max="${degrees(MAX_BARREL_PITCH)}" step="0.5" value="45" aria-label="Elevation"></label>
      </div>
      <div class="dock-face" id="dock-face">
        <button type="button" class="hud-chip ammo-cycle" id="munition-cycle" title="Next munition · select weapons with 1–4"><span class="ammo-name" id="munition-name">HE</span><span class="ammo-count" id="munition-count">∞</span><kbd>1</kbd></button>
        <span class="aim-readout" id="aim-readout" aria-hidden="true"><span>B <b id="bearing-readout">0°</b></span><span>E <b id="elevation-readout">45°</b></span></span>
        <button type="button" class="hud-round small" id="fine-aim-toggle" aria-expanded="false" aria-controls="fine-aim" aria-label="Fine aim and munitions" title="Fine aim and munitions">▴</button>
        <label class="power-field" id="power-field"><span class="field-row"><span class="field-label">Power</span><output id="power-value">55%</output></span>
          <input class="range power-range" id="power" type="range" min="0" max="100" step="1" value="55" aria-label="Power"></label>
        <button type="button" class="hud-round" id="camera" title="Planet view (O)" aria-label="Planet view"><span aria-hidden="true">◉</span><kbd>O</kbd></button>
        <button type="button" class="hud-round scan-btn" id="scan" title="Spend charge for a radar report (R)" aria-label="Radar scan"><span aria-hidden="true">⌖</span><span class="charge" id="charge">0%</span><kbd>R</kbd></button>
        <button type="button" class="hud-round target-cycle" id="target-cycle" title="Cycle visible targets (Tab)" aria-label="Select nearest enemy or cycle visible targets"><span aria-hidden="true">⊕</span><span class="target-caption">Target</span><kbd>Tab</kbd></button>
        <button type="button" class="fire-btn" id="fire"><span>Fire</span><kbd>Space</kbd></button>
        <button type="button" class="fire-btn hold-btn" id="end-move" hidden><span>Hold ✓</span><kbd>Enter</kbd></button>
      </div>
    </aside>
    </div>
  </div>
  <div class="screens" id="screens"></div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <div class="loading" id="loading" role="status" hidden>
    <div class="loading-inner paper">
      <div class="orbit" aria-hidden="true"><span></span></div>
      <div class="eyebrow" id="loading-eyebrow">WARMING THE WORKSHOP LAMP</div>
      <h2 id="loading-title">Preparing your little world.</h2>
      <p id="loading-copy">Building the terrain and setting up your tank.</p>
      <div class="loading-actions"><button type="button" class="btn btn-primary" id="retry" hidden>Try again</button><button type="button" class="btn btn-brass" id="loading-menu" hidden>Menu</button></div>
    </div>
  </div>`;
  return root;
}

export const element = byId;
