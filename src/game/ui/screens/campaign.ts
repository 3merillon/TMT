/** Orrery operations board: every operation, with any-order Act II dependencies. */
import './orrery.css';
import { button, menuItem } from '../components/controls';
import { el } from '../components/el';
import { screenCard } from '../components/panel';
import { CAMPAIGN } from '../../campaign/catalog';
import { continueMission, missionStars, missionUnlocked } from '../../campaign/progress';
import type { ScreenContext } from './context';
import { renderCrew } from './crew';
import { playCampaignVoice } from '../../../audio';
export function renderCampaign(ctx: ScreenContext): HTMLElement {
  const next = continueMission(ctx.profile), cleared = CAMPAIGN.filter(m => missionStars(ctx.profile, m.id) > 0).length;
  const chapters = [...new Set(CAMPAIGN.map(m => m.chapter))];
  const worlds = el('nav', { class: 'orrery-worlds', 'aria-label': 'Worlds of the Orrery' },
    ...[...new Set(CAMPAIGN.map(m => m.worldName ?? 'Verdant Cradle'))].map((world, i) => {
      const missions = CAMPAIGN.filter(m => (m.worldName ?? 'Verdant Cradle') === world), open = missions.some(m => missionUnlocked(ctx.profile, m.id));
      const target = missions.find(m => missionUnlocked(ctx.profile, m.id) && !missionStars(ctx.profile, m.id)) ?? missions[0];
      const node = button(world, () => document.getElementById(`mission-${target.id}`)?.focus(), { disabled: !open, variant: 'quiet' });
      node.classList.add('orrery-world', `planet-${i % 6}`); return node;
    }));
  return screenCard({ id: 'campaign', title: 'The Unwinding', eyebrow: 'TINY METAL TANK · CAMPAIGN', size: 'wide', class: 'orrery-card',
    subtitle: `${cleared}/${CAMPAIGN.length} operations cleared · Commander rank ${ctx.profile.rank}. The Lantern is fading. Bring the worlds together.`, dismiss: () => ctx.go({ type: 'BACK' }),
    body: [worlds, renderCrew(ctx), ...chapters.map(chapter => el('section', { class: 'orrery-chapter' }, el('h3', { class: 'section-title', text: chapter }),
      el('nav', { class: 'menu-list', 'aria-label': chapter }, ...CAMPAIGN.filter(m => m.chapter === chapter).map(m => {
        const stars = missionStars(ctx.profile, m.id), open = missionUnlocked(ctx.profile, m.id);
        const launch = menuItem(m.title, () => ctx.startMission?.(m.id), { id: `mission-${m.id}`, index: m.id.toUpperCase(),
          hint: open ? `${m.briefing}${m.intel ? ` Intel: ${m.intel}` : ''}` : `Complete ${(m.requires ?? []).join(', ') || 'the previous operation'} to open this mission.`,
          badge: stars === 2 ? '★ Medal' : stars ? 'Cleared' : open ? 'Ready' : 'Locked', disabled: !open,
          ...(m.id === next ? { variant: 'primary' as const, primary: true } : {}) });
        const listen = button('Listen to briefing', async () => {
          listen.textContent = 'Playing briefing…';
          const played = await playCampaignVoice('Narrator', m.briefing);
          if (played && m.intel) await playCampaignVoice('Sgt. Sprocket', m.intel);
          listen.textContent = 'Listen to briefing';
        }, { disabled: !open, variant: 'quiet' });
        listen.setAttribute('aria-label', `Listen to briefing: ${m.title}`);
        listen.classList.add('orrery-listen');
        return el('div', { class: 'orrery-operation' }, launch, listen);
      })))),
      el('p', { class: 'field-hint', text: 'Tidewell, Frostmere and Cinder Forge can be played in any order. Rally all three before Council of Embers.' })],
    actions: [button('Back', () => ctx.go({ type: 'BACK' }), { variant: 'quiet' }),
      button('Workshop', () => ctx.openWorkshop?.(), { variant: 'quiet' }),
      button(cleared ? 'Continue campaign ▸' : 'Begin campaign ▸', () => ctx.startMission?.(next), { id: 'campaign-continue', variant: 'primary', primary: true })],
  });
}
