import type { Beat } from './mission';

export function whiteout(): Beat {
  return {
    id: 'whiteout',
    enter(c) {
      c.spawn('watchtower', 'watch-east', { group: 'watchers', facing: 'start', revealed: true });
      c.spawn('watchtower', 'watch-west', { group: 'watchers', facing: 'depot', revealed: true });
      c.flags['whiteout:alarms'] = 0; c.flags['whiteout:last'] = -30; c.flags['whiteout:route'] = 0;
      c.objective('whiteout', 'Reach the observatory. Keep your lights off and stay below the search beams.');
      c.mark('depot', 'Observatory approach');
      c.say('Mags', 'Searchlights on the ridge. Switch your headlights off. A trench hides your hull; a shell into a tower base shuts its projector down.');
    },
    update(c) {
      const route = ['depot', 'ridge', 'archive'];
      const index = c.flags['whiteout:route'];
      if (index < route.length - 1 && c.near(route[index], 3)) {
        c.flags['whiteout:route']++;
        c.mark(route[index + 1], index === 1 ? 'Free Seraphine' : 'Observatory approach');
      }
      const detected = (c.api.players ?? [c.api.player]).some(id => {
        const tank = c.api.state.tanks[id]; return tank?.health > 0 && !tank.retired && (tank.detection ?? 0) >= 1;
      });
      if (!detected || c.beatTime - c.flags['whiteout:last'] < 30) return;
      c.flags['whiteout:last'] = c.beatTime; c.flags['whiteout:alarms']++;
      c.api.emit({ type: 'audio', cue: { type: 'ui', sound: 'alarm' } });
      c.api.emit({ type: 'banner', title: 'SEARCHLIGHT ALARM', subtitle: 'Break line of sight. Reinforcements incoming.' });
      if (c.alive('whiteout-patrol') < 4) {
        c.spawn('rustling', 'archive', { group: 'whiteout-patrol', side: 2, patrol: ['depot'] });
        c.spawn('rustling', 'archive', { group: 'whiteout-patrol', side: -2, patrol: ['depot'] });
        c.spawn('vex', 'ridge', { group: 'whiteout-patrol', patrol: ['depot'] });
      }
      if (c.flags['whiteout:alarms'] === 1) c.say('Sgt. Sprocket', 'They saw you. Break the beam or get behind the ridge. You can still reach the prison.');
    },
    done: c => c.near('archive', 3),
    exit(c) { c.complete('whiteout'); c.mark(null); },
    hint: { after: 25, text: 'Lights off prevents distant headlight glints. Watch the detection bar. Terrain blocks the beam: dig, circle behind a tower, or destroy its base.' },
  };
}
