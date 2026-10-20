/** The Crawler is one physical chassis with seven independently damageable assemblies. */
import type { Beat } from './mission';
import { activeComponents, componentPoint, componentStage } from '../realtime/components';
import { distance } from '../math';

export function siegeCrawler(): Beat {
  return {
    id: 'crawler',
    enter(c) {
      c.spawn('crawler', 'road0', { group: 'crawler', revealed: true, facing: 'road1' });
      c.flags['crawler:road'] = 1; c.flags['crawler:phase'] = 0; c.flags['crawler:salvo'] = -8;
      c.objective('crawler', 'Disable four drive assemblies before the Crawler reaches the archive');
      c.api.emit({ type: 'audio', cue: { type: 'boss', id: 'crawler', phase: 0 } });
      c.say('Mags', 'Four exposed final drives. Break those brass hubs and the Crawler stops. The thick hull will just shrug it off.');
    },
    update(c) {
      const boss = c.group('crawler')[0]; if (!boss || boss.health <= 0) return;
      const phase = componentStage(boss), road = c.flags['crawler:road'];
      if (phase === 0) {
        const goal = c.at(`road${road % 8}`); c.api.order(boss.id, goal);
        if (distance(boss.position, goal) < 2.5) c.flags['crawler:road']++;
        if (road > 8) { c.lose('The Siege Crawler reached the archive. Disable its drives before it completes the circuit.'); return; }
      } else c.api.order(boss.id, null);
      if (phase < 2 && c.beatTime - c.flags['crawler:salvo'] > 8 && c.api.fireAt(boss.id, c.player.position, true)) c.flags['crawler:salvo'] = c.beatTime;
      if (phase !== c.flags['crawler:phase']) {
        c.flags['crawler:phase'] = phase;
        c.api.emit({ type: 'audio', cue: { type: 'boss', id: 'crawler', phase } });
        c.api.emit({ type: 'banner', title: phase === 1 ? 'CRAWLER IMMOBILIZED' : 'CORE EXPOSED' });
        if (phase === 1) {
          c.say('Mags', 'It cannot move. The two mortar feeds are exposed. Cut them off before the next salvo.');
          c.spawn('hornet', 'road0', { group: 'crawler-escort', side: 3, patrol: ['start'] });
          c.spawn('hornet', 'road0', { group: 'crawler-escort', side: -3, patrol: ['start'] });
        } else c.say('Sgt. Sprocket', 'Guns silent. The furnace vent is open at the rear. Finish it, Rook!');
      }
      if (c.api.tick % 15 === 0) {
        const targets = activeComponents(boss).sort((a, b) => distance(componentPoint(boss, a), c.player.position) - distance(componentPoint(boss, b), c.player.position));
        if (targets[0]) c.mark({ tank: boss.id, component: targets[0].id }, targets[0].name);
        c.objective('crawler', phase === 0 ? `Disable drives · ${4 - targets.length}/4 · Archive approach ${Math.min(8, road - 1)}/8`
          : phase === 1 ? `Silence mortar feeds · ${2 - targets.length}/2` : 'Destroy the exposed furnace core at the rear');
      }
    },
    done: c => c.cleared('crawler'),
    exit(c) { c.complete('crawler'); c.mark(null); c.api.emit({ type: 'audio', cue: { type: 'boss-end' } }); },
    hint: { after: 20, text: 'The brass assemblies are separate targets. Flank the Crawler and aim at a marked hub. Hull hits cannot bypass the armored stages.' },
  };
}
