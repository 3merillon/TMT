/** Three independent launches. Local service crews need a friendly vehicle on their pad. */
import type { Beat, MissionContext } from './mission';
import { distance, normalize } from '../math';

export const LAUNCH_POSTS = [
  { site: 'forge-pad', label: 'Forge', companion: 'brann', seconds: 240 },
  { site: 'aether-pad', label: 'Aether', companion: 'seraphine', seconds: 480 },
  { site: 'harbor-pad', label: 'Tidewell', companion: 'mags', seconds: 720 },
] as const;
const groundDistance = (c: MissionContext, a: readonly number[], b: readonly number[]) => distance(normalize([...a] as [number, number, number]), normalize([...b] as [number, number, number])) * c.api.world.radius;

export function launchDefence(): Beat {
  return {
    id: 'launch-defence',
    enter(c) {
      for (const post of LAUNCH_POSTS) {
        c.spawn('relay', post.site, { group: `launch:${post.site}`, name: `${post.label} launch pad` });
        c.flags[`launch:${post.site}`] = 0;
        c.flags[`launched:${post.site}`] = 0;
        const companion = c.group(post.companion).find(t => t.health > 0);
        if (companion) c.api.order(companion.id, c.at(post.site));
        c.flags[`assignment:${post.companion}`] = LAUNCH_POSTS.indexOf(post);
        c.objective(post.site, `${post.label} launch · ${post.seconds} s`);
      }
      c.flags['launch:wave'] = 0;
      c.say('Mags', 'Three launch pads. Assign us from the command panel. Keep a friendly vehicle on each pad for repairs, and clear the Rust before the countdown can continue.');
      c.mark('harbor-pad', 'Tidewell launch pad');
    },
    update(c) {
      const active = LAUNCH_POSTS.filter(post => !c.flags[`launched:${post.site}`]);
      const wave = c.flags['launch:wave'];
      if (c.beatTime >= wave * 30 && c.alive('launch-attackers') < 12) {
        const post = active[wave % active.length];
        if (post) {
          const lane = `${post.site}-lane`;
          for (let i = 0; i < 3; i++) c.spawn(i === 2 && wave % 3 === 2 ? 'tosser' : 'rustling', lane,
            { group: 'launch-attackers', side: (i - 1) * 2, patrol: [post.site] });
          c.flags['launch:wave']++;
        }
      }
      let urgent = active[0], urgency = -Infinity;
      for (const post of active) {
        const pad = c.group(`launch:${post.site}`)[0];
        if (!pad || pad.health <= 0) { c.lose(`${post.label}'s launch pad was destroyed before its fleet escaped.`); return; }
        const point = c.at(post.site);
        const enemies = c.api.state.tanks.filter(t => t.team === 1 && t.health > 0 && groundDistance(c, t.position, point) < 5);
        const friends = c.api.state.tanks.filter(t => t.team === 0 && t.health > 0 && t.id !== pad.id && !t.name?.endsWith('launch pad') && groundDistance(c, t.position, point) < 4);
        if (friends.length) {
          c.api.heal(pad.id, 4 / 60);
          for (const friend of friends) c.api.heal(friend.id, 3 / 60);
        }
        if (!enemies.length) c.flags[`launch:${post.site}`] += 1 / 60;
        const left = Math.max(0, Math.ceil(post.seconds - c.flags[`launch:${post.site}`]));
        if (left === 0) {
          c.flags[`launched:${post.site}`] = 1; c.complete(post.site);
          c.api.emit({ type: 'audio', cue: { type: 'escalation', stage: LAUNCH_POSTS.filter(p => c.flags[`launched:${p.site}`]).length } });
          c.api.emit({ type: 'banner', title: `${post.label.toUpperCase()} FLEET AWAY`, subtitle: 'Move its defenders to another pad' });
          if (post.site === 'forge-pad') c.say('Brann', 'Forge ships clear. Our pad is safe. Send me where you need the repairs.');
          if (post.site === 'aether-pad') c.say('Seraphine', 'Aether is away. One fleet remains. Hold the harbor.');
        } else if (c.api.tick % 60 === 0) {
          c.objective(post.site, `${post.label} · ${Math.ceil(pad.health / (pad.maxHealth ?? 1) * 100)}% hull · ${enemies.length ? 'CONTESTED' : `${left} s`}`);
        }
        const pressure = enemies.length * 2 + 1 - pad.health / (pad.maxHealth ?? 1) + (friends.length ? 0 : 1);
        if (pressure > urgency) { urgency = pressure; urgent = post; }
      }
      // A launched platform has no remaining crew or cargo to protect. Hostile fire may damage the empty structure.
      if (urgent && c.api.tick % 60 === 0) c.mark(urgent.site, `${urgent.label} launch pad`);
    },
    done: c => LAUNCH_POSTS.every(post => !!c.flags[`launched:${post.site}`]),
    exit(c) { c.mark(null); },
    hint: { after: 30, text: 'Select a launch pad for each companion. Occupied friendly pads repair nearby allies. Enemy vehicles within five metres pause that launch.' },
  };
}
