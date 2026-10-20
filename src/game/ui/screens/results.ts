/** Results: the outcome, the match stats and the record, then retry or back to the menu. */
import { button } from '../components/controls';
import { el } from '../components/el';
import { screenCard, statGrid } from '../components/panel';
import type { ScreenContext } from './context';

export function renderResults(ctx: ScreenContext): HTMLElement {
  const summary = ctx.summary ?? { title: 'Match over.', eyebrow: 'MATCH COMPLETE', detail: '', stats: [], outcome: 'other' as const };
  const { stats } = ctx.profile;
  return screenCard({
    id: 'results', eyebrow: summary.eyebrow, title: summary.title, subtitle: summary.detail, size: 'narrow', class: `results-card outcome-${summary.outcome}`,
    body: [
      el('div', { class: 'results-medal', 'aria-hidden': 'true' }, summary.outcome === 'win' ? '★' : summary.outcome === 'draw' ? '⚖' : summary.outcome === 'forfeit' ? '⚑' : '✦'),
      summary.stats.length ? statGrid(summary.stats) : null,
      el('p', { class: 'field-hint center', id: 'results-record', text: `Record: ${stats.wins} ${stats.wins === 1 ? 'win' : 'wins'} in ${stats.matches} ${stats.matches === 1 ? 'match' : 'matches'}` }),
    ],
    actions: ctx.onlineEnded ? [
      button('Invite another player', () => ctx.rematchOnline?.(), { id: 'results-rematch', variant: 'quiet' }),
      button('Find another game', () => ctx.leaveOnline?.(), { id: 'results-online', variant: 'primary', primary: true }),
    ] : ctx.online ? [
      button('Leave server', () => ctx.leaveOnline?.(), { id: 'results-online', variant: 'quiet' }),
      ...(ctx.onlineHost ? [button('Play again together', () => ctx.rematchOnline?.(), { id: 'results-rematch', variant: 'primary', primary: true }),
        ...(summary.next && summary.outcome === 'win' ? [button('Next mission', () => ctx.rematchOnline?.(summary.next), { id: 'results-online-next', variant: 'primary' })] : [])] : [el('p', { class: 'field-hint', text: 'Waiting for the host to choose the next round.' })]),
    ] : summary.next && summary.outcome === 'win' && ctx.startMission ? [
      button('Menu', () => ctx.go({ type: 'MENU' }), { id: 'results-menu', variant: 'quiet' }),
      button('Replay ↻', () => ctx.go({ type: 'RESTART' }), { id: 'results-retry', variant: 'quiet' }),
      button('Next mission ▸', () => ctx.startMission!(summary.next!), { id: 'results-next', variant: 'primary', primary: true }),
    ] : summary.checkpoint ? [
      button('Menu', () => ctx.go({ type: 'MENU' }), { id: 'results-menu', variant: 'quiet' }),
      button('Restart mission', () => ctx.go({ type: 'RESTART', fresh: true }), { id: 'results-restart', variant: 'quiet' }),
      button('Retry from checkpoint ↻', () => ctx.go({ type: 'RESTART' }), { id: 'results-retry', variant: 'primary', primary: true }),
    ] : [
      button('Menu', () => ctx.go({ type: 'MENU' }), { id: 'results-menu', variant: 'quiet' }),
      button('Retry ↻', () => ctx.go({ type: 'RESTART' }), { id: 'results-retry', variant: 'primary', primary: true }),
    ],
  });
}
