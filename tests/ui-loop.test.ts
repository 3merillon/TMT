import { afterEach, expect, it, vi } from 'vitest';
import { startLoop } from '../src/game/app/loop';
import type { GameSession } from '../src/game/app/session';
import type { GameView } from '../src/game/view';

vi.mock('../src/game/app/hooks', () => ({ combinedTimeScale: () => 1, hasFrameHooks: () => false, dispatchFrame: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

it('keeps a hidden world paused without GPU rendering, then resumes its normal frame on workshop exit', () => {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; });
  vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn() });
  let visible = false;
  const game = { ready: true, snapshot: { tanks: [{ position: [0, 0, 0] }] }, observer: 0, on: vi.fn(), setPaused: vi.fn(),
    command: vi.fn(), step: vi.fn(), preview: vi.fn(), interpolation: () => 0 };
  const view = { update: vi.fn(), render: vi.fn(), idle: vi.fn() };
  startLoop(game as unknown as GameSession, view as unknown as GameView, {
    worldVisible: () => visible, modalOpen: () => !visible, driveInput: () => ({ throttle: 0, steer: 0 }), fullPreview: () => false,
    syncActive: vi.fn(), updateHud: vi.fn(), tickToast: vi.fn(), diagnostics: vi.fn(),
  });
  callbacks.shift()!(100);
  expect(game.setPaused).toHaveBeenLastCalledWith(true); expect(game.step).not.toHaveBeenCalled();
  expect(view.update).not.toHaveBeenCalled(); expect(view.render).not.toHaveBeenCalled();
  expect(view.idle).toHaveBeenCalledOnce();
  visible = true;
  callbacks.shift()!(116);
  expect(game.setPaused).toHaveBeenLastCalledWith(false); expect(game.step).toHaveBeenCalledOnce();
  expect(view.update).toHaveBeenCalledOnce(); expect(view.render).toHaveBeenCalledOnce();
});

it('advances deferred GPU cleanup while a cancelled match is at the menu', () => {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; });
  vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn() });
  const game = { ready: false, on: vi.fn() }, view = { idle: vi.fn(), render: vi.fn() };
  startLoop(game as unknown as GameSession, view as unknown as GameView, {
    modalOpen: () => true, driveInput: () => ({ throttle: 0, steer: 0 }), fullPreview: () => false,
    syncActive: vi.fn(), updateHud: vi.fn(), tickToast: vi.fn(), diagnostics: vi.fn(),
  });
  for (const t of [100, 117, 134]) callbacks.shift()!(t);
  expect(view.idle).toHaveBeenCalledTimes(3); expect(view.render).not.toHaveBeenCalled();
});

it('projects world indicators after every render while panel updates remain throttled', () => {
  const callbacks: FrameRequestCallback[] = [], order: string[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; });
  vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn() });
  const game = { ready: true, snapshot: { tanks: [{ position: [0, 0, 0] }] }, observer: 0, on: vi.fn(), setPaused: vi.fn(),
    command: vi.fn(), step: vi.fn(), interpolation: () => 0 };
  const view = { update: vi.fn(), render: () => order.push('render') }, updateHud = vi.fn();
  startLoop(game as unknown as GameSession, view as unknown as GameView, {
    modalOpen: () => false, driveInput: () => ({ throttle: 0, steer: 0 }), fullPreview: () => false,
    syncActive: vi.fn(), updateHud, updateWorldIndicators: () => order.push('indicators'), tickToast: vi.fn(), diagnostics: vi.fn(),
  });
  for (let frame = 0; frame < 20; frame++) callbacks.shift()!(1000 + frame * 8.33);
  expect(order).toEqual(Array.from({ length: 20 }, () => ['render', 'indicators']).flat());
  expect(updateHud).toHaveBeenCalledTimes(2);
});

it('keeps wreck physics running behind a result modal, but stops when the world is hidden', () => {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; });
  vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn() });
  let visible = true;
  const game = { ready: true, snapshot: { phase: 'finished', tanks: [{ position: [0, 0, 0] }] }, observer: 0, on: vi.fn(), setPaused: vi.fn(),
    step: vi.fn(), settleWrecks: vi.fn(), interpolation: () => 0 };
  const view = { update: vi.fn(), render: vi.fn(), idle: vi.fn() };
  startLoop(game as unknown as GameSession, view as unknown as GameView, {
    modalOpen: () => true, worldVisible: () => visible, driveInput: () => ({ throttle: 0, steer: 0 }), fullPreview: () => false,
    syncActive: vi.fn(), updateHud: vi.fn(), tickToast: vi.fn(), diagnostics: vi.fn(),
  });
  callbacks.shift()!(100); callbacks.shift()!(117);
  expect(game.step).not.toHaveBeenCalled(); expect(game.settleWrecks).toHaveBeenCalledTimes(2);
  expect(view.render).toHaveBeenCalledTimes(2);
  visible = false; callbacks.shift()!(134);
  expect(game.settleWrecks).toHaveBeenCalledTimes(2); expect(view.idle).toHaveBeenCalledOnce();
});

it('includes skipped animation frames in benchmark presentation intervals', () => {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; });
  vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn() });
  let allowFrame = true;
  const bench = { stepSeconds: 1 / 60, simulationScale: 0, beforeFrame: () => allowFrame, beforeRender: vi.fn(), afterFrame: vi.fn() };
  vi.stubGlobal('window', { __tmtRenderBench: bench });
  const game = { ready: true, snapshot: { tanks: [{ position: [0, 0, 0] }] }, observer: 0, on: vi.fn(), setPaused: vi.fn(),
    command: vi.fn(), step: vi.fn(), interpolation: () => 0 };
  const view = { update: vi.fn(), render: vi.fn() };
  startLoop(game as unknown as GameSession, view as unknown as GameView, {
    modalOpen: () => false, driveInput: () => ({ throttle: 0, steer: 0 }), fullPreview: () => false,
    syncActive: vi.fn(), updateHud: vi.fn(), tickToast: vi.fn(), diagnostics: vi.fn(),
  });
  callbacks.shift()!(100);
  allowFrame = false; callbacks.shift()!(116); callbacks.shift()!(132);
  allowFrame = true; callbacks.shift()!(148);
  expect(view.render).toHaveBeenCalledTimes(2);
  expect(bench.afterFrame).toHaveBeenLastCalledWith(48);
  expect(view.render).toHaveBeenLastCalledWith(1000 / 60);
});
