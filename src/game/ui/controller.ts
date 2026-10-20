/**
 * The UI controller: runs the flow state machine (ui/flow.ts) and its side effects, renders the screens, owns the
 * profile and settings, starts matches through `session().startMatch()`, and wires the HUD and the input devices.
 * main.ts creates it once; the frame loop talks to it through `loopShell()`.
 */
import type { GameEvent, GameSnapshot } from '../contracts';
import { practiceSetup, type KitLoadoutIds, type MatchSetup } from '../api/match';
import { session } from '../api/session';
import { registerTelemetry } from '../app/hooks';
import type { GameSession } from '../app/session';
import type { LoopShell } from '../app/loop';
import { matchSeed, type PracticeMode } from '../app/dev-flags';
import { assembleKit, kitLoadoutToLegacy, validateKitLoadout } from '../kit';
import { fittingBudget, lockedKitParts } from '../meta/special-designs';
import {
  activeKit, browserStorage, readProgress, recordMatch, saveProgress, withActiveLoadout, withLoadout, withSettings, type ProgressProfile,
} from '../meta/profile';
import { dispatchSettings, updateSettings, type SettingsPatch } from '../meta/settings';
import { MAX_BARREL_PITCH, MIN_BARREL_PITCH } from '../simulation';
import { rotate } from '../math';
import type { GameView } from '../view';
import { createMatchActions, type MatchActions } from './actions';
import { byId, el } from './components/el';
import { initialFlow, overMatch, simulationPaused, transition, type FlowEvent, type FlowState } from './flow';
import { Hud } from './hud';
import { coverage, initialInputStyle, inputStyleFor, type InputStyle } from './hud-layout';
import type { PressAction } from './input/bindings';
import { canAim, type ContextInput } from './input/contexts';
import { InputController } from './input/controller';
import { GroundAimController } from './input/ground-aim';
import { bindMouseAim, dragPower, dragReach, grabRadius, solveDragAim, type Point, type TankScreenFrame } from './input/mouse';
import { bindTouchGestures } from './input/touch';
import { type LaunchOptions } from './launch';
import { browserNavigation, type NavigationRoute } from './navigation';
import { navigationGames } from './navigation-session';
import { clock, matchSummary, wonBy } from './results-model';
import { CampaignHud } from './campaign-hud';
import { missionSetup, type MissionId } from '../campaign/mission';
import { missionById } from '../campaign/catalog';
import { missionStars, campaignReward, cooperativeReward } from '../campaign/progress';
import { Autopilot } from '../campaign/autopilot';
import { profileCrew } from '../campaign/loadout';
import { renderCampaign } from './screens/campaign';
import type { MatchSummary, ScreenContext } from './screens/context';
import { renderHelp } from './screens/help';
import { renderPause } from './screens/pause';
import { renderResults } from './screens/results';
import { renderSettings } from './screens/settings';
import { renderSkirmish } from './screens/skirmish';
import { renderTitle } from './screens/title';
import { WorkshopScreen } from './screens/workshop';
import { defaultSkirmish, randomSeed, skirmishSetup, type SkirmishOptions } from './skirmish-setup';
import { clearToast, tickToast, toast } from './toast';
import { resolvePlanetType } from '../planet-field';
import { workshopSandbox } from '../workshop/sandbox';
import { releaseWorkshopPrewarm } from '../workshop/assets';
import { stopCampaignVoice } from '../../audio';
import { OnlineClient } from '../online/client';
import { OnlineMatch } from '../online/match';
import { makeOnlineSetup } from '../online/setup';
import { OnlineScreen } from './screens/online';
import { OnlineChat } from './online-chat';
import { missionIdOf } from '../campaign/mission';

export interface UiControllerOptions { root: HTMLElement; game: GameSession; view: GameView; launch: LaunchOptions }
/** A match start the flow runs when it enters 'loading' (kept for RESTART from the error screen). */
type StartAction = () => Promise<void>;

/** The finish card waits a moment so the last impact can be seen. */
const FINISH_DELAY_MS = 1400;
/** The profile owner's tank (the first spawn of every setup the front end builds). */
const OWNER = 0;

export class UiController {
  private readonly online: OnlineClient;
  private readonly onlineMatch: OnlineMatch;
  private readonly chat: OnlineChat;
  private onlineScreen: OnlineScreen | null = null;
  private readonly onlinePresence = el('aside', { class: 'online-presence', hidden: true, 'aria-label': 'Online status' });
  private readonly onlineStatus = el('span');
  private flow: FlowState = initialFlow();
  private profile: ProgressProfile;
  private readonly storage = browserStorage();
  private skirmish: SkirmishOptions;
  private summary: MatchSummary | null = null;
  private viewReady = false;
  private viewPromise: Promise<void> = new Promise(() => {});
  private matchReady = false;
  private startToken = 0;
  private onlineLaunch?: { start: StartAction; reject(error: unknown): void };
  private deferredOnline?: { run(): void; reject(error: unknown): void };
  private start?: StartAction;
  private pendingSetup?: MatchSetup;
  /** The start a RESTART from the match uses instead of replaying the setup (the drive-test toggle). */
  private nextStart?: StartAction;
  private finishTimer = 0;
  private readonly navigation = browserNavigation(route => this.restoreRoute(route), {
    needed: (from, to) => from.screen === 'workshop' && to.screen !== 'workshop' && !!this.workshop?.hasUnsavedPaint,
    request: (leave, cancel) => { if (this.workshop) this.workshop.requestLeave(leave, cancel); else leave(); },
  });
  private readonly navigationGames = navigationGames();
  private navigationReady = false;
  private activeGame: string | null = null;
  private resumeRoute: NavigationRoute | null = null;
  private restoring = false;
  private shots = new Map<number, number>();
  private readonly actions: MatchActions;
  private readonly input: InputController;
  private readonly hud: Hud;
  private readonly campaignHud: CampaignHud;
  private mouseAim?: ReturnType<typeof bindMouseAim>;
  private touchGestures?: ReturnType<typeof bindTouchGestures>;
  private readonly coarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
  private readonly initialStyle = initialInputStyle(location.search, !!this.coarse?.matches);
  private inputStyle: InputStyle = this.initialStyle.style;
  private readonly groundAim: GroundAimController;
  private workshop: WorkshopScreen | null = null;
  private workshopTest = false;
  private audioRoute = '';
  private audioScreen: FlowState['screen'] | null = null;

  constructor(private readonly o: UiControllerOptions) {
    this.profile = readProgress(this.storage);
    this.skirmish = defaultSkirmish(randomSeed(), this.profile.settings.gameplay.difficulty);
    this.onlineMatch = new OnlineMatch(o.game, () => this.online, (setup, operation) => this.launchOnline(setup, operation), message => toast(message, 10));
    this.online = new OnlineClient({ room: (room, previous) => {
      this.onlineMatch.updateRoom(room, previous);
      if (room.ended && (!previous?.ended || previous.code !== room.code)) this.finishDisconnectedMatch(room.ended);
      if (previous?.phase === 'finished' && room.phase === 'waiting') this.navigation.visit({ screen: 'online' });
      if (room.phase === 'finished' && previous?.host !== room.host && this.flow.screen === 'results') this.render();
    },
      peer: (room, seat, link) => this.onlineMatch.attach(room, seat, link), lost: message => toast(message, 10) });
    this.chat = new OnlineChat(o.root, this.online, () => this.profile.settings.gameplay.profanityFilter);
    this.onlinePresence.append(this.onlineStatus,
      el('button', { text: 'Server', onclick: () => this.navigation.visit({ screen: 'online' }) }),
      el('button', { text: 'Leave', onclick: () => this.leaveOnline() }));
    o.root.append(this.onlinePresence);
    this.online.subscribe(() => {
      this.onlinePresence.hidden = !this.online.state.room;
      this.onlineStatus.textContent = `${this.onlineMatch.status ?? (this.flow.screen === 'match' ? 'Online' : this.online.state.status)}${this.onlineMatch.latency !== null ? ` · ${this.onlineMatch.latency} ms` : ''}`;
    });
    window.addEventListener('pagehide', event => { if (!event.persisted) this.online.dispose(); });
    const actions = createMatchActions({ view: o.view, context: () => this.context(), changed: () => this.hud.invalidate() });
    this.actions = { ...actions, aim: (yaw, pitch, power) => {
      this.groundAim.clear();
      return actions.aim(yaw, pitch, power);
    } };
    this.groundAim = new GroundAimController({
      enabled: () => canAim(this.context()), tank: () => this.ownTank(),
      pick: point => o.view.pickAimTarget(point),
      surface: direction => (o.game.world?.footprintSurface ?? o.game.world)?.surface(direction)?.point ?? null,
      surfaceVersion: () => (o.game.world?.footprintSurface ?? o.game.world)?.version ?? 0,
      resolve: selection => o.view.resolveAimTarget(selection),
      revision: () => `${o.game.world?.footprintSurface?.version ?? o.game.world?.version}/${o.game.setup?.rules.wind ? o.game.snapshot?.tick : 0}`,
      solve: (target, previous) => o.game.solveAimTarget(o.game.observer, target, previous),
      aim: aim => actions.aim(aim.yaw, aim.pitch, aim.power),
      show: result => o.view.setAimTarget(result && result.status !== 'invalid' ? { point: result.target, error: result.error,
        collider: result.collider, objectId: result.objectId,
        status: result.status === 'ready' ? 'reachable' : result.status === 'solving' ? 'solving'
          : result.status === 'blocked' ? 'blocked' : 'out-of-range' } : null),
    });
    this.input = new InputController({ context: () => this.context(), actions: this.actions, pitch: { min: MIN_BARREL_PITCH, max: MAX_BARREL_PITCH },
      navigate: action => this.navigate(action), pointerFrame: now => { this.groundAim.update(now); this.hud.setHeading(this.headingAngle()); },
      driveSchemes: () => ({ touch: this.profile.settings.gameplay.touchDrive, keys: this.profile.settings.gameplay.keyDrive }),
      keyBindings: () => this.profile.settings.controls.bindings,
      nextTarget: () => {
        const target = o.view.nextAimTarget(this.groundAim.selectedObjectId());
        if (target) { this.groundAim.select(target); this.groundAim.update(performance.now()); }
        else { this.groundAim.clear(); toast('No visible enemy targets.'); }
      },
      driveFrame: () => {
        const tank = this.ownTank();
        if (!tank) return null;
        const r = Math.hypot(...tank.position) || 1;
        return { forward: rotate([0, 0, 1], tank.rotation), up: [tank.position[0] / r, tank.position[1] / r, tank.position[2] / r], cameraRight: o.view.cameraRight() };
      },
      beforeFire: () => this.groundAim.update(performance.now(), true) });
    this.hud = new Hud({
      view: o.view, actions: this.actions, input: this.input, context: () => this.context(),
      terrainInfo: () => o.game.lastTerrain,
      inputStyle: () => this.inputStyle,
      pause: () => this.go({ type: 'PAUSE' }), toggleDriveTest: () => this.toggleDriveTest(), resetTest: () => this.restartFromMatch(),
    });
    this.campaignHud = new CampaignHud(byId('hud'), o.game, o.view);
    o.game.on('ready', () => { this.matchReady = true; this.shots = new Map(); this.hud.onMatchReady(); this.syncChrome(); });
    o.game.on('event', payload => this.onGameEvent(payload as GameEvent));
    o.game.on('finish', payload => this.onFinish(payload as { winner: number | null; setup: MatchSetup }));
    registerTelemetry('ui', () => ({ screen: this.flow.screen, history: [...this.flow.history], error: this.flow.error, game: this.activeGame, navigation: this.navigationReady ? this.navigation.route : null }));
    registerTelemetry('aiming', () => this.groundAim.snapshot());
    // Captures read window.__tmtGame.hud.coverage(): the fraction of the viewport the visible HUD covers (measured on call).
    registerTelemetry('hud', () => ({ input: this.inputStyle, coverage: () => coverage(this.hud.coverRects(), innerWidth, innerHeight) }));
    o.root.dataset.input = this.inputStyle;
    this.applySettings();
  }

  /** Mounts the input and HUD, then boots the flow: the title, or straight to loading for a ?mode / ?seed deep link. */
  boot(viewReady: Promise<void>): void {
    this.viewPromise = viewReady.then(() => {
      this.viewReady = true;
      if (!overMatch(this.flow)) this.render();
    });
    this.viewPromise.catch(() => {});
    this.hud.mount();
    this.input.start();
    this.mouseAim = bindMouseAim(this.o.root, {
      enabled: () => canAim(this.context()),
      canvas: () => byId('viewport').querySelector('canvas'),
      point: point => this.groundAim.point(point), end: cancelled => cancelled ? this.groundAim.clear() : this.groundAim.release(),
      adjustRange: scale => this.groundAim.adjustRange(scale),
    });
    // The HUD dresses for the last pointer type: thumb controls after a touch, the compact dock with key hints after a mouse.
    const dress = (style: InputStyle) => {
      if (this.initialStyle.forced || style === this.inputStyle) return;
      this.inputStyle = style; this.o.root.dataset.input = style; this.hud.invalidate();
    };
    window.addEventListener('pointerdown', event => dress(inputStyleFor(event.pointerType, this.inputStyle)), { capture: true, passive: true });
    window.addEventListener('touchstart', () => dress('touch'), { capture: true, passive: true });
    // Device emulation toggled without a reload, a tablet docked or undocked: follow the primary pointer.
    this.coarse?.addEventListener('change', event => dress(event.matches ? 'touch' : 'pointer'));
    // iOS Safari ignores user-scalable=no; its proprietary pinch events are the only way to keep the page at scale 1.
    for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, event => event.preventDefault(), { passive: false });
    this.touchGestures = bindTouchGestures(this.o.root, {
      // Touch gestures belong to the HUD: with the HUD hidden (capture --hide-ui, photo shots) the view's own handlers orbit.
      enabled: () => this.flow.screen === 'match' && this.context().ready && getComputedStyle(byId('hud')).visibility !== 'hidden',
      canvas: () => byId('viewport').querySelector('canvas'),
      onTank: point => {
        const frame = this.canAimNow() ? this.tankScreenFrame() : null;
        return !!frame && Math.hypot(point[0] - frame.origin[0], point[1] - frame.origin[1]) <= grabRadius(this.o.root.clientWidth, this.o.root.clientHeight);
      },
      tap: point => { if (canAim(this.context())) { this.groundAim.point(point); this.groundAim.release(); } },
      orbit: (dx, dy) => this.o.view.orbitCamera(dx, dy),
      zoom: pixels => this.o.view.zoomCamera(pixels),
      aimDrag: point => this.dragAim(point),
    });
    byId('retry').addEventListener('click', () => { if (this.flow.fatal) location.reload(); else this.go({ type: 'RESTART' }); });
    byId('loading-menu').addEventListener('click', () => { if (this.flow.fatal) location.reload(); else this.go({ type: 'MENU' }); });
    const deep = this.o.launch.deepLink, mission = this.o.launch.mission;
    try {
      if (deep) this.start = this.prepareStart(this.practiceMatchSetup(deep.mode, deep.seed));
      if (mission) this.start = this.prepareStart(this.missionMatchSetup(mission));
    } catch (error) { this.start = async () => { throw error; }; }
    const route = this.navigation.boot(!!deep || !!mission);
    this.navigationReady = true;
    this.restoreRoute(route, !!deep || !!mission);
  }

  /** An unrecoverable failure (no WebGPU, lost device): only a reload helps. */
  fatal(message: string): void {
    this.matchReady = false;
    this.go({ type: 'FATAL', message });
  }

  loopShell(diagnostics: () => void): LoopShell {
    return {
      modalOpen: () => simulationPaused(this.flow),
      worldVisible: () => overMatch(this.flow),
      // The dev autopilot drives through the same per-frame drive command as the keyboard, stick and pad.
      driveInput: () => this.autopilot ? this.autopilotDrive : this.input.driveInput(),
      fullPreview: () => true,
      aimTargetCollider: () => this.groundAim.collider(),
      syncActive: () => this.hud.syncActive(),
      updateHud: () => { this.pilotFrame(); this.hud.update(); this.campaignHud.update(); },
      updateWorldIndicators: () => this.campaignHud.updateMarker(),
      tickToast: now => { tickToast(now); if (this.flow.screen === 'loading') this.renderLoading(); },
      diagnostics,
    };
  }

  // ---- flow -----------------------------------------------------------------------------------------------------------
  go(event: FlowEvent): boolean {
    if (this.o.game.network && event.type === 'RESTART') { toast('Online matches are controlled by the host. Return to Online Play for another match.'); return false; }
    const previous = this.flow, next = transition(previous, event);
    if (next === previous) return false;
    if (this.navigationReady && !this.restoring && event.type !== 'FATAL' && previous.screen === 'workshop' && next.screen !== 'workshop') {
      const destination: NavigationRoute = { screen: next.screen === 'loading' ? 'match' : next.screen as NavigationRoute['screen'] };
      if (this.navigation.needsGuard(destination)) return this.navigation.beforeLeave(destination, () => { this.go(event); });
    }
    if (this.navigationReady && !this.restoring) {
      const route = this.navigation.route;
      if (['OPEN', 'BACK', 'PAUSE', 'RESUME', 'MENU', 'LEAVE'].includes(event.type)) {
        if (event.type === 'BACK' && previous.screen !== 'pause') this.navigation.back();
        else if (event.type === 'MENU' || event.type === 'LEAVE') this.navigation.visit({ screen: event.type === 'LEAVE' ? route.parent ?? 'title' : 'title' });
        else if (next.screen === 'match' || next.screen === 'pause' || (next.screen === 'settings' && next.back === 'pause'))
          this.navigation.visit({ ...route, screen: next.screen });
        else if (event.type === 'OPEN') this.navigation.visit({ screen: event.screen });
        return true;
      }
      if (event.type === 'START' || event.type === 'RESTART' || event.type === 'PLAYGROUND') {
        if (this.navigation.busy) return false;
        this.activeGame = this.navigation.startGame(route.query ?? '');
        this.resumeRoute = this.navigation.route;
      }
      if (event.type === 'READY' && this.resumeRoute) {
        const target = this.resumeRoute; this.resumeRoute = null;
        this.restoreFlow(target);
        return true;
      }
      if (event.type === 'FINISH' || event.type === 'FORFEIT') {
        const record = this.activeGame && this.navigationGames.get(this.activeGame);
        if (record) this.navigationGames.set(this.activeGame!, { ...record, result: next.result!, summary: this.summary });
        if (route.game) this.navigation.finishGame();
      }
    }
    this.flow = next;
    this.enter(previous, next, event);
    this.render();
    return true;
  }

  private restoreFlow(route: NavigationRoute): void {
    this.restoring = true;
    try {
      this.go({ type: 'RESTORE', screen: route.screen,
        back: route.screen === 'settings' && route.game ? 'pause' : ['campaign', 'skirmish', 'online', 'workshop', 'settings', 'help'].includes(route.screen) ? 'title' : null,
        origin: route.parent === 'campaign' || route.parent === 'workshop' || route.parent === 'skirmish' || route.parent === 'online' ? route.parent : 'deeplink',
        result: route.game ? this.navigationGames.get(route.game)?.result : null });
    } finally { this.restoring = false; }
  }

  private restoreRoute(route: NavigationRoute, allowLaunch = false): void {
    if (this.flow.fatal) return;
    if (!route.game) {
      this.resumeRoute = null;
      if (this.flow.screen === 'loading' && !this.o.game.network) { this.endMatch(); this.activeGame = null; }
      this.restoreFlow(route);
      return;
    }
    const record = this.navigationGames.get(route.game);
    if (record?.setup.online && !this.online.state.room) { this.navigation.replace({ screen: 'online' }); this.restoreFlow({ screen: 'online' }); return; }
    if (record) {
      route = { ...route, query: this.setupQuery(record.setup) };
      this.navigation.replace(route);
    }
    if (record?.result) {
      if (route.screen === 'pause') {
        this.navigation.visit(this.navigation.direction > 0 ? { ...route, screen: 'results' } : { screen: route.parent ?? 'title' });
        return;
      }
      if (this.activeGame !== route.game) { this.endMatch(); this.activeGame = route.game!; }
      this.summary = record.summary ?? null;
      const finished: NavigationRoute = { ...route, screen: 'results' };
      this.navigation.replace(finished); this.restoreFlow(finished); return;
    }
    if (this.activeGame === route.game && this.matchReady) {
      this.restoreFlow(route); return;
    }
    if (this.activeGame === route.game && this.flow.screen === 'loading') {
      if (route.screen === 'pause') { this.navigation.visit({ screen: route.parent ?? 'title' }); return; }
      this.resumeRoute = route; return;
    }
    if (!record && !allowLaunch) {
      const parent: NavigationRoute = { screen: route.parent ?? 'title' };
      this.navigation.replace(parent); this.restoreRoute(parent);
      toast('That session has expired. Choose a mission or start a new game.', 5); return;
    }
    this.endMatch();
    this.activeGame = route.game!; this.resumeRoute = route;
    if (record) {
      this.workshopTest = record.workshop; workshopSandbox.testing = record.sandbox;
      this.start = this.prepareStart(record.setup);
    }
    this.restoring = true;
    try { this.go({ type: 'RESTORE', screen: 'loading', origin: route.parent === 'campaign' ? 'campaign' : 'deeplink' }); }
    finally { this.restoring = false; }
  }

  private rememberSetup(setup: MatchSetup): void {
    if (!this.activeGame) return;
    this.navigationGames.set(this.activeGame, { setup, workshop: this.workshopTest, sandbox: workshopSandbox.testing });
    const query = this.setupQuery(setup);
    const route = { ...this.navigation.route, query };
    this.navigation.replace(route);
    if (this.resumeRoute) this.resumeRoute = { ...this.resumeRoute, query };
  }
  private prepareStart(setup: MatchSetup): StartAction {
    this.pendingSetup = setup;
    return () => this.startTrackedMatch(setup);
  }
  private startTrackedMatch(setup: MatchSetup): Promise<void> {
    this.rememberSetup(setup);
    return session().startMatch(setup);
  }
  private setupQuery(setup: MatchSetup): string {
    if (setup.online) return '';
    return setup.mode === 'campaign' ? `mode=campaign&mission=${encodeURIComponent(setup.id.replace(/^campaign:/, ''))}`
      : `mode=${setup.id.startsWith('playground:') ? 'dev' : setup.mode === 'skirmish' ? 'bot' : setup.mode}&seed=${setup.seed}`;
  }
  private restartTrackedMatch(fromStart = false): Promise<void> {
    const setup = session().setup;
    if (setup && session().snapshot) this.rememberSetup(setup);
    else {
      const record = this.activeGame && this.navigationGames.get(this.activeGame);
      if (record) return this.startTrackedMatch(record.setup);
    }
    return session().restart(fromStart);
  }

  private enter(previous: FlowState, next: FlowState, event: FlowEvent): void {
    if (previous.screen === 'loading' && next.screen !== 'loading' && !this.o.game.network) {
      this.startToken++; this.onlineLaunch?.reject(new Error('Online load cancelled.')); this.onlineLaunch = undefined;
    }
    if (previous.screen === 'workshop' && next.screen !== 'workshop') { this.workshop?.dispose(); this.workshop = null; }
    if (previous.screen === 'match' && next.screen !== 'match') { this.input.clear(); this.mouseAim?.clear(); this.touchGestures?.reset(); clearToast(); }
    if (event.type === 'RESTART' && previous.screen !== 'error') { const fresh = event.fresh === true; this.start = this.nextStart ?? (() => this.restartTrackedMatch(fresh)); }
    this.nextStart = undefined;
    if (event.type === 'MENU') {
      this.endMatch();
      this.workshopTest = false; workshopSandbox.testing = false;
    }
    if (next.screen === 'title' || next.screen === 'loading') this.summary = null;
    if (next.screen === 'loading') { releaseWorkshopPrewarm(); void this.runStart(); }
    if (next.screen === 'match') byId('viewport').focus({ preventScroll: true });
  }

  private async runStart(): Promise<void> {
    const token = ++this.startToken, start = this.start;
    this.matchReady = false;
    clearTimeout(this.finishTimer);
    clearToast();
    try {
      if (!start) throw new Error('There is no match to start.');
      const setup = this.pendingSetup ?? (this.activeGame ? this.navigationGames.get(this.activeGame)?.setup : undefined);
      this.pendingSetup = undefined;
      if (setup) this.rememberSetup(setup);
      await this.viewPromise;
      if (token !== this.startToken) return;
      await start();
      if (token !== this.startToken) return;
      if (!this.matchReady) throw new Error('The match did not start.');
      this.go({ type: 'READY' });
    } catch (error) {
      const online = this.onlineLaunch;
      if (online && online.start === start) { online.reject(error); this.onlineLaunch = undefined; }
      if (token !== this.startToken || this.flow.fatal) return;
      // Surfaced in the UI (the setup screen or the error card); a warning, not an error, in the console.
      console.warn('Match start failed:', error);
      const message = error instanceof Error ? error.message : String(error);
      this.go({ type: 'FAIL', message });
      if (this.flow.screen === 'skirmish') toast(message, 6);
    }
  }

  /** A deep-link or drive-test practice match with the active build (the session maps it onto the kit). */
  private validateOwnedBuild(ids: KitLoadoutIds): void {
    const kit = validateKitLoadout(ids), locked = lockedKitParts(this.profile, kit);
    if (locked.length) throw new Error('This build contains undiscovered blueprints. Unlock them in the workshop, or test it in Sandbox.');
    if (assembleKit(kit).stats.cost > fittingBudget(this.profile)) throw new Error(`This build costs ${assembleKit(kit).stats.cost}, over your fitting budget of ${fittingBudget(this.profile)}. Swap in cheaper parts or reset it in the workshop.`);
  }
  private practiceMatchSetup(mode: PracticeMode, seed: number | null, playground = false): MatchSetup {
    const kit = this.workshopTest && workshopSandbox.active && workshopSandbox.kit ? workshopSandbox.kit : activeKit(this.profile);
    if (!(this.workshopTest && workshopSandbox.active)) this.validateOwnedBuild(kit);
    const setup = practiceWithKit(mode, seed ?? matchSeed(), kit);
    if (playground || new URLSearchParams(location.search).get('mode') === 'dev') {
      setup.id = `playground:${setup.seed}`;
      setup.rules.fog = false;
      setup.rules.fallDamage = false;
      setup.rules.friendlyFire = false;
      setup.tanks = setup.tanks.map(t => ({ ...t, maxHealth: 100000 }));
    }
    return setup;
  }

  private startSkirmish(): void {
    if (this.online.state.room) { toast('Leave your online server or queue before starting a local game.'); return; }
    this.workshopTest = false; workshopSandbox.testing = false;
    let setup: MatchSetup;
    try { this.validateOwnedBuild(activeKit(this.profile)); setup = skirmishSetup(this.skirmish, activeKit(this.profile)); } catch (error) { toast(error instanceof Error ? error.message : String(error), 5); return; }
    this.start = this.prepareStart(setup);
    this.go({ type: 'START' });
  }

  private restartFromMatch(): void { this.go({ type: 'RESTART' }); }
  private launchOnline(setup: MatchSetup, operation: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.deferredOnline?.reject(new Error('Online load replaced.'));
      const deferred = { reject, run: () => {
        if (this.deferredOnline !== deferred) return;
        this.navigation.beforeLeave({ screen: 'match' }, () => {
          if (this.deferredOnline !== deferred) return;
          this.deferredOnline = undefined; this.onlineMatch.deferLaunch(false);
          this.workshopTest = false; workshopSandbox.testing = false;
          this.onlineLaunch?.reject(new Error('Online load replaced.'));
          const start = async () => { try { await operation(); resolve(); } catch (error) { reject(error); throw error; } finally { if (this.onlineLaunch?.start === start) this.onlineLaunch = undefined; } };
          this.start = start; this.onlineLaunch = { start, reject };
          this.pendingSetup = setup;
          this.activeGame = this.navigation.startGame('', 'online');
          this.resumeRoute = this.navigation.route;
          this.go({ type: 'RESTORE', screen: 'loading', origin: 'online' });
        }, () => { if (this.deferredOnline === deferred) this.onlineMatch.deferLaunch(true); });
      } };
      this.deferredOnline = deferred; deferred.run();
    });
  }
  private resumeOnline(): void {
    if (this.deferredOnline) { this.deferredOnline.run(); return; }
    if (this.activeGame && this.o.game.ready) this.navigation.visit({ screen: 'match', game: this.activeGame, parent: 'online', query: '' });
  }
  private leaveOnline(): void {
    void this.online.leave(); this.onlineMatch.reset(); this.cancelOnlineLoad(); this.endMatch(); this.activeGame = null;
    this.navigation.visit({ screen: 'online' });
  }
  private cancelOnlineLoad(): void {
    this.deferredOnline?.reject(new Error('Online match ended.')); this.deferredOnline = undefined; this.onlineMatch.deferLaunch(false);
    this.startToken++; this.onlineLaunch?.reject(new Error('Online match ended.')); this.onlineLaunch = undefined;
    this.start = undefined; this.pendingSetup = undefined; this.resumeRoute = null;
  }
  private finishDisconnectedMatch(ended: NonNullable<import('../online/protocol').Room['ended']>): void {
    this.cancelOnlineLoad(); this.endMatch();
    this.summary = { title: 'Match over.', eyebrow: 'OPPONENT DISCONNECTED', outcome: 'other', stats: [],
      detail: ended.reason === 'opponent-left' ? 'Your opponent left the game. Find another opponent or invite someone into this lobby.'
        : 'Your opponent did not return before the reconnect time expired. This match has ended.' };
    this.rememberResult(ended.winner);
    if (this.activeGame) this.navigation.visit({ screen: 'results', game: this.activeGame, parent: 'online', query: '' });
    else { this.navigation.visit({ screen: 'online' }); this.render(); }
  }
  private rematchOnline(mission?: MissionId): void {
    const room = this.online.state.room; if (!room?.host) return;
    const campaignOwner = room.setup.tanks[room.setup.online?.campaignOwnerSeat ?? 0];
    const setup = mission ? makeOnlineSetup('coop', room.capacity as 2 | 3, campaignOwner.loadout,
      { ...this.skirmish, difficulty: campaignOwner.difficulty ?? this.skirmish.difficulty }, mission) : room.setup;
    if (mission && room.setup.crew) setup.crew = structuredClone(room.setup.crew);
    void this.online.restart(setup).then(() => { if (!this.online.state.error) this.navigation.visit({ screen: 'online' }); });
  }

  /** A campaign mission with the active build (it must be owned and within budget, like any normal match). */
  private missionMatchSetup(id: MissionId): MatchSetup {
    this.workshopTest = false; workshopSandbox.testing = false;
    const kit = activeKit(this.profile);
    this.validateOwnedBuild(kit);
    return missionSetup(missionById(id), kit, this.profile.settings.gameplay.difficulty, profileCrew(this.profile));
  }
  /** From the campaign screen (START) or the results card (a restart into the next mission). */
  private startMission(id: MissionId): void {
    if (this.online.state.room) { toast('Leave your online server or queue before starting a solo mission.'); return; }
    try { this.validateOwnedBuild(activeKit(this.profile)); } catch (error) { toast(error instanceof Error ? error.message : String(error), 5); return; }
    if (this.flow.screen === 'campaign') { this.start = this.prepareStart(this.missionMatchSetup(id)); this.go({ type: 'START' }); return; }
    this.nextStart = this.prepareStart(this.missionMatchSetup(id));
    if (!this.go({ type: 'RESTART' })) this.nextStart = undefined;
  }
  private startWorkshopTest(mode: 'drive' | 'bot'): void {
    if (this.online.state.room) { toast('Your online queue is still active. Leave it before starting a test drive.'); return; }
    this.workshopTest = true; workshopSandbox.testing = workshopSandbox.active;
    this.start = this.prepareStart(this.practiceMatchSetup(mode, matchSeed()));
    this.go({ type: 'START' });
  }
  /** Developer bar: a fresh practice match in the other mode (drive test ⇄ bot), keeping ?mode=drive in the URL for reloads. */
  private toggleDriveTest(): void {
    const driving = session().setup?.mode !== 'drive';
    this.nextStart = this.prepareStart(this.practiceMatchSetup(driving ? 'drive' : 'bot', null));
    if (!this.go({ type: 'RESTART' })) this.nextStart = undefined;
  }

  private endMatch(): void {
    clearTimeout(this.finishTimer);
    this.matchReady = false;
    if (session().snapshot || session().setup) session().endMatch();
  }

  private forfeit(): void {
    const s = session();
    this.summary = matchSummary({ state: s.snapshot, setup: s.setup, observer: OWNER, winner: null, forfeited: true, shots: this.shots });
    if (!this.workshopTest) this.setProfile(recordMatch(this.profile, false, false), false);
    this.endMatch();
    this.go({ type: 'FORFEIT' });
  }

  private onGameEvent(event: GameEvent): void {
    if (this.autopilot) this.autopilotEvents.push(event);
    if (event.type === 'shot') {
      this.shots.set(event.player, (this.shots.get(event.player) ?? 0) + 1);
      if (event.player === this.o.game.observer) this.groundAim.shotFired();
    }
    this.hud.onEvent(event);
  }

  private onFinish(result: { winner: number | null; setup: MatchSetup }): void {
    if (result.setup.online?.kind === 'coop') { this.onCooperativeFinish(result); return; }
    const mission = this.o.game.mission;
    if (mission) { this.onMissionFinish(result, mission); return; }
    const s = session();
    const owner = result.setup.online ? s.observer : OWNER;
    this.summary = matchSummary({ state: s.snapshot, setup: result.setup, observer: owner, winner: result.winner, forfeited: false, shots: this.shots });
    if (!this.workshopTest) this.setProfile(recordMatch(this.profile, wonBy(result.setup, owner, result.winner)), false);
    this.rememberResult(result.winner);
    clearTimeout(this.finishTimer);
    const token = this.startToken;
    this.finishTimer = window.setTimeout(() => { if (token === this.startToken) this.go({ type: 'FINISH', winner: result.winner }); }, FINISH_DELAY_MS);
  }

  private onCooperativeFinish(result: { winner: number | null; setup: MatchSetup }): void {
    const id = missionIdOf(result.setup); if (!id) return;
    const game = this.o.game, mission = game.mission, remote = game.remoteMission, def = missionById(id);
    const won = mission ? mission.outcome === 'won' : remote?.won === true;
    const ownsCampaign = game.observer === (result.setup.online?.campaignOwnerSeat ?? 0);
    const reward = { medal: mission?.medalEarned ?? remote?.medal ?? false, optional: mission?.optionalCompleted ?? remote?.optional ?? false,
      secrets: mission?.secretsFound.size ?? remote?.secrets ?? 0, ending: mission?.ending ?? remote?.ending };
    // Every browser follows this same result path, including a guest elected simulation host.
    const profile = won ? cooperativeReward(this.profile, id, reward, ownsCampaign) : this.profile;
    this.summary = { title: won ? 'Mission complete.' : 'Mission failed.', eyebrow: `${def.chapter.toUpperCase()} · CO-OP`,
      outcome: won ? 'win' : 'loss', detail: ownsCampaign
        ? (won ? 'Your campaign progress is saved. Friends receive assistance rewards.' : 'Your campaign progress is unchanged. Retry together when ready.')
        : 'Assistance XP and scrap are awarded once per mission and improvement. Your own campaign progress and checkpoints are unchanged.',
      stats: [{ label: 'Mission', value: def.title }, { label: 'XP earned', value: String(profile.xp - this.profile.xp) },
        { label: 'Medal', value: reward.medal && won ? 'Earned' : 'Not earned' }, { label: 'Mission time', value: clock(game.snapshot?.time ?? 0) }],
      ...(won && def.next ? { next: def.next } : {}) };
    this.setProfile(profile, false); this.rememberResult(result.winner);
    clearTimeout(this.finishTimer); const token = this.startToken;
    this.finishTimer = window.setTimeout(() => { if (token === this.startToken) this.go({ type: 'FINISH', winner: result.winner }); }, FINISH_DELAY_MS * 2);
  }

  /** Campaign result: the mission card (medal, stats), the cleared mission saved, match XP as for any win or loss. */
  /** `?autopilot=1` (dev): plays campaign missions through the session's own commands, for capture verification. */
  private autopilot: Autopilot | null = new URLSearchParams(location.search).has('autopilot') ? new Autopilot() : null;
  private autopilotEvents: GameEvent[] = [];
  private autopilotDrive = { throttle: 0, steer: 0 };
  private pilotFrame(): void {
    const game = this.o.game, state = game.snapshot, mission = game.mission, remote = game.remoteMission;
    const beat = mission?.beatId ?? remote?.beat, marker = mission?.marker ?? remote?.marker ?? null;
    if (!this.autopilot || !state || !beat || !this.matchReady || this.flow.screen !== 'match') return;
    if (beat === 'ending-choice') game.command(game.observer, { k: 'utility', id: 'ending-rewind' });
    const own = state.tanks[game.observer];
    if (own.health < (own.maxHealth ?? 1) * .65) game.command(game.observer, { k: 'utility', id: 'repair' });
    const order = this.autopilot.decide({ state, observer: game.observer, beat, marker, canFire: game.canFire(game.observer),
      events: this.autopilotEvents.splice(0), solve: selection => game.solveAimTarget(game.observer, selection) });
    if (order.headlights !== undefined && order.headlights !== (state.tanks[game.observer].headlights !== false)) game.command(game.observer, { k: 'utility', id: 'headlights' });
    if (order.aim) game.command(game.observer, { k: 'aim', ...order.aim });
    if (order.fire) game.command(game.observer, { k: 'fire' });
    this.autopilotDrive = order.drive;
  }

  private onMissionFinish(result: { winner: number | null; setup: MatchSetup }, mission: NonNullable<GameSession['mission']>): void {
    const state = this.o.game.snapshot, won = mission.outcome === 'won', def = mission.def;
    const owner = result.setup.online ? this.o.game.observer : OWNER, own = state?.tanks[owner];
    const kills = state ? state.tanks.filter(t => t.team !== own?.team && t.health <= 0).length : 0;
    const best = missionStars(this.profile, def.id), checkpoint = !won && (session() as GameSession).hasCampaignCheckpoint;
    this.summary = {
      title: won ? 'Mission complete.' : 'Mission failed.', eyebrow: `${def.chapter.toUpperCase()} · ${def.title.toUpperCase()}`,
      detail: won ? (mission.medalEarned ? `Medal earned: ${def.medal.text}.` : `Medal: ${def.medal.text}. Replay to earn it.`) : checkpoint ? 'Retry from your last saved checkpoint, or restart the mission from the beginning.' : 'Retry from the start of the mission.',
      checkpoint,
      outcome: won ? 'win' : 'loss',
      stats: [
        { label: 'Shots fired', value: String(this.shots.get(owner) ?? 0) },
        { label: 'Enemies down', value: String(kills) },
        { label: 'Hull left', value: own ? `${Math.max(0, Math.ceil(own.health))}/${own.maxHealth ?? '—'}` : '—' },
        { label: 'Mission time', value: clock(state?.time ?? 0) },
        { label: 'Medal', value: won && mission.medalEarned ? 'Earned' : best === 2 ? 'Earned before' : 'Not yet' },
      ],
      ...(won && def.next ? { next: def.next } : {}),
    };
    let profile = recordMatch(this.profile, won, false);
    if (won && best === 0) profile = { ...profile, stats: { ...profile.stats, wins: profile.stats.wins + 1 } };
    if (won) profile = campaignReward(profile, def.id, { medal: mission.medalEarned, optional: mission.optionalCompleted, secrets: mission.secretsFound.size, ending: mission.ending });
    this.summary.stats.push({ label: 'XP earned', value: String(profile.xp - this.profile.xp) }, { label: 'Commander rank', value: String(profile.rank) });
    if (mission.ending) this.summary.detail = mission.ending === 'rewind' ? 'REWIND · The Lantern brightens. The Rust sleeps. The crew stays to mend the worlds.' : 'RELEASE · The worlds come to rest. The people sail together toward the Lantern.';
    this.setProfile(profile, false);
    this.rememberResult(result.winner);
    clearTimeout(this.finishTimer);
    const token = this.startToken;
    this.finishTimer = window.setTimeout(() => { if (token === this.startToken) this.go({ type: 'FINISH', winner: result.winner }); }, FINISH_DELAY_MS * 2);
  }

  // ---- keyboard and gamepad navigation ----------------------------------------------------------------------------------
  private rememberResult(winner: number | null): void {
    const record = this.activeGame && this.navigationGames.get(this.activeGame);
    if (record) this.navigationGames.set(this.activeGame!, { ...record, result: { winner, forfeited: false }, summary: this.summary });
  }
  private navigate(action: PressAction): void {
    const screen = this.flow.screen;
    if (action === 'pause') { if (screen === 'match') this.go({ type: 'PAUSE' }); return; }
    if (action === 'back') {
      if (screen === 'online' && this.onlineScreen?.backToChoices()) return;
      if (screen === 'workshop' && this.workshop?.closePanel()) return;
      if (screen === 'pause') this.go({ type: 'RESUME' }); else this.go({ type: 'BACK' }); return;
    }
    const screens = byId('screens');
    const container = screens.querySelector<HTMLElement>('dialog[open]') ?? screens;
    const focusable = Array.from(container.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, summary, a[href]'))
      .filter(node => node.offsetParent !== null);
    const current = document.activeElement instanceof HTMLElement && container.contains(document.activeElement) ? document.activeElement : null;
    if (action === 'confirm') { (current ?? container.querySelector<HTMLElement>('[data-primary]:not([disabled])'))?.click(); return; }
    if (action === 'navUp' || action === 'navDown') {
      if (!focusable.length) return;
      const index = current ? focusable.indexOf(current) : -1;
      const next = action === 'navDown' ? (index + 1) % focusable.length : (index <= 0 ? focusable.length - 1 : index - 1);
      focusable[next].focus();
    }
  }

  // ---- profile and settings ---------------------------------------------------------------------------------------------
  private setProfile(profile: ProgressProfile, rerender = true): void {
    const appearanceChanged = this.profile.cosmetics !== profile.cosmetics || this.profile.loadouts !== profile.loadouts || this.profile.activeLoadout !== profile.activeLoadout;
    this.profile = profile;
    saveProgress(profile, this.storage);
    if (appearanceChanged) this.onlineMatch.appearanceChanged();
    if (rerender) { this.applySettings(); this.render(); }
  }
  private updateSettings(patch: SettingsPatch): void {
    this.profile = withSettings(this.profile, updateSettings(this.profile.settings, patch));
    saveProgress(this.profile, this.storage);
    this.applySettings();
    this.hud.invalidate();
    this.chat.update();
    if (this.flow.screen === 'workshop') this.workshop?.update(this.screenContext());
  }
  /** Broadcasts tmt:settings (on load and after every change) and applies what the DOM itself honours. */
  private applySettings(): void {
    dispatchSettings(this.profile.settings);
    this.o.root.classList.toggle('reduced-motion', this.profile.settings.gameplay.reducedMotion);
  }

  // ---- rendering --------------------------------------------------------------------------------------------------------
  private screenContext(): ScreenContext {
    const controller = this;
    return {
      flow: this.flow, get profile() { return controller.profile; }, viewReady: this.viewReady, get skirmish() { return controller.skirmish; }, summary: this.summary, campaign: this.o.game.setup?.mode === 'campaign',
      online: !!this.o.game.network || !!this.online.state.room?.ended, onlineEnded: !!this.online.state.room?.ended, leaveOnline: () => this.leaveOnline(),
      onlineHost: this.online.state.room?.host, rematchOnline: mission => this.rematchOnline(mission),
      resumeOnline: () => this.resumeOnline(),
      validateOnlineBuild: () => this.validateOwnedBuild(activeKit(this.profile)),
      go: event => { this.go(event); },
      setSkirmish: options => { this.skirmish = options; },
      startSkirmish: () => this.startSkirmish(),
      openWorkshop: () => this.navigation.visit({ screen: 'workshop' }),
      startPlayground: () => {
        this.start = this.prepareStart(this.practiceMatchSetup('drive', 7, true));
        this.go({ type: 'PLAYGROUND' });
      },
      startWorkshopTest: mode => this.startWorkshopTest(mode),
      startMission: id => this.startMission(id),
      setProfile: profile => this.setProfile(profile),
      saveProfile: profile => {
        if (!saveProgress(profile, this.storage)) return false;
        this.profile = profile; this.onlineMatch.appearanceChanged(); this.applySettings(); this.render(); return true;
      },
      setLoadout: (index: number, kit: KitLoadoutIds, name?: string) => this.setProfile(withLoadout(this.profile, index, kit, name)),
      setActiveLoadout: index => this.setProfile(withActiveLoadout(this.profile, index)),
      updateSettings: patch => this.updateSettings(patch),
      toast: (message, seconds) => toast(message, seconds),
      forfeit: () => this.forfeit(),
      refresh: () => this.render(),
    };
  }

  private render(): void {
    const { screen } = this.flow, ctx = this.screenContext();
    this.online.setBrowsing(screen === 'online');
    const scene = screen === 'workshop' ? 'workshop' : screen === 'title' || screen === 'boot' ? 'title'
      : screen === 'loading' ? 'loading' : screen === 'match' ? 'skirmish' : screen === 'pause' || (screen === 'settings' && this.flow.back === 'pause') ? 'pause'
      : screen === 'results' ? 'results' : screen === 'skirmish' ? 'setup' : 'menu';
    const setup = session().setup;
    const world = screen === 'skirmish' || (screen === 'loading' && this.flow.origin === 'skirmish')
      ? resolvePlanetType(this.skirmish.seed, this.skirmish.planet) : setup ? resolvePlanetType(setup.seed, setup.planet.kind) : undefined;
    // Background renderer readiness and profile refreshes can redraw this same
    // menu while a briefing is speaking. Only real route/world changes should
    // cancel dialogue or reset its audio scene. Distinguish menus sharing a scene
    // so Back/Forward and opening Settings still cancel speech from the old page.
    const audioRoute = JSON.stringify([screen, scene, world]);
    if (audioRoute !== this.audioRoute) {
      // Browser navigation can return from the board to a paused match. Its briefing
      // belongs to the board, not to the mission that is about to resume.
      if (this.audioScreen === 'campaign' && screen !== 'campaign') stopCampaignVoice();
      this.audioScreen = screen;
      this.audioRoute = audioRoute;
      window.dispatchEvent(new CustomEvent('tmt:audio-scene', { detail: { scene, world } }));
    }
    const container = byId('screens');
    const focused = document.activeElement instanceof HTMLElement && container.contains(document.activeElement) ? document.activeElement.id : '';
    const node = screen === 'title' ? renderTitle(ctx) : screen === 'online' ? (this.onlineScreen ??= new OnlineScreen(ctx, this.online)).update(ctx) : screen === 'skirmish' ? renderSkirmish(ctx) : screen === 'workshop' ? (this.workshop ??= new WorkshopScreen(ctx)).update(ctx)
      : screen === 'settings' ? renderSettings(ctx) : screen === 'campaign' ? renderCampaign(ctx) : screen === 'help' ? renderHelp(ctx)
      : screen === 'pause' ? renderPause(ctx) : screen === 'results' ? renderResults(ctx) : null;
    if (node) { if (container.firstElementChild !== node) container.replaceChildren(node); } else container.replaceChildren();
    container.hidden = !node;
    container.className = `screens screen-${screen}${overMatch(this.flow) ? ' over-match' : ''}`;
    this.o.root.dataset.screen = screen;
    window.dispatchEvent(new CustomEvent('tmt:navigation', { detail: { screen } }));
    this.renderLoading();
    this.syncChrome();
    if (node) {
      const again = focused ? document.getElementById(focused) : null;
      const target = again && container.contains(again) ? again : container.querySelector<HTMLElement>('[data-primary]:not([disabled])');
      target?.focus({ preventScroll: true });
    }
  }

  private renderLoading(): void {
    const { screen, error, fatal } = this.flow, overlay = byId('loading');
    const failed = screen === 'error';
    overlay.hidden = screen !== 'loading' && !failed;
    overlay.classList.toggle('error', failed);
    byId('loading-eyebrow').textContent = failed ? (fatal ? 'THE LAMP WENT OUT' : 'THE WORLD DID NOT FORM') : this.viewReady ? 'SETTING THE TABLE' : 'WARMING THE WORKSHOP LAMP';
    byId('loading-title').textContent = failed ? (fatal ? 'The game has to reload.' : 'The world could not be prepared.') : 'Preparing your little world.';
    const progress = this.o.game.startupProgress;
    byId('loading-copy').textContent = failed ? error ?? 'Something went wrong.' : !this.viewReady ? 'Preparing graphics and materials.'
      : `${progress.stage}${progress.total ? ` · ${progress.completed} / ${progress.total}` : ''} · ${(progress.elapsedMs / 1000).toFixed(1)} s`;
    const retry = byId('retry'), menu = byId('loading-menu');
    retry.hidden = menu.hidden = !failed;
    retry.textContent = fatal ? 'Reload game' : 'Try again';
    menu.hidden = fatal || (screen !== 'loading' && !failed);
    menu.textContent = screen === 'loading' ? 'Cancel and return to menu' : 'Return to menu';
  }

  private syncChrome(): void {
    const s = session();
    const inMatch = overMatch(this.flow) && !!s.snapshot && this.matchReady;
    this.hud.setVisible(inMatch);
    this.hud.setDevChrome(inMatch && (this.o.launch.dev || s.setup?.mode === 'drive'));
    if (inMatch) this.hud.invalidate();
    this.o.root.querySelector('#workshop-test-badge')?.remove();
    if (inMatch && this.workshopTest) this.o.root.append(el('div', { id: 'workshop-test-badge', class: 'ws-test-badge' },
      el('strong', { text: workshopSandbox.active ? 'SANDBOX TEST · no progression' : 'WORKSHOP TEST · no progression' }),
      el('button', { type: 'button', class: 'ws-control', text: 'Return to workshop', onclick: () => this.navigation.visit({ screen: 'workshop' }) })));
  }

  // ---- input context --------------------------------------------------------------------------------------------------
  private context(): ContextInput {
    const s = session();
    return { screen: this.flow.screen, snapshot: s.snapshot, observer: s.observer, ready: this.matchReady, driveTest: s.setup?.mode === 'drive',
      realtime: s.setup?.rules.turnModel === 'realtime' };
  }
  private ownTank(): GameSnapshot['tanks'][number] | undefined { const s = session(); return s.snapshot?.tanks[s.observer]; }
  private canAimNow(): boolean {
    const c = this.context(), state = c.snapshot;
    return !!state && (c.realtime || state.active === c.observer) && (state.phase === 'aim' || (c.driveTest && state.phase === 'resolving'));
    // (A realtime match keeps phase 'aim' until it ends, so this already holds for it.)
  }
  /** The hull's forward direction on screen (radians, 0 = up, clockwise), for the joystick's heading needle; null when
   * the touch stick is not camera-relative or the tank is off screen. */
  private headingAngle(): number | null {
    if (this.inputStyle !== 'touch' || this.profile.settings.gameplay.touchDrive !== 'camera' || this.flow.screen !== 'match') return null;
    const frame = this.tankScreenFrame();
    if (!frame) return null;
    const dx = frame.forward[0] - frame.origin[0], dy = frame.forward[1] - frame.origin[1];
    return Math.hypot(dx, dy) > 0.5 ? Math.atan2(dx, -dy) : null;
  }

  /** Drag-aim from your own tank: the drag direction is the bearing, its length the power (the pitch is kept). */
  private dragAim(point: Point | null): void {
    if (!point) { this.hud.showGuide(null); return; }
    const frame = this.tankScreenFrame();
    if (!frame) return;
    const yaw = solveDragAim(frame, point), power = dragPower(frame.origin, point, dragReach(this.o.root.clientWidth, this.o.root.clientHeight));
    this.hud.showGuide({ origin: frame.origin, pointer: point, power, yaw: yaw ?? Number.NaN });
    const tank = this.ownTank();
    if (yaw !== null && tank && this.canAimNow()) this.actions.aim(yaw, tank.barrelPitch, power);
  }

  /** The observer tank's screen position and the screen positions one step along its local +Z and +X. */
  private tankScreenFrame(): TankScreenFrame | null {
    const tank = this.ownTank();
    if (!tank) return null;
    const along = (axis: [number, number, number]) => {
      const d = rotate(axis, tank.rotation);
      return this.o.view.worldToScreen([tank.position[0] + d[0], tank.position[1] + d[1], tank.position[2] + d[2]]);
    };
    const origin = this.o.view.worldToScreen(tank.position), forward = along([0, 0, 0.8]), left = along([0.8, 0, 0]);
    return origin && forward && left ? { origin, forward, left } : null;
  }
}

/** Build a practice preset, then apply the player's validated kit IDs to both tanks. */
export function practiceWithKit(mode: PracticeMode, seed: number, kit: KitLoadoutIds): MatchSetup {
  const setup = practiceSetup({ seed, mode, player: kitLoadoutToLegacy(validateKitLoadout(kit)) });
  return { ...setup, tanks: setup.tanks.map(tank => ({ ...tank, loadout: { ...kit } })) };
}
