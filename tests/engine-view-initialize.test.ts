import { expect, it, vi } from 'vitest';
import { GameView } from '../src/game/view';

const renderer = vi.hoisted(() => {
  let release!: () => void;
  const downloaded = new Promise<void>(resolve => { release = resolve; });
  return { downloaded, release, requested: vi.fn(), createEngine: vi.fn(), createScene: vi.fn() };
});

vi.mock('../src/game/presentation/renderer', async () => {
  renderer.requested();
  await renderer.downloaded;
  return { Engine: { create: renderer.createEngine }, RENDER_MODULES: [], createSceneModules: renderer.createScene,
    LIGHTING_DEBUG_VIEWS: [], TerrainDebris: class {}, createProjectileTrails: vi.fn() };
});

it('keeps the renderer out of shell imports and abandons initialization if the view closes during download', async () => {
  expect(renderer.requested).not.toHaveBeenCalled();
  // No DOM or GPU is needed until the lazy renderer arrives. Model the view closing in that interval.
  const view = { disposed: false };
  const initializing = GameView.prototype.initialize.call(view as unknown as GameView);
  const rejected = expect(initializing).rejects.toThrow('The game view was closed.');
  view.disposed = true;
  renderer.release();
  await rejected;
  expect(renderer.requested).toHaveBeenCalledOnce();
  expect(renderer.createScene).not.toHaveBeenCalled();
  expect(renderer.createEngine).not.toHaveBeenCalled();
});
