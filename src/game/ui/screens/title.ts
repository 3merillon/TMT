/** Title: the wordmark, the list menu and the active build. It stays up while the renderer warms up. */
import { activeKit } from '../../meta/profile';
import { menuItem } from '../components/controls';
import { el } from '../components/el';
import { kitSummary } from '../workshop-model';
import { prefetchWorkshop, prefetchWorkshopWhenIdle, prewarmWorkshop, prewarmWorkshopWhenIdle } from '../../workshop/assets';
import type { ScreenContext } from './context';
import { titleArt } from './title-art';

export function renderTitle(ctx: ScreenContext): HTMLElement {
  const { profile } = ctx;
  const build = profile.loadouts[profile.activeLoadout] ?? profile.loadouts[0];
  const { wins, matches } = profile.stats;
  // The workshop package downloads in the background, and its renderer compiles once the battle renderer has finished
  // its own; pointing at Workshop starts both at once, so it opens without waiting.
  prefetchWorkshopWhenIdle();
  if (ctx.viewReady) prewarmWorkshopWhenIdle();
  const workshop = menuItem('Workshop', () => ctx.go({ type: 'OPEN', screen: 'workshop' }), { id: 'title-workshop', index: '04', hint: 'Build, paint and test your tank' });
  for (const type of ['pointerenter', 'pointerdown', 'focus']) workshop.addEventListener(type, () => { void prefetchWorkshop().catch(() => {}); prewarmWorkshop(); }, { once: true, passive: true });
  const record = matches ? `${wins} ${wins === 1 ? 'win' : 'wins'} · ${matches} ${matches === 1 ? 'match' : 'matches'}` : 'No matches yet';
  return el('section', { class: 'title-screen', id: 'title' },
    el('div', { class: 'title-art-clip', 'aria-hidden': 'true' }, titleArt()),
    el('div', { class: 'title-hero' },
      el('img', { class: 'title-emblem', src: '/brand/tmt-emblem.svg', alt: '', width: '100', height: '100' }),
      el('header', { class: 'title-head' },
        el('h1', { class: 'wordmark' }, el('img', { src: '/brand/tmt-wordmark.webp', alt: 'TMT', width: '330', height: '110' })),
        el('p', { class: 'title-name', text: 'Tiny Metal Tank' }),
        el('p', { class: 'tagline', text: 'Small worlds. Big trouble.' }))),
    el('nav', { class: 'title-menu menu-list', 'aria-label': 'Main menu' },
      menuItem('Campaign', () => ctx.go({ type: 'OPEN', screen: 'campaign' }), { id: 'title-campaign', index: '01', hint: 'The Unwinding · 18 realtime operations', variant: 'primary', primary: true, badge: 'New' }),
      menuItem('Online Play', () => ctx.go({ type: 'OPEN', screen: 'online' }), { id: 'title-online', index: '02', hint: 'Quick Match · servers · private games · co-op' }),
      menuItem('Artillery Duel', () => ctx.go({ type: 'OPEN', screen: 'skirmish' }), { id: 'title-skirmish', index: '03', hint: 'Local play · AI or pass & play on this device' }),
      workshop,
      menuItem('Settings', () => ctx.go({ type: 'OPEN', screen: 'settings' }), { id: 'title-settings', index: '05', hint: 'Graphics, audio, keys, gameplay and profile' }),
      menuItem('How to play', () => ctx.go({ type: 'OPEN', screen: 'help' }), { id: 'title-help', index: '06', hint: 'Touch, mouse, keyboard and gamepad' }),
      menuItem('Engine playground', () => ctx.startPlayground?.(), { id: 'title-engine-dev', index: '07', hint: 'Developer sandbox' }),
      el('a', { id: 'title-donate', class: 'menu-item', href: 'https://buy.stripe.com/3cIcN77Lg7xv2g68sQdnW00', target: '_blank', rel: 'noopener noreferrer',
        'aria-label': 'Donate to 3merillon on Stripe (opens in a new tab)' },
        el('span', { class: 'mi-index', 'aria-hidden': 'true', text: '08' }),
        el('span', { class: 'mi-text' }, el('span', { class: 'mi-label', text: 'Donate on Stripe' }), el('span', { class: 'mi-hint', text: 'Support free, open-source development' })),
        el('span', { 'aria-hidden': 'true', text: '↗' })),
      el('footer', { class: 'title-footer', 'aria-label': 'Creator links' },
        el('span', { class: 'title-credit' }, 'Built by ', el('a', { id: 'title-creator', href: 'https://x.com/3merillon', target: '_blank', rel: 'noopener noreferrer',
          'aria-label': '@3merillon on X (opens in a new tab)', text: '@3merillon' })),
        el('a', { id: 'title-website', href: 'https://3merillon.com', target: '_blank', rel: 'noopener noreferrer',
          'aria-label': '3merillon developer website (opens in a new tab)', text: 'Developer website ↗' }))),
    el('aside', { class: 'title-build', 'aria-label': 'Active build' },
      el('span', { class: 'eyebrow', text: 'Active build' }),
      el('div', { class: 'title-build-name', text: build.name }),
      el('div', { class: 'title-build-kit', text: kitSummary(activeKit(profile)) }),
      el('div', { class: 'title-status' },
        el('span', { class: `lamp ${ctx.viewReady ? 'lit' : ''}`, 'aria-hidden': 'true' }),
        el('span', { id: 'title-status', text: ctx.viewReady ? 'Systems ready' : 'Warming up…' }),
        el('span', { class: 'title-record', text: record }))));
}
