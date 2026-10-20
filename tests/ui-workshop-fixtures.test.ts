import { describe, expect, it } from 'vitest';
import { fanRotorMesh, liftDeckMesh, liftFoundationMesh } from '../src/game/workshop/fixtures';
import { RoomPickingGrid } from '../src/game/workshop/picking';
import { liftControlPanelMesh, liftPushbuttonMesh, LIFT_BUTTON_POINTS } from '../src/game/workshop/control-panel';
import { WORKSHOP_LIFT_CONTROL_POINT } from '../src/game/workshop/dimensions';

describe('dimensioned workshop fixtures', () => {
  it('has real grating apertures and load-bearing bars at the kit contact datum', () => {
    const mesh = liftDeckMesh(), grid = new RoomPickingGrid([mesh]);
    // Halfway between bearing bars and crossbars sees through the open deck.
    expect(grid.occludes([.2925, 1, .12], [0, -1, 0], .6)).toBe(false);
    expect(grid.occludes([.26, 1, .12], [0, -1, 0], .6)).toBe(true);
    expect(grid.occludes([.2925, 1, .12], [0, 1, 0], 3)).toBe(false);
  });
  it('never overlaps the grating, divider or rim triangles on their visible contact plane', () => {
    const mesh = liftDeckMesh(), top: [number, number][][] = [];
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const vertices = [0, 1, 2].map(j => mesh.indices[i + j] * 3);
      if (vertices.every(v => Math.abs(mesh.positions[v + 1] - .65) < 1e-6))
        top.push(vertices.map(v => [mesh.positions[v], mesh.positions[v + 2]]));
    }
    const area = (p: [number, number][]) => p.reduce((n, v, i) => { const q = p[(i + 1) % p.length]; return n + v[0] * q[1] - v[1] * q[0]; }, 0) / 2;
    const overlap = (a: [number, number][], b: [number, number][]) => {
      let polygon = a; const sign = Math.sign(area(b));
      for (let edge = 0; edge < 3 && polygon.length; edge++) {
        const c = b[edge], d = b[(edge + 1) % 3], side = (p: [number, number]) => sign * ((d[0] - c[0]) * (p[1] - c[1]) - (d[1] - c[1]) * (p[0] - c[0]));
        const clipped: [number, number][] = [];
        for (let i = 0; i < polygon.length; i++) {
          const p = polygon[i], q = polygon[(i + 1) % polygon.length], s = side(p), t = side(q);
          if (s >= 0) clipped.push(p);
          if ((s >= 0) !== (t >= 0)) { const f = s / (s - t); clipped.push([p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])]); }
        }
        polygon = clipped;
      }
      return Math.abs(area(polygon));
    };
    expect(top.length).toBeGreaterThan(100);
    for (let a = 0; a < top.length; a++) for (let b = a + 1; b < top.length; b++)
      expect(overlap(top[a], top[b]), `coplanar grating triangles ${a}/${b}`).toBeLessThan(1e-8);
  });
  it('keeps the pitched rotor inside its guard and produces finite unit normals', () => {
    const fan = fanRotorMesh();
    let front = -Infinity, back = Infinity;
    for (let i = 0; i < fan.positions.length; i += 3) {
      expect(Math.hypot(fan.positions[i], fan.positions[i + 1])).toBeLessThan(1.55);
      expect(Math.hypot(fan.normals[i], fan.normals[i + 1], fan.normals[i + 2])).toBeCloseTo(1, 5);
      front = Math.max(front, fan.positions[i + 2]); back = Math.min(back, fan.positions[i + 2]);
    }
    expect(front - back).toBeGreaterThan(.20);
    expect(fan.indices.every(index => index < fan.positions.length / 3)).toBe(true);
  });
  it('blocks picking only when a fixture is closer than the tank', () => {
    const grid = new RoomPickingGrid([liftFoundationMesh()]);
    expect(grid.occludes([0, .25, 3], [0, 0, -1], .5)).toBe(false);
    expect(grid.occludes([0, .25, 3], [0, 0, -1], 3)).toBe(true);
    expect(grid.occludes([0, 2, 3], [0, 0, -1], 3)).toBe(false);
  });
  it('keeps the two physical arrow faces front-facing and routes the conduit below the slab outside the foot', () => {
    for (const direction of [-1, 1] as const) {
      const button = liftPushbuttonMesh(direction), p = button.positions, n = button.normals;
      const face = [];
      for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i + 2] - .015) < 1e-6) face.push(n[i + 2]);
      expect(face).toHaveLength(3); expect(face.every(z => z > .99)).toBe(true);
    }
    expect(LIFT_BUTTON_POINTS[0][1]).toBeGreaterThan(LIFT_BUTTON_POINTS[1][1]);
    const p = liftControlPanelMesh().positions;
    let floorEntries = 0;
    for (let i = 0; i < p.length; i += 3) if (p[i + 1] + WORKSHOP_LIFT_CONTROL_POINT[1] < -.01) {
      expect(p[i] + WORKSHOP_LIFT_CONTROL_POINT[0]).toBeGreaterThan(2.58); floorEntries++;
    }
    expect(floorEntries).toBeGreaterThan(12);
  });
});
