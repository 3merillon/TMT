/** Real resident Rust terrain for game-level tests: the shipped WASM, the worker
 * protocol with in-process delivery for fault injection, and a numeric GPU gate. */
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { RustResidentTerrain, type RustPageBackend } from '../../src/gpu/terrain/rust-service';
import { RustTerrainCore } from '../../src/gpu/terrain/rust-core';
import type { RustWorkerSurface } from '../../src/gpu/terrain/rust-core-pool';
import type { RustWorkerMessage } from '../../src/gpu/terrain/rust-core-worker';
import type { GpuPage } from '../../src/gpu/terrain/page-batch';
import type { TerrainRenderHost } from '../../src/gpu/terrain/render-host';
import { structuralFixture, type ResidentWorldInput } from '../../src/gpu/terrain/fixtures';
import { StructuralPhysics } from '../../src/game/structural-physics';
import { FakeTerrainHost } from './geometry-gate';
import { ResidentGameTerrain } from '../../src/game/resident-terrain';
import { GameSimulation, FIXED_DT } from '../../src/game/simulation';
import { practiceSetup } from '../../src/game/api/match';

export const module = WebAssembly.compile(readFileSync(new URL('../../src/gpu/terrain/terrain-core.wasm', import.meta.url)));
/** Same worker protocol and WASM, with event delivery in-process for fault injection. */
export class Worker implements RustWorkerSurface {
  onmessage: RustWorkerSurface['onmessage'] = null; onerror: RustWorkerSurface['onerror'] = null; onmessageerror: RustWorkerSurface['onmessageerror'] = null;
  core?: RustTerrainCore; closed = false;
  postMessage(message: RustWorkerMessage): void {
    void (async () => {
      try {
        let data;
        if (message.kind === 'init') { this.core = await RustTerrainCore.create(message.module, undefined, message.initial); data = { kind: 'ready' }; }
        else { const packet = this.core!.compileEncoded(message.input); this.core!.resetConstruction(); data = { kind: 'result', id: message.id, packet, milliseconds: 0, stages: {}, fallbacks: 0, memoryBytes: this.core!.memoryBytes }; }
        if (this.closed) { this.core?.dispose(); this.core = undefined; } else this.onmessage?.({ data } as MessageEvent);
      } catch (error) { if (!this.closed) this.onmessage?.({ data: { kind: 'error', error: String(error) } } as MessageEvent); }
    })();
  }
  terminate(): void { this.closed = true; this.core?.dispose(); this.core = undefined; }
}
/** Flat numeric staging stand-in. GPU numerical admission is qualified separately in Chromium. */
export class Gate implements RustPageBackend {
  fail = false; gate?: () => Promise<void>; live = 0; invalidated = 0;
  packedBatch(host: TerrainRenderHost) {
    const pages = new Map<string, GpuPage>();
    return {
      constructPacked: (input: Parameters<ReturnType<RustPageBackend['packedBatch']>['constructPacked']>[0]) => {
        expect(input.recipes(0).length).toBeGreaterThan(0); const volume = input.volumes();
        expect([...volume.volumes].every(v => v > 0)).toBe(true);
      },
      pagePacked: (...[key, surface, target, bounds]: Parameters<ReturnType<RustPageBackend['packedBatch']>['pagePacked']>) => {
        expect(surface.triangles.length % 8).toBe(0); const buffer = {} as GPUBuffer;
        const handle = host.createPage({ position: buffer, normal: buffer, surface: buffer, index: buffer, indirect: buffer, vertexCount: surface.triangles.length / 8 * 3, indexCount: surface.triangles.length / 8 * 3 }, { ...target, bounds });
        let alive = true; this.live++; pages.set(key, { handle, bytes: 1, dispose: () => { if (alive) { alive = false; this.live--; handle.dispose(); } } });
      },
      submit: async () => { await this.gate?.(); if (this.fail) { pages.forEach(p => p.dispose()); throw new Error('Injected GPU admission failure'); } return pages; },
      cancel: () => pages.forEach(p => p.dispose()),
    };
  }
  invalidateUpload(count: number): void { this.invalidated = count; }
  dispose(): void {}
}
/** The newest native engine; `version` selects an older one (v16+) for differential checks. */
export const LATEST_ENGINE = 22;
export async function setup(count = 1, native = false, version = LATEST_ENGINE, input: ResidentWorldInput = structuralFixture()) {
  const gate = new Gate(), host = new FakeTerrainHost(), physics = native ? undefined : await StructuralPhysics.create(input.planetCenter);
  const terrain = await RustResidentTerrain.create(input, gate, physics, host, await module, count, () => new Worker(),
    true, true, true, true, true, true, true, true, true, true, true, true, true, true, version >= 16, version >= 17, version >= 18, version >= 19, version >= 20, version >= 21, version >= 22);
  return { input, gate, host, physics: terrain.physics, terrain };
}

/** A native-engine game world on the structural fixture (radius 18; bots fall into the core within a few turns). */
export async function botWorld(workers: number, version = LATEST_ENGINE) {
  const r = await setup(workers, true, version), world = ResidentGameTerrain.adopt(r.terrain, 19); await world.initialize(); return world;
}
export const botSetup = (profile: string) => {
  const s = practiceSetup({ seed: 19, mode: 'bot', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
  s.tanks[1].brain = profile as typeof s.tanks[1]['brain']; return s;
};
/** Fixed-tick differential cadence; a human hold is submitted once at its tick boundary, independent of worker stalls.
 * Irregular cadence remains covered when advancing MatchReplay. */
export async function play(sim: GameSimulation, ticks: number): Promise<void> {
  let heldTick = -1;
  for (let i = 0; i < 40000 && sim.state.tick < ticks && sim.state.phase !== 'finished'; i++) {
    if (sim.state.phase === 'aim' && sim.state.active === 0 && heldTick !== sim.state.tick) { sim.hold(0); heldTick = sim.state.tick; }
    sim.step(FIXED_DT);
    if (sim.stalledOn) await new Promise(resolve => setTimeout(resolve, 0));
  }
}
