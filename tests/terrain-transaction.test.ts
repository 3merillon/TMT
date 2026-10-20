/** TerrainTransactions on ResidentGameTerrain (plan §5.1): prepare stages an edit off the tick; commitReady publishes
 * it at exactly its commit tick (never before, never while preparing); cancel releases the serial slot without
 * waiting for the cancelled work; a moved recut body fails the commit (stale) unless freezeBodies held it; a failed
 * prepare keeps the old world and reports its code (I3); a real prepare cancels every unpromoted speculation; replay
 * recuts exactly the bodies the live commit recut. Headless: GeometryGate + FakeTerrainHost (no GPU claim). */
import { describe, expect, it } from 'vitest';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { StructuralPhysics } from '../src/game/structural-physics';
import { ResidentGameTerrain } from '../src/game/resident-terrain';
import type { CutRequest } from '../src/gpu/terrain/transactions';
import { add, rotate, sub } from '../src/game/math';
import type { V3 } from '../src/game/contracts';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';
import { replayResident, residentReplay } from '../src/game/resident-checkpoint';

async function world() {
  const fixture = structuralFixture(), gate = new GeometryGate(), host = new FakeTerrainHost(), physics = await StructuralPhysics.create(fixture.planetCenter);
  const resident = new ResidentTerrain(fixture, gate.pages, physics, host), game = ResidentGameTerrain.adopt(resident, 7);
  await game.initialize();
  const cuts: CutRequest[] = fixture.cuts.map((cut, i) => ({ id: `0:0:${i}`, center: [...cut.center] as V3, radius: cut.radius }));
  return { fixture, gate, host, physics, resident, game, tx: game.transactions, cuts };
}
const settle = async (check: () => boolean, limit = 2000) => { for (let i = 0; i < limit && !check(); i++) await new Promise(r => setTimeout(r, 1)); expect(check()).toBe(true); };

describe('terrain transactions', () => {
  it('prepares off the tick and commits exactly at the commit tick', async () => {
    const { resident, game, tx, cuts, host } = await world();
    try {
      const epoch = resident.epoch, queries = resident.queries, commits = host.commits.length, version = game.version;
      const ticket = tx.prepare([cuts[0]], 12);
      expect(tx.status(ticket)).toBe('preparing');
      expect(tx.commitReady(ticket, 12)).toEqual({ status: 'not-ready' });
      await settle(() => tx.status(ticket) === 'ready');
      for (const tick of [0, 5, 11]) expect(tx.commitReady(ticket, tick)).toEqual({ status: 'not-ready' });
      // Nothing is visible, collidable or queryable before the tick (I4).
      expect(resident.epoch).toBe(epoch); expect(resident.queries).toBe(queries); expect(host.commits).toHaveLength(commits); expect(game.version).toBe(version);
      const result = tx.commitReady(ticket, 12);
      expect(result.status).toBe('committed');
      expect(resident.epoch).toBe(epoch + 1); expect(host.commits).toHaveLength(commits + 1); expect(game.version).toBe(version + 1);
      if (result.status === 'committed') { expect(result.update.version).toBe(version + 1); expect(result.update.footprintBounds?.length).toBeGreaterThan(0); }
      expect(tx.status(ticket)).toBe('committed');
      expect(tx.commitReady(ticket, 13)).toEqual(result);
      expect(resident.history.at(-1)!.cut?.id).toBe(cuts[0].id);
      expect(resident.history.at(-1)!.metrics.enqueueToReadyMs).toBeGreaterThan(0);
    } finally { game.dispose(); }
  }, 60000);

  it('queues a second prepare behind a ready ticket and commits both in order', async () => {
    const { resident, tx, cuts, game } = await world();
    try {
      const first = tx.prepare([cuts[0]], 10), second = tx.prepare([cuts[1]], 11);
      await settle(() => tx.status(first) === 'ready');
      await new Promise(r => setTimeout(r, 20));
      expect(tx.status(second)).toBe('preparing');
      expect(tx.commitReady(second, 11)).toEqual({ status: 'not-ready' });
      expect(tx.commitReady(first, 10).status).toBe('committed');
      await settle(() => tx.status(second) === 'ready');
      expect(tx.commitReady(second, 11).status).toBe('committed');
      expect(resident.history.slice(1).map(edit => edit.cut?.id)).toEqual([cuts[0].id, cuts[1].id]);
      expect(resident.physics.bodies.size).toBe(1);
    } finally { game.dispose(); }
  }, 60000);

  it('cancels a preparing ticket without blocking the serial tail, and a ready one by rolling it back', async () => {
    const { resident, gate, host, tx, cuts, game } = await world();
    try {
      let release!: () => void, entered!: () => void; const entering = new Promise<void>(r => { entered = r; });
      gate.gate = () => { entered(); return new Promise<void>(r => { release = r; }); };
      const stuck = tx.prepare([cuts[0]], 5);
      await entering; gate.gate = undefined;
      const next = tx.prepare([cuts[1]], 6);
      tx.cancel(stuck);
      expect(tx.status(stuck)).toBe('cancelled');
      // The queued ticket prepares while the cancelled one's GPU work is still outstanding.
      await settle(() => tx.status(next) === 'ready');
      expect(tx.commitReady(stuck, 5)).toMatchObject({ status: 'failed', code: 'cancelled' });
      expect(tx.commitReady(next, 6).status).toBe('committed');
      release(); await new Promise(r => setTimeout(r, 20));
      expect(resident.arrangement.cuts.map(c => c.id)).toEqual([cuts[1].id]);
      expect(host.disposedWhileVisible).toBe(0);
      expect(gate.live).toBe(host.visible.length);
      // A ready ticket rolls back: no field, no page, the slot is free again.
      const fields = resident.arrangement.fields.length, epoch = resident.epoch, visible = [...host.visible].sort();
      const ready = tx.prepare([cuts[0]], 9);
      await settle(() => tx.status(ready) === 'ready');
      tx.cancel(ready);
      expect(resident.arrangement.fields).toHaveLength(fields); expect(resident.epoch).toBe(epoch); expect([...host.visible].sort()).toEqual(visible);
      expect(gate.live).toBe(host.visible.length);
      const again = tx.prepare([cuts[0]], 10);
      await settle(() => tx.status(again) === 'ready');
      expect(tx.commitReady(again, 10).status).toBe('committed');
      expect(resident.physics.bodies.size).toBe(1);
    } finally { game.dispose(); }
  }, 60000);

  it('keeps the old world and reports the code when a prepare fails', async () => {
    const { resident, gate, host, tx, cuts, game } = await world();
    try {
      const pages = resident.pages, queries = resident.queries, epoch = resident.epoch, commits = host.commits.length, live = gate.live;
      gate.fail = true;
      const ticket = tx.prepare([cuts[0]], 3);
      await settle(() => tx.status(ticket) !== 'preparing');
      expect(tx.status(ticket)).toBe('failed');
      expect(tx.commitReady(ticket, 3)).toMatchObject({ status: 'failed', code: 'capacity' });
      expect(resident.pages).toBe(pages); expect(resident.queries).toBe(queries); expect(resident.epoch).toBe(epoch);
      expect(host.commits).toHaveLength(commits); expect(gate.live).toBe(live); expect(resident.arrangement.cuts).toHaveLength(0);
      expect(resident.lastFailure?.code).toBe('capacity');
      gate.fail = false;
      const retry = tx.prepare([cuts[0]], 4);
      await settle(() => tx.status(retry) === 'ready');
      expect(tx.commitReady(retry, 4).status).toBe('committed');
      // Invalid input fails at once, explicitly.
      const invalid = tx.prepare([{ id: 'x', center: [0, 0, 0], radius: 0.5 }], 5);
      expect(tx.status(invalid)).toBe('failed');
      expect(tx.commitReady(invalid, 5)).toMatchObject({ status: 'failed', code: 'validation' });
      expect(tx.commitReady(9999, 5)).toMatchObject({ status: 'failed', code: 'unknown-ticket' });
    } finally { game.dispose(); }
  }, 60000);

  it('fences a moving recut body: stale without freezeBodies, committed with it', async () => {
    const { resident, physics, game, tx, cuts } = await world();
    try {
      for (const [i, cut] of cuts.entries()) { const t = tx.prepare([cut], i); await settle(() => tx.status(t) === 'ready'); expect(tx.commitReady(t, i).status).toBe('committed'); }
      const slab = physics.bodies.get(1)!;
      expect(slab).toBeDefined();
      const at = () => { const p = slab.body.translation(), q = slab.body.rotation(); return add([p.x, p.y, p.z], rotate(sub([0, 6.5, 0], slab.candidate.center), [q.x, q.y, q.z, q.w])); };
      const recut = (id: string): CutRequest => ({ id, center: at(), radius: 2.25 });
      const epoch = resident.epoch;
      // Unfrozen: the slab falls while the edit is prepared, so the recut is stale at commit.
      const stale = tx.prepare([recut('7:0:0')], 20);
      await settle(() => tx.status(stale) === 'ready');
      for (let i = 0; i < 5; i++) game.fixedStep();
      expect(tx.commitReady(stale, 20)).toMatchObject({ status: 'failed', code: 'stale' });
      expect(resident.epoch).toBe(epoch); expect(physics.bodies.get(1)).toBe(slab);
      // Frozen at the impact tick: deterministic recut, released after the commit.
      const cut = recut('27:0:0'), ticket = tx.prepare([cut], 40);
      const moving = slab.body.linvel(), held: V3 = [moving.x, moving.y, moving.z];
      expect(Math.hypot(...held)).toBeGreaterThan(0);
      tx.freezeBodies({ min: cut.center.map(v => v - cut.radius) as V3, max: cut.center.map(v => v + cut.radius) as V3 }, 40);
      expect(tx.frozenBodies).toEqual([1]);
      const pose = slab.body.translation();
      for (let i = 0; i < 12; i++) game.fixedStep();
      expect(slab.body.translation()).toEqual(pose);
      // A checkpoint inside the hold saves the held pose with the motion the body resumes with, not the hold's zeros.
      expect(slab.body.linvel()).toEqual({ x: 0, y: 0, z: 0 });
      const saved = (await game.saveCheckpoint()).bodies.find(b => b.id === 1)!;
      expect(saved.position).toEqual([pose.x, pose.y, pose.z]); expect(saved.velocity).toEqual(held);
      expect(tx.frozenBodies).toEqual([1]);
      await settle(() => tx.status(ticket) === 'ready');
      const result = tx.commitReady(ticket, 40);
      expect(result.status).toBe('committed');
      expect(physics.bodies.has(1)).toBe(false); expect(physics.bodies.size).toBeGreaterThanOrEqual(1);
      expect(tx.frozenBodies).toEqual([]);
      expect(resident.history.at(-1)!.ledger.removed).toBeGreaterThan(0);
      expect(resident.queries.isSolid(cut.center)).toBe(false);
    } finally { game.dispose(); }
  }, 60000);

  it('promotes a matching speculative ticket and refuses a different impact', async () => {
    const { tx, cuts, game, resident } = await world();
    try {
      const guess = tx.prepare([cuts[0]], 0, { speculative: true });
      await settle(() => tx.status(guess) === 'ready');
      expect(tx.commitReady(guess, 100)).toMatchObject({ status: 'failed', code: 'speculative' });
      expect(tx.promote(guess, [{ ...cuts[0], radius: cuts[0].radius + 0.25 }], 30)).toBe(false);
      expect(tx.promote(guess, [{ ...cuts[0], id: 'other' }], 30)).toBe(false);
      expect(tx.promote(guess, [cuts[0]], 30)).toBe(true);
      expect(tx.commitReady(guess, 29)).toEqual({ status: 'not-ready' });
      expect(tx.commitReady(guess, 30).status).toBe('committed');
      expect(resident.history.at(-1)!.cut?.id).toBe(cuts[0].id);
      // A miss: cancel the speculation and prepare the real impact; the slot is not held.
      const miss = tx.prepare([cuts[1]], 0, { speculative: true });
      tx.cancel(miss);
      const real = tx.prepare([{ ...cuts[1], id: '44:0:0' }], 50);
      await settle(() => tx.status(real) === 'ready');
      expect(tx.commitReady(real, 50).status).toBe('committed');
    } finally { game.dispose(); }
  }, 60000);

  it('cancels an unpromoted speculation when a real impact is prepared, so a missed guess never stalls the queue', async () => {
    const { tx, cuts, game, resident } = await world();
    try {
      const guess = tx.prepare([cuts[0]], 0, { speculative: true }), other = tx.prepare([cuts[1]], 0, { speculative: true });
      await settle(() => tx.status(guess) === 'ready');
      // Speculations never cancel each other.
      expect(tx.status(other)).toBe('preparing');
      const real = tx.prepare([{ ...cuts[1], id: '9:0:0' }], 12);
      expect(tx.status(guess)).toBe('cancelled'); expect(tx.status(other)).toBe('cancelled');
      expect(tx.promote(guess, [cuts[0]], 12)).toBe(false);
      await settle(() => tx.status(real) === 'ready');
      expect(tx.commitReady(real, 12).status).toBe('committed');
      expect(resident.arrangement.cuts.map(c => c.id)).toEqual(['9:0:0']);
    } finally { game.dispose(); }
  }, 60000);

  it('replays exactly when a body moved into the cut after the request (it was not recut live)', async () => {
    const { fixture, resident, physics, game, tx, cuts } = await world();
    try {
      for (const [i, cut] of cuts.entries()) { const t = tx.prepare([cut], i); await settle(() => tx.status(t) === 'ready'); expect(tx.commitReady(t, i).status).toBe('committed'); }
      const slab = physics.bodies.get(1)!;
      expect(slab).toBeDefined();
      const target: V3 = [9, 0.75, 6], cut: CutRequest = { id: '50:0:0', center: target, radius: 2.25 };
      const ticket = tx.prepare([cut], 50);
      await settle(() => tx.status(ticket) === 'ready');
      // After the request-time snapshot the slab lands in the cut: the live edit did not recut it (no fence holds it).
      const local = sub([0, 6.5, 0], slab.candidate.center);
      slab.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      slab.body.setTranslation({ x: target[0] - local[0], y: target[1] - 0.5 - local[1], z: target[2] - local[2] }, true);
      slab.body.setLinvel({ x: 0, y: 0, z: 0 }, true); slab.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      expect(tx.commitReady(ticket, 50).status).toBe('committed');
      expect(physics.bodies.get(1)).toBe(slab);
      const edit = resident.history.at(-1)!;
      expect(edit.eligible).toEqual([]);
      expect(edit.bodiesBefore.find(b => b.id === 1)?.position[0]).toBeCloseTo(target[0] - local[0], 5);
      const replayPhysics = await StructuralPhysics.create(fixture.planetCenter);
      const replayed = new ResidentTerrain(fixture, new GeometryGate().pages, replayPhysics, new FakeTerrainHost());
      try {
        await replayResident(replayed, residentReplay(resident), physics.motions(), physics.tick);
        expect([...replayPhysics.bodies.keys()]).toEqual([...physics.bodies.keys()]);
        expect([...replayed.ownership]).toEqual([...resident.ownership]);
        expect(replayed.epoch).toBe(resident.epoch);
        expect(replayed.history.at(-1)!.ledger).toEqual(edit.ledger);
      } finally { replayed.dispose(); }
    } finally { game.dispose(); }
  }, 60000);
});
