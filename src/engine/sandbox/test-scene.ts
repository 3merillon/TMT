/**
 * `?scene=test` — the W0 test scene, a RenderModule built only from `scene.meshes` / `scene.instances` / `scene.lights`:
 * an icosphere planet (r = 18, noise-displaced, paint), 20 boxes, a box "tank" of 5 parts (gunmetal, rubber, paint, brass)
 * on a flat ground patch, and a few punctual lights. The turret and three boxes animate so the velocity view has motion.
 */
import { MATERIAL_CLASS } from '../contracts';
import type { EngineServices, InstanceHandle, RenderModule, Vec3 } from '../contracts';
import { add3, boxMesh, fbm, mul4, norm, planetMesh, plateMesh, rotationY, scale3, scaling, surfaceFrame, surfaceModel, translation } from './geometry';
import { focusRingDrawer } from './focus-ring';
import type { SandboxScene, SceneFactory } from './scene-types';

const RADIUS = 18;
const SEED = 7;
const RELIEF = 0.85;
const FOCUS_DIR = norm([0.32, 0.86, 0.4]);
const FLAT_INNER = 2.6, FLAT_OUTER = 5.5;

/** Planet surface radius along a unit direction: fbm relief, flattened to RADIUS around the focus (the tank's patch). */
export function surfaceRadius(d: readonly number[]): number {
  const relief = fbm(d, SEED) * RELIEF + fbm(d, SEED + 11, 3, 5.3) * 0.18;
  const dist = Math.acos(Math.min(1, d[0] * FOCUS_DIR[0] + d[1] * FOCUS_DIR[1] + d[2] * FOCUS_DIR[2])) * RADIUS;
  const t = Math.min(1, Math.max(0, (dist - FLAT_INNER) / (FLAT_OUTER - FLAT_INNER)));
  const w = t * t * (3 - 2 * t);
  return RADIUS + relief * w;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const createTestScene: SceneFactory = () => {
  const focus: Vec3 = scale3(FOCUS_DIR, RADIUS);
  const { u, t, b } = surfaceFrame(focus);
  // Side/back light relative to the default camera (yaw −0.7), about 40° above the horizon at the focus.
  const sun = norm(add3(add3(scale3(u, 0.62), scale3(t, 0.24)), scale3(b, 0.75)));
  let services: EngineServices | null = null;
  const animated: { h: InstanceHandle; base: Float32Array; spin: number }[] = [];
  let turret: { h: InstanceHandle; base: Float32Array; barrel: InstanceHandle; barrelLocal: Float32Array } | null = null;

  const module: RenderModule = {
    name: 'sandbox.test-scene',
    install(s) {
      services = s;
      const sc = s.scene;
      // Planet (TERRAIN class, paint tinted grass-green).
      const planet = sc.meshes.create(planetMesh(6, surfaceRadius));
      sc.instances.add(planet, { model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), tint: [0.2, 0.34, 0.12], classId: MATERIAL_CLASS.TERRAIN, objectId: 1, castShadow: true });
      // One box mesh per matId.
      const boxes = Array.from({ length: 8 }, (_, id) => sc.meshes.create(boxMesh(id)));
      const plate = sc.meshes.create(plateMesh(0));
      // Ground patch under the tank.
      sc.instances.add(plate, { model: surfaceModel(add3(focus, scale3(u, 0.01)), focus, 0, [5.5, 1, 5.5]), tint: [0.42, 0.4, 0.36], classId: MATERIAL_CLASS.STRUCTURE, objectId: 2 });

      // Tank: hull (paint), two tracks (rubber), turret (gunmetal), barrel (brass). Local y up, z forward.
      const tankModel = surfaceModel(focus, focus, 0.6, [1, 1, 1]);
      const part = (m: Float32Array) => mul4(tankModel, m);
      const at = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => part(mul4(translation(x, y, z), scaling(sx, sy, sz)));
      const tankTint: Vec3 = [0.62, 0.16, 0.1];
      sc.instances.add(boxes[0], { model: at(0, 0.42, 0, 0.9, 0.34, 1.5), tint: tankTint, objectId: 10 });
      sc.instances.add(boxes[2], { model: at(-0.56, 0.2, 0, 0.26, 0.4, 1.7), objectId: 10 });
      sc.instances.add(boxes[2], { model: at(0.56, 0.2, 0, 0.26, 0.4, 1.7), objectId: 10 });
      const turretBase = part(translation(0, 0.72, -0.1));
      const turretH = sc.instances.add(boxes[3], { model: mul4(turretBase, scaling(0.62, 0.26, 0.7)), objectId: 11 });
      const barrelLocal = mul4(translation(0, 0.02, 0.62), scaling(0.09, 0.09, 0.95));
      const barrelH = sc.instances.add(boxes[4], { model: mul4(turretBase, barrelLocal), objectId: 11 });
      turret = { h: turretH, base: turretBase, barrel: barrelH, barrelLocal };

      // 20 boxes around the patch, sitting on the surface.
      const rnd = mulberry32(12345);
      const mats = [0, 1, 3, 4, 5, 6, 7, 0, 3, 7];
      for (let i = 0; i < 20; i++) {
        const ang = (i / 20) * Math.PI * 2 + rnd() * 0.25;
        const dist = 3.2 + rnd() * 6.5;
        const dir = norm(add3(focus, add3(scale3(t, Math.cos(ang) * dist), scale3(b, Math.sin(ang) * dist))));
        const size: Vec3 = [0.35 + rnd() * 0.9, 0.3 + rnd() * 1.1, 0.35 + rnd() * 0.9];
        const ground = surfaceRadius(dir) - 0.04;
        const pos = scale3(dir, ground + size[1] / 2);
        const matId = mats[i % mats.length];
        const tint: Vec3 = matId === 5 ? [1.0, 0.25, 0.08] : [0.25 + rnd() * 0.7, 0.25 + rnd() * 0.6, 0.2 + rnd() * 0.6];
        const model = surfaceModel(pos, dir, rnd() * Math.PI, size);
        const h = sc.instances.add(boxes[matId], { model, tint, objectId: 20 + i });
        if (i % 7 === 3) animated.push({ h, base: model, spin: 0.6 + rnd() });
        if (matId === 5) sc.lights.add({ type: 'point', position: scale3(dir, ground + size[1] + 0.6), color: tint, intensity: 6, range: 5 });
      }
      // Lights near the tank.
      sc.lights.add({ type: 'point', position: add3(focus, add3(scale3(u, 1.6), scale3(t, 1.8))), color: [1.0, 0.72, 0.4], intensity: 5, range: 6 });
      sc.lights.add({ type: 'point', position: add3(focus, add3(scale3(u, 1.2), scale3(b, -2.2))), color: [0.35, 0.8, 1.0], intensity: 4, range: 5 });
      // Overlay: a depth-tested focus ring around the tank.
      sc.addOverlayDrawer(focusRingDrawer(s, add3(focus, scale3(u, 0.01)), 2.1, [2.4, 1.5, 0.35]));
      const fwd: Vec3 = [tankModel[8], tankModel[9], tankModel[10]];
      sc.lights.add({ type: 'spot', position: add3(add3(focus, scale3(u, 0.6)), scale3(fwd, 0.9)), direction: norm(add3(fwd, scale3(u, -0.25))), color: [1, 0.95, 0.8], intensity: 18, range: 9, innerAngle: 0.25, outerAngle: 0.45 });
    },
  };

  const scene: SandboxScene = {
    name: 'test', module, focus, sun, defaultCamera: 'boom17',
    cameras: {
      boom6: { distance: 6, yaw: -0.9, pitch: 0.36 },
      boom17: { distance: 17, yaw: -0.7, pitch: 0.55 },
      boom36: { distance: 36, yaw: -0.6, pitch: 0.8 },
      overview: { target: [0, 0, 0], distance: 72, yaw: -0.6, pitch: 0.95 },
    },
    update(time) {
      const sc = services?.scene;
      if (!sc) return;
      for (const a of animated) sc.instances.set(a.h, mul4(a.base, rotationY(time * a.spin)));
      if (turret) {
        const yawM = mul4(turret.base, rotationY(Math.sin(time * 0.7) * 0.9));
        sc.instances.set(turret.h, mul4(yawM, scaling(0.62, 0.26, 0.7)));
        sc.instances.set(turret.barrel, mul4(yawM, turret.barrelLocal));
      }
    },
  };
  return scene;
};

export default createTestScene;
