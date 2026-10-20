// W1-ENG-SCENE: CPU page culling (plan §4.7) — extractFrustumPlanes on the engine's reversed-Z infinite projection, the
// horizon occluder test (never culls a visible point) and the front-to-back order.
import { describe, expect, it } from 'vitest';
import { Camera } from '../src/engine/frame/camera';
import { boxSphere, cullAndSort, extractFrustumPlanes, HORIZON_OCCLUDER_RADIUS, sphereBehindHorizon, sphereInFrustum } from '../src/engine/scene/culling';

type V3 = [number, number, number];
function camera(position: V3, target: V3, up: V3 = [0, 1, 0], size: [number, number] = [1280, 720]) {
  const c = new Camera();
  c.update({ position, target, up, fovY: 47 * Math.PI / 180 }, size, size, false, 0);
  return c;
}
function mulberry(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

describe('extractFrustumPlanes (reversed-Z infinite)', () => {
  const cam = camera([0, 30, 20], [0, 18, 0]);
  const planes = extractFrustumPlanes(cam.viewProjNoJitter);

  it('the far plane degenerates to "accept everything" and the near plane is real', () => {
    expect(planes[4]).toEqual([0, 0, 0, 0]);
    const n = planes[5];
    expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 6);
    // A point just behind the near plane is outside; one just in front is inside.
    const fwd = [0 - 0, 18 - 30, 0 - 20]; const l = Math.hypot(...fwd); const f = fwd.map(v => v / l);
    const at = (d: number) => [f[0] * d, 30 + f[1] * d, 20 + f[2] * d];
    expect(sphereInFrustum(planes, at(0.04), 0)).toBe(false);
    expect(sphereInFrustum(planes, at(0.2), 0)).toBe(true);
    expect(sphereInFrustum(planes, at(1e5), 0)).toBe(true); // infinite far
  });

  it('agrees with projection for random points (inside ⇔ |ndc| ≤ 1 and in front)', () => {
    const rnd = mulberry(7);
    for (let i = 0; i < 2000; i++) {
      const p: V3 = [(rnd() - 0.5) * 60, (rnd() - 0.5) * 60, (rnd() - 0.5) * 60];
      const m = cam.viewProjNoJitter;
      const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
      const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      const inside = w > 0 && Math.abs(x / w) <= 1 && Math.abs(y / w) <= 1 && z / w <= 1;
      const margin = 1e-4;
      const strictlyInside = w > 0 && Math.abs(x / w) <= 1 - margin && Math.abs(y / w) <= 1 - margin && z / w <= 1 - margin;
      const got = sphereInFrustum(planes, p, 0);
      if (strictlyInside) expect(got).toBe(true);
      if (!inside && got) {
        // Only points within float noise of a plane may disagree.
        const d = Math.min(...planes.slice(0, 4).concat([planes[5]]).map(q => q[0] * p[0] + q[1] * p[1] + q[2] * p[2] + q[3]));
        expect(d).toBeGreaterThan(-1e-4);
      }
    }
  });

  it('spheres straddling a plane are kept', () => {
    const m = cam.viewProjNoJitter;
    void m;
    expect(sphereInFrustum(planes, [0, 18, 0], 0.5)).toBe(true);
    expect(sphereInFrustum(planes, [0, 30, 60], 1)).toBe(false); // behind the camera
  });
});

describe('horizon occluder (r = 15.2)', () => {
  const eye: V3 = [0, 30, 0];

  it('culls a page on the far side and keeps pages on the near side', () => {
    expect(sphereBehindHorizon(eye, [0, -18, 0], 1.5, 15.2)).toBe(true);
    expect(sphereBehindHorizon(eye, [0, 18, 0], 1.5, 15.2)).toBe(false);
    expect(sphereBehindHorizon(eye, [18, 0, 0], 1.5, 15.2)).toBe(false); // near the limb: visible from above
  });

  it('never culls a sphere that contains a point with a clear line of sight to the eye', () => {
    const rnd = mulberry(99);
    const R = 15.2;
    for (let i = 0; i < 4000; i++) {
      const dir = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]; const l = Math.hypot(...dir) || 1;
      const rad = 14 + rnd() * 10;
      const c: V3 = [dir[0] / l * rad, dir[1] / l * rad, dir[2] / l * rad];
      const r = 0.2 + rnd() * 3;
      if (!sphereBehindHorizon(eye, c, r, R)) continue;
      // Sample points of the sphere: every segment eye → point must pierce the occluder.
      for (let k = 0; k < 24; k++) {
        const s = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]; const sl = Math.hypot(...s) || 1;
        const p = [c[0] + s[0] / sl * r * rnd(), c[1] + s[1] / sl * r * rnd(), c[2] + s[2] / sl * r * rnd()];
        const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]]; const dl = Math.hypot(...d);
        const u = d.map(v => v / dl);
        const b = eye[0] * u[0] + eye[1] * u[1] + eye[2] * u[2];
        const cc = eye[0] ** 2 + eye[1] ** 2 + eye[2] ** 2 - R * R;
        const disc = b * b - cc;
        expect(disc).toBeGreaterThan(0);
        const tNear = -b - Math.sqrt(disc);
        expect(tNear).toBeLessThan(dl + 1e-9);
      }
    }
  });

  it('an eye inside the occluder culls nothing', () => {
    expect(sphereBehindHorizon([0, 10, 0], [0, -18, 0], 1, 15.2)).toBe(false);
  });
});

describe('cullAndSort', () => {
  it('keeps excavated crater walls and exposed core fragments without a proven occluder', () => {
    const cam = camera([0, 20, 0], [0, 0, 0], [0, 0, -1]);
    const items = [{ center: [0, 8, 0], radius: 1 }, { center: [0, 5, 0], radius: .5 }];
    expect(cullAndSort(items, cam.viewProjNoJitter, cam.eye, { occluderRadius: 15.2 }).visible).toEqual([]);
    expect(HORIZON_OCCLUDER_RADIUS).toBe(0);
    expect(cullAndSort(items, cam.viewProjNoJitter, cam.eye).visible).toEqual([0, 1]);
  });

  it('drops frustum- and horizon-culled pages and sorts front to back', () => {
    const cam = camera([0, 30, 0.001], [0, 0, 0], [0, 0, -1]);
    const items = [
      { center: [0, 18, 0], radius: 1 },       // straight below the eye: near
      { center: [3, 17.6, 0], radius: 1 },     // slightly farther
      { center: [0, -18, 0], radius: 1 },      // far side: horizon
      null,                                    // free slot
      { center: [0, 45, 0], radius: 1 },       // behind the camera: frustum
      { center: [8, 16, 0], radius: 1 },       // farther still
    ];
    const r = cullAndSort(items, cam.viewProjNoJitter, [0, 30, 0.001], { occluderRadius: 15.2 });
    expect(r.visible).toEqual([0, 1, 5]);
    expect(r.horizonCulled).toBe(1);
    expect(r.frustumCulled).toBe(1);
  });

  it('boxSphere encloses its box', () => {
    const s = boxSphere([-1, 2, 3], [4, 5, 9]);
    for (const x of [-1, 4]) for (const y of [2, 5]) for (const z of [3, 9]) expect(Math.hypot(x - s.center[0], y - s.center[1], z - s.center[2])).toBeLessThanOrEqual(s.radius + 1e-12);
  });
});
