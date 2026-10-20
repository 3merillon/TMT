/** O(dirty) edits (W1-TER): an edit's work and CPU time do not grow with crater history or world region count.
 * The same probe cut is prepared and aborted (a transaction can be staged and dropped at no cost to the world) on a
 * fresh planet and on the same planet after 58 craters elsewhere: identical dirty sets and vertex work, with a
 * reported timing target of less than 15% growth (enforced only by npm run verify:performance). The two planets
 * are probed alternately, so load from other processes on a shared machine lands on both
 * series alike (probing one planet before and after the craters read 1.22 once while another test file ran beside
 * it, 0.97 alone). */
import { expect, it } from 'vitest';
import { ResidentTerrain, type StagedEdit } from '../src/gpu/terrain/service';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { StructuralPhysics } from '../src/game/structural-physics';
import { normalize } from '../src/game/math';
import type { V3 } from '../src/game/contracts';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';
import { reportPerformanceTarget } from './helpers/performance-target';

it('keeps edit work identical versus crater history and reports preparation timing', async () => {
  const input = residentPlanet(7);
  const planet = async () => {
    const terrain = new ResidentTerrain(input, new GeometryGate().pages, await StructuralPhysics.create(input.planetCenter), new FakeTerrainHost());
    await terrain.initialize();
    return terrain;
  };
  const fresh = await planet(), terrain = await planet();
  try {
    const surface = (d: V3): V3 => terrain.queries.surface(normalize(d))?.point ?? normalize(d).map(v => v * 18) as V3;
    const probe = { id: 'probe', center: surface([0.2, 1, 0.1]), radius: 2.6, repeat: 'impact' as const };
    const regions = (t: ResidentTerrain) => [...t.pages.values()].reduce((s, p) => s + p.regions.length, 0);
    const regionsBefore = regions(terrain);
    // 58 craters far from the probe (southern hemisphere), growing history, fields and vertices.
    for (let i = 0; i < 58; i++) {
      const angle = i * 2.399963229728653, center = surface([Math.cos(angle), -0.4 - 0.6 * ((i * 0.618) % 1), Math.sin(angle)]);
      await terrain.cut({ id: `far-${i}`, center, radius: i % 7 === 6 ? 4.8 : 2.6, repeat: 'impact' });
    }
    expect(terrain.history.filter(edit => edit.cut)).toHaveLength(58);
    expect(regions(terrain)).not.toBe(regionsBefore);
    expect(regions(fresh)).toBe(regionsBefore);
    expect(terrain.arrangement.fields.length).toBeGreaterThan(261 + 50);
    type Run = { ms: number; tets: number; bricks: number; vertices: number };
    const sample = async (t: ResidentTerrain): Promise<Run> => {
      const vertices = t.arrangement.vertices.length, start = performance.now();
      const staged = await t.prepare([probe]) as StagedEdit;
      const run = { ms: performance.now() - start, tets: staged.metrics.dirtyTets!, bricks: staged.metrics.dirtyBricks, vertices: t.arrangement.vertices.length - vertices };
      t.abort(staged);
      return run;
    };
    const before: Run[] = [], after: Run[] = [];
    for (let i = 0; i < 17; i++) {
      const a = await sample(fresh), b = await sample(terrain);
      if (i >= 2) { before.push(a); after.push(b); } // JIT warm-up
    }
    // Identical work: the same tets, bricks and newly constructed vertices.
    expect(after.map(r => [r.tets, r.bricks, r.vertices])).toEqual(before.map(r => [r.tets, r.bricks, r.vertices]));
    const best = (runs: Run[]) => Math.min(...runs.map(r => r.ms));
    const ratio = best(after) / best(before);
    console.log(`scaling: probe prepare ${best(before).toFixed(1)} ms fresh, ${best(after).toFixed(1)} ms after 58 craters (ratio ${ratio.toFixed(2)})`);
    expect(terrain.compactions).toBe(0);
    reportPerformanceTarget({ name: 'Terrain prepare after 58 craters / fresh', value: ratio, target: 1.15, unit: 'ratio', comparison: '<' });
  } finally { fresh.dispose(); terrain.dispose(); }
}, 180000);
