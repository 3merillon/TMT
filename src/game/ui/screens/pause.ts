/** Pause (Escape): resume, restart, settings, forfeit. The simulation is paused while any screen is up. */
import { menuItem } from '../components/controls';
import { el } from '../components/el';
import { screenCard } from '../components/panel';
import type { ScreenContext } from './context';

export function renderPause(ctx: ScreenContext): HTMLElement {
  const campaign = ctx.campaign === true;
  return screenCard({
    id: 'pause', eyebrow: ctx.online ? 'ONLINE MATCH CONTINUES' : 'MATCH PAUSED', title: ctx.online ? 'Match menu' : 'Paused', size: 'narrow', class: 'pause-card', dismiss: () => ctx.go({ type: 'RESUME' }),
    body: [
      el('nav', { class: 'menu-list menu-stack', 'aria-label': 'Pause menu' },
        menuItem('Resume', () => ctx.go({ type: 'RESUME' }), { id: 'pause-resume', variant: 'primary', primary: true, hint: 'Back to the battlefield' }),
        ctx.online ? null : menuItem(campaign ? 'Restart mission' : 'Restart', () => ctx.go({ type: 'RESTART', fresh: true }),
          { id: 'pause-restart', hint: campaign ? 'From the beginning, at full health (drops the checkpoint)' : 'Start this attempt again' }),
        menuItem('Settings', () => ctx.go({ type: 'OPEN', screen: 'settings' }), { id: 'pause-settings', hint: 'Graphics, audio and gameplay' }),
        menuItem(ctx.online ? 'Leave server' : 'Leave battlefield', () => ctx.online ? ctx.leaveOnline?.() : ctx.go({ type: 'LEAVE' }), { id: 'pause-leave', hint: ctx.online ? 'Transfer host when a recovery checkpoint is available' : 'Menu · Forward returns to this game' }),
        ctx.online ? null : menuItem('Forfeit', () => ctx.forfeit(), { id: 'pause-forfeit', variant: 'danger', hint: 'End the match without a winner' })),
      el('p', { class: 'field-hint center', text: 'Esc resumes · Browser Back returns to the menu' }),
    ],
  });
}
