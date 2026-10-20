import { afterEach, expect, it, vi } from 'vitest';
import { UiController } from '../src/game/ui/controller';
import { initialFlow, transition } from '../src/game/ui/flow';
import { OnlineMatch } from '../src/game/online/match';
import { makeOnlineSetup } from '../src/game/online/setup';
import type { GameSession } from '../src/game/app/session';
import type { OnlineClient } from '../src/game/online/client';
import type { Room } from '../src/game/online/protocol';

vi.hoisted(() => vi.stubGlobal('location', { search: '' }));

afterEach(() => vi.unstubAllGlobals());

it('lets gamepad navigation open manual sections and activate links while skipping hidden controls', () => {
  let activeElement: MenuElement | null = null;
  class MenuElement {
    opened = false;
    clicks = 0;
    constructor(readonly tagName: string, readonly offsetParent: object | null = {}, readonly href?: string) {}
    focus() { activeElement = this; }
    click() { this.clicks++; if (this.tagName === 'SUMMARY') this.opened = !this.opened; }
  }
  const summary = new MenuElement('SUMMARY'), hidden = new MenuElement('BUTTON', null);
  const link = new MenuElement('A', {}, 'https://example.com'), back = new MenuElement('BUTTON');
  const elements = [summary, hidden, link, back];
  const container = {
    contains: (element: unknown) => elements.includes(element as MenuElement),
    querySelector: () => null,
    querySelectorAll: (selector: string) => elements.filter(element => selector.split(',').some(part => {
      const tag = part.trim().match(/^[a-z]+/)?.[0].toUpperCase();
      return element.tagName === tag && (!part.includes('[href]') || !!element.href);
    })),
  };
  vi.stubGlobal('HTMLElement', MenuElement);
  vi.stubGlobal('document', { get activeElement() { return activeElement; }, getElementById: () => container });
  const controller = { flow: { screen: 'help' } } as unknown as UiController;
  const navigate = (action: 'navDown' | 'navUp' | 'confirm') =>
    (UiController.prototype as unknown as { navigate(action: string): void }).navigate.call(controller, action);
  navigate('navDown'); expect(activeElement).toBe(summary);
  navigate('confirm'); expect(summary.opened).toBe(true);
  navigate('navDown'); expect(activeElement).toBe(link);
  navigate('confirm'); expect(link.clicks).toBe(1);
  navigate('navDown'); expect(activeElement).toBe(back);
  navigate('navDown'); expect(activeElement).toBe(summary);
  navigate('navUp'); expect(activeElement).toBe(back);
});

it('keeps gamepad focus and activation inside the unsaved-paint dialog', () => {
  let activeElement: Button | null = null;
  class Button { clicks = 0; offsetParent = {}; focus() { activeElement = this; } click() { this.clicks++; } }
  const background = new Button(), save = new Button(), keep = new Button();
  const dialog = { contains: (element: unknown) => element === save || element === keep, querySelectorAll: () => [save, keep] };
  const screens = { contains: () => true, querySelectorAll: () => [background, save, keep], querySelector: () => dialog };
  vi.stubGlobal('HTMLElement', Button);
  vi.stubGlobal('document', { get activeElement() { return activeElement; }, getElementById: () => screens });
  const controller = { flow: { screen: 'help' } } as unknown as UiController;
  const navigate = (action: 'navDown' | 'navUp' | 'confirm') =>
    (UiController.prototype as unknown as { navigate(action: string): void }).navigate.call(controller, action);
  background.focus(); navigate('navDown'); expect(activeElement).toBe(save);
  navigate('confirm'); expect(save.clicks).toBe(1);
  navigate('navUp'); expect(activeElement).toBe(keep);
  navigate('confirm'); expect(keep.clicks).toBe(1); expect(background.clicks).toBe(0);
});

it('defers a direct workshop match start before changing history, flow or disposing the editor', () => {
  let leave!: () => void, dirty = true;
  const startGame = vi.fn(() => 'paint-test'), enter = vi.fn(), render = vi.fn();
  const navigation = { route: { screen: 'workshop' }, busy: false, startGame,
    needsGuard: () => dirty,
    beforeLeave: (_route: unknown, action: () => void) => { leave = () => { dirty = false; action(); }; return true; } };
  const controller = { o: { game: {} }, flow: transition(initialFlow(), { type: 'RESTORE', screen: 'workshop' }),
    navigationReady: true, restoring: false, navigation, enter, render, go: UiController.prototype.go } as unknown as UiController;
  expect(controller.go({ type: 'START' })).toBe(true);
  expect(startGame).not.toHaveBeenCalled(); expect(enter).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
  leave(); expect(startGame).toHaveBeenCalledOnce(); expect(enter).toHaveBeenCalledOnce(); expect(render).toHaveBeenCalledOnce();
});

it('keeps an online autostart pending after Keep painting and loads the same epoch on Return to match', async () => {
  const kit = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
  const setup = makeOnlineSetup('artillery', 2, kit);
  const room = { code: 'PAINT', epoch: 7, phase: 'playing', mode: 'artillery', seat: 0, hostSeat: 0, host: true, paused: false, setup,
    peers: [0, 1].map(seat => ({ seat, name: `Player ${seat}`, generation: 1, connected: true })) } as Room;
  const questions: { leave(): void; keep(): void }[] = [];
  const errors = vi.fn(), startMatch = vi.fn(async () => { game.ready = true; });
  const game = { on() {}, ready: false, startMatch, network: undefined };
  const startGame = vi.fn(() => 'same-epoch');
  const controller = { navigation: { beforeLeave: (_route: unknown, leave: () => void, keep: () => void) => { questions.push({ leave, keep }); return true; },
    startGame, route: { screen: 'match', game: 'same-epoch', parent: 'online', query: '' } },
    onlineMatch: {} as OnlineMatch, go: vi.fn(), start: undefined as (() => Promise<void>) | undefined };
  const internals = UiController.prototype as unknown as {
    launchOnline(setup: unknown, operation: () => Promise<void>): Promise<void>; resumeOnline(): void;
  };
  const match = new OnlineMatch(game as unknown as GameSession, () => ({ leaseValid: () => true }) as unknown as OnlineClient,
    (next, operation) => internals.launchOnline.call(controller as unknown as UiController, next, operation), errors);
  controller.onlineMatch = match;
  try {
    match.updateRoom(room, null);
    expect(questions).toHaveLength(1); questions[0].keep();
    expect(match.status).toMatch(/Match ready/); expect(startGame).not.toHaveBeenCalled(); expect(startMatch).not.toHaveBeenCalled();
    match.updateRoom({ ...room }, room);
    expect(questions).toHaveLength(1); expect(errors).not.toHaveBeenCalled();
    internals.resumeOnline.call(controller as unknown as UiController);
    expect(questions).toHaveLength(2); questions[1].leave();
    await controller.start!(); await Promise.resolve();
    expect(startGame).toHaveBeenCalledOnce(); expect(startMatch).toHaveBeenCalledExactlyOnceWith(setup, undefined, true);
    expect(controller.go).toHaveBeenCalledExactlyOnceWith({ type: 'RESTORE', screen: 'loading', origin: 'online' });
    expect(match.room?.epoch).toBe(7); expect(match.status).not.toMatch(/Match ready/); expect(errors).not.toHaveBeenCalled();
  } finally { match.dispose(); }
});
