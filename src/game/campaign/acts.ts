/** The Unwinding: authored operations after Wind-Up. Shared verbs are in beats.ts. */
import type { Beat, MissionDef, MissionId, SiteDef } from './mission';
import { battle, capture, depotService, escort, hold, radio, travel, undermine } from './beats';
import { normalize } from '../math';
import { siegeCrawler } from './bosses';
import { TERRAIN_RADIUS } from '../terrain-config';
import { LAUNCH_POSTS, launchDefence } from './launch-defence';
import { whiteout } from './whiteout';
import type { AudioCue } from '../audio-cues';
/** Audio cues around a beat, emitted as realtime events after its own enter/exit (presentation only). */
const cued = (beat: Beat, enter: readonly AudioCue[], exit: readonly AudioCue[] = []): Beat => ({ ...beat,
  enter: c => { beat.enter?.(c); for (const cue of enter) c.api.emit({ type: 'audio', cue }); }, exit: c => { beat.exit?.(c); for (const cue of exit) c.api.emit({ type: 'audio', cue }); } });
const bossBeat = (beat: Beat, id: string, phase = 0, end = true): Beat => cued(beat, [{ type: 'boss', id, phase }], end ? [{ type: 'boss-end' }] : []);
const start = { up: normalize([-.3, 1, 0]), heading: Math.PI / 2 };
const sites: Record<string, SiteDef> = {
  start: { bearing: 0, distance: 0 }, depot: { bearing: 0, distance: 8 }, east: { bearing: 65, distance: 18 },
  west: { bearing: 300, distance: 19 }, ridge: { bearing: 15, distance: 24 }, archive: { bearing: 0, distance: 38 },
  cache: { bearing: 100, distance: 10 }, toy: { bearing: 270, distance: 9 }, exit: { bearing: 160, distance: 18 },
};
type Operation = Pick<MissionDef, 'id' | 'title' | 'briefing' | 'beats'> & Partial<MissionDef>;
function mission(act: string, kind: MissionDef['planet']['kind'], worldName: string, op: Operation): MissionDef {
  return { chapter: act, planet: { kind, seed: 7 }, worldName, start, sites, fog: true,
    routes: [['start', 'depot'], ['depot', 'east'], ['depot', 'west'], ['depot', 'ridge'], ['ridge', 'archive'], ['start', 'exit'], ['start', 'cache'], ['start', 'toy']],
    optional: { site: 'cache', text: 'Recover the stranded supply cache', reward: 'Repair Kit' }, secrets: ['toy'],
    medal: { text: 'Keep the Kestrel above half hull', earned: c => c.lowestHealth >= .5 },
    update: c => depotService(c, 'depot'),
    structures: p => [p.block('depot-pad', p.site('depot'), p.site('start'), 4, .03, 4)], ...op };
}
const a1 = (op: Operation, dune = false) => mission('Act I · The Rusting', dune ? 'dune' : 'temperate', dune ? 'Amber Reach' : 'Verdant Cradle', op);
export const ACT_I: readonly MissionDef[] = [
  a1({ id: '1-1', title: 'Lantern Hill', requires: ['p3'], next: '1-2', unlocks: ['smoke'],
    briefing: 'The lamp relay is our last voice to the regiment. Hold the hill until its message reaches Corvin.',
    intel: 'The relay pad repairs your hull. Dig cover before each wave and leave room to dodge.',
    beats: [travel('approach', 'depot', 'Reach the lamp relay'), hold('relay', 'depot', 360, ['east', 'west', 'ridge']), radio('message', 'Sgt. Sprocket', 'Signal received. The regiment is coming. You kept the light on.')] }),
  a1({ id: '1-2', title: 'Orchard Depot', requires: ['1-1'], next: '1-3', unlocks: ['gadget:lucky-cog'],
    briefing: 'The orchard depot has fallen. Recapture its repair pad and sever the foundations of three Rust Spires.',
    intel: 'Concrete protects the tower. Soil supports it. Attack the soil.',
    beats: [battle('guards', 'depot', ['rustling', 'rusty'], 'Clear the depot guards'), capture('capture', 'depot'),
      undermine('spire-east', 'east', 'Undermine the eastern Spire'), undermine('spire-west', 'west', 'Undermine the western Spire'), undermine('spire-ridge', 'ridge', 'Undermine the ridge Spire')] }),
  a1({ id: '1-3', title: 'Windward', requires: ['1-2'], next: '1-4', unlocks: ['blueprint:drill'],
    briefing: 'Cross Amber Reach with Corvin’s caravan. The wind carries shells across the canyon. Vex watches the rim.',
    intel: 'The caravan waits when you fall behind. Keep your front armor toward the sniper while reversing.',
    rules: { wind: { mean: .6, gust: .3, period: 16 } },
    beats: [battle('rim', 'east', ['vex', 'bulwark'], 'Break the canyon ambush'), escort('caravan', ['depot', 'ridge', 'archive']), radio('arrival', 'Marshal Corvin', 'An archive older than the sun. Imagine what we might learn.')] }, true),
  a1({ id: '1-4', title: 'Glass Canyon', requires: ['1-3'], next: '1-5', unlocks: ['ability:winch'],
    optional: { site: 'cache', text: 'Recover the navigation case', reward: 'Mags Compass' },
    briefing: 'The Wright archive lies beyond an abandoned glassworks. Break the old chimney’s footing to open a path.',
    intel: 'A shell at a structure’s foot cuts the support and lets gravity do the work.',
    structures: p => [p.block('chimney', p.site('ridge'), p.site('start'), 1.4, 7, 1.4)],
    beats: [travel('entry', 'depot', 'Enter the glassworks'), undermine('chimney', 'ridge', 'Break the chimney foundation'),
      battle('guardians', 'archive', ['hornet', 'rustling', 'rusty'], 'Clear the archive approach'), travel('archive', 'archive', 'Reach the Wright archive'),
      radio('truth', 'Mags', 'It isn’t a plague. The Rust is a recycler. The Wrights built it to remake the worlds.')] }, true),
  a1({ id: '1-5', title: 'The Siege Crawler', requires: ['1-4'], next: 't-a', unlocks: ['blueprint:twin-howitzer'],
    briefing: 'A siege battery is rolling toward the archive. Disable its outer defence, mortar pods and armored core.',
    intel: 'The exposed brass drive housings are separate targets. Four drives, two mortar feeds, then the rear core.',
    sites: { ...sites, ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`road${i}`, { bearing: 0, distance: 8 + i * Math.PI * TERRAIN_RADIUS / 4 }])) },
    routes: [['start', 'road0'], ...Array.from({ length: 8 }, (_, i) => [`road${i}`, `road${(i + 1) % 8}`] as const)],
    beats: [siegeCrawler(),
      radio('betrayal', 'Marshal Corvin', 'The Key can rewind the Mainspring. I will not let our worlds die because you are afraid of the price.'),
      radio('abandoned', 'Mags', 'He took the Key. Rook… the regiment is following him. We’re on our own.')] }, true),
];
const a2 = (kind: MissionDef['planet']['kind'], world: string, op: Operation) => mission('Act II · Embers and Aether', kind, world, op);
export const ACT_II: readonly MissionDef[] = [
  a2('temperate', 'Tidewell', { id: 't-a', title: 'Skipping Stones', requires: ['1-5'], next: 't-b', unlocks: ['blueprint:paddle'],
    briefing: 'Win Tidewell’s harbor. Break the Rust’s shore batteries and recover the harbor master’s charts.',
    intel: 'Aim low at the pontoon foundations. The harbor is a repair stop once captured.',
    beats: [battle('shore', 'depot', ['rustling', 'hornet'], 'Secure the harbor'), capture('harbor', 'depot'), undermine('pontoon', 'east', 'Sink the Rust pontoon'), travel('charts', 'archive', 'Recover the harbor charts')] }),
  a2('temperate', 'Tidewell', { id: 't-b', title: 'Tidebreak Dam', requires: ['t-a'], unlocks: ['alliance:tidewell'],
    briefing: 'The Rust holds the dam and the old valley road. Break its supports, then bring down the Leviathan battery.',
    intel: 'The dam wall is thick. Its buttresses are exposed at the eastern and western footings.',
    structures: p => [p.block('dam', p.site('ridge'), p.site('start'), 10, 4, 1.2)],
    beats: [undermine('buttress-east', 'east', 'Cut the eastern dam footing'), undermine('buttress-west', 'west', 'Cut the western dam footing'),
      bossBeat(battle('leviathan', 'ridge', ['bulwark', 'tosser'], 'Defeat the Leviathan battery'), 'leviathan'), radio('fleet', 'Harbor Master', 'Our ships are yours. Tidewell sails with the Kestrel.')] }),
  a2('glacial', 'Frostmere', { id: 'f-a', title: 'Whiteout', requires: ['1-5'], next: 'f-b', unlocks: ['companion:seraphine'], timeOfDay: .65,
    briefing: 'Seraphine is a prisoner in the frozen observatory. Cross the whiteout and silence its watchers.',
    intel: 'Turn your headlights off. Stay out of the sweeping beams, use a ridge or trench as cover, or shell the projector bases. An alarm calls patrols but does not end the mission.',
    sites: { ...sites, 'watch-east': { bearing: 35, distance: 17 }, 'watch-west': { bearing: 340, distance: 28 } },
    medal: { text: 'Reach Seraphine without triggering an alarm', earned: c => c.flags['whiteout:alarms'] === 0 },
    beats: [whiteout(), radio('astronomer', 'Seraphine', 'The Lantern is not dying. It is waiting. I can show you another way.')] }),
  a2('glacial', 'Frostmere', { id: 'f-b', title: 'The Frost Titan', requires: ['f-a'], unlocks: ['alliance:frostmere', 'blueprint:arc-projector'],
    briefing: 'The Titan anchors its armor to the ice pylons. Cut away their support and finish the exposed battery.',
    intel: 'Attack the ground below each pylon. A crater that severs the foundation is the objective.',
    beats: [undermine('ice-east', 'east', 'Calve the eastern ice pylon'), undermine('ice-west', 'west', 'Calve the western ice pylon'),
      bossBeat(battle('titan', 'ridge', ['bulwark', 'spire'], 'Destroy the exposed Frost Titan'), 'titan'), radio('accord', 'Seraphine', 'The Ascendancy will stand with you. Even beside the Forge.')] }),
  a2('volcanic', 'Cinder Forge', { id: 'c-a', title: 'Foundry', requires: ['1-5'], next: 'c-b', unlocks: ['companion:brann'],
    optional: { site: 'cache', text: 'Recover the armor rivets', reward: 'Branns Rivets' },
    briefing: 'Brann’s foundry is under siege. Clear the repair depot, then cut the supports feeding the Rust furnace.',
    intel: 'Repair at the depot before crossing to the furnace. Rust artillery can be silenced from beyond the curve.',
    beats: [battle('siege', 'depot', ['rusty', 'hornet'], 'Break the foundry siege'), capture('forge-pad', 'depot'), undermine('furnace', 'ridge', 'Collapse the Rust furnace footing'),
      radio('brann', 'Brann', 'You saved my forge. You have my tracks, my tools, and my last good rivet.')] }),
  a2('volcanic', 'Cinder Forge', { id: 'c-b', title: 'Magma Run', requires: ['c-a'], unlocks: ['alliance:cinder', 'blueprint:hop-thrusters'],
    briefing: 'Intercept the ore convoy before its cargo reaches Corvin’s launch spire.',
    intel: 'The launch spire is the destination. Destroy its footing and the convoy has nowhere to unload.',
    beats: [battle('convoy', 'east', ['hornet', 'rusty', 'rusty'], 'Stop the ore convoy'), undermine('launch', 'archive', 'Disable the launch spire'), travel('extract', 'exit', 'Reach Brann’s extraction point')] }),
  a2('temperate', 'Council Anchorage', { id: 'ii-7', title: 'Council of Embers', requires: ['t-b', 'f-b', 'c-b'], next: '3-1', unlocks: ['fleet:launched'],
    briefing: 'The free worlds launch together. Defend three launch pads while Forge, Aether and Tidewell prepare the fleet.',
    intel: 'Assign each companion to a launch pad. Friendly vehicles enable repairs. Enemy vehicles contest the countdown. Move defenders as each fleet launches.',
    commandPosts: LAUNCH_POSTS,
    sites: { ...sites, 'forge-pad': { bearing: 315, distance: 9 }, 'aether-pad': { bearing: 45, distance: 9 }, 'harbor-pad': { bearing: 0, distance: 17 },
      'forge-pad-lane': { bearing: 300, distance: 24 }, 'aether-pad-lane': { bearing: 60, distance: 24 }, 'harbor-pad-lane': { bearing: 0, distance: 32 } },
    routes: [...LAUNCH_POSTS.flatMap(p => [['start', p.site], [p.site, `${p.site}-lane`]] as [string, string][]), ['forge-pad', 'aether-pad'], ['forge-pad', 'harbor-pad'], ['aether-pad', 'harbor-pad']],
    structures: p => LAUNCH_POSTS.map(post => p.block(post.site, p.site(post.site), p.site('start'), 4, .03, 4)),
    beats: [{ id: 'council', enter(c) { c.spawn('mags', 'start', { side: 3 }); c.spawn('brann', 'start', { side: -3 }); c.spawn('seraphine', 'start', { side: 5 }); c.say('Mags', 'All three worlds. One last launch. Let’s make it count.'); c.objective('council', 'Rally the allied crew'); c.mark('depot'); }, done: c => c.near('depot', 3), exit: c => c.complete('council') },
      launchDefence(), radio('launch', 'Brann', 'Forge engines hot. Aether shields holding. Launch every ship!')] }),
];
const a3 = (op: Operation) => mission('Act III · The Unwinding', 'glacial', 'Shattered Halo', op);
export const ACT_III: readonly MissionDef[] = [
  a3({ id: '3-1', title: 'Driftstone', requires: ['ii-7'], next: '3-2', rules: { gravityScale: .6 }, unlocks: ['blueprint:mirv'],
    optional: { site: 'cache', text: 'Recover the Lantern fragment', reward: 'Lantern Shard' },
    briefing: 'Low gravity has loosened the Halo’s old anchors. Cut the Rust emplacements free and cross to the Mainspring approach.',
    intel: 'Gravity is sixty percent of normal. Your familiar shots will travel farther.',
    beats: [undermine('anchor-east', 'east', 'Break the eastern island anchor'), undermine('anchor-west', 'west', 'Break the western island anchor'), battle('halo', 'ridge', ['vex', 'tosser'], 'Silence the Halo batteries'), travel('crossing', 'archive', 'Reach the fleet crossing')] }),
  a3({ id: '3-2', title: 'Orbital Mechanics', requires: ['3-1'], next: '3-3', rules: { gravityScale: .6, projectileAge: 16 },
    briefing: 'Seraphine marks the battery beyond the curve. Make a high arc reach the far-side guns before the fleet passes.',
    intel: 'Long shots bend with radial gravity. The marker remains visible when the target crosses the horizon.',
    beats: [battle('far-side', 'archive', ['tosser', 'vex', 'spire'], 'Destroy the far-side battery'),
      radio('release', 'Seraphine', 'We could let the worlds rest. Sail for the Lantern. Make something new.'), radio('rewind', 'Brann', 'Or mend what our people built. There is still life in these worlds.')] }),
  a3({ id: '3-3', title: 'The Mainspring', requires: ['3-2'], worldName: 'The Mainspring',
    briefing: 'Corvin holds the Key. Break the Rustcrown, sever the core, and choose the future of the Orrery.',
    intel: 'The duel is only the beginning. Keep enough hull for the escape.',
    beats: [cued(bossBeat(battle('rustcrown', 'depot', ['bulwark', 'hornet'], 'Defeat Corvin’s Rustcrown guard'), 'rustcrown', 0, false), [{ type: 'finale', phase: 'duel' }]),
      bossBeat(battle('corvin', 'ridge', ['bulwark'], 'Break the Rustcrown'), 'rustcrown', 1, false), radio('corvin-last', 'Marshal Corvin', 'I only wanted the light to stay. Don’t let it all have been for nothing.'),
      cued(undermine('core', 'archive', 'Sever the Mainspring core'), [{ type: 'finale', phase: 'core' }, { type: 'boss', id: 'rustcrown', phase: 2 }]),
      cued(travel('escape', 'exit', 'Escape to the Lantern gate'), [{ type: 'boss-end' }, { type: 'finale', phase: 'escape' }]),
      cued({ id: 'ending-choice', enter(c) { c.objective('choice', 'Choose the future: Rewind or Release'); c.mark(null); c.say('Mags', 'We’re with you, Rook. Whatever comes next.'); }, done: c => !!c.flags.ending, exit: c => c.complete('choice') }, [{ type: 'finale', phase: 'choice' }])],
  }),
];
export const OPERATIONS = [...ACT_I, ...ACT_II, ...ACT_III];
export function operation(id: MissionId): MissionDef | undefined { return OPERATIONS.find(m => m.id === id); }
