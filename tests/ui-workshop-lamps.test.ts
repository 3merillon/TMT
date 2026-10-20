import { describe, expect, it } from 'vitest';
import { applyDir, applyPoint } from '../src/game/kit/geometry/math';
import { TASK_LAMPS, taskLampHeadMesh, taskLampPose, taskLampYokeMesh, wallLampMesh } from '../src/game/workshop/lamps';

describe('articulated workshop luminaires', () => {
  it('keeps pins seated, links rigid and the beam aligned through the full service lift travel', () => {
    for (const spec of TASK_LAMPS) for (let step = 0; step <= 34; step++) {
      const pose = taskLampPose(spec, step * .05);
      for (let i = 0; i < 2; i++) expect(Math.hypot(...pose.points[i].map((p, a) => p - pose.points[i + 1][a]))).toBeCloseTo(spec.lengths[i], 10);
      const axis = applyDir(pose.head, 0, 0, 1), length = Math.hypot(...axis);
      expect(axis.reduce((n, v, i) => n + v / length * pose.direction[i], 0)).toBeCloseTo(1, 10);
      const swivel = applyPoint(pose.yoke, 0, .40, 0);
      for (let a = 0; a < 3; a++) expect(swivel[a]).toBeCloseTo(pose.points[2][a], 10);
      const emitter = applyPoint(pose.head, 0, 0, .14);
      expect(emitter).toEqual(pose.emitter);
    }
    for (const spec of TASK_LAMPS.filter(s => s.bay)) expect(taskLampPose(spec, 1.7).direction).not.toEqual(taskLampPose(spec, 0).direction);
    for (const spec of TASK_LAMPS.filter(s => !s.bay)) expect(taskLampPose(spec, 1.7)).toEqual(taskLampPose(spec, 0));
  });
  it('keeps both shade and bearing fork outside the whole gantry bridge envelope', () => {
    for (const spec of TASK_LAMPS.filter(s => s.bay)) for (let step = 0; step <= 34; step++) {
      const pose = taskLampPose(spec, step * .05);
      for (const [mesh, frame] of [[taskLampHeadMesh(), pose.head], [taskLampYokeMesh(), pose.yoke]] as const)
        for (let i = 0; i < mesh.positions.length; i += 3) expect(Math.abs(applyPoint(frame, ...Array.from(mesh.positions.slice(i, i + 3)) as [number, number, number])[0])).toBeGreaterThan(2.925 + .06);
    }
  });
  it('has finite smooth surfaces with distinct painted housings, machined bearings and recessed optics', () => {
    for (const mesh of [taskLampHeadMesh(), taskLampYokeMesh(), wallLampMesh()]) {
      expect(mesh.indices.every(i => i < mesh.positions.length / 3)).toBe(true);
      for (let i = 0; i < mesh.normals.length; i += 3) expect(Math.hypot(...mesh.normals.slice(i, i + 3))).toBeCloseTo(1, 5);
      expect(mesh.positions.every(Number.isFinite)).toBe(true);
    }
    const mesh = taskLampHeadMesh();
    const materials = new Set(Array.from(mesh.attrs!, a => a >>> 16 & 255));
    expect(materials.size).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < mesh.positions.length / 3; i++) if ((mesh.attrs![i] >>> 16 & 255) === 5) expect(mesh.positions[i * 3 + 2]).toBeLessThan(-.10);
  });
});
