/** Frame pacing and edit frame diagnostics. Every edit records its own worst in-flight frame (request to two frames
 * after its commit), also when edits run back to back; the pacer never holds terrain work on a frame that does not
 * come (GPU queue stalled, hidden tab). Headless with a fake requestAnimationFrame (GeometryGate + FakeTerrainHost). */
import { expect, it } from 'vitest';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { StructuralPhysics } from '../src/game/structural-physics';
import { ResidentGameTerrain } from '../src/game/resident-terrain';
import type { V3 } from '../src/game/contracts';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';
import { FramePacer } from '../src/gpu/terrain/work-budget';

type Raf = (callback: (time: number) => void) => number;
const settle = async (check: () => boolean, limit = 4000) => { for (let i = 0; i < limit && !check(); i++) await new Promise(r => setTimeout(r, 1)); expect(check()).toBe(true); };

it('records the worst in-flight frame of every back-to-back edit', async () => {
  const scope = globalThis as { requestAnimationFrame?: Raf }, saved = scope.requestAnimationFrame;
  scope.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 4) as unknown as number;
  const fixture = structuralFixture(), physics = await StructuralPhysics.create(fixture.planetCenter);
  const resident = new ResidentTerrain(fixture, new GeometryGate().pages, physics, new FakeTerrainHost()), game = ResidentGameTerrain.adopt(resident, 7);
  try {
    await game.initialize();
    const tx = game.transactions, [a, b] = fixture.cuts.map((cut, i) => ({ id: `0:0:${i}`, center: [...cut.center] as V3, radius: cut.radius }));
    // The second edit is requested while the first is in flight, and commits right after it.
    const first = tx.prepare([a], 1), second = tx.prepare([b], 2);
    await settle(() => tx.status(first) === 'ready');
    expect(tx.commitReady(first, 1).status).toBe('committed');
    await settle(() => tx.status(second) === 'ready');
    expect(tx.commitReady(second, 2).status).toBe('committed');
    const edits = resident.history.slice(1);
    await settle(() => edits.every(edit => edit.metrics.worstFrameMs !== undefined));
    for (const edit of edits) expect(edit.metrics.worstFrameMs).toBeGreaterThan(0);
    expect(resident.frameLog).toHaveLength(2);
  } finally { game.dispose(); scope.requestAnimationFrame = saved; }
}, 60000);

it('does not hold terrain work on a frame that never comes, and paces again once frames resume', async () => {
  const scope = globalThis as { requestAnimationFrame?: Raf }, saved = scope.requestAnimationFrame, pending: ((time: number) => void)[] = [];
  scope.requestAnimationFrame = callback => pending.push(callback);
  const pacer = new FramePacer(), sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  try {
    pacer.acquire(); await sleep(15);
    expect(pacer.frameDue).toBe(true);
    const start = performance.now(); await pacer.afterNextFrame();
    expect(performance.now() - start).toBeLessThan(250);
    expect(pacer.stalls).toBe(1); expect(pacer.frameDue).toBe(false);
    // A frame ends the stall: the next due frame is awaited again.
    for (const callback of pending.splice(0)) callback(performance.now());
    await sleep(15);
    expect(pacer.frameDue).toBe(true);
    const waiting = pacer.afterNextFrame();
    for (const callback of pending.splice(0)) callback(performance.now());
    // Released by the frame, not by the stall bound (which would count a second stall).
    await waiting;
    expect(pacer.stalls).toBe(1);
    pacer.release();
  } finally { scope.requestAnimationFrame = saved; }
});
