import { describe, expect, it } from 'vitest';
import { cameraRay, categoryView, centeredTankView, easeOrbit, HERO, inspectionView, workshopCamera, WorkshopPreviewFraming } from '../src/game/workshop/camera';
import { decodeRoomMesh } from '../src/game/workshop/room';
import type { MeshDesc } from '../src/engine';
import { RoomPickingGrid } from '../src/game/workshop/picking';

describe('workshop Cartesian camera', () => {
  it('keeps the full orbit inside the arched stone shell', () => {
    for (const yaw of [0, .4, 1.1, 1.57, 2.6, 3.14, 4.8]) for (const pitch of [-.1, .3, .7, 1.2, 1.45]) for (const distance of [2, 3.5, 7.6, 12]) {
      const { position } = workshopCamera({ ...HERO, yaw, pitch, distance });
      expect(position[0]).toBeGreaterThanOrEqual(-6.4); expect(position[0]).toBeLessThanOrEqual(6.4);
      expect(position[1]).toBeGreaterThanOrEqual(.42);
      const ceiling = 3.3 + 4.2 * Math.sqrt(Math.max(0, 1 - (position[0] / 7) ** 2));
      expect(position[1], `camera above vault at yaw ${yaw}, pitch ${pitch}, distance ${distance}`).toBeLessThan(ceiling);
      expect(position[2]).toBeGreaterThanOrEqual(-7.3); expect(position[2]).toBeLessThanOrEqual(8.1);
    }
  });
  it('casts the centre inspection ray at the tank with correct perspective axes', () => {
    for (const view of ['hero', 'front', 'side', 'rear', 'top'] as const) {
      const camera = workshopCamera(inspectionView(view)), center = cameraRay(camera, 960, 540, 1920, 1080);
      const delta = camera.target.map((v, i) => v - center.origin[i]), distance = Math.hypot(...delta);
      center.direction.forEach((v, i) => expect(v).toBeCloseTo(delta[i] / distance, 10));
      expect(Math.hypot(...cameraRay(camera, 1200, 300, 1920, 1080).direction)).toBeCloseTo(1, 10);
    }
  });
  it('stops the camera before room geometry and retains its orbit angle at the limits', () => {
    const obstacle = { positions: new Float32Array([-10, 0, 4, 10, 0, 4, 0, 10, 4]), indices: new Uint32Array([0, 1, 2]) } as MeshDesc;
    const grid = new RoomPickingGrid([obstacle]);
    expect(grid.distance([0, 2, 0], [0, 0, 1], 10)).toBe(4);
    const orbit = { ...HERO, yaw: 0, pitch: .1, distance: 11 };
    const camera = workshopCamera(orbit, (p, d, distance) => grid.distance(p, d, distance));
    expect(camera.position[2]).toBeLessThan(3.7);
    expect(camera.position[2]).toBeGreaterThan(3);
    const comparison = { ...HERO, target: [-2.2, 1.3, .5] as [number, number, number], distance: 11 };
    const constrained = workshopCamera(comparison);
    expect(Math.atan2(constrained.position[0] - comparison.target[0], constrained.position[2] - comparison.target[2])).toBeCloseTo(comparison.yaw, 8);
  });
  it('interpolates across the shortest yaw arc without sweeping through the tank', () => {
    const from = { ...HERO, yaw: Math.PI - .1 }, to = { ...HERO, yaw: -Math.PI + .1 };
    expect(easeOrbit(from, to, .5).yaw).toBeCloseTo(Math.PI, 10);
    expect(easeOrbit(HERO, inspectionView('front'), 0)).toEqual(HERO);
  });
  it('inspects accessories from the open service side and keeps their actual center in view', () => {
    const center: [number, number, number] = [.2, 1.8, -.4], orbit = categoryView('utility', center), camera = workshopCamera(orbit);
    expect(orbit.target).toEqual(center); expect(camera.position[0]).toBeLessThan(0); expect(camera.position[2]).toBeGreaterThan(2);
    expect(orbit.distance).toBeLessThan(5);
  });
  it('keeps a consistent comparison angle and restores installed framing after repeated candidate changes', () => {
    const framing = new WorkshopPreviewFraming(), installed = categoryView('utility', [.2, 1.8, -.4]);
    const comparison = framing.begin(installed, false);
    expect(comparison.yaw).toBe(installed.yaw); expect(comparison.pitch).toBe(installed.pitch);
    expect(comparison.distance).toBeGreaterThan(installed.distance); expect(comparison.target[0]).toBeLessThan(-2);
    expect(framing.begin(comparison, false)).toEqual(comparison);
    expect(framing.end(comparison)).toEqual(installed); expect(framing.active).toBe(false);
    expect(framing.end(installed)).toEqual(installed);
  });
  it('preserves manual orbit adjustments on dismissal and recenters a completed or closed preview on the tank', () => {
    const framing = new WorkshopPreviewFraming(), installed = categoryView('turret', [0, 1.5, 0]);
    const comparison = framing.begin(installed, true), manual = { ...comparison, yaw: -.9, pitch: .6, distance: comparison.distance * .8 };
    const restored = framing.end(manual);
    expect(restored.yaw).toBe(-.9); expect(restored.pitch).toBe(.6); expect(restored.distance).toBeCloseTo(installed.distance * .8);
    const centered = centeredTankView(restored, .4);
    expect(centered.target).toEqual([0, HERO.target[1] + .4, 0]); expect(centered.yaw).toBe(-.9); expect(centered.distance).toBeGreaterThanOrEqual(6.2);
    framing.begin(installed, false); framing.forget();
    expect(framing.end(inspectionView('front'))).toEqual(inspectionView('front'));
  });
});

describe('authored room binary validation', () => {
  const spec = { file: 'room-10.bin', material: 10, tint: [1, 1, 1] as [number, number, number], vertexCount: 3, indexCount: 3 };
  const valid = () => {
    const buffer = new ArrayBuffer(132);
    new Float32Array(buffer, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    new Float32Array(buffer, 36, 9).set([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    new Float32Array(buffer, 72, 9).fill(.4);
    new Uint32Array(buffer, 120, 3).set([0, 1, 2]); return buffer;
  };
  it('reads authored position, normal, colour and index spans without copying', () => {
    const buffer = valid(), mesh = decodeRoomMesh(spec, buffer);
    expect(mesh.positions.buffer).toBe(buffer); expect([...mesh.indices]).toEqual([0, 1, 2]);
    expect(mesh.partLocal?.[0]).toBeCloseTo(.4);
  });
  it('rejects truncated, nonfinite and out-of-range data before it reaches WebGPU', () => {
    expect(() => decodeRoomMesh(spec, new ArrayBuffer(128))).toThrow('Invalid workshop mesh');
    const invalidPosition = valid(); new Float32Array(invalidPosition)[0] = NaN;
    expect(() => decodeRoomMesh(spec, invalidPosition)).toThrow('Corrupt workshop mesh');
    const invalidIndex = valid(); new Uint32Array(invalidIndex, 120, 3)[2] = 3;
    expect(() => decodeRoomMesh(spec, invalidIndex)).toThrow('Corrupt workshop mesh');
  });
});
