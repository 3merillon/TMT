/** Prologue · Wind-Up: the three tutorial missions on Verdant Cradle (src/game/campaign/README.md). Each teaches one
 * or two verbs and practises the previous ones. Lines stay short; a hint appears only when the player is stuck. */
import type { V3 } from '../contracts';
import { normalize } from '../math';
import { SPEAKERS, type MissionContext, type MissionDef, type MissionId } from './mission';

const { sprocket, corvin, mags } = SPEAKERS;
/** The duel's player spawn on every seed: clear of the generated settlements around the pole. */
const START = { up: normalize([-0.3, 1, 0]) as V3, heading: Math.PI / 2 };
const CRADLE = { kind: 'temperate' as const, seed: 7 };

/** A beat that only waits (a closing line, a pause between lines). */
const pause = (id: string, seconds: number, enter?: (ctx: MissionContext) => void) => ({ id, enter, done: (ctx: MissionContext) => ctx.beatTime >= seconds });
/** Objective text with a live count, re-issued only when the count changes. */
function counted(ctx: MissionContext, id: string, text: string, group: string, total: number): void {
  const down = total - ctx.alive(group), key = `count:${id}`;
  if (ctx.flags[key] === down) return;
  ctx.flags[key] = down;
  ctx.objective(id, `${text} (${down}/${total})`);
}

export const FIRST_LIGHT: MissionDef = {
  id: 'p1', chapter: 'Prologue · Wind-Up', title: 'First Light', next: 'p2',
  briefing: 'Range day at the Cradle depot. Sergeant Sprocket wants to see whether the new crew can drive, shoot and keep their heads down.',
  planet: CRADLE, start: START, fog: true,
  sites: {
    flag: { bearing: 0, distance: 8 }, range: { bearing: 0, distance: 14 }, hidden: { bearing: 32, distance: 15 },
    battery: { bearing: 120, distance: 12 },
    // The moving target's loop stays 8 m or more beyond the range, so shooting at it never splashes the Kestrel.
    'lane-a': { bearing: 335, distance: 21 }, 'lane-b': { bearing: 350, distance: 26 }, 'lane-c': { bearing: 20, distance: 26 }, 'lane-d': { bearing: 40, distance: 21 },
  },
  // A concrete wall between the flag and the hidden target: the lob lesson does not depend on the terrain.
  structures: place => {
    const flag = place.site('flag'), hidden = place.site('hidden');
    const wall = normalize([0, 1, 2].map(i => flag[i] * 0.35 + hidden[i] * 0.65) as V3);
    return [place.block('wall', wall, flag, 5, 2.4, 0.6)];
  },
  medal: { text: 'Finish with at least 75% hull', earned: ctx => ctx.lowestHealth >= 0.75 },
  beats: [
    {
      id: 'roll-out',
      enter: ctx => {
        ctx.say(sprocket, "Morning rookie. Let's see if this crate still rolls. Drive to the flag.");
        ctx.objective('flag', 'Drive to the flag'); ctx.mark('flag', 'Flag');
      },
      done: ctx => ctx.near('flag', 3),
      exit: ctx => ctx.complete('flag'),
      hint: { text: 'Drive with W A S D (or the left stick). Hold the right mouse button and drag to look around.', after: 10 },
    },
    {
      id: 'targets',
      enter: ctx => {
        for (const side of [-3, 0, 3]) ctx.spawn('target', 'range', { group: 'targets', side, facing: 'flag' });
        ctx.say(sprocket, 'Three practice targets. Point at one and fire. Big gun, big hole.');
        ctx.mark('range', 'Targets');
      },
      update: ctx => counted(ctx, 'targets', 'Destroy the practice targets', 'targets', 3),
      done: ctx => ctx.cleared('targets'),
      exit: ctx => ctx.complete('targets'),
      hint: { text: 'Point at a target and fire: left click or Space (the fire button on touch). The gun needs a moment to reload.', after: 14 },
    },
    {
      id: 'lob',
      enter: ctx => {
        ctx.spawn('target', 'hidden', { group: 'hidden', facing: 'flag' });
        ctx.say(sprocket, "That one's hiding behind the wall. Shells fly in an arc, so lob one over.");
        ctx.objective('lob', 'Hit the target behind the wall'); ctx.mark('hidden', 'Target');
      },
      done: ctx => ctx.cleared('hidden'),
      exit: ctx => { ctx.complete('lob'); ctx.mark(null); },
      hint: { text: 'Aim at the target itself: when a wall is in the way, the aim takes the high arc on its own.', after: 15 },
    },
    {
      id: 'incoming',
      enter: ctx => {
        ctx.spawn('instructor', 'battery', { group: 'battery' });
        ctx.say(sprocket, "My turn. See the red ring? That's where my shell lands. Move!");
        ctx.objective('dodge', 'Dodge the incoming practice shells');
        ctx.flags.salvos = 0;
      },
      update: ctx => {
        const battery = ctx.group('battery')[0];
        if (battery && ctx.flags.salvos < 2 && ctx.beatTime >= 2.5 + ctx.flags.salvos * 4) {
          ctx.api.fireAt(battery.id, ctx.player.position, true);
          ctx.flags.salvos++;
        }
      },
      done: ctx => ctx.flags.salvos >= 2 && ctx.beatTime >= 13,
      exit: ctx => { ctx.complete('dodge'); ctx.say(sprocket, "Never sit still when the ring's on you."); },
    },
    {
      id: 'dig-in',
      enter: ctx => {
        ctx.say(sprocket, 'Craters are cover. Put a shell just in front of you. Not on your feet.');
        ctx.objective('dig', 'Dig in: land a shell within 4 m of the Kestrel');
        ctx.flags.impacts = ctx.api.impactsOf(ctx.api.player).length;
        for (const id of ctx.api.players ?? [ctx.api.player]) ctx.flags[`dig:impacts:${id}`] = ctx.api.impactsOf(id).length;
      },
      done: ctx => (ctx.api.players ?? [ctx.api.player]).some(id => {
        const tank = ctx.api.state.tanks[id];
        return tank?.health > 0 && !tank.retired && ctx.api.impactsOf(id).slice(ctx.flags[`dig:impacts:${id}`] ?? (id === ctx.api.player ? ctx.flags.impacts : 0))
          .some(p => Math.hypot(p[0] - tank.position[0], p[1] - tank.position[1], p[2] - tank.position[2]) <= 4.5);
      }),
      exit: ctx => { ctx.complete('dig'); ctx.say(sprocket, 'Now you have a hole to hide in. Remember that.'); },
      hint: { text: 'Aim at the ground a few metres ahead of your tank, then fire.', after: 12 },
    },
    {
      id: 'mover',
      enter: ctx => {
        // Range targets carry a beacon: visible beyond the horizon, and the marker follows it.
        const mover = ctx.spawn('mover', 'lane-a', { group: 'mover', patrol: ['lane-a', 'lane-b', 'lane-c', 'lane-d'], revealed: true });
        ctx.objective('mover', 'Destroy the moving target');
        if (mover !== null) ctx.mark({ tank: mover }, 'Moving target');
      },
      update: ctx => { if (ctx.beatTime >= 3.5 && !ctx.flags.told) { ctx.flags.told = 1; ctx.say(sprocket, "Last one moves. Lead it: aim where it's going to be."); } },
      done: ctx => ctx.cleared('mover'),
      exit: ctx => { ctx.complete('mover'); ctx.mark(null); },
      hint: { text: 'Shells take time to land. Aim ahead of the moving target.', after: 18 },
    },
    pause('debrief', 5, ctx => ctx.say(sprocket, 'Not bad rookie. Marshal Corvin will want to see you.')),
  ],
};

export const OVER_THE_CURVE: MissionDef = {
  id: 'p2', chapter: 'Prologue · Wind-Up', title: 'Over the Curve', next: 'p3',
  briefing: 'A first patrol past the depot. Scouts report movement beyond the ridge. On a world this small, the enemy is always just over the horizon.',
  planet: CRADLE, start: { up: START.up, heading: START.heading + Math.PI }, fog: true,
  sites: {
    start: { bearing: 0, distance: 0 }, lookout: { bearing: 330, distance: 10 }, field: { bearing: 350, distance: 23 },
    orchard: { bearing: 35, distance: 19 }, woods: { bearing: 280, distance: 15 },
  },
  medal: { text: 'Finish in under 7 minutes', earned: ctx => ctx.elapsed < 7 * 60 },
  beats: [
    {
      id: 'patrol',
      enter: ctx => {
        ctx.say(sprocket, 'Scouts saw something past the ridge. Get to the lookout and have a look.');
        ctx.objective('lookout', 'Reach the lookout'); ctx.mark('lookout', 'Lookout');
      },
      done: ctx => ctx.near('lookout', 3.5),
      exit: ctx => { ctx.complete('lookout'); ctx.mark(null); },
    },
    {
      id: 'swarm',
      enter: ctx => {
        for (const side of [-3, -1, 1, 3]) ctx.spawn('rustling', 'field', { group: 'swarm', side, facing: 'lookout', patrol: ['lookout'] });
        ctx.say(sprocket, 'Contacts! Little ones. The planet curves away fast, so things pop over the horizon close. Your machine gun fires on its own at whatever your turret faces.');
        ctx.flags.coaxLine = 0;
      },
      update: ctx => {
        counted(ctx, 'swarm', 'Destroy the Rustlings', 'swarm', 4);
        if (!ctx.flags.coaxLine && ctx.beatTime > 9) { ctx.flags.coaxLine = 1; ctx.say(sprocket, 'Save the big gun for the big ones.'); }
      },
      done: ctx => ctx.cleared('swarm'),
      exit: ctx => ctx.complete('swarm'),
      hint: { text: 'Turn your turret toward a Rustling: the machine gun fires by itself within about 12 m, until it overheats.', after: 12 },
    },
    {
      id: 'tosser',
      enter: ctx => {
        ctx.spawn('tosser', 'orchard', { group: 'tosser' });
        ctx.say(sprocket, "Something's lobbing at us from behind the curve! Watch the smoke trail. It comes from where the gun is.");
        ctx.objective('tosser', 'Find and destroy the Tosser');
        ctx.flags.salvos = 0;
      },
      update: ctx => {
        // Two scripted shells teach the trail and the ring: the first lands short, the second close.
        const tosser = ctx.group('tosser')[0];
        if (tosser && tosser.health > 0 && ctx.flags.salvos < 2 && ctx.beatTime >= 3 + ctx.flags.salvos * 6) {
          const p = ctx.player.position, t = tosser.position, short = ctx.flags.salvos === 0 ? 0.3 : 0.05;
          ctx.api.fireAt(tosser.id, [p[0] + (t[0] - p[0]) * short, p[1] + (t[1] - p[1]) * short, p[2] + (t[2] - p[2]) * short], true);
          ctx.flags.salvos++;
        }
        if (ctx.beatTime >= 30 && !ctx.flags.marked) { ctx.flags.marked = 1; ctx.mark('orchard', 'Tosser (last seen)'); }
      },
      done: ctx => ctx.cleared('tosser'),
      exit: ctx => { ctx.complete('tosser'); ctx.mark(null); },
      hint: { text: 'Drive toward where the shells come from. Once you can see the Tosser, it is an easy target.', after: 20 },
    },
    {
      id: 'ambush',
      enter: ctx => {
        for (const side of [-1.5, 1.5]) ctx.spawn('rusty', 'woods', { group: 'ambush', side });
        // The ambushers open on the Kestrel's known position, then hunt it by sight like any tank: a hill or a crater
        // between them really does block their fire.
        ctx.reveal(ctx.api.player, true);
        ctx.say(sprocket, "Two more, on your left! They've spotted you. Use the ground, a crater, anything!");
      },
      update: ctx => {
        // A flag set when the reveal ends (not when it starts), so a save from before this rule also drops it.
        if (!ctx.flags.lostSight && ctx.beatTime >= 5) { ctx.flags.lostSight = 1; ctx.reveal(ctx.api.player, false); }
        counted(ctx, 'ambush', 'Survive the ambush', 'ambush', 2);
      },
      done: ctx => ctx.cleared('ambush'),
      exit: ctx => { ctx.reveal(ctx.api.player, false); ctx.complete('ambush'); },
      hint: { text: 'Keep moving between shots. A hill or a crater between you and them blocks their fire.', after: 20 },
    },
    {
      id: 'home',
      enter: ctx => {
        ctx.say(sprocket, "That's the patrol. Back to the start line.");
        ctx.objective('home', 'Return to the start line'); ctx.mark('start', 'Start line');
      },
      done: ctx => ctx.near('start', 3.5),
      exit: ctx => { ctx.complete('home'); ctx.mark(null); },
    },
    pause('report', 6, ctx => ctx.say(corvin, "Good work, Kestrel. Something's stirring at Millbrook. Get some rest; you ride at dawn.")),
  ],
};

export const MILLBROOK: MissionDef = {
  id: 'p3', next: '1-1', chapter: 'Prologue · Wind-Up', title: 'Millbrook',
  briefing: 'Millbrook has gone quiet. Marshal Corvin sends the Kestrel ahead of his column to hold the old mill until he arrives.',
  planet: CRADLE, start: { up: START.up, heading: START.heading - Math.PI / 2 }, fog: true,
  sites: {
    mill: { bearing: 0, distance: 15 }, ridge: { bearing: 20, distance: 22 }, 'ridge-west': { bearing: 350, distance: 25 },
    'ridge-east': { bearing: 18, distance: 26 }, pond: { bearing: 335, distance: 19 }, wing: { bearing: 270, distance: 2.5 },
  },
  structures: place => {
    const mill = place.site('mill'), start = place.site('wing');
    return [
      place.block('mill-house', place.site('mill', 3.2), mill, 2.4, 2.2, 2.4, 3),
      place.block('mill-barn', place.site('mill', -3.4), start, 3.2, 1.6, 2.0, 3),
    ];
  },
  medal: { text: 'Mags is never knocked out', earned: ctx => ctx.alive('mags') > 0 },
  beats: [
    {
      id: 'rendezvous',
      enter: ctx => {
        ctx.spawn('mags', 'wing', { group: 'mags', facing: 'mill' });
        ctx.say(corvin, "Rook, Millbrook's gone quiet. Hold the mill until my column arrives. Mags is riding with you.");
        ctx.objective('mill', 'Reach Millbrook mill'); ctx.mark('mill', 'Millbrook');
      },
      update: ctx => { if (ctx.beatTime >= 6 && !ctx.flags.hello) { ctx.flags.hello = 1; ctx.say(mags, "Mags Holloway, at your service. I'll stick to your flank. Try to keep up."); } },
      done: ctx => ctx.near('mill', 4.5),
      exit: ctx => { ctx.complete('mill'); ctx.mark(null); },
    },
    {
      id: 'first-wave',
      enter: ctx => {
        for (const side of [-2, 0, 2]) ctx.spawn('rustling', 'ridge-west', { group: 'wave1', side, patrol: ['mill'] });
        ctx.spawn('rusty', 'ridge-east', { group: 'wave1', patrol: ['mill'] });
        ctx.say(mags, "They're coming over the ridge! I've got your flank.");
      },
      update: ctx => counted(ctx, 'wave1', 'Hold the mill: destroy the first wave', 'wave1', 4),
      done: ctx => ctx.cleared('wave1'),
      exit: ctx => ctx.complete('wave1'),
      hint: { text: 'Mags fights on her own. Keep the mill between you and their guns.', after: 25 },
    },
    {
      id: 'spotter',
      enter: ctx => {
        ctx.spawn('tosser', 'ridge', { group: 'lobber', revealed: true });
        ctx.reveal(ctx.api.player, true);
        ctx.say(mags, "There's a lobber on the ridge. I can see it from here, so I'm marking it for you.");
        ctx.objective('lobber', 'Destroy the marked Tosser'); ctx.mark('ridge', 'Tosser');
      },
      done: ctx => ctx.cleared('lobber'),
      exit: ctx => { ctx.reveal(ctx.api.player, false); ctx.complete('lobber'); ctx.mark(null); },
      hint: { text: 'A marked enemy shows even beyond the horizon. Shell it from where you are, then move before its reply lands.', after: 20 },
    },
    {
      id: 'spire',
      enter: ctx => {
        ctx.spawn('spire', 'pond', { group: 'spire', revealed: true, facing: 'mill' });
        ctx.say(mags, "The pond is boiling... Something's coming up out of it!");
        ctx.objective('spire', 'Destroy the Rust Spire'); ctx.mark('pond', 'Rust Spire');
        ctx.flags.nextWave = 12;
      },
      update: ctx => {
        if (ctx.alive('spire') && ctx.beatTime >= ctx.flags.nextWave) {
          ctx.flags.nextWave += 20;
          for (const side of [-2, 2]) ctx.spawn('rustling', 'pond', { group: 'spawn', side, patrol: ['mill'] });
          if (!ctx.flags.warned) { ctx.flags.warned = 1; ctx.say(mags, 'It keeps spitting those little ones out. Take the big one down!'); }
        }
      },
      done: ctx => ctx.cleared('spire'),
      exit: ctx => { ctx.complete('spire'); ctx.mark(null); },
      hint: { text: 'The Spire is armoured at the front. Hit it from the side, or use heavy shells if you have them.', after: 30 },
    },
    pause('relief', 6, ctx => ctx.say(corvin, "Hold your fire, the column's here. Well done, Rook. Better than I'd hoped.")),
    pause('shard', 6, ctx => ctx.say(corvin, "And what's this... still warm. I'll keep this shard of the core. For study.")),
  ],
};

export const PROLOGUE: readonly MissionDef[] = Object.freeze([FIRST_LIGHT, OVER_THE_CURVE, MILLBROOK]);
export function missionById(id: MissionId): MissionDef {
  const def = PROLOGUE.find(m => m.id === id);
  if (!def) throw new Error(`Unknown mission '${id}'`);
  return def;
}
