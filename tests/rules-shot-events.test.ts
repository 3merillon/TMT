import { describe, expect, it } from 'vitest';
import { practiceSetup } from '../src/game/api/match';
import { GameSimulation, MatchReplay, FIXED_DT } from '../src/game/simulation';
import { ShotEvents } from '../src/game/presentation/shot-events';
import { SphereWorld } from './helpers/sphere-world';
import type { ShotEvent } from '../src/game/contracts';

const setup = () => practiceSetup({ seed: 7, mode: 'drive', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });

describe('captured launch presentation', () => {
  it('captures all ammunition from the actual shot without adding presentation fields to saved projectiles', () => {
    for (const munition of ['explosive', 'heavy', 'incendiary', 'nuclear'] as const) {
      const sim = new GameSimulation(new SphereWorld(), setup());
      sim.selectMunition(0, munition);
      const muzzle = sim.muzzle(0);
      expect(sim.fire(0)).toBe(true);
      const projectile = structuredClone(sim.state.projectiles[0]);
      const event = sim.step(0).find(e => e.type === 'shot') as ShotEvent;
      expect(event.launch).toMatchObject({ munition, weapon: 'mortar', id: projectile.id, tick: 0, position: muzzle.position });
      event.launch!.direction.forEach((value, axis) => expect(value).toBeCloseTo(muzzle.direction[axis], 12));
      sim.state.tanks[0].munition = 'explosive';
      sim.state.tanks[0].position[0] += 10;
      sim.state.projectiles[0].position[0] += 20;
      expect(event.launch?.position).toEqual(muzzle.position);
      expect(event.launch?.munition).toBe(munition);
      expect(Object.keys(projectile).sort()).toEqual(['age', 'id', 'launchTick', 'munition', 'origin', 'owner', 'peakAltitude', 'position', 'velocity']);
    }
  });

  it('deduplicates cloned events, retains constant state, and accepts IDs after a new match', () => {
    const sim = new GameSimulation(new SphereWorld(), setup()); sim.fire(0);
    const shot = sim.step(0).find(e => e.type === 'shot') as ShotEvent;
    const seen = new ShotEvents();
    expect(seen.accept(shot)).toBe(true);
    expect(seen.accept(structuredClone(shot))).toBe(false);
    seen.clear(); expect(seen.accept(shot)).toBe(true);
  });

  it('restores a mid-flight save without refiring a historical muzzle, then accepts the next shot once', () => {
    const sim = new GameSimulation(new SphereWorld(), setup());
    sim.selectMunition(0, 'nuclear'); sim.fire(0); sim.step(FIXED_DT * 3);
    const saved = JSON.parse(JSON.stringify(sim.checkpoint()));
    const replay = new MatchReplay(new SphereWorld(), saved);
    for (let i = 0; i < 1000 && replay.advance(60) !== 'done'; i++) {
      if (replay.simulation.stalledOn?.serial) replay.simulation.completeLegacyCarve();
    }
    expect(replay.verified()).toBe(true);
    // The session drains historical events before presenting the restored state.
    replay.simulation.step(0);
    expect(replay.simulation.step(0).filter(e => e.type === 'shot')).toEqual([]);
    expect(replay.simulation.state.projectiles[0].munition).toBe('nuclear');
  });
});
