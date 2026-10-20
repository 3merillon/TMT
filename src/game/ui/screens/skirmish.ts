/** Skirmish setup: planet, seed, tanks and teams, AI profile and difficulty, rule toggles. Start builds a MatchSetup. */
import { activeKit } from '../../meta/profile';
import { button, segmented, select, toggle } from '../components/controls';
import { el } from '../components/el';
import { collapsible, screenCard } from '../components/panel';
import {
  DIFFICULTY_CHOICES, PLANET_CHOICES, randomSeed, skirmishBrains, skirmishProblem, TANK_COUNTS, updateSkirmishOptions, type RuleToggles, type SkirmishOptions,
} from '../skirmish-setup';
import { kitSummary } from '../workshop-model';
import type { ScreenContext } from './context';

export function renderSkirmish(ctx: ScreenContext): HTMLElement {
  let o = ctx.skirmish;
  const set = (patch: Partial<SkirmishOptions>) => {
    const next = updateSkirmishOptions(o, patch);
    o = next;
    ctx.setSkirmish(next);
    seedInput.value = String(o.seed);
    for (const key of ['tanks', 'teams', 'opponents', 'difficulty', 'turnModel'] as const) {
      for (const node of Array.from(card.querySelectorAll<HTMLElement>(`#skirmish-${key} [data-value]`))) node.setAttribute('aria-checked', String(node.dataset.value === String(o[key])));
    }
    const ai = o.opponents === 'ai';
    const brain = card.querySelector<HTMLSelectElement>('#skirmish-brain')!;
    brain.disabled = !ai;
    brain.replaceChildren(...skirmishBrains(o.turnModel).map(choice => el('option', { value: choice.id, selected: choice.id === o.brain, text: choice.label })));
    for (const node of Array.from(card.querySelectorAll<HTMLButtonElement>('#skirmish-difficulty button'))) node.disabled = !ai;
    card.querySelector('.brain-hint')!.textContent = ai ? skirmishBrains(o.turnModel).find(b => b.id === o.brain)?.blurb ?? '' : 'Every seat is a player: pass the device between turns.';
    card.querySelector<HTMLButtonElement>('#skirmish-turnModel [data-value="realtime"]')!.disabled = !ai;
    card.querySelector<HTMLInputElement>('#rule-aimTimer')!.disabled = o.turnModel === 'realtime';
    card.querySelector('#skirmish-combat-hint')!.textContent = combatHint();
  };
  const combatHint = () => o.opponents === 'local' ? 'Pass-and-play takes turns on one device. Realtime artillery is available against AI.'
    : o.turnModel === 'realtime' ? 'You and the AI drive, aim and fire together. Main guns reload between shots; no automatic coaxial fire.'
      : 'Aim and fire in turns, then relocate. Choose Realtime artillery to fight AI simultaneously.';
  const rule = (key: keyof RuleToggles, label: string, hint: string) =>
    toggle(label, o.rules[key], checked => set({ rules: { ...o.rules, [key]: checked } }), { id: `rule-${key}`, hint });
  const seedInput = el('input', { class: 'text-input', id: 'skirmish-seed', type: 'text', inputmode: 'numeric', value: String(o.seed), 'aria-label': 'Seed', maxlength: 10 });
  seedInput.addEventListener('change', () => {
    const value = Number(seedInput.value.trim());
    if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) set({ seed: value });
    else { seedInput.value = String(o.seed); ctx.toast('The seed is a whole number from 0 to 4294967295.'); }
  });
  const problem = skirmishProblem(o);
  const ai = o.opponents === 'ai';
  const card = screenCard({
    id: 'skirmish', eyebrow: 'LOCAL PLAY', title: 'Artillery Duel', subtitle: 'Play against AI or share this device. For separate devices, choose Online Play.', size: 'wide',
    dismiss: () => ctx.go({ type: 'BACK' }),
    body: [
      ctx.flow.error ? el('p', { class: 'notice error', role: 'alert', id: 'skirmish-error', text: 'This skirmish could not start with these options. Change them and try again.', title: ctx.flow.error }) : null,
      segmented('Combat mode', [{ id: 'tempo', label: 'Turn-based' }, { id: 'realtime', label: 'Realtime artillery', disabled: !ai }], o.turnModel, turnModel => set({ turnModel }), 'skirmish-turnModel'),
      el('p', { class: 'field-hint', id: 'skirmish-combat-hint', role: 'status', text: combatHint() }),
      el('div', { class: 'card-columns three' },
        el('div', { class: 'stack' },
        collapsible('skirmish-world', 'World', true,
          select('Planet', PLANET_CHOICES, o.planet, planet => set({ planet }), 'skirmish-planet'),
          el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Seed' }),
            el('span', { class: 'seed-row' }, seedInput, button('Reroll', () => set({ seed: randomSeed() }), { id: 'skirmish-reroll', variant: 'quiet', title: 'New random seed' })))),
        collapsible('skirmish-ai', 'AI', false,
          select('Profile', skirmishBrains(o.turnModel).map(b => ({ id: b.id, label: b.label })), o.brain, brain => set({ brain }), 'skirmish-brain'),
          el('p', { class: 'field-hint brain-hint', text: ai ? skirmishBrains(o.turnModel).find(b => b.id === o.brain)?.blurb ?? '' : 'Every seat is a player: pass the device between turns.' }),
          segmented('Difficulty', DIFFICULTY_CHOICES.map(d => ({ ...d, disabled: !ai })), o.difficulty, difficulty => set({ difficulty }), 'skirmish-difficulty'))),
        collapsible('skirmish-tanks-section', 'Tanks', true,
          segmented('Tanks', TANK_COUNTS.map(n => ({ id: n, label: String(n) })), o.tanks, tanks => set({ tanks }), 'skirmish-tanks'),
          segmented('Teams', [{ id: 'ffa', label: 'Free for all' }, { id: '2v2', label: '2 v 2' }], o.teams, teams => set({ teams }), 'skirmish-teams'),
          segmented('Opponents', [{ id: 'ai', label: 'AI' }, { id: 'local', label: 'Pass & play' }], o.opponents, opponents => set({ opponents }), 'skirmish-opponents')),
        collapsible('skirmish-rules', 'Rules', false,
          rule('fog', 'Fog of war', 'Off reveals all tanks to everyone, including AI'),
          rule('friendlyFire', 'Friendly fire', 'Blasts hurt every tank'),
          rule('wind', 'Wind', 'Gusts bend the shell'),
          rule('aimTimer', 'Aim timer', 'Turn-based only: 20 seconds to take the shot'),
          rule('limitedAmmo', 'Limited ammo', 'Special shells are scarce'))),
      el('p', { class: 'build-line' }, el('span', { class: 'eyebrow', text: 'YOUR BUILD' }), el('span', { text: kitSummary(activeKit(ctx.profile)) })),
      problem ? el('p', { class: 'notice', text: problem }) : null,
    ],
    actions: [
      button('Back', () => ctx.go({ type: 'BACK' }), { id: 'skirmish-back', variant: 'quiet' }),
      button('Start ▸', () => ctx.startSkirmish(), { id: 'skirmish-start', variant: 'primary', primary: true, disabled: !!problem }),
    ],
  });
  card.querySelector<HTMLSelectElement>('#skirmish-brain')!.disabled = !ai;
  card.querySelector<HTMLInputElement>('#rule-aimTimer')!.disabled = o.turnModel === 'realtime';
  return card;
}
