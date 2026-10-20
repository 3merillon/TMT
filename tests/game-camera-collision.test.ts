import { CameraPose } from '../src/game/presentation/camera-pose';
import { describe, expect, it } from 'vitest';
import { Matrix4, BoxGeometry, Quaternion, Vector3 } from 'three';
import type { TerrainChunk, V3 } from '../src/game/contracts';
import { queryCollision, ResidentQueries } from '../src/game/resident-queries';
import { TankFollowCamera, keepOverviewOutsideTerrain, cameraClearanceRadius } from '../src/game/follow-camera';

function box(id: string, center: V3, size: V3): TerrainChunk {
  const geometry = new BoxGeometry(...size).translate(...center);
  return { id, positions: geometry.attributes.position.array as Float32Array, indices: Uint32Array.from(geometry.index!.array),
    normals: new Float32Array(), colors: new Float32Array(), materials: new Uint16Array(geometry.index!.count / 3).fill(1) };
}

describe('swept orbital camera clearance', () => {
  it('contains all near-plane corners with wide, zoomed and off-centre projections', () => {
    const camera = new CameraPose(100, 3, .5, 220);
    camera.zoom = .5; camera.viewOffset = [3000, 1000, 800, -300, 3000, 1000]; camera.updateProjection();
    const radius = cameraClearanceRadius(camera);
    for (const x of [-1, 1]) for (const y of [-1, 1]) {
      const corner = new Vector3(x, y, -1).applyMatrix4(new Matrix4().fromArray(camera.inverseProjectionMatrix));
      expect(corner.length()).toBeLessThan(radius);
    }
  });

  it('clips constraints that move through a wall even when their endpoint is back in air', () => {
    const world = queryCollision([box('wall', [0, 25, -4], [60, 40, .1])]);
    const camera = new CameraPose(47, 2, .08, 220), follow = new TankFollowCamera(camera), target: V3 = [0, 0, 0];
    follow.update({ position: [0, 18.6, 0], rotation: [0, 0, 0, 1] }, target, 1 / 60, true, world, [() => [0, 25, -8]]);
    expect(camera.position[2]).toBeGreaterThan(-3.7);
    expect(world.sweepSphere(camera.position, [0, 1, 0], 0, cameraClearanceRadius(camera))).toBeNull();
  });

  it('keeps the final shaken camera clear of crater walls for every frame', () => {
    const world = queryCollision([box('wall', [0, 25, -4], [60, 40, .1]), box('floor', [0, 16, 0], [60, 2, 60])]);
    const camera = new CameraPose(47, 2, .08, 220), follow = new TankFollowCamera(camera), target: V3 = [0, 0, 0];
    for (let i = 0; i < 180; i++) {
      follow.addTrauma(1);
      follow.update({ position: [0, 18.6, 0], rotation: [0, 0, 0, 1] }, target, 1 / 60, i === 0, world);
      expect(world.isSolid(camera.position)).toBe(false);
      expect(world.sweepSphere(camera.position, [0, 1, 0], 0, cameraClearanceRadius(camera))).toBeNull();
    }
  });

  it('checks recovery offsets against neighboring terrain instead of trusting one face normal', () => {
    const world = queryCollision([box('planet', [0, 0, 0], [36, 36, 36])]), camera = new CameraPose();
    // A surface query may meet a steep adjoining face; its normal offset remains in rock.
    world.surface = () => ({ point: [0, 17.9, 0], normal: [1, 0, 0], distance: 1, material: 1 });
    camera.position = [0, 15, 0]; keepOverviewOutsideTerrain(camera, world);
    expect(world.isSolid(camera.position)).toBe(false);
    expect(world.sweepSphere(camera.position, [0, 1, 0], 0, cameraClearanceRadius(camera))).toBeNull();
  });

  it('hits faces, near-plane edge and corner grazes even when the center ray misses', () => {
    const world = queryCollision([box('wall', [0, 0, 0], [2, 2, 2])]);
    expect(world.sweepSphere([0, 0, 5], [0, 0, -1], 10, .3)).toBeCloseTo(3.7);
    expect(world.raycast([1.2, 0, 5], [0, 0, -1], 10)).toBeNull();
    expect(world.sweepSphere([1.2, 0, 5], [0, 0, -1], 10, .3)).toBeCloseTo(4 - Math.sqrt(.09 - .04));
    expect(world.sweepSphere([1.15, 1.15, 5], [0, 0, -1], 10, .3)).toBeCloseTo(4 - Math.sqrt(.09 - .045));
    expect(world.sweepSphere([1.4, 0, 5], [0, 0, -1], 10, .3)).toBeNull();
    expect(world.sweepSphere([0, 0, 1.2], [0, 0, 1], 0, .3)).toBe(0);
    expect(world.sweepSphere([0, 0, 5], [0, 0, -1], 3, .3)).toBeNull();
  });

  it('queries translated and rotated structural bodies and uses their live pose', () => {
    let position: V3 = [0, 20, -5];
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), .6).toArray() as [number, number, number, number];
    const world = new ResidentQueries(1, queryCollision([]), new Map([[1, { collision: queryCollision([box('body', [0, 0, 0], [4, 4, .1])]), pose: () => ({ position, rotation }) }]]));
    expect(world.sweepSphere([0, 20, 0], [0, 0, -1], 10, .28)).toBeGreaterThan(4);
    expect(world.sweepSphere([0, 20, 0], [0, 0, -1], 10, .28)).toBeLessThan(5);
    position = [20, 20, -5]; expect(world.sweepSphere([0, 20, 0], [0, 0, -1], 10, .28)).toBeNull();
  });

  it('retracts immediately for a wall and eases back to the requested orbit when it disappears', () => {
    const tank = { position: [0, 18.6, 0] as V3, rotation: [0, 0, 0, 1] as [number, number, number, number] }, target: V3 = [0, 0, 0];
    const camera = new CameraPose(47, 2, .08, 220), follow = new TankFollowCamera(camera);
    const empty = queryCollision([]), wall = queryCollision([box('wall', [0, 28, -4], [30, 30, .1])]);
    follow.update(tank, target, 0, true, empty); expect(new Vector3(...camera.position).distanceTo(new Vector3(...target))).toBeCloseTo(17);
    follow.update(tank, target, 1 / 60, false, wall);
    const compressed = new Vector3(...camera.position).distanceTo(new Vector3(...target));
    expect(compressed).toBeLessThan(5); expect(wall.isSolid(camera.position)).toBe(false);
    expect(wall.sweepSphere(camera.position, [0, 1, 0], 0, .28)).toBeNull();
    follow.update(tank, target, 1 / 60, false, empty);
    expect(new Vector3(...camera.position).distanceTo(new Vector3(...target))).toBeGreaterThan(compressed);
    expect(new Vector3(...camera.position).distanceTo(new Vector3(...target))).toBeLessThan(7);
    for (let i = 0; i < 120; i++) follow.update(tank, target, 1 / 60, false, empty);
    expect(new Vector3(...camera.position).distanceTo(new Vector3(...target))).toBeCloseTo(17, 2);
    expect(follow.distance).toBe(17);
  });

  it('keeps orbiting and following across steering, radial poles and repeated ground-facing drags', () => {
    const camera = new CameraPose(), follow = new TankFollowCamera(camera), target: V3 = [0, 0, 0];
    const tank = { position: [0, 18.6, 0] as V3, rotation: [0, 0, 0, 1] as [number, number, number, number] };
    follow.update(tank, target, 0, true); follow.orbit(200, 0); follow.update(tank, target, 1 / 60);
    const chosen = new Vector3(...camera.position).sub(new Vector3(...target)).normalize();
    tank.rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 1.5).toArray() as typeof tank.rotation;
    follow.update(tank, target, 1 / 60);
    expect(new Vector3(...camera.position).sub(new Vector3(...target)).normalize().distanceTo(chosen)).toBeLessThan(1e-12);
    const ground = queryCollision([box('ground', [0, 17, 0], [60, 2, 60])]);
    for (let i = 0; i < 80; i++) {
      tank.position[0] += .02; follow.orbit(8, -20); follow.update(tank, target, 1 / 60, false, ground);
      expect(new Vector3(...target).distanceTo(new Vector3(...tank.position))).toBeCloseTo(.85);
      expect(ground.isSolid(camera.position)).toBe(false);
      expect(ground.sweepSphere(camera.position, [0, 1, 0], 0, .28)).toBeNull();
    }
  });

  it('escapes an engulfed focus under a newly moved overhang without disabling collision', () => {
    const world = queryCollision([box('slab', [0, 19.45, 0], [2, .2, 2])]);
    const camera = new CameraPose(), follow = new TankFollowCamera(camera), target: V3 = [0, 0, 0];
    follow.update({ position: [0, 18.6, 0], rotation: [0, 0, 0, 1] }, target, 0, true, world);
    expect(world.isSolid(camera.position)).toBe(false);
    expect(world.sweepSphere(camera.position, [0, 1, 0], 0, .28)).toBeNull();
  });

  it('keeps the optional planet overview outside terrain when zooming inside it', () => {
    const world = queryCollision([box('planet', [0, 0, 0], [36, 36, 36])]), camera = new CameraPose(47, 2, .08, 220);
    for (const height of [0, 15, 18.1]) {
      camera.position = [0, height, 0]; keepOverviewOutsideTerrain(camera, world);
      expect(camera.position[1]).toBeGreaterThan(18.28);
      expect(world.isSolid(camera.position)).toBe(false);
      expect(world.sweepSphere(camera.position, [0, 1, 0], 0, .28)).toBeNull();
    }
  });
});
