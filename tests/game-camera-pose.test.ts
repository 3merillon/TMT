import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import type { V3 } from '../src/game/contracts';
import { cameraClearanceRadius } from '../src/game/follow-camera';
import { CameraPose } from '../src/game/presentation/camera-pose';
import { PlanetOrbitControls } from '../src/game/presentation/orbit-controls';

const close = (actual: ArrayLike<number>, expected: ArrayLike<number>, digits = 12) => {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) expect(actual[i], `component ${i}`).toBeCloseTo(expected[i], digits);
};

describe('owned camera pose', () => {
  it('preserves look-at orientation at ordinary, coincident and parallel-up positions', () => {
    const cases: [V3, V3, V3][] = [
      [[-17, 33, 26], [0, 13, 0], [0, 1, 0]],
      [[1, 2, 3], [1, 2, 3], [0, 1, 0]],
      [[0, 10, 0], [0, 0, 0], [0, 1, 0]],
      [[0, 0, 10], [0, 0, 0], [0, 0, 1]],
      [[.3, -.7, 1.2], [-2, .4, .8], [.1, .5, -.3]],
    ];
    for (const [position, target, up] of cases) {
      const owned = new CameraPose(), oracle = new PerspectiveCamera();
      owned.position = [...position]; owned.up = [...up]; owned.lookAt(target); owned.updateWorld();
      oracle.position.set(...position); oracle.up.set(...up); oracle.lookAt(new Vector3(...target)); oracle.updateMatrixWorld();
      close(owned.rotation, oracle.quaternion.toArray());
      close(owned.worldMatrix, oracle.matrixWorld.elements);
      close(owned.viewMatrix, oracle.matrixWorldInverse.elements);
    }
  });

  it('keeps local roll then pitch shake in the rendered world basis', () => {
    const owned = new CameraPose(), oracle = new PerspectiveCamera();
    owned.position = [4, -7, 11]; owned.up = [.2, .9, -.3]; owned.lookAt([-3, 2, 8]);
    oracle.position.set(...owned.position); oracle.up.set(...owned.up); oracle.lookAt(new Vector3(-3, 2, 8));
    for (const angle of [-.035, .012, 0, .024]) {
      owned.rotateLocal([0, 0, 1], angle); owned.rotateLocal([1, 0, 0], angle * .6); owned.updateWorld();
      oracle.rotateZ(angle); oracle.rotateX(angle * .6); oracle.updateMatrixWorld();
      close(owned.rotation, oracle.quaternion.toArray());
      close(owned.worldMatrix, oracle.matrixWorld.elements);
    }
  });

  it('preserves zoom, asymmetric sub-views, near-plane clearance and OpenGL depth', () => {
    for (const far of [220, 2000]) for (const zoom of [.5, 1, 2]) for (const shifted of [false, true]) {
      const owned = new CameraPose(100, .6, .5, far), oracle = new PerspectiveCamera(100, .6, .5, far);
      owned.zoom = oracle.zoom = zoom;
      if (shifted) {
        owned.viewOffset = [3000, 1000, 800, -300, 1200, 700];
        oracle.setViewOffset(3000, 1000, 800, -300, 1200, 700);
      }
      owned.updateProjection(); oracle.updateProjectionMatrix();
      close(owned.projectionMatrix, oracle.projectionMatrix.elements);
      close(owned.inverseProjectionMatrix, oracle.projectionMatrixInverse.elements);
      for (const x of [-1, 1]) for (const y of [-1, 1]) {
        const corner = new Vector3(x, y, -1).applyMatrix4(oracle.projectionMatrixInverse);
        expect(corner.length()).toBeLessThan(cameraClearanceRadius(owned));
      }
      close(owned.project([0, 0, -.5]), new Vector3(0, 0, -.5).project(oracle).toArray());
      expect(owned.project([0, 0, -far])[2]).toBeCloseTo(1, 12);
    }
  });

  it('projects world points through the independent finite reference camera', () => {
    const owned = new CameraPose(47, 16 / 9, .08, 220), oracle = new PerspectiveCamera(47, 16 / 9, .08, 220);
    owned.position = [7, 25, -14]; owned.up = [.2, .9, -.1]; owned.lookAt([0, 18, 0]); owned.updateWorld();
    oracle.position.set(...owned.position); oracle.up.set(...owned.up); oracle.lookAt(new Vector3(0, 18, 0)); oracle.updateMatrixWorld();
    for (const point of [[0, 18, 0], [2, 19, -.5], [8, -3, 5], [-10, 7, 22]] as V3[]) close(owned.project(point), new Vector3(...point).project(oracle).toArray());
  });

  it('keeps overview orbit and zoom damping independent of frame rate in radial frames', () => {
    for (const target of [[0, 0, 0], [0, 13, 0], [7, -4, 2]] as V3[]) {
      const cameras = [new CameraPose(), new CameraPose()];
      const controls = cameras.map(camera => {
        const orbit = new PlanetOrbitControls();
        camera.position = [-17, 33, 26]; orbit.reset(camera, target);
        orbit.rotateBy(110, -50); orbit.zoomBy(160);
        return orbit;
      });
      for (const [i, fps] of [30, 120].entries()) for (let frame = 0; frame < fps; frame++) controls[i].update(cameras[i], 1 / fps);
      close(cameras[0].position, cameras[1].position, 10);
      close(cameras[0].worldMatrix, cameras[1].worldMatrix, 10);
      const up = new Vector3(...target).length() > 1e-3 ? new Vector3(...target).normalize() : new Vector3(0, 1, 0);
      close(cameras[0].up, up.toArray());
      expect(controls[0].orbitDistance).toBeGreaterThanOrEqual(controls[0].minDistance);
      expect(controls[0].orbitDistance).toBeLessThanOrEqual(controls[0].maxDistance);
      controls.forEach(orbit => orbit.dispose());
    }
  });
});
