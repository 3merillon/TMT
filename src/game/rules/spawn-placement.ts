/** Resolve new artillery duels against committed terrain, then save explicit poses in the setup.
 * Replays keep their original poses and never rerun a placement policy against a changed world. */
import type { MatchSetup } from '../api/match';
import type { TerrainHit, V3, WorldQuery } from '../contracts';
import { assembleKit, validateKitLoadout, type KitAssembly } from '../kit';
import { ROOT_SURFACE_LIFT } from '../kit/dimensions';
import { add, distance, dot, frame, mul, normalize, sub } from '../math';

interface Site { up: V3; heading: number; point: V3; width: number; sightHeight: number }
const natural = (hit: TerrainHit | null): hit is TerrainHit => !!hit && (hit.material === 1 || hit.material === 2);

function findSite(world: WorldQuery, setup: MatchSetup, kit: KitAssembly, up: V3, heading: number): Site | null {
  const hit = world.surface(up), slope = Math.cos(Math.min(20, Math.max(5, kit.stats.climbDeg - 5)) * Math.PI / 180);
  if (!natural(hit) || dot(normalize(hit.normal), up) < slope || Math.hypot(...hit.point) < world.radius) return null;
  const width = kit.running.halfSpacing + kit.running.trackWidth / 2 + .2;
  const length = Math.max(...kit.running.stations.map(s => Math.abs(s.z) + s.radius)) + .2;
  // Initial cuts are applied at tick zero. Do not place a tank on ground they are about to remove.
  if (setup.initialCuts?.some(cut => distance(hit.point, cut.center) < cut.radius + Math.hypot(width, length) + 5)) return null;
  const sample = (right: V3, forward: V3, x: number, z: number): TerrainHit | null => {
    const direction = normalize(add(hit.point, add(mul(right, x), mul(forward, z))));
    const ground = world.surface(direction);
    if (!natural(ground) || dot(normalize(ground.normal), direction) < slope || Math.hypot(...ground.point) < world.radius) return null;
    return ground;
  };
  for (let turn = 0; turn < 4; turn++) {
    const yaw = heading + turn * Math.PI / 2, axes = frame(up, yaw);
    let supported = true;
    for (const x of [-width, 0, width]) for (const z of [-length, 0, length]) {
      const ground = sample(axes.right, axes.forward, x, z);
      if (!ground || Math.abs(Math.hypot(...ground.point) - Math.hypot(...hit.point)) > .65) { supported = false; break; }
      // Check the body's air space too: a roof or adjoining wall is not a usable landing pad.
      const raised = add(add(hit.point, add(mul(axes.right, x), mul(axes.forward, z))), mul(up, ROOT_SURFACE_LIFT + .25));
      if (world.isSolid(raised)) { supported = false; break; }
    }
    if (!supported) continue;
    // A tank-sized corridor must connect the pad to surrounding terrain; checking
    // only its centre admits isolated roofs, crater lips and tiny flat ledges.
    let previous = [-width, 0, width].map(x => sample(axes.right, axes.forward, x, 0));
    let exit = true;
    for (let step = 1; step <= 5 && exit; step++) {
      const next = [-width, 0, width].map(x => sample(axes.right, axes.forward, x, step));
      for (let lane = 0; lane < next.length; lane++) {
        const a = previous[lane], b = next[lane];
        if (!a || !b || distance(a.point, b.point) > 1.5 || Math.abs(Math.hypot(...a.point) - Math.hypot(...b.point)) > .5) { exit = false; break; }
        const start = add(a.point, mul(normalize(a.point), .8)), end = add(b.point, mul(normalize(b.point), .8));
        const delta = sub(end, start), travel = Math.hypot(...delta);
        if (world.raycast(start, normalize(delta), travel)) { exit = false; break; }
      }
      previous = next;
    }
    if (exit) return { up, heading: yaw, point: hit.point, width, sightHeight: Math.max(2.5, ROOT_SURFACE_LIFT + kit.frames.sensor.position[1] + .5) };
  }
  return null;
}

function hiddenFromEachOther(world: WorldQuery, a: Site, b: Site): boolean {
  if (distance(a.point, b.point) < world.radius * 1.2) return false;
  // Test elevated centre and both hull edges, not just the ground-to-ground chord.
  const ar = frame(a.up, a.heading).right, br = frame(b.up, b.heading).right;
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) {
    const start = add(add(a.point, mul(a.up, a.sightHeight)), mul(ar, x * a.width));
    const end = add(add(b.point, mul(b.up, b.sightHeight)), mul(br, y * b.width));
    const delta = sub(end, start), length = Math.hypot(...delta);
    const hit = world.raycast(start, normalize(delta), length);
    if (!hit || hit.distance >= length - .1) return false;
  }
  return true;
}

export function resolveArtillerySpawns(world: WorldQuery, setup: MatchSetup): MatchSetup {
  if (setup.rules.turnModel !== 'tempo' || setup.mode === 'drive' || setup.mode === 'campaign' || setup.tanks.length !== 2
    || setup.tanks[0].team === setup.tanks[1].team || setup.tanks.every(t => t.spawn !== 'auto')) return setup;
  const phase = ((Math.imul(setup.seed, 1664525) + 1013904223) >>> 0) / 4294967296 * Math.PI * 2;
  // Even coverage, ordered from the landing hemisphere outward; no random retry loop.
  const directions: V3[] = [[0, 1, 0]];
  for (let i = 0; i < 512; i++) {
    const y = 1 - 2 * (i + .5) / 512, r = Math.sqrt(1 - y * y), angle = phase + i * Math.PI * (3 - Math.sqrt(5));
    directions.push([Math.cos(angle) * r, y, Math.sin(angle) * r]);
  }
  const kits = setup.tanks.map(t => assembleKit(validateKitLoadout(t.loadout)));
  const candidates = setup.tanks.map((tank, index) => {
    if (tank.spawn !== 'auto') {
      const up = normalize(tank.spawn.up), hit = world.surface(up);
      if (!hit) throw new Error('Authored duel spawn has no supporting terrain');
      return [{ up, heading: tank.spawn.heading, point: hit.point, width: kits[index].running.halfSpacing + kits[index].running.trackWidth / 2,
        sightHeight: Math.max(2.5, ROOT_SURFACE_LIFT + kits[index].frames.sensor.position[1] + .5) }];
    }
    return directions.map(up => findSite(world, setup, kits[index], up, phase)).filter((site): site is Site => site !== null);
  });
  for (const a of candidates[0]) for (const b of candidates[1]) {
    if (!hiddenFromEachOther(world, a, b)) continue;
    const sites = [a, b];
    return { ...setup, tanks: setup.tanks.map((tank, index) => tank.spawn === 'auto'
      ? { ...tank, spawn: { up: sites[index].up, heading: sites[index].heading } } : tank) };
  }
  throw new Error('No safe artillery spawn pair: opponents need separated, navigable terrain out of sight');
}
