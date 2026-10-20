import { crewBuild, profileCrew, GADGETS, TRAINING, ULTIMATES } from '../../campaign/loadout';
import { button } from '../components/controls';
import { el } from '../components/el';
import type { ScreenContext } from './context';
export function renderCrew(ctx: ScreenContext): HTMLElement {
  const build = profileCrew(ctx.profile), spent = build.gunner + build.driver + build.commander;
  const update = (patch: Partial<typeof build>) => { ctx.setProfile({ ...ctx.profile, crew: crewBuild({ ...build, ...patch }, ctx.profile.rank, ctx.profile.unlocks) }); ctx.refresh(); };
  return el('details', { class: 'crew-panel' }, el('summary', { text: `Crew & equipment · ${ctx.profile.rank - spent} training points · ${build.gadgets.length}/4 gadgets` }),
    el('p', { class: 'field-hint', text: 'One point per rank. Training and equipment apply to campaign missions. Respec is free.' }),
    el('div', { class: 'crew-branches' }, ...Object.entries(TRAINING).map(([branch, tiers]) => {
      const key = branch as keyof typeof TRAINING, level = build[key];
      return el('section', {}, el('h3', { text: `${branch} · ${level}/5` }), ...tiers.map((tier, i) => button(`${i < level ? '✓ ' : ''}${tier}`, () => update({ [key]: level + 1 }), { disabled: i !== level || spent >= ctx.profile.rank, variant: i < level ? 'brass' : 'quiet' })));
    })), button('Respec training', () => update({ gunner: 0, driver: 0, commander: 0 }), { variant: 'quiet' }),
    el('h3', { text: 'Gadgets · four slots' }), el('div', { class: 'crew-gadgets' }, ...GADGETS.map(g => {
      const equipped = build.gadgets.includes(g.id), owned = ctx.profile.unlocks.includes(`gadget:${g.id}`);
      return button(`${equipped ? '✓ ' : ''}${g.name}`, () => update({ gadgets: equipped ? build.gadgets.filter(id => id !== g.id) : [...build.gadgets, g.id] }), { title: g.text, disabled: !owned || !equipped && build.gadgets.length === 4, variant: equipped ? 'brass' : 'quiet' });
    })), el('h3', { text: 'Ultimate · one use per mission' }), ...ULTIMATES.map(u => button(`${build.ultimate === u.id ? '✓ ' : ''}${u.name} · rank ${u.rank}`, () => update({ ultimate: u.id }), { title: u.text, disabled: ctx.profile.rank < u.rank, variant: build.ultimate === u.id ? 'brass' : 'quiet' })));
}
