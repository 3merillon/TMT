import { describe, expect, it } from 'vitest';
import type { EngineServices, TransparentDrawer } from '../src/engine/contracts';
import { createWorkshopAtmospherics, workshopAtmosphericParticles, workshopAtmosphericsShader } from '../src/game/workshop/atmospherics';
import { link } from '../src/engine/wgsl/module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

describe('workshop atmospherics', () => {
  it('is deterministic, bounded and fully hidden under reduced motion', () => {
    expect(workshopAtmosphericParticles(12.5, false)).toEqual(workshopAtmosphericParticles(12.5, false));
    expect(workshopAtmosphericParticles(12.5, true, { at: 12, position: [0, 1, 0] })).toEqual([]);
    for (let t = 0; t < 30; t += 0.15) {
      const particles = workshopAtmosphericParticles(t, false, { at: t - 0.8, position: [-1.3, 0.35, 0.8] });
      expect(particles.length).toBeLessThanOrEqual(280);
      for (const p of particles) {
        expect([...p.position, p.radius, p.opacity].every(Number.isFinite)).toBe(true);
        expect(p.opacity).toBeGreaterThanOrEqual(0);
        expect(p.opacity).toBeLessThan(0.25);
      }
    }
  });

  it('vents briefly and lets an old manual release expire', () => {
    const idle = workshopAtmosphericParticles(1, false);
    const vent = workshopAtmosphericParticles(3.8, false);
    expect(idle.filter(p => p.kind === 1)).toHaveLength(0);
    expect(vent.filter(p => p.kind === 1).length).toBeGreaterThan(0);
    expect(workshopAtmosphericParticles(1, false, { at: -3, position: [0, 1, 0] })).toEqual(idle);
  });

  it('unregisters its drawer and defers its single GPU buffer exactly once', () => {
    let removed = 0, freed = 0, depthRemoved = 0, vents = 0;
    const drawers: TransparentDrawer[] = [];
    const s = {
      ctx: {
        device: { createBindGroupLayout: () => ({}), createBuffer: () => ({}), createBindGroup: () => ({}) },
        queue: { writeBuffer() {} }, layouts: { frame: {} },
        pipelines: { register() {}, compile: async () => ({}), get: () => undefined },
        deferDestroy() { freed++; },
      },
      scene: { addTransparentDrawer(drawer: TransparentDrawer) { drawers.push(drawer); return () => { removed++; }; } },
      graph: { addPass() { return () => { depthRemoved++; }; } },
    } as unknown as EngineServices;
    const fx = createWorkshopAtmospherics(s, undefined, () => vents++);
    expect(drawers).toHaveLength(1);
    fx.update(0.016, 0, false);
    fx.release();
    expect(vents).toBe(1);
    for (let i = 0; i < 40; i++) fx.release();
    expect(fx.snapshot().releases).toBe(6);
    fx.update(.1, 0, true);
    fx.release();
    expect(fx.snapshot()).toMatchObject({ particles: 0, steam: 0, releases: 0 });
    const silent = vents;
    fx.dispose();
    fx.dispose();
    fx.update(0.016, 1, false);
    fx.release();
    expect(removed).toBe(1);
    expect(depthRemoved).toBe(1);
    expect(freed).toBe(1);
    expect(vents).toBe(silent);
  });

  it('expands steam smoothly and expires bursts without retaining moving emitters', () => {
    const origin: [number, number, number] = [0, 1, 0];
    const release = { at: 0, position: origin, direction: [1, 0, 0] as [number, number, number] };
    const early = workshopAtmosphericParticles(.2, false, release).filter(p => p.kind === 1);
    const late = workshopAtmosphericParticles(1.1, false, release).filter(p => p.kind === 1);
    expect(early.length).toBeGreaterThan(0);
    expect(late[0].radius).toBeGreaterThan(early[0].radius);
    expect(late[0].position[1]).toBeGreaterThan(early[0].position[1]);
    expect(late[0].position[0]).toBeGreaterThan(early[0].position[0]);
    expect(origin).toEqual([0, 1, 0]);
    expect(workshopAtmosphericParticles(3.5, false, release)).toEqual(workshopAtmosphericParticles(3.5, false));
  });

  const naga = process.env.TMT_NAGA ?? join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'naga.exe' : 'naga');
  it.skipIf(!existsSync(naga))('validates its depth-tested billboard shader with Naga', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmt-workshop-shader-'));
    try {
      const file = join(dir, 'atmospherics.wgsl');
      writeFileSync(file, link(workshopAtmosphericsShader).code);
      const run = spawnSync(naga, [file], { encoding: 'utf8' });
      expect(run.status, run.stdout + run.stderr).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
