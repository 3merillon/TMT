/**
 * ?dev: a live panel over the game for isolating rendering artifacts. Drive mode is the playground
 * (play.html?mode=drive&dev): drive anywhere, then pick what the screen shows (the final image, one lighting term or a
 * G-buffer channel), switch single effects off, and move the time of day. "Copy state" puts a URL with the seed, view,
 * switches and time on the clipboard, plus where the tank is, so an artifact can be described exactly.
 *
 * Keys: ` shows or hides the panel, [ and ] step through the views, \ returns to the final image.
 * URL: ?view=<view> picks a view, ?off=a,b switches effects off (the keys below), ?dayOffset=<fraction of a day>,
 * ?fog=on shows the fog of war even where the match rules turn it off (the playground does).
 *
 * The panel owns its state and pushes it to the engine's facets a few times a second, so a renderer rebuilt by a new
 * match picks it up again.
 */
import type { GBufferView } from '../../engine/contracts';
import { LIGHTING_DEBUG_VIEW_INFO, type LightingDebugView } from '../../engine/passes/lighting/debug-views';
import type { LiquidDebugView } from '../../engine/passes/fluids/liquid-params';
import type { GameView } from '../view';
import { currentSettings, dispatchSettings, updateSettings, type GraphicsSettings } from '../meta/settings';
import { MUNITIONS, type MunitionId } from '../munitions';

type Controls = ReturnType<GameView['devControls']>;

interface ViewEntry { id: string; label: string; info: string; lighting?: LightingDebugView; gbuffer?: Exclude<GBufferView, 'none'>; liquid?: LiquidDebugView }

const L = (id: LightingDebugView, label: string): ViewEntry => ({ id, label, info: LIGHTING_DEBUG_VIEW_INFO[id], lighting: id });
const G = (id: Exclude<GBufferView, 'none'>, label: string, info: string): ViewEntry => ({ id: `gb-${id}`, label, info, gbuffer: id });
const W = (id: LiquidDebugView, label: string, info: string): ViewEntry => ({ id: `water-${id}`, label, info, liquid: id });

/** Views in panel order, by group. */
const VIEW_GROUPS: readonly { title: string; views: readonly ViewEntry[] }[] = [
  { title: 'Image', views: [L('none', 'Final')] },
  { title: 'Light', views: [L('shadow', 'Sun shadow'), L('sdf-sun', 'SDF sun'), L('moon', 'Moon'), L('direct', 'Direct'), L('local', 'Local lights'), L('ambient', 'Ambient')] },
  { title: 'SDF effects', views: [L('ao', 'AO'), L('gi', 'GI'), L('gi-sky', 'GI sky'), L('gi-bounce', 'GI bounce'), L('sdf', 'SDF distance')] },
  { title: 'Fog of war', views: [L('fog', 'Hidden'), L('veil', 'Veil'), L('mist', 'Mist')] },
  { title: 'Water', views: [
    W('shore', 'Shore', 'Water kept (blue), contact foam (white), front cells dipped under the bed (red), as the final image computes them.'),
    W('depth', 'Depth', 'Water depth under the surface.'), W('foam', 'Foam', 'The foam the simulation carries.'),
    W('flow', 'Flow', 'Surface flow speed.'), W('wetness', 'Wetness', 'Ground the water left recently.'),
  ] },
  { title: 'G-buffer', views: [
    G('albedo', 'Albedo', 'Material base colour.'), G('normal', 'Normal', 'Shading normal (with detail maps).'),
    G('geonormal', 'Geo normal', 'Geometric (per-triangle) normal.'), G('material', 'Material', 'Roughness, metalness, emissive.'),
    G('ids', 'IDs', 'Class, flags and object id, hashed to colours.'), G('depth', 'Depth', 'Log depth.'),
  ] },
];
const VIEWS = VIEW_GROUPS.flatMap(g => g.views);

/** Effect switches: key, label, what switching it off removes. */
const TOGGLES = [
  ['veil', 'Fog veil', 'Hidden surfaces keep their real material instead of the fog colour.'],
  ['mist', 'Fog mist', 'The volumetric war fog along camera rays.'],
  ['ao', 'AO', 'SDF ambient occlusion (and material AO).'],
  ['gi', 'GI', 'GI probe sky visibility and bounce.'],
  ['ambient', 'Ambient', 'All ambient light (sky, GI, night floor).'],
  ['sunShadows', 'Sun shadows', 'The soft SDF sun shadow of the world (terrain, buildings).'],
  ['moonShadows', 'Moon shadows', 'The soft SDF moon shadow (world and tanks).'],
  ['casters', 'Tank shadows', 'The tank bricks in every SDF shadow (sun, moon, lights) and in AO.'],
  ['contact', 'Contact shadow', 'The screen-space contact shadow.'],
  ['localShadows', 'Local shadows', 'Shadows of shell, flash and impact lights (world and tanks).'],
  ['taa', 'TAA', 'Temporal anti-aliasing (shows raw per-frame noise).'],
  ['bloom', 'Bloom', 'Bloom.'],
  ['autoExposure', 'Auto exposure', 'Adaptive exposure (fixed exposure when off).'],
  ['clouds', 'Clouds', 'Planetary cloud volume and its surface shadows.'],
  ['cloudShadows', 'Cloud shadows', 'Only the world-anchored cloud shadow cube.'],
  ['volumetrics', 'Light in haze', 'Depth-aware sunlight and local-light scattering.'],
  ['volumeSun', 'Sunlit haze', 'World-space sunlight scattering through haze.'],
  ['volumeLocal', 'Local beams', 'Shadowed local-light scattering through haze.'],
  ['lensFlare', 'Lens flare', 'Occlusion-driven optical ghosts, halo and streaks.'],
  ['godRays', 'Sun rays', 'Subtle screen-space rays from the visible sun.'],
] as const;
type ToggleKey = typeof TOGGLES[number][0];

export function installDevPanel(view: GameView, tools?: { blast(radius: number, munition: MunitionId): Promise<void>; placeTank(): void; selectMunition(id: MunitionId): boolean; selectedMunition(): MunitionId | undefined }): () => void {
  const c = view.devControls();
  const params = new URLSearchParams(location.search);
  if (params.get('fog') === 'on') c.setFog(true);
  const off = new Set<ToggleKey>((params.get('off') ?? '').split(',').filter((k): k is ToggleKey => TOGGLES.some(t => t[0] === k)));
  const lightView = params.get('view') ?? params.get('lightView');
  let current = VIEWS.find(v => v.id === lightView || v.id === `gb-${lightView}`) ?? VIEWS[0];

  const panel = document.createElement('aside');
  panel.className = 'dev-panel';
  panel.innerHTML = /* html */ `
    <header><strong>Render dev</strong><span class="dev-hint">click folds · \` hide · [ ] view · \\ final</span></header>
    <div class="dev-current"></div>
    <div class="dev-views"></div>
    <div class="dev-section">Effects</div>
    <div class="dev-toggles"></div>
    <div class="dev-section">Time of day <span class="dev-time"></span></div>
    <input class="dev-slider" type="range" min="-0.5" max="0.5" step="0.01">
    <div class="dev-row"><button class="dev-copy" type="button">Copy state</button><button class="dev-reset" type="button">Reset</button></div>
    <pre class="dev-stats"></pre>`;
  const style = document.createElement('style');
  style.textContent = DEV_CSS;
  document.head.append(style);
  document.body.append(panel);
  const playground = params.get('mode') === 'dev';
  let syncMunition = () => {};
  if (playground) {
    panel.classList.add('engine-playground');
    panel.querySelector('strong')!.textContent = 'Engine playground';
    const controls = document.createElement('div'); controls.className = 'dev-playground';
    controls.innerHTML = `<p>WASD drive · click or Tab target · 1–4 ammunition · Space fire<br>Wheel zoom · right-drag orbit · Q/E and arrows also aim. All controls below apply live.</p>
      <div class="dev-row"><label>Planet <select class="dev-planet"><option value="7">Temperate · grass & water</option><option value="6">Glacial · water</option><option value="4">Volcanic · lava</option><option value="5">Dune · dry</option></select></label><button class="dev-load">Load</button></div>
      <div class="dev-row"><button class="dev-follow">Follow tank</button><button class="dev-overview">Orbit planet</button><button class="dev-water">Inspect shoreline</button></div>
      <div class="dev-row"><button class="dev-underwater">Underwater camera</button><button class="dev-in-lava">Inside lava</button></div>
      <div class="dev-row"><button class="dev-place-tank">Place tank here</button><button class="dev-reload">Reset planet</button></div>
      <label>Munition <select class="dev-munition" aria-label="Dev munition">${Object.entries(MUNITIONS).map(([id, ammo]) => `<option value="${id}">${ammo.name}</option>`).join('')}</select></label>
      <div class="dev-row"><button class="dev-preview">Preview explosion</button><button class="dev-blast">Blast terrain</button><button class="dev-clear-fx">Clear effects</button></div>
      <label>Blast radius <input class="dev-radius" type="range" min="2" max="5" step="0.1" value="2.5"></label>
      <label>Show game HUD <input class="dev-hud" type="checkbox"></label>
      <div class="dev-live-settings"></div><p class="dev-feedback" role="status">Temperate worlds grow grass on dry, gentle terrain.</p>`;
    panel.querySelector('header')!.after(controls);
    const find = <T extends HTMLElement>(selector: string) => controls.querySelector(selector) as T;
    const select = find<HTMLSelectElement>('.dev-planet'); select.value = params.get('seed') ?? '7';
    if (!select.value) select.value = '7';
    const feedback = find('.dev-feedback');
    document.body.classList.add('engine-development');
    find<HTMLInputElement>('.dev-hud').addEventListener('change', e => document.body.classList.toggle('dev-show-hud', (e.target as HTMLInputElement).checked));
    const radius = () => Number(find<HTMLInputElement>('.dev-radius').value);
    const ammo = find<HTMLSelectElement>('.dev-munition');
    const munition = () => ammo.value as MunitionId;
    syncMunition = () => {
      const selected = tools?.selectedMunition();
      if (selected && ammo !== document.activeElement && ammo.value !== selected) ammo.value = selected;
    };
    ammo.addEventListener('blur', syncMunition);
    ammo.addEventListener('change', () => {
      const applied = tools?.selectMunition(munition());
      ammo.blur(); syncMunition();
      feedback.textContent = applied ? `${MUNITIONS[munition()].name} selected. Space fires this round.` : 'Finish the current shot before selecting a new round.';
    });
    syncMunition();
    find('.dev-load').addEventListener('click', () => { const u = new URL(location.href); u.searchParams.set('mode', 'dev'); u.searchParams.set('seed', select.value); location.href = u.toString(); });
    find('.dev-follow').addEventListener('click', c.follow);
    find('.dev-overview').addEventListener('click', c.overview);
    find('.dev-water').addEventListener('click', async () => { if (!await c.inspectWater()) feedback.textContent = 'No shoreline on this planet.'; });
    find('.dev-underwater').addEventListener('click', async () => {
      feedback.textContent = await c.inspectWater(true) ? 'Underwater camera. Drag to look around; scroll to cross the surface.' : 'No deep water found on this planet.';
    });
    find('.dev-in-lava').addEventListener('click', async () => {
      feedback.textContent = await c.inspectWater(true, 'lava') ? 'Camera inside opaque lava. Scroll to cross the surface.' : 'No lava pool found on this planet.';
    });
    find('.dev-place-tank').addEventListener('click', () => { try { tools?.placeTank(); feedback.textContent = 'Tank placed at camera target. WASD to drive.'; }
      catch (error) { feedback.textContent = String(error); } });
    find('.dev-reload').addEventListener('click', () => location.reload());
    find('.dev-preview').addEventListener('click', () => { const hit = c.aimHit(); if (hit) c.burst(hit.point, radius() * MUNITIONS[munition()].radius, munition()); else feedback.textContent = 'Point the camera at terrain.'; });
    find('.dev-clear-fx').addEventListener('click', () => c.scene()?.get('fluids')?.clearEffects());
    const blast = find<HTMLButtonElement>('.dev-blast');
    blast.addEventListener('click', async () => {
      blast.disabled = true; feedback.textContent = 'Cutting terrain…';
      try { await tools?.blast(radius() * MUNITIONS[munition()].radius, munition()); feedback.textContent = 'Terrain cut committed. Fragments now collide and settle.'; }
      catch (error) { feedback.textContent = error instanceof Error ? error.message : String(error); }
      finally { blast.disabled = false; }
    });
    const settings = find('.dev-live-settings');
    const change = (key: keyof GraphicsSettings, value: number | string) => {
      dispatchSettings(updateSettings(currentSettings(), { graphics: { [key]: value } }));
      feedback.textContent = `${key}: ${value} · applied`;
    };
    for (const [key, label, min, max, step] of [
      ['grassDensity', 'Grass density', 0, 1, 0.05], ['renderScale', 'Render scale', 0.5, 1, 0.05],
      ['bloom', 'Bloom', 0, 1, 0.05], ['grain', 'Film grain', 0, 1, 0.05],
    ] as const) {
      const labelNode = document.createElement('label'); labelNode.textContent = label;
      const input = document.createElement('input'); input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
      input.value = String(currentSettings().graphics[key]); input.setAttribute('aria-label', label);
      input.addEventListener('input', () => change(key, Number(input.value))); labelNode.append(input); settings.append(labelNode);
    }
    const quality = document.createElement('select'); quality.setAttribute('aria-label', 'Quality tier');
    for (const tier of ['low', 'medium', 'high', 'ultra']) { const option = document.createElement('option'); option.value = tier; option.textContent = tier; quality.append(option); }
    quality.value = currentSettings().graphics.tier === 'auto' ? 'high' : currentSettings().graphics.tier;
    quality.addEventListener('change', () => change('tier', quality.value)); settings.append('Quality ', quality);
  }
  // Available whenever the explicit developer panel is installed, including campaign captures.
  Object.assign(window, { __tmtFluids: view.fluidsDebug(), __tmtVisuals: { ...c, ...(playground ? {
    blast: (r = 2.5) => tools?.blast(r, (panel.querySelector<HTMLSelectElement>('.dev-munition')?.value ?? 'explosive') as MunitionId), placeTank: () => tools?.placeTank(),
  } : {}), stats: () => view.telemetry().visuals } });
  const q = <T extends Element>(sel: string) => panel.querySelector(sel) as T;
  // A click on the title folds the panel to one line (the view stays applied).
  q('header').addEventListener('click', () => panel.classList.toggle('collapsed'));
  // On a phone the panel starts folded so the world and the thumb controls stay usable.
  if (matchMedia('(max-width: 600px)').matches) panel.classList.add('collapsed');
  const currentEl = q<HTMLDivElement>('.dev-current'), statsEl = q<HTMLPreElement>('.dev-stats'), timeEl = q<HTMLSpanElement>('.dev-time');
  const slider = q<HTMLInputElement>('.dev-slider');

  // Controls give focus back to the game: a focused button or checkbox would eat Space (fire) and the arrow keys.
  const release = (el: HTMLElement) => el.addEventListener('pointerup', () => setTimeout(() => el.blur(), 0));
  panel.querySelectorAll<HTMLElement>('.dev-playground button, .dev-playground input').forEach(release);

  const viewButtons = new Map<string, HTMLButtonElement>();
  for (const group of VIEW_GROUPS) {
    const row = document.createElement('div');
    row.className = 'dev-group';
    row.innerHTML = `<span class="dev-group-title">${group.title}</span>`;
    for (const v of group.views) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = v.label; b.title = v.info;
      b.addEventListener('click', () => { current = v; render(); apply(); });
      release(b);
      viewButtons.set(v.id, b);
      row.append(b);
    }
    if (group.title === 'Fog of war') {
      // Force sensor visibility as well as the veil when the playground normally reveals every tank.
      const label = document.createElement('label'), fog = document.createElement('input');
      label.className = 'dev-fog-force'; label.title = 'Use team sensor line of sight for fog, contacts and target selection, even where the match rules turn fog off.';
      fog.type = 'checkbox'; fog.className = 'dev-fog'; fog.setAttribute('aria-label', 'Force fog of war on'); fog.checked = c.fog() === true;
      fog.addEventListener('change', () => c.setFog(fog.checked ? true : undefined));
      release(fog); label.append(fog, ' Force on'); row.append(label);
    }
    q('.dev-views').append(row);
  }
  const toggleInputs = new Map<ToggleKey, HTMLInputElement>();
  for (const [key, label, info] of TOGGLES) {
    const l = document.createElement('label');
    l.title = `Off: ${info}`;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => { if (input.checked) off.delete(key); else off.add(key); render(); apply(); });
    release(input);
    l.append(input, ` ${label}`);
    toggleInputs.set(key, input);
    q('.dev-toggles').append(l);
  }
  slider.value = String(c.dayOffset());
  slider.addEventListener('input', () => { c.setDayOffset(Number(slider.value)); render(); });
  release(slider);
  const copy = q<HTMLButtonElement>('.dev-copy');
  copy.addEventListener('click', () => {
    const text = stateText();
    void navigator.clipboard?.writeText(text).then(() => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy state'; }, 1200); },
      () => { console.info(text); copy.textContent = 'In console'; });
  });
  release(copy);
  const reset = q<HTMLButtonElement>('.dev-reset');
  reset.addEventListener('click', () => { off.clear(); current = VIEWS[0]; c.setDayOffset(0); slider.value = '0'; render(); apply(); });
  release(reset);

  function stateUrl(): string {
    const u = new URL(location.href);
    const p = u.searchParams;
    p.set('mode', p.get('mode') ?? 'drive');
    p.set('seed', String(c.seed()));
    p.set('dev', '');
    for (const k of ['view', 'off', 'dayOffset', 'lightView', 'fog']) p.delete(k);
    if (c.fog() === true) p.set('fog', 'on');
    if (current !== VIEWS[0]) p.set('view', current.id);
    if (off.size) p.set('off', [...off].join(','));
    if (c.dayOffset() !== 0) p.set('dayOffset', c.dayOffset().toFixed(2));
    return u.toString().replace('dev=&', 'dev&').replace(/dev=$/, 'dev');
  }
  function stateText(): string {
    const f = (v: readonly number[] | null | undefined) => v ? `[${[...v].map(x => x.toFixed(2)).join(', ')}]` : 'n/a';
    const t = c.telemetry();
    return [stateUrl(), `view: ${current.label}; off: ${[...off].join(', ') || 'none'}; time of day: ${c.dayOffset().toFixed(2)}`,
      `tank: ${f(c.tank())}; camera: ${f(c.camera().eye)} (${c.camera().following ? 'follow' : 'orbit'}); tier ${t?.tier ?? '?'}`].join('\n');
  }

  function timeLabel(d: number): string {
    const a = ((d % 1) + 1) % 1;
    return a < 0.2 || a > 0.8 ? 'day' : a < 0.3 || a > 0.7 ? 'dusk / dawn' : 'night';
  }

  function render(): void {
    for (const [id, b] of viewButtons) b.classList.toggle('on', id === current.id);
    for (const [key, input] of toggleInputs) input.checked = !off.has(key);
    currentEl.textContent = `${current.label}: ${current.info}`;
    timeEl.textContent = `${c.dayOffset().toFixed(2)} (${timeLabel(c.dayOffset())})`;
  }

  /** Push the state into the engine (idempotent; the renderer may not exist yet or may have been rebuilt). */
  function apply(): void {
    syncMunition();
    const scene = c.scene(), settings = c.settings();
    if (!scene || !settings) return;
    const on = (k: ToggleKey) => !off.has(k);
    const lighting = scene.get('lighting');
    if (lighting) {
      lighting.view = current.lighting ?? 'none';
      lighting.ao = on('ao') && currentSettings().graphics.ambientOcclusion;
      lighting.ambient = on('ambient') ? 1 : 0;
      const g = currentSettings().graphics;
      Object.assign(lighting.toggles, { veil: on('veil'), mist: on('mist'), gi: on('gi') && g.globalIllumination, sunShadows: on('sunShadows') && g.shadows > 0,
        moonShadows: on('moonShadows') && g.shadows > 0, localShadows: on('localShadows') && g.shadows > 0, casters: on('casters') });
    }
    settings.gbufferView = current.gbuffer ?? 'none';
    const fluids = scene.get('fluids');
    if (fluids) fluids.view = current.liquid ?? 'none';
    const sun = scene.get('sunShadows');
    if (sun) sun.contact = on('contact');
    const taa = scene.get('taa');
    if (taa) taa.enabled = on('taa');
    const post = scene.get('post');
    if (post) { post.bloom = on('bloom') && currentSettings().graphics.bloom > 0; post.autoExposure = on('autoExposure'); }
    if (post) { post.flare = on('lensFlare') && currentSettings().graphics.lensFlare; post.godRays = on('godRays') && currentSettings().graphics.godRays; }
    const clouds = scene.get('clouds');
    if (clouds) { clouds.enabled = on('clouds') && currentSettings().graphics.clouds; clouds.shadows = on('cloudShadows') && currentSettings().graphics.shadows > 0; }
    const volume = scene.get('volumetrics');
    if (volume) { volume.enabled = on('volumetrics') && currentSettings().graphics.volumetrics; volume.sun = on('volumeSun'); volume.local = on('volumeLocal'); }
  }

  function stats(): void {
    const t = c.telemetry();
    if (!t) { statsEl.textContent = 'renderer not ready'; return; }
    const top = [...t.gpu.passes].sort((a, b) => b.ms - a.ms).slice(0, 5).map(p => `${p.name.padEnd(16)} ${p.ms.toFixed(2)}`);
    const sdf = c.scene()?.get('sdf');
    const visual = view.telemetry().visuals;
    statsEl.textContent = [`GPU ${t.gpu.total.toFixed(2)} ms · ${t.tier} · SDF ${sdf?.size ?? '-'}³`,
      `Grass sites ${visual.grassSites} · liquid ${visual.liquidReady ? 'running' : 'dry / loading'}`,
      `Fluid explosions ${visual.gas} · debris ${visual.debris}`, ...top].join('\n');
  }

  const cycle = (step: number) => { current = VIEWS[(VIEWS.indexOf(current) + step + VIEWS.length) % VIEWS.length]; render(); apply(); };
  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.code === 'Backquote') panel.classList.toggle('hidden');
    else if (e.code === 'BracketRight') cycle(1);
    else if (e.code === 'BracketLeft') cycle(-1);
    else if (e.code === 'Backslash') { current = VIEWS[0]; render(); apply(); }
    else return;
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  const timers = [setInterval(apply, 250), setInterval(stats, 500)];
  render();
  apply();
  return () => { window.removeEventListener('keydown', onKey); for (const t of timers) clearInterval(t); panel.remove(); style.remove();
    document.body.classList.remove('engine-development', 'dev-show-hud'); Reflect.deleteProperty(window, '__tmtVisuals'); Reflect.deleteProperty(window, '__tmtFluids'); };
}

const DEV_CSS = /* css */ `
/* Keep the touch drive, target, ammunition, Fire and camera controls available in the playground. */
.engine-development:not(.dev-show-hud) #game:not([data-input=touch]) #hud,
.engine-development:not(.dev-show-hud) #hud > :not(.stick-zone):not(.hud-bottom):not(.drag-guide),
.engine-development:not(.dev-show-hud) .hud-bottom > :not(.hud-dock),
.engine-development:not(.dev-show-hud) #fine-aim,
.engine-development:not(.dev-show-hud) #dock-face > :not(#fire):not(#camera):not(#target-cycle):not(#munition-cycle) { display: none !important; }
.engine-development:not(.dev-show-hud) #toast { display: none !important; }
.dev-panel { position: fixed; top: 96px; left: 8px; z-index: 10000; width: 312px; max-height: calc(100vh - 290px); overflow: auto;
  padding: 8px 10px; border-radius: 8px; background: rgba(14, 16, 20, 0.86); color: #e6e6e6; font: 12px/1.35 system-ui, sans-serif;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35); user-select: none; }
.dev-panel.hidden { display: none; }
.dev-panel.engine-playground { top: 8px; left: auto; right: 8px; max-height: calc(100vh - 32px); width: 340px; }
@media (max-width: 600px) { .dev-panel, .dev-panel.engine-playground { top: max(8px, env(safe-area-inset-top)); left: 8px; right: 8px; width: auto; max-height: 52dvh; touch-action: pan-y; } .dev-panel header { min-height: 36px; align-items: center; } }
.dev-playground { border-bottom: 1px solid #52606a; padding-bottom: 8px; margin-bottom: 8px; }
.dev-playground label { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 5px 0; }
.dev-playground input[type=range] { width: 180px; }
.dev-playground select { max-width: 210px; background: #29343b; color: #f3f6f7; padding: 4px; }
.dev-panel header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; cursor: pointer; }
.dev-panel.collapsed > :not(header) { display: none; }
.dev-panel.collapsed header { margin-bottom: 0; }
.dev-hint { color: #8a8f98; font-size: 11px; }
.dev-current { min-height: 30px; margin-bottom: 6px; padding: 4px 6px; border-radius: 4px; background: rgba(255, 255, 255, 0.06); color: #cfd6df; }
.dev-group { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; margin-bottom: 4px; }
.dev-group-title, .dev-section { width: 100%; color: #8a8f98; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.dev-section { margin-top: 8px; margin-bottom: 3px; }
.dev-panel button { padding: 2px 7px; border: 1px solid #3a3f47; border-radius: 4px; background: #22262d; color: #dfe3e8; font: inherit; cursor: pointer; }
.dev-panel button:hover { border-color: #5b6470; }
.dev-panel button.on { border-color: #d9a441; background: #4a3a17; color: #fff; }
.dev-toggles { display: grid; grid-template-columns: 1fr 1fr; gap: 1px 8px; }
.dev-toggles label { white-space: nowrap; cursor: pointer; }
.dev-fog-force { white-space: nowrap; cursor: pointer; margin-left: 6px; color: #d7dbe0; }
.dev-slider { width: 100%; }
.dev-row { display: flex; gap: 6px; margin-top: 6px; }
.dev-stats { margin: 6px 0 0; color: #9aa3ad; font: 11px/1.3 ui-monospace, Consolas, monospace; white-space: pre; }
`;
