import { expect, it } from 'vitest';
import { fractureArmor } from '../src/game/presentation/armor-fracture';
import { finish, plate, shape } from '../src/game/presentation/campaign-machining';
import type { TankSurfaceMark } from '../src/engine';

it('keeps painted surface coordinates attached as an impact subdivides and bends armor', () => {
  const source = shape(0); plate(source, [0, 0, 0], [2, .1, 2]);
  const panel = finish(source, 'painted-panel', 'hull', 0);
  const uv = Float32Array.from({ length: panel.positions.length / 3 * 2 }, (_, index) => {
    const vertex = Math.floor(index / 2), coordinate = index % 2 === 0 ? 0 : 2;
    return .5 + panel.positions[vertex * 3 + coordinate] / 4;
  });
  const pixels = Uint8Array.from({ length: 4 * 4 * 4 }, (_, index) => index * 3);
  const painted = { ...panel, paintTexture: { width: 4, height: 4, pixels, uv } };
  const beforePositions = panel.positions.slice(), beforeUv = uv.slice(), beforePixels = pixels.slice();
  const mark: TankSurfaceMark = { position: [0, .05, 0], normal: [0, 1, 0], radius: .25,
    opacity: 1, softness: .5, color: [.02, .02, .02], damage: true };
  const damaged = fractureArmor(painted, [mark]);

  expect(damaged.indices.length).toBeGreaterThan(panel.indices.length);
  expect(damaged.paintTexture!.uv.length).toBe(damaged.positions.length / 3 * 2);
  expect(damaged.paintTexture!.pixels).toBe(pixels);
  expect(damaged.paintTexture).toMatchObject({ width: 4, height: 4 });
  let dented = false;
  for (let vertex = 0; vertex < damaged.positions.length / 3; vertex++) {
    const [x, y, z] = damaged.positions.subarray(vertex * 3, vertex * 3 + 3);
    // The impact moves steel along Y. Its original X/Z paint mapping must survive every new corner.
    expect(damaged.paintTexture!.uv[vertex * 2]).toBeCloseTo(.5 + x / 4, 6);
    expect(damaged.paintTexture!.uv[vertex * 2 + 1]).toBeCloseTo(.5 + z / 4, 6);
    if (Math.hypot(x, z) < .1 && y > -.04 && y < .04) dented = true;
  }
  expect(dented).toBe(true);
  expect(panel.positions).toEqual(beforePositions);
  expect(uv).toEqual(beforeUv);
  expect(pixels).toEqual(beforePixels);
});
