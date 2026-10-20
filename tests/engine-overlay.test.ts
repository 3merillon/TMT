// W1-ENG-SCENE: overlays (plan §4.5 'overlay' slot) — the screen-space trajectory ribbon's miter joins leave no gaps
// (120° included), the miter limit holds, and the ring / ribbon uniform layouts are pinned.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MAX_RINGS, RIBBON_MITER_LIMIT, RIBBON_PARAMS, RINGS, overlayOutputConsumed, ribbonOffset, ribbonShaderLinked } from '../src/engine/scene/overlays';
import { pendingCraterModifier } from '../src/engine/materials/terrain/modifiers/pending-crater.wgsl';
import { PendingCutSet } from '../src/engine/scene/pending-cuts';
import { Scene } from '../src/engine/scene/scene-registry';

type V2 = [number, number];
const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
const len = (a: V2) => Math.hypot(a[0], a[1]);
const unit = (a: V2): V2 => { const l = len(a); return [a[0] / l, a[1] / l]; };
/** Signed distance of p from the line through a with unit direction d (positive on the left). */
const lineDistance = (p: V2, a: V2, d: V2) => (d[0] * (p[1] - a[1]) - d[1] * (p[0] - a[0]));

describe('ribbon miters', () => {
  const naga = process.env.TMT_NAGA ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.cargo', 'bin', process.platform === 'win32' ? 'naga.exe' : 'naga');
  it.skipIf(!existsSync(naga))('validates the outlined depth-aware ribbon with Naga', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'tmt-ribbon-')), file = join(scratch, 'ribbon.wgsl');
    try {
      writeFileSync(file, ribbonShaderLinked().code);
      const result = spawnSync(naga, [file], { encoding: 'utf8', timeout: 30000 });
      expect(result.status, result.stderr || result.stdout || String(result.error)).toBe(0);
    } finally { unlinkSync(file); rmdirSync(scratch); }
  });

  const hw = 2.5 * 1.5 * 0.5; // 2.5 px at DPR 1.5, half width

  for (const turnDegrees of [0, 30, 60, 90, 120, 135]) {
    it(`a ${turnDegrees}° turn: both offset vertices lie on BOTH segments' offset edges (no gap, no overlap)`, () => {
      const a: V2 = [100, 300], b: V2 = [260, 300];
      const t = turnDegrees * Math.PI / 180;
      const c: V2 = [b[0] + Math.cos(t) * 150, b[1] + Math.sin(t) * 150];
      const m = ribbonOffset(a, b, c, hw);
      const d0 = unit(sub(b, a)), d1 = unit(sub(c, b));
      for (const side of [1, -1]) {
        const v = add(b, [m[0] * side, m[1] * side]);
        // The quad of segment AB ends on the line offset by ±hw along its normal, as does the quad of BC:
        expect(lineDistance(v, a, d0)).toBeCloseTo(hw * side, 6);
        expect(lineDistance(v, b, d1)).toBeCloseTo(hw * side, 6);
      }
    });
  }

  it('an interior angle of 120° (a 60° turn) and a 120° turn both join exactly: the strips share their joint vertices', () => {
    // The strip draws (prev−, prev+, joint−, joint+, next−, next+): the joint vertices are shared, so the two quads
    // meet along one edge. Coverage check: the joint edge spans exactly the full ribbon width across both segments.
    for (const turn of [60, 120]) {
      const a: V2 = [0, 0], b: V2 = [100, 0], t = turn * Math.PI / 180, c: V2 = [100 + 100 * Math.cos(t), 100 * Math.sin(t)];
      const m = ribbonOffset(a, b, c, hw);
      const d0 = unit(sub(b, a));
      // Projected on segment AB's normal, the joint edge spans [-hw, +hw]: the width never collapses at the joint.
      const n0: V2 = [-d0[1], d0[0]];
      expect(Math.abs(m[0] * n0[0] + m[1] * n0[1])).toBeCloseTo(hw, 6);
    }
  });

  it('the miter is limited to 4× the half width at hairpins, and ends use the segment normal', () => {
    const m = ribbonOffset([0, 0], [100, 0], [0, 1], hw);
    expect(len(m)).toBeLessThanOrEqual(RIBBON_MITER_LIMIT * hw + 1e-9);
    const start = ribbonOffset([0, 0], [0, 0], [10, 0], hw);
    expect(start[0]).toBeCloseTo(0, 12); expect(start[1]).toBeCloseTo(hw, 12);
    const end = ribbonOffset([0, 0], [10, 0], [10, 0], hw);
    expect(end[1]).toBeCloseTo(hw, 12);
    const fold = ribbonOffset([0, 0], [10, 0], [0, 0], hw); // 180°: defined, finite
    expect(Number.isFinite(fold[0]) && Number.isFinite(fold[1])).toBe(true);
  });
});

describe('overlay uniform layouts', () => {
  it('rings: 16 rings in 784 B; ribbon params in 48 B', () => {
    expect(MAX_RINGS).toBe(16);
    expect(RINGS.size).toBe(16 + 3 * 16 * MAX_RINGS);
    expect(RINGS.offsets).toMatchObject({ count: 0, centers: 16, colors: 16 + 256, widths: 16 + 512 });
    expect(RIBBON_PARAMS.size).toBe(48);
  });
});

describe('pending cuts (presentation side)', () => {
  it('adds, replaces by id, caps at 8 (oldest first), commits by id and expires', () => {
    const set = new PendingCutSet(5);
    for (let i = 0; i < 10; i++) set.add(`c${i}`, [0, 19, i], 2, i * 0.1);
    expect(set.size).toBe(8);
    expect(set.live(1).map(c => c.id)).toEqual(['c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
    set.add('c9', [1, 19, 0], 3, 1);
    expect(set.size).toBe(8);
    expect(set.commit(['c2', 'c3']).map(c => c.id)).toEqual(['c2', 'c3']);
    expect(set.size).toBe(6);
    expect(set.live(5.95).map(c => c.id)).toEqual(['c9']); // maxAge 5: everything announced before t = 0.95 expired
    expect(set.frameInput(5.95)).toEqual([{ center: [1, 19, 0], radius: 3, t0: 1 }]);
    set.commit();
    expect(set.size).toBe(0);
  });

  it('keeps pending crater geometry identical to collision until the closed mesh commits', () => {
    expect(pendingCraterModifier.vertex).not.toBe(true);
  });
});

describe('overlay output consumption probe', () => {
  const pass = (name: string, slot: string, reads: string[], writes: string[]) => ({ name, slot, reads, writes, run() {} });
  const overlay = pass('overlay', 'overlay', ['frameUniforms', 'hdr', 'depth'], ['hdr']);

  it('is true when a later pass reads the overlay output (the W0 composite reads hdr)', () => {
    const sorted = [pass('lighting', 'lighting', ['depth'], ['hdr']), overlay, pass('composite', 'composite', ['frameUniforms', 'hdr'], ['ldr'])];
    expect(overlayOutputConsumed({ sorted }, ['lighting', 'overlay', 'composite'])).toBe(true);
  });

  it('is false when bloom and composite read a TAA output instead, so the ribbon and rings would never reach the screen', () => {
    const sorted = [pass('taa', 'taa', ['hdr', 'history:taaColor'], ['taaColor']), overlay,
      pass('bloom', 'post.bloom', ['frameUniforms', 'taaColor'], ['bloomUp']), pass('composite', 'composite', ['taaColor', 'bloomUp'], ['ldr'])];
    expect(overlayOutputConsumed({ sorted }, ['taa', 'overlay', 'bloom', 'composite'])).toBe(false);
    // A consumer that did not run last frame does not count.
    expect(overlayOutputConsumed({ sorted: [...sorted, pass('late', 'debug', ['hdr'], [])] }, ['taa', 'overlay', 'bloom', 'composite'])).toBe(false);
  });

  it('is true for the CC-013 chain: TAA presents into postColor, the overlays draw into it, bloom and composite read it', () => {
    const sorted = [pass('taa', 'taa', ['hdr', 'history:taaColor'], ['taaColor']), pass('taa.present', 'taa', ['taaColor'], ['postColor']),
      pass('overlay', 'overlay', ['frameUniforms', 'postColor', 'depth'], ['postColor']),
      pass('bloom', 'post.bloom', ['frameUniforms', 'postColor'], ['bloomUp']), pass('composite', 'composite', ['postColor', 'bloomUp'], ['ldr'])];
    expect(overlayOutputConsumed({ sorted }, ['taa', 'taa.present', 'overlay', 'bloom', 'composite'])).toBe(true);
    // The history stays clean: no pass after the overlays writes taaColor, and TAA reads only its own history.
    expect(sorted.slice(2).some(p => p.writes.includes('taaColor'))).toBe(false);
  });

  it('checks the transparent pass when the overlays are routed there (TAA reads its hdr output)', () => {
    const sorted = [pass('transparent', 'transparent', ['frameUniforms', 'hdr', 'depth'], ['hdr']), pass('taa', 'taa', ['hdr', 'history:taaColor'], ['taaColor']),
      overlay, pass('composite', 'composite', ['taaColor'], ['ldr'])];
    expect(overlayOutputConsumed({ sorted }, ['transparent', 'taa', 'composite'], 'transparent')).toBe(true);
    expect(overlayOutputConsumed({ sorted }, ['transparent', 'taa', 'overlay', 'composite'])).toBe(false);
  });

  it('is null when it cannot tell', () => {
    expect(overlayOutputConsumed({}, ['overlay'])).toBeNull();
    expect(overlayOutputConsumed({ sorted: [overlay] }, [])).toBeNull();
    expect(overlayOutputConsumed({ sorted: [overlay] }, ['composite'])).toBeNull();
  });
});

describe('overlay route in the scene registry', () => {
  it('moves every overlay drawer to the end of the transparent pass and back, keeping registration and removal', () => {
    const scene = new Scene();
    const calls: string[] = [];
    const offRing = scene.addOverlayDrawer({ name: 'ring', draw() { calls.push('ring'); } });
    scene.addOverlayDrawer({ name: 'lines', draw() { calls.push('lines'); } });
    scene.addTransparentDrawer({ name: 'water', order: 5, draw() { calls.push('water'); } });
    expect(scene.overlayRoute).toBe('overlay');
    expect(scene.overlayDrawers.map(d => d.name)).toEqual(['ring', 'lines']);
    expect(scene.transparentDrawers.map(d => d.name)).toEqual(['water']);
    scene.setOverlayRoute('transparent');
    expect(scene.overlayDrawers).toHaveLength(0);
    expect(scene.transparentDrawers.map(d => d.name)).toEqual(['water', 'ring@transparent', 'lines@transparent']);
    const f = {} as never;
    for (const d of scene.transparentDrawers) d.draw({} as GPURenderPassEncoder, f);
    expect(calls).toEqual(['water', 'ring', 'lines']);
    scene.addTransparentDrawer({ name: 'smoke', order: 9, draw() {} });
    offRing();
    expect(scene.transparentDrawers.map(d => d.name)).toEqual(['water', 'smoke', 'lines@transparent']);
    scene.setOverlayRoute('overlay');
    expect(scene.overlayDrawers.map(d => d.name)).toEqual(['lines']);
    expect(scene.transparentDrawers.map(d => d.name)).toEqual(['water', 'smoke']);
  });
});
