/** Settings: graphics, audio and gameplay (broadcast as tmt:settings), plus profile export and import. */
import { exportProfile, importProfile } from '../../meta/profile';
import { DIFFICULTIES, DRIVE_SCHEMES, GRAPHICS_TIERS, recommendedGraphicsPreset, SETTING_RANGES, type GraphicsSettings } from '../../meta/settings';
import { button, percent, segmented, slider, toggle } from '../components/controls';
import { el } from '../components/el';
import { screenCard, section } from '../components/panel';
import { keyBindings } from './key-bindings';
import type { ScreenContext } from './context';

type Tab = 'graphics' | 'audio' | 'controls' | 'gameplay' | 'profile';
let tab: Tab = 'graphics';
const TAB_ITEMS: { id: Tab; label: string }[] = [{ id: 'graphics', label: 'Graphics' }, { id: 'audio', label: 'Audio' }, { id: 'controls', label: 'Keys' }, { id: 'gameplay', label: 'Gameplay' }, { id: 'profile', label: 'Profile' }];
const TIER_LABELS: Record<string, string> = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra', custom: 'Custom' };
const capital = (text: string) => text[0].toUpperCase() + text.slice(1);
const DRIVE_LABELS: Record<string, string> = { camera: 'Camera', tank: 'Tank' };

function graphics(ctx: ScreenContext): HTMLElement[] {
  const root = el('div', { class: 'graphics-settings' });
  const change = (patch: Partial<GraphicsSettings>) => {
    ctx.updateSettings({ graphics: patch });
    for (const node of Array.from(root.querySelectorAll('#set-tier [role="radio"]'))) node.setAttribute('aria-checked', String(node.getAttribute('data-value') === ctx.profile.settings.graphics.tier));
  };
  const draw = () => {
    const g = ctx.profile.settings.graphics;
    const range = (key: keyof typeof SETTING_RANGES & keyof GraphicsSettings, label: string, hint?: string, quality = false) => {
      const [min, max, step] = SETTING_RANGES[key];
      return slider({ id: `set-${key}`, label, min, max, step: key === 'renderScale' ? 0.01 : step, value: g[key] as number,
        format: quality ? value => ['Off', 'Low', 'Medium', 'High', 'Ultra'][value] : percent, hint, onInput: value => change({ [key]: value }) });
    };
    const flag = (key: 'ambientOcclusion' | 'globalIllumination' | 'godRays' | 'lensFlare', label: string, hint?: string) => toggle(label, g[key], value => change({ [key]: value }), { id: `set-${key}`, hint });
    root.replaceChildren(
      segmented('Graphics preset', GRAPHICS_TIERS.map(id => ({ id, label: TIER_LABELS[id], disabled: id === 'custom' })), g.tier, tier => { change({ tier }); draw(); }, 'set-tier'),
      el('p', { class: 'field-hint preset-hint', text: `Changes apply immediately and save automatically. Editing a control selects Custom. Auto starts at ${TIER_LABELS[recommendedGraphicsPreset()]} using device hints.` }),
      el('p', { class: 'settings-protected', text: 'Every preset preserves terrain detail, liquid motion, explosion detail and fog of war. Low removes optional effects for slower devices.' }),
      section('Performance',
        range('renderScale', 'Render scale', '50% draws a quarter as many pixels; temporal upscaling reconstructs the display image.'),
        range('shadows', 'Shadow quality', 'Sun, moon and local-light shadows. Off uses simple direct lighting.', true),
        range('cloudQuality', 'Cloud quality', 'Off removes clouds; higher levels trace more detail and light.', true),
        range('hazeQuality', 'Light in haze', 'Atmospheric light scattering; fog of war stays intact even at Off.', true),
        range('grassDensity', 'Grass density', 'Decorative vegetation only.'),
        flag('ambientOcclusion', 'Ambient occlusion', 'Contact shading in creases and corners.'),
        flag('globalIllumination', 'Bounce lighting', 'Indirect light reflected from nearby surfaces.')),
      section('Lens & image', range('miniature', 'Miniature focus', 'Depth-of-field blur around the focused tank; 0 keeps the scene sharp.'),
        range('fisheye', 'Fisheye lens', 'Negative: wider view with an inverted curve. Positive: rounded fisheye. 0: normal lens.'),
        range('bloom', 'Bloom'), range('grain', 'Film grain'), flag('godRays', 'Sun rays'), flag('lensFlare', 'Lens flare')),
    );
  };
  draw(); return [root];
}
function audio(ctx: ScreenContext): HTMLElement[] {
  const a = ctx.profile.settings.audio, [min, max, step] = SETTING_RANGES.volume;
  return (['master', 'music', 'sfx', 'ui', 'voice'] as const).map(key => slider({
    id: `set-${key}`, label: { master: 'Master', music: 'Music', sfx: 'Effects', ui: 'Interface', voice: 'Dialogue' }[key], min, max, step, value: a[key], format: percent,
    onInput: value => ctx.updateSettings({ audio: { [key]: value } }),
  }));
}
function gameplay(ctx: ScreenContext): HTMLElement[] {
  const p = ctx.profile.settings.gameplay;
  return [
    segmented('Default AI difficulty', DIFFICULTIES.map(id => ({ id, label: capital(id) })), p.difficulty, difficulty => ctx.updateSettings({ gameplay: { difficulty } }), 'set-difficulty'),
    segmented('Touch joystick', DRIVE_SCHEMES.map(id => ({ id, label: DRIVE_LABELS[id] })), p.touchDrive, touchDrive => ctx.updateSettings({ gameplay: { touchDrive } }), 'set-touch-drive'),
    segmented('Keyboard and gamepad driving', DRIVE_SCHEMES.map(id => ({ id, label: DRIVE_LABELS[id] })), p.keyDrive, keyDrive => ctx.updateSettings({ gameplay: { keyDrive } }), 'set-key-drive'),
    el('p', { class: 'field-hint', text: 'Camera: push where you want to go on screen; the tank turns, drives and reverses to get there. Tank: up drives the hull forward and sideways turns it.' }),
    toggle('Cinematic cameras', p.cinematics, cinematics => ctx.updateSettings({ gameplay: { cinematics } }), { id: 'set-cinematics', hint: 'Shell follow and impact cuts' }),
    toggle('Chat profanity filter', p.profanityFilter, profanityFilter => ctx.updateSettings({ gameplay: { profanityFilter } }), { id: 'set-profanity-filter', hint: 'Mask common profanity and slurs in chat and player names. On by default.' }),
    toggle('Reduced motion', p.reducedMotion, reducedMotion => ctx.updateSettings({ gameplay: { reducedMotion } }), { id: 'set-reduced-motion', hint: 'Calmer camera and menus, no shake' }),
    toggle('Auto-brace', p.autoBrace, autoBrace => ctx.updateSettings({ gameplay: { autoBrace } }), { id: 'set-auto-brace', hint: 'Brace against incoming shells automatically' }),
    el('p', { class: 'field-hint', text: 'The full predicted shot arc is always shown while aiming, in every match mode.' }),
  ];
}
function profile(ctx: ScreenContext): HTMLElement[] {
  const box = el('textarea', { class: 'text-input profile-json', id: 'profile-json', rows: 6, spellcheck: 'false', placeholder: 'Paste an exported profile here to import it.', 'aria-label': 'Profile JSON' });
  const file = el('input', { type: 'file', accept: 'application/json,.json', id: 'profile-file', class: 'visually-hidden' });
  const load = (text: string) => {
    const result = importProfile(text);
    if (!result.ok) { ctx.toast(result.error, 5); return; }
    ctx.setProfile(result.profile);
    ctx.toast(result.migrated ? 'Imported a v1 profile and upgraded it.' : 'Profile imported.');
  };
  file.addEventListener('change', () => { const chosen = file.files?.[0]; if (chosen) void chosen.text().then(load).catch(() => ctx.toast('Could not read that profile file.', 5)); file.value = ''; });
  const download = () => {
    const url = URL.createObjectURL(new Blob([exportProfile(ctx.profile)], { type: 'application/json' }));
    el('a', { href: url, download: 'tmt-profile.json' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const stats = ctx.profile.stats;
  return [
    el('p', { class: 'field-hint', text: `Rank ${ctx.profile.rank} · ${stats.matches} matches · ${stats.wins} wins. Your profile lives in this browser; export it to keep a copy.` }),
    el('p', { class: 'profile-explainer', text: 'This is your saved progress: builds, crew, rank, scrap, unlocks, campaign stars, cosmetics, and settings (including keys). It saves automatically in this browser. A profile does not resume a battle in progress or include campaign checkpoints. Importing replaces your current profile; download a backup first.' }),
    el('div', { class: 'button-row' },
      button('Download profile', download, { id: 'profile-export' }),
      button('Copy to the box', () => { box.value = exportProfile(ctx.profile); box.select(); }, { id: 'profile-show', variant: 'quiet' })),
    box,
    el('div', { class: 'button-row' },
      button('Import from the box', () => load(box.value), { id: 'profile-import' }),
      button('Import a file…', () => file.click(), { id: 'profile-import-file', variant: 'quiet' }), file),
  ];
}

export function renderSettings(ctx: ScreenContext): HTMLElement {
  const renderBody = () => ({ graphics, audio, gameplay, profile, controls: (context: ScreenContext) => [keyBindings(context)] }[tab](ctx));
  const body = el('div', { class: 'settings-body', id: `settings-${tab}`, role: 'tabpanel', 'aria-labelledby': `settings-tab-${tab}` }, ...renderBody());
  let resizing: Animation | undefined;
  let profileDraft = '';
  const switchTab = (value: Tab) => {
    if (value === tab) return;
    const from = card.getBoundingClientRect().height;
    resizing?.cancel();
    if (tab === 'profile') profileDraft = body.querySelector<HTMLTextAreaElement>('#profile-json')?.value ?? '';
    tab = value;
    for (const button of Array.from(nav.querySelectorAll<HTMLButtonElement>('[role="tab"]'))) {
      const selected = button.dataset.value === tab;
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    }
    body.id = `settings-${tab}`; body.setAttribute('aria-labelledby', `settings-tab-${tab}`);
    body.replaceChildren(...renderBody());
    if (tab === 'profile') body.querySelector<HTMLTextAreaElement>('#profile-json')!.value = profileDraft;
    card.querySelector('.card-body')!.scrollTop = 0;
    const to = card.getBoundingClientRect().height;
    if (!ctx.profile.settings.gameplay.reducedMotion && !matchMedia('(prefers-reduced-motion: reduce)').matches && card.animate) {
      resizing = card.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' });
      body.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 180 });
    }
  };
  const nav = el('div', { class: 'tabs settings-tabs', role: 'tablist', 'aria-label': 'Settings sections' }, ...TAB_ITEMS.map(item => {
    const target = el('button', { type: 'button', class: 'tab', role: 'tab', id: `settings-tab-${item.id}`, 'data-value': item.id,
      'aria-selected': String(item.id === tab), 'aria-controls': `settings-${item.id}`, tabindex: item.id === tab ? 0 : -1,
      onclick: () => switchTab(item.id), text: item.label });
    target.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const index = TAB_ITEMS.findIndex(item => item.id === tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? TAB_ITEMS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + TAB_ITEMS.length) % TAB_ITEMS.length;
      switchTab(TAB_ITEMS[next].id); nav.querySelector<HTMLButtonElement>(`#settings-tab-${tab}`)?.focus();
    });
    return target;
  }));
  const card = screenCard({
    dismiss: () => ctx.go({ type: 'BACK' }),
    id: 'settings', eyebrow: ctx.flow.back === 'pause' ? 'PAUSED' : 'PREFERENCES', title: 'Settings',
    body: [nav, body],
    actions: [button('Done', () => ctx.go({ type: 'BACK' }), { id: 'settings-back', variant: 'primary', primary: true })],
  });
  return card;
}
