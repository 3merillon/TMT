/** Campaign verbs. Completion is driven by gameplay state and committed terrain, never a cutscene timer. */
import type { Beat, MissionContext, UnitKind } from './mission';
import { distance, length, normalize } from '../math';
export const travel = (id: string, site: string, text: string, speaker = 'Sgt. Sprocket'): Beat => ({
  id, enter(c) { c.objective(id, text); c.mark(site, text); c.say(speaker, text); },
  done: c => c.near(site, 3), exit: c => c.complete(id), hint: { after: 18, text: 'Follow the brass objective marker. Scan to locate enemies beyond the curve.' },
});
export function battle(id: string, site: string, kinds: readonly UnitKind[], text: string): Beat {
  return { id, enter(c) {
    c.objective(id, text); c.say('Mags', text);
    kinds.forEach((kind, i) => c.spawn(kind, site, { group: id, side: (i - (kinds.length - 1) / 2) * 2.5, revealed: true, patrol: ['start'] }));
    c.mark(site, text);
  }, update(c) { const enemy = c.group(id).find(t => t.health > 0); if (enemy && c.api.tick % 60 === 0) c.mark({ tank: enemy.id }, enemy.name); },
  done: c => c.cleared(id), exit: c => c.complete(id), hint: { after: 25, text: 'Move between main-gun shots. Close enough for the coax to help, and flank reactive front armor.' } };
}
export function hold(id: string, site: string, seconds: number, lanes: readonly string[], count = 3): Beat {
  return { id, enter(c) {
    c.spawn('relay', site, { group: id, name: 'Lantern relay' }); c.objective(id, `Defend the relay for ${Math.ceil(seconds / 60)} minutes`);
    c.mark(site, 'Defence perimeter'); c.say('Sgt. Sprocket', 'Keep the relay alive. Dig cover, watch the rings, and repair at the pad.');
    c.flags[`${id}:wave`] = 0;
  }, update(c) {
    if (!c.alive(id)) { c.lose('The relay was destroyed.'); return; }
    const wave = c.flags[`${id}:wave`];
    if (c.beatTime >= wave * 26 && c.alive(`${id}:attackers`) < 8) {
      for (let i = 0; i < count; i++) c.spawn(i === count - 1 && wave % 3 === 2 ? 'tosser' : 'rustling', lanes[wave % lanes.length], { group: `${id}:attackers`, side: (i - 1) * 2, patrol: [site] });
      c.flags[`${id}:wave`]++;
    }
    // The service footprint follows a surface direction, not the height of a crater at its centre.
    // A tank on the rim remains inside the pad even after bombardment lowers the middle.
    const onPad = (c.api.players ?? [c.api.player]).filter(id => {
      const tank = c.api.state.tanks[id];
      return tank?.health > 0 && !tank.retired && distance(normalize(tank.position), normalize(c.at(site))) * c.api.world.radius < 4;
    });
    for (const id of onPad) c.api.heal(id, 3 / 60);
    if (onPad.length) for (const relay of c.group(id)) c.api.heal(relay.id, 2 / 60);
    if (c.api.tick % 60 === 0) {
      c.objective(id, `Protect relay · ${Math.max(0, Math.ceil(seconds - c.beatTime))} s remaining`);
      c.mark(site, 'Defence perimeter');
    }
  }, done: c => c.beatTime >= seconds && c.alive(id) > 0, exit: c => c.complete(id),
  hint: { after: 30, text: 'The relay pad repairs you. Incoming rings are warnings to move; swarms can be cleared by the coax.' } };
}
export function capture(id: string, site: string): Beat {
  return { id, enter(c) { c.flags[id] = 0; c.objective(id, 'Capture the depot: hold the pad for five seconds'); c.mark(site, 'Capture pad'); },
    update(c) {
      const contested = c.api.state.tanks.some(t => t.team === 1 && t.health > 0 && distance(t.position, c.at(site)) < 5);
      c.flags[id] = c.near(site, 3) && !contested ? c.flags[id] + (c.api.crew.commander >= 3 ? 2 : 1) / 60 : Math.max(0, c.flags[id] - 1 / 60);
      if (c.api.tick % 60 === 0) { c.objective(id, contested ? 'Depot contested: clear enemies from the pad' : `Capture depot · ${Math.floor(c.flags[id])}/5 s`); if (!contested && c.near(site, 3)) c.api.emit({ type: 'audio', cue: { type: 'ui', sound: 'capture-tick' } }); }
    }, done: c => c.flags[id] >= 5, exit(c) { c.flags[`depot:${site}`] = 1; c.complete(id); c.api.emit({ type: 'audio', cue: { type: 'ui', sound: 'depot-ping' } }); c.say('Brann', 'Depot online. Park here to repair.'); },
    hint: { after: 20, text: 'Stay inside the marker. Enemy vehicles inside the pad contest it.' } };
}
export function depotService(c: MissionContext, site: string): void {
  if (!c.flags[`depot:${site}`]) return;
  for (const t of c.api.state.tanks) if (t.team === 0 && t.health > 0 && distance(t.position, c.at(site)) < 4) c.api.heal(t.id, 8 / 60);
}
export function undermine(id: string, site: string, text: string): Beat {
  return { id: `undermine-${id}`, enter(c) {
    c.flags[id] = length(c.at(site)); c.spawn('spire', site, { group: id, revealed: true });
    c.objective(id, text); c.mark(site, 'Shoot the foundation'); c.say('Mags', 'The soil carries the weight. Put a shell at its foot.');
  }, update(c) { if (length(c.at(site)) < c.flags[id] - .55) for (const t of c.group(id)) c.api.damage(t.id, 1000, 'undermined'); },
  done: c => length(c.at(site)) < c.flags[id] - .55,
  exit(c) { c.complete(id); c.api.emit({ type: 'audio', cue: { type: 'stinger', id: 'undermined' } }); c.api.emit({ type: 'banner', title: 'UNDERMINED', subtitle: text }); },
  hint: { after: 20, text: 'Aim at the ground under the structure, not its upper armor. A committed crater must lower the foundation.' } };
}
export function escort(id: string, route: readonly string[]): Beat {
  return { id, enter(c) { c.spawn('caravan', route[0], { group: id }); c.flags[id] = 1; c.objective(id, 'Escort the caravan to the archive'); c.say('Marshal Corvin', 'Stay with the caravan, Rook. We travel together.'); },
    update(c) {
      const wagon = c.group(id)[0]; if (!wagon || wagon.health <= 0) { c.lose('The caravan was lost.'); return; }
      const index = c.flags[id], site = route[Math.min(index, route.length - 1)];
      const escorted = (c.api.players ?? [c.api.player]).some(id => {
        const tank = c.api.state.tanks[id]; return tank?.health > 0 && !tank.retired && distance(wagon.position, tank.position) < 8;
      });
      c.api.order(wagon.id, escorted ? c.at(site) : null);
      if (distance(wagon.position, c.at(site)) < 2.5) c.flags[id]++;
      if (c.api.tick % 60 === 0) c.mark({ tank: wagon.id }, `Caravan · ${Math.min(index, route.length - 1)}/${route.length - 1}`);
    }, done: c => c.flags[id] >= route.length, exit: c => c.complete(id),
    hint: { after: 20, text: 'Stay within eight metres of the caravan to keep it moving. Clear threats before advancing.' } };
}
export function radio(id: string, speaker: string, text: string, seconds = 5): Beat {
  return { id, enter: c => c.say(speaker, text), done: c => c.beatTime >= seconds };
}
