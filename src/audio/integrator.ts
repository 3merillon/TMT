/**
 * TankAudioIntegrator: the per-frame bridge from the game's hooks to the audio engine. It reads only what the hooks hand
 * it (the MatchSetup, GameEvents with their snapshot, FrameInfo, the session's realtime events and the mission runner's
 * published state) and never touches the simulation.
 *
 * - shot → the weapon's pre-rendered report (near/far by distance, speed-of-sound delay) and the loader's clunk;
 * - impact → the blast for the munition and crater, armour hits that ricochet, penetrate or tear by outcome, the
 *   destruction burst on lethal hits, music ducking on big near booms; terrain-commit → rubble settling;
 * - realtime: coax tracers (a sustained-fire loop per gun with its stop tail, supersonic snaps for rounds passing the
 *   listener, pings at the target by material), objectives, banners, results; near-miss and kill-streak music cues;
 * - per frame: the listener, engine/tread loops for the nearest chassis, actor loops (wrecks, rotors, hovers, swarms,
 *   the Crawler, Spires, searchlights, shields), suspension thumps, shell whistles with doppler, EMP and alarm cues,
 *   the wind bed, a measured threat estimate and the boss phase for the music director.
 */
import type { MatchSetup } from '../game/api/match';
import type { FrameInfo } from '../game/app/hooks';
import type { GameEvent, GameSnapshot, TankState, V3 } from '../game/contracts';
import { GRAVITY_BALLISTIC } from '../game/world-constants';
import { ShotEvents } from '../game/presentation/shot-events';
import { AudioManager } from './audio-manager';
import { BUS_TRIM, toDb, volumesFrom, type Volumes } from './buses';
import { TankLoops, type LoopNodeFactory } from './loops';
import { MusicBed, type MusicBedOptions } from './music-bed';
import type { MusicScene } from './score/director';
import { WorldSoundscape } from './world-soundscape';
import { planetKindFromSeed, type PlanetKind } from '../world/sun';
import { hash32, Rng } from './rng';
import { playExplosion } from './sfx/explosion';
import { playArmorHit, playEmp, playKillAccent, playMetalCreak, playRicochetPing, playRubbleSettle, playWreckStages, type PingMaterial } from './sfx/impacts';
import { SuspensionThumps } from './sfx/suspension';
import { soundDelay, shotSeed } from './sfx/tank-sfx-math';
import { playUi, setUiBank } from './sfx/ui';
import { playArcCrackle, playCoaxBurst, playSnap, playWeaponFire } from './sfx/weapons';
import { MachineGuns, segmentDistance } from './sfx/mg';
import { worldSetOf } from './score/director';
import { ShellWhistles } from './sfx/whistle';
import { WIND_UPDATE_INTERVAL, WindSynth } from './sfx/wind';
import { sampleWorldGust } from './sfx/world-gust';
import { BUS_NAMES } from './voice-select';
import { FetchBankLoader, SfxBank, type BankLoader } from './sfx-bank';
import { ActorLoops } from './actor-loops';
import type { AudioCue } from './cues';

export interface IntegratorOptions {
  seed?: number;
  /** URL of the bundled engine worklet (null: use the native fallback loops). */
  workletUrl?: string | null;
  /** Test hook: build loop nodes without an AudioWorklet. */
  loopFactory?: LoopNodeFactory;
  music?: boolean;
  wind?: boolean;
  /** Validate every recipe before playing it (dev and tests). */
  dev?: boolean;
  destination?: AudioNode;
  /** Built ahead of the first user gesture: no source starts until start(), so the parked context stays silent. */
  standby?: boolean;
  /** Where `audio/` assets are served from (import.meta.env.BASE_URL in the app). */
  baseUrl?: string;
  /** The effects bank loader (false: never load the bank; undefined: fetch in a browser). */
  bank?: BankLoader | false;
  musicOptions?: MusicBedOptions;
}
/** Realtime events as src/game/realtime/match.ts emits them (structurally typed here so the audio stays decoupled). */
export type RealtimeAudioEvent =
  | { type: 'tracer'; owner: number; from: V3; to: V3; victim: number | null }
  | { type: 'audio'; cue: AudioCue }
  | { type: 'spawn'; tank: number }
  | { type: 'say'; speaker: string; text: string; seconds: number }
  | { type: 'objective'; id: string; text: string; state: 'active' | 'done' | 'failed' }
  | { type: 'hint'; text: string | null }
  | { type: 'banner'; title: string; subtitle?: string }
  | { type: 'marker'; point: V3 | null }
  | { type: 'mission'; status: 'won' | 'failed'; reason?: string };
/** What index.ts reads from the mission runner each frame (all optional; see the handoff note). */
export interface MissionAudioState { beat?: string | null; ending?: 'rewind' | 'release' | null; outcome?: 'won' | 'failed' | null }

type Vec = readonly [number, number, number];
const MUZZLE_LIFT = 0.45;
/** Distance between the wind synth's two "ears" in the gust field (u): the field's cells are ~9 u. */
const EAR_SEPARATION = 3;
const DEFAULT_WIND = { mean: 0.6, gust: 0.25, period: 8 } as const;
const COAX_BURST_GAP_S = 0.42, PING_GAP_S = 0.25, THREAT_INTERVAL_S = 0.2, DISTRESS_GAP_S = 7, ALARM_GAP_S = 12;
const SNAP_RANGE = 2, SNAP_MIN_SHOOTER_DIST = 4, SNAP_GAP_S = 0.07, NEAR_MISS_RANGE = 3, NEAR_MISS_GAP_S = 6, KILL_STREAK_N = 3, KILL_STREAK_WINDOW_S = 10;
/** Ground materials per world set (a hash picks between the two so impacts vary); a hit machine is metal. */
const WORLD_MATERIALS: Record<string, [PingMaterial, PingMaterial]> = { cradle: ['soil', 'rock'], dune: ['rock', 'soil'], frost: ['concrete', 'rock'], forge: ['rock', 'metal'], halo: ['concrete', 'metal'] };
const LAUNCH_PADS = ['forge-pad', 'aether-pad', 'harbor-pad'];

const up = (p: Vec): [number, number, number] => { const r = Math.hypot(p[0], p[1], p[2]) || 1; return [p[0] / r, p[1] / r, p[2] / r]; };
const add = (p: Vec, d: Vec, k: number): [number, number, number] => [p[0] + d[0] * k, p[1] + d[1] * k, p[2] + d[2] * k];
const dist = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const clamp01 = (v: number) => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
/** Mission id of a campaign setup ('campaign:1-5' → '1-5'), else null. */
export function missionIdOf(setup: { id: string; mode: string }): string | null { return setup.mode === 'campaign' && setup.id.startsWith('campaign:') ? setup.id.slice('campaign:'.length) : null; }
/** Lowest alive component stage (the Siege Crawler's phase); −1 without components. */
export function componentStage(t: { components?: readonly { stage: number; health: number }[] }): number {
  if (!t.components?.length) return -1;
  let stage = Infinity; for (const c of t.components) if (c.health > 0 && c.stage < stage) stage = c.stage;
  return stage === Infinity ? 3 : stage;
}

export class TankAudioIntegrator {
  readonly m: AudioManager;
  readonly loops: TankLoops;
  readonly whistles = new ShellWhistles();
  readonly thumps = new SuspensionThumps();
  readonly music: MusicBed;
  readonly wind: WindSynth | null;
  readonly soundscape: WorldSoundscape | null;
  readonly bank: SfxBank;
  readonly actors: ActorLoops;
  readonly guns: MachineGuns;
  private scene: MusicScene = 'title';
  private setup: MatchSetup | undefined;
  private mission: string | null = null;
  private observerId: number | null = null;
  private windRule: { mean: number; gust: number; period: number } = { ...DEFAULT_WIND };
  private windDir: [number, number, number] = [1, 0.3, 0.2];
  private readonly focus: [number, number, number] = [0, 0, 0];
  private hasFocus = false;
  private clock = 0;
  private readonly cuts = new Map<string, { position: V3; radius: number }>();
  private readonly killed = new Set<string>();
  private readonly shots = new ShotEvents();
  readonly events: Record<string, number> = {};
  private readonly gustA: [number, number, number] = [0, 0, 0];
  private windDue = 0;
  // Threat model (all 0..1, decaying): hostile fire, projectiles aimed our way, incoming warnings, nearby enemies.
  private readonly threat = { fire: 0, incoming: 0, near: 0, projectiles: 0, health: 0, value: 0, override: null as { value: number; until: number } | null };
  private threatAt = 0;
  private readonly coaxLast = new Map<number, number>();
  private readonly pingLast = new Map<number, number>();
  private snapLast = -Infinity;
  private nearMissAt = -Infinity;
  private readonly killTimes: number[] = [];
  private checkpoints = 0;
  private worldSet = 'cradle';
  private readonly lastArcShot = new Map<number, number>();
  private readonly disabled = new Set<string>();
  private readonly objectives = new Map<string, string>();
  private distressAt = -Infinity;
  private alarmAt = -Infinity;
  private bossCue: { id: string; phase: number } | null | undefined;
  private derivedBoss: { id: string; phase: number } | null = null;
  private missionState: MissionAudioState = {};
  /** Dev profiling: cumulative ms per onFrame section (listener, loops, thumps, whistles, wind, prune+meters). */
  private readonly sections = new Float64Array(6);
  private profiledFrames = 0;
  private lapAt = 0;
  private readonly profiling: boolean;
  private lap(i: number): void { const n = performance.now(); this.sections[i] += n - this.lapAt; this.lapAt = n; }

  constructor(readonly ctx: BaseAudioContext, private readonly o: IntegratorOptions = {}) {
    this.m = new AudioManager(ctx, { seed: o.seed, dev: o.dev, destination: o.destination });
    this.profiling = o.dev === true && typeof performance !== "undefined";
    this.loops = new TankLoops(this.m);
    this.bank = new SfxBank();
    setUiBank(this.bank);
    this.actors = new ActorLoops(this.m, this.bank);
    this.guns = new MachineGuns(this.m, this.bank);
    this.music = new MusicBed(this.m, { baseUrl: o.baseUrl, ...o.musicOptions });
    this.wind = o.wind === false ? null : new WindSynth(ctx, this.m.pools, !o.standby);
    this.wind?.output.connect(this.m.buses.input.ambience);
    this.soundscape = o.wind === false ? null : new WorldSoundscape(ctx, this.m.buses.input.ambience, this.m.pools, !o.standby);
  }

  /** A standby engine takes the match seed it would have been built with (before start()). */
  reseed(seed: number): void { this.m.reseed(seed); }

  private lastFrameAt = -Infinity;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /** Starts the beds and the music, loads the effects bank, then the engine worklet (async). Outside a match no frame
   * hooks arrive, so a slow idle timer keeps the voice budget pruned and the meters read for the menus. */
  async start(): Promise<void> {
    this.wind?.start();
    this.soundscape?.start();
    if (this.o.music !== false) this.music.start();
    if (this.idleTimer === null && typeof setInterval === 'function') { this.idleTimer = setInterval(() => { if (this.ctx.currentTime - this.lastFrameAt > 0.3) { try { this.m.update(); } catch { /* reported by the frame path */ } } }, 250); (this.idleTimer as unknown as { unref?: () => void }).unref?.(); }
    const loader = this.o.bank === false ? null : this.o.bank ?? (typeof window !== 'undefined' && typeof fetch === 'function' ? new FetchBankLoader(this.ctx, this.o.baseUrl ?? '/') : null);
    if (loader) void this.bank.load(loader);
    await this.loops.init(this.o.workletUrl ?? null, this.o.loopFactory);
  }

  /** The unlock fade-in (0.6 s), from the current audio time. */
  fadeIn(): void { this.m.buses.fadeIn(this.ctx.currentTime); }
  setVolumes(v: Volumes): void { this.m.setVolumes(v); this.music.setMuted(v.master * v.music <= 0); }
  setScene(scene: MusicScene, world?: PlanetKind): void {
    this.scene = scene; this.music.setScene(scene, world);
    if (world) this.soundscape?.setWorld(world);
    const inWorld = scene === 'skirmish' || scene === 'results' || scene === 'pause';
    this.soundscape?.setActive(inWorld);
    this.m.buses.input.ambience.gain.setTargetAtTime(inWorld ? BUS_TRIM.ambience * (scene === 'pause' ? 0.5 : 1) : 0, this.ctx.currentTime, .25);
    if (scene !== 'skirmish') {
      this.loops.reset(this.ctx.currentTime); this.whistles.clear(this.m, this.ctx.currentTime); this.guns.reset(this.ctx.currentTime);
      if (scene !== 'pause' && scene !== 'results') this.actors.reset(this.ctx.currentTime);
    }
    if (scene === 'title' || scene === 'menu') { this.mission = null; this.bossCue = undefined; this.derivedBoss = null; this.missionState = {}; }
  }
  applySettings(detail: unknown): void {
    const audio = detail && typeof detail === 'object' ? (detail as { audio?: unknown }).audio : undefined;
    this.setVolumes(volumesFrom(audio));
  }
  /** Dialogue on/off: ducks music and world effects (the campaign voice calls this). */
  setDialogue(active: boolean): void { this.m.setDialogue(active); this.music.setDialogue(active); }
  /** The observing player's tank index (the session's observer), for "my" cues and the team of the threat model. */
  setObserver(id: number | null): void { this.observerId = id; }
  /** Mission runner state published by the game (see the handoff note); null fields clear. */
  setMissionState(state: MissionAudioState): void {
    const prev = this.missionState; this.missionState = { ...prev, ...state };
    const beat = this.missionState.beat ?? null;
    if (this.bossCue === undefined) {
      // Derived finale/boss phases from beat ids (interim until the campaign emits explicit cues).
      const finale = this.mission === '3-3';
      this.music.setPhase(finale ? (beat === 'corvin' || beat === 'rustcrown' ? 'duel' : beat === 'undermine-core' ? 'core' : beat === 'escape' ? 'escape' : beat === 'ending-choice' ? 'choice' : null) : null);
      const bossBeat = this.mission === 't-b' && beat === 'leviathan' ? 'leviathan' : this.mission === 'f-b' && beat === 'titan' ? 'titan' : null;
      if (bossBeat && !this.derivedBoss) this.music.setBoss(this.derivedBoss = { id: bossBeat, phase: 0 });
      else if (!bossBeat && this.derivedBoss && this.derivedBoss.id !== 'crawler') this.music.setBoss(this.derivedBoss = null);
    }
    if (this.missionState.ending !== undefined) this.music.setEnding(this.missionState.ending ?? null);
    if (this.missionState.outcome !== undefined && this.missionState.outcome) this.music.setOutcome(this.missionState.outcome);
  }
  /** Explicit campaign cues (src/audio/cues.ts). */
  cue(c: AudioCue): void {
    const now = this.ctx.currentTime;
    switch (c.type) {
      case 'boss': this.bossCue = { id: c.id, phase: c.phase }; this.music.setBoss(this.bossCue); return;
      case 'boss-end': if (this.bossCue) this.music.stinger('boss-defeated'); this.bossCue = null; this.music.setBoss(null); return;
      case 'finale': this.music.setPhase(c.phase); return;
      case 'escalation': this.music.setEscalation(c.stage); return;
      case 'ending': this.music.setEnding(c.choice); this.music.stinger(`ending-${c.choice}`); return;
      case 'stinger': this.music.stinger(c.id); return;
      case 'ui': if (c.sound === 'alarm') this.alarmAt = now; playUi(this.m, c.sound); return;
      case 'threat': this.threat.override = { value: clamp01(c.value), until: now + (c.seconds ?? 6) }; return;
      case 'checkpoint': { playUi(this.m, 'checkpoint'); const variant = ['checkpoint', 'checkpoint-b', 'checkpoint-c'][this.checkpoints++ % 3]; this.music.stinger(this.music.player.has(`stinger-${variant}`) ? variant : 'checkpoint'); return; }
    }
  }

  onMatchStart(s: MatchSetup): void {
    this.setup = s;
    const now = this.ctx.currentTime;
    this.loops.reset(now);
    this.thumps.reset();
    this.whistles.clear(this.m, now);
    this.actors.reset(now);
    this.whistles.gravity = GRAVITY_BALLISTIC * (Number.isFinite(s.rules?.gravityScale) ? s.rules.gravityScale : 1);
    this.killed.clear();
    this.shots.clear();
    this.cuts.clear();
    this.coaxLast.clear(); this.pingLast.clear(); this.disabled.clear(); this.objectives.clear(); this.lastArcShot.clear();
    this.guns.reset(now); this.snapLast = -Infinity; this.nearMissAt = -Infinity; this.killTimes.length = 0; this.checkpoints = 0;
    this.m.listener.reset();
    this.hasFocus = false;
    Object.assign(this.threat, { fire: 0, incoming: 0, near: 0, projectiles: 0, health: 0, value: 0, override: null });
    this.distressAt = -Infinity; this.alarmAt = -Infinity;
    this.bossCue = undefined; this.derivedBoss = null; this.missionState = {};
    const rule = s.rules?.wind;
    this.windRule = rule && [rule.mean, rule.gust, rule.period].every(Number.isFinite) ? { ...rule } : { ...DEFAULT_WIND };
    const rng = new Rng(hash32(s.seed ?? 0, 0x77696e64));
    const z = rng.signed(), a = rng.range(0, Math.PI * 2), r = Math.sqrt(Math.max(0, 1 - z * z));
    this.windDir = [r * Math.cos(a), z, r * Math.sin(a)];
    const world = s.planet.kind === 'auto' ? planetKindFromSeed(s.seed) : s.planet.kind;
    this.mission = missionIdOf(s);
    this.worldSet = worldSetOf(world, this.mission);
    this.music.setMission(this.mission);
    if (this.o.music !== false) this.music.start(s.seed ?? 0);
    this.music.prefetch(world, this.mission);
    this.setScene('skirmish', world);
    if (this.mission) this.music.stinger('mission-start');
  }

  onMatchEnd(_r: { winner: number | null; setup: MatchSetup }): void {
    this.setScene('results');
  }

  private observer(s: GameSnapshot): number {
    if (this.observerId !== null && s.tanks[this.observerId]) return this.observerId;
    if (!this.hasFocus) return 0;
    let best = 0, bestD = Infinity;
    s.tanks.forEach((t, i) => { const d = dist(t.position, this.focus); if (d < bestD) { bestD = d; best = i; } });
    return best;
  }
  private myTeam(s: GameSnapshot): number | undefined { return s.tanks[this.observer(s)]?.team; }
  private hostile(s: GameSnapshot, t: TankState | undefined): boolean { const team = this.myTeam(s); return !!t && team !== undefined && t.team !== undefined && t.team !== team; }
  private keyOf(t: TankState): string { return `${t.id}:${t.generation ?? 0}`; }
  /** Ground material at an impact: the world set's two materials, picked by a hash of the position. */
  private groundMaterial(p: Vec, salt = 0): PingMaterial { const pair = WORLD_MATERIALS[this.worldSet] ?? WORLD_MATERIALS.cradle; return (hash32(Math.round(p[0] * 31 + p[2] * 17), Math.round(p[1] * 13), salt) % 10) < 7 ? pair[0] : pair[1]; }
  /** A kill by the observer: three within ten seconds fire the kill-streak cue (once per streak). */
  private noteObserverKill(now: number): void {
    this.killTimes.push(now);
    while (this.killTimes.length && now - this.killTimes[0] > KILL_STREAK_WINDOW_S) this.killTimes.shift();
    if (this.killTimes.length >= KILL_STREAK_N) { this.killTimes.length = 0; this.music.stinger('kill-streak'); }
  }

  onEvent(e: GameEvent, s: GameSnapshot): void {
    this.events[e.type] = (this.events[e.type] ?? 0) + 1;
    const now = this.ctx.currentTime;
    switch (e.type) {
      case 'shot': {
        if (!this.shots.accept(e)) return;
        const tank = s.tanks[e.player] as TankState | undefined;
        if (!tank) return;
        let projectile = 0;
        for (const p of s.projectiles) if (p.owner === e.player && p.id > projectile) projectile = p.id;
        const weapon = e.launch?.weapon ?? tank.kit?.weapon ?? tank.loadout?.barrel;
        if (weapon === 'arc_cannon') this.lastArcShot.set(e.player, now); else this.lastArcShot.delete(e.player);
        playWeaponFire(this.m, {
          weapon, power: e.launch?.power ?? tank.power,
          seed: shotSeed(e.launch?.tick ?? s.tick, e.player, e.launch?.id ?? projectile),
          position: e.launch?.position ?? add(tank.position, up(tank.position), MUZZLE_LIFT),
        }, this.bank);
        this.threat.fire = Math.min(1, this.threat.fire + (this.hostile(s, tank) ? 0.45 : 0.1));
        return;
      }
      case 'impact': {
        const position = add(e.position, e.normal, 0.1);
        const seed = hash32(s.tick, e.owner, Math.round(e.position[0] * 97 + e.position[1] * 89 + e.position[2] * 83));
        const hits = e.hits ?? this.inferHits(e, s);
        const material = hits.some(h => h.direct) ? 'metal' : this.groundMaterial(e.position);
        playExplosion(this.m, { position, radius: e.radius, munition: e.munition, seed, noCrater: e.noCrater, material }, this.bank);
        if (this.lastArcShot.has(e.owner)) { this.lastArcShot.delete(e.owner); playArcCrackle(this.m, this.bank, position, hash32(seed, 0xa7), soundDelay(this.m.spatialize(position).path)); }
        if (e.cut) this.cuts.set(e.cut.id, { position: e.position, radius: e.cut.radius });
        // A hostile shell landing within a few units of the observer without hitting it: the near-miss cue.
        const me = s.tanks[this.observer(s)];
        if (me && this.hostile(s, s.tanks[e.owner]) && dist(e.position, me.position) < NEAR_MISS_RANGE && !hits.some(h => h.tank === this.observer(s) && h.damage > 0) && now - this.nearMissAt > NEAR_MISS_GAP_S) { this.nearMissAt = now; this.music.stinger('near-miss'); this.threat.incoming = Math.min(1, this.threat.incoming + 0.5); }
        hits.forEach((hit, i) => {
          const tank = s.tanks[hit.tank];
          if (!tank) return;
          const at = add(tank.position, up(tank.position), 0.3);
          const delay = soundDelay(this.m.spatialize(at).path);
          const maxHealth = tank.maxHealth && tank.maxHealth > 0 ? tank.maxHealth : 100;
          const damage01 = clamp01(hit.damage / Math.max(20, maxHealth * 0.45));
          const shielded = !!tank.shield && hit.damage <= 0;
          playArmorHit(this.m, at, { damage01, direct: hit.direct, lethal: hit.lethal, section: hit.armorSection, reactiveSpent: !!hit.reactiveSpent, shielded, heavy: maxHealth > 150 && hit.direct }, hash32(seed, i, hit.tank), delay, this.bank);
          if (hit.lethal && !this.killed.has(this.keyOf(tank))) {
            this.killed.add(this.keyOf(tank));
            playKillAccent(this.m, at, hash32(seed, 0x6b, hit.tank), delay, this.bank, maxHealth > 150);
            playWreckStages(this.m, this.bank, at, hash32(seed, 0x77, hit.tank), delay, maxHealth > 150);
            if (e.owner === this.observer(s) && this.hostile(s, tank)) this.noteObserverKill(now);
          }
          if (hit.tank === this.observer(s) && hit.damage > 0) this.threat.fire = Math.min(1, this.threat.fire + 0.5);
        });
        this.threat.fire = Math.min(1, this.threat.fire + (this.hostile(s, s.tanks[e.owner]) ? 0.35 : 0.12));
        return;
      }
      case 'kill': {
        const tank = s.tanks[e.tank];
        if (!tank || this.killed.has(this.keyOf(tank))) return;
        this.killed.add(this.keyOf(tank));
        playKillAccent(this.m, add(tank.position, up(tank.position), 0.3), hash32(s.tick, e.tank, 0x6b), 0, this.bank, (tank.maxHealth ?? 100) > 150);
        playWreckStages(this.m, this.bank, add(tank.position, up(tank.position), 0.3), hash32(s.tick, e.tank, 0x77), 0, (tank.maxHealth ?? 100) > 150);
        if (e.by === this.observer(s) && this.hostile(s, tank)) this.noteObserverKill(now);
        return;
      }
      case 'terrain-commit': {
        for (const id of e.cutIds) {
          const cut = this.cuts.get(id);
          if (!cut) continue;
          this.cuts.delete(id);
          playRubbleSettle(this.m, cut.position, cut.radius, hash32(e.version, id.length, s.tick), this.bank);
        }
        return;
      }
      case 'turn': playUi(this.m, e.player === this.observer(s) ? 'turn' : 'turn-other', 0.5, s.tick); return;
      case 'finish': {
        const me = this.observer(s), team = this.myTeam(s);
        const won = e.team !== undefined && e.team !== null && team !== undefined ? e.team === team : e.winner === me;
        if (e.winner !== null || (e.team !== undefined && e.team !== null)) this.music.setOutcome(won ? 'won' : 'failed');
        if (!this.music.player.has(won ? 'stinger-victory' : 'stinger-defeat')) playUi(this.m, e.winner === null ? 'turn-other' : won ? 'victory' : 'defeat', 0.5, s.tick);
        this.setScene('results');
        return;
      }
      case 'incoming': {
        this.whistles.hint(e.predicted, now);
        if (e.tank === this.observer(s)) { this.threat.incoming = 1; playUi(this.m, 'incoming', 0.5, s.tick); }
        return;
      }
      case 'scan': if (e.tank === this.observer(s)) playUi(this.m, 'depot-ping', 0.5, s.tick); return;
      default: return;
    }
  }

  /** Realtime (campaign) events forwarded by index.ts from the session. */
  onRealtimeEvent(e: RealtimeAudioEvent, s?: GameSnapshot): void {
    this.events[`rt:${e.type}`] = (this.events[`rt:${e.type}`] ?? 0) + 1;
    const now = this.ctx.currentTime;
    switch (e.type) {
      case 'tracer': {
        // Sustained fire: one loop per gun that follows it; the rate-limited burst is the fallback without the loop sprite.
        if (!this.guns.tracer(e.owner, e.from, now, hash32(e.owner, 0x3c))) {
          const last = this.coaxLast.get(e.owner) ?? -Infinity;
          if (now - last >= COAX_BURST_GAP_S) { this.coaxLast.set(e.owner, now); playCoaxBurst(this.m, this.bank, e.from, hash32(e.owner, Math.round(now * 7), 0x3c)); }
        }
        // Rounds passing within a couple of units of the focus (from a gun that is not right next to it) snap.
        if (this.hasFocus && now - this.snapLast >= SNAP_GAP_S && dist(e.from, this.focus) > SNAP_MIN_SHOOTER_DIST && segmentDistance(this.focus, e.from, e.to) < SNAP_RANGE) {
          this.snapLast = now;
          playSnap(this.m, this.bank, this.focus, hash32(e.owner, Math.round(now * 17), 0x5a));
        }
        const victimKey = e.victim ?? -1 - e.owner;
        const lastPing = this.pingLast.get(victimKey) ?? -Infinity;
        if (now - lastPing >= PING_GAP_S && (hash32(victimKey, Math.round(now * 13)) & 3) !== 0) {
          this.pingLast.set(victimKey, now);
          playRicochetPing(this.m, this.bank, e.to, hash32(victimKey, Math.round(now * 11), 0x9), e.victim !== null ? 'metal' : this.groundMaterial(e.to, Math.round(now * 5)));
        }
        if (e.victim !== null && s && e.victim === this.observer(s)) this.threat.fire = Math.min(1, this.threat.fire + 0.08);
        if (s && this.hostile(s, s.tanks[e.owner])) this.threat.fire = Math.min(1, this.threat.fire + 0.04);
        return;
      }
      case 'objective': {
        const prev = this.objectives.get(e.id);
        this.objectives.set(e.id, e.state);
        if (prev === undefined && e.state === 'active' && e.id !== 'optional') playUi(this.m, 'objective-new');
        else if (prev !== e.state && e.state === 'done') { if (this.music.player.playing && this.music.player.has('stinger-objective')) this.music.stinger('objective'); else playUi(this.m, 'objective-done'); }
        else if (prev !== e.state && e.state === 'failed') playUi(this.m, 'objective-failed');
        if (this.mission === 'ii-7') { let stage = 0; for (const pad of LAUNCH_PADS) if (this.objectives.get(pad) === 'done') stage++; this.music.setEscalation(stage); }
        return;
      }
      case 'banner': if (now - this.music.player.lastStingerAt > 0.5) playUi(this.m, 'banner'); return;
      case 'audio': if (e.cue && typeof e.cue.type === 'string') this.cue(e.cue); return;
      case 'mission': this.music.setOutcome(e.status); return;
      default: return;
    }
  }

  /** v1 impacts carry no `hits`: estimate them from the blast the way the simulation applies damage (presentation only). */
  private inferHits(e: { position: V3; radius: number }, s: GameSnapshot) {
    const out: { tank: number; damage: number; exposure: number; direct: boolean; lethal: boolean; armorSection?: 'front' | 'left' | 'right' | 'rear' | 'roof'; reactiveSpent?: number }[] = [];
    s.tanks.forEach((t, i) => {
      const reach = e.radius * 1.65 + 0.9, d = dist(t.position, e.position);
      const exposure = Math.max(0, 1 - d / reach);
      if (exposure > 0.15) out.push({ tank: i, damage: 70 * exposure, exposure, direct: d < 1.1, lethal: t.health <= 0 });
    });
    return out;
  }

  onFrame(f: FrameInfo): void {
    const prof = this.profiling;
    if (prof) this.lapAt = performance.now();
    const now = this.ctx.currentTime, dt = Number.isFinite(f.realDt) ? Math.max(0, Math.min(0.25, f.realDt)) : 0;
    this.clock += dt; this.lastFrameAt = now;
    if (this.m.listener.update(f.camera, f.focus, dt)) {
      this.focus[0] = f.focus[0]; this.focus[1] = f.focus[1]; this.focus[2] = f.focus[2];
      this.hasFocus = true;
    }
    if (prof) this.lap(0);
    const s = f.snapshot;
    if (s && this.scene === 'skirmish') {
      this.loops.update(s.tanks, s.tick, now);
      this.actors.update(s.tanks, s.tick, now);
      this.guns.update(now);
      if (prof) this.lap(1);
      this.thumps.update(this.m, s.tanks, s.tick, now);
      if (prof) this.lap(2);
      this.whistles.update(this.m, s.projectiles, this.focus, now);
      if (prof) this.lap(3);
      if (now - this.threatAt >= THREAT_INTERVAL_S) { this.updateThreat(s, now - this.threatAt, now); this.threatAt = now; }
      // The wind drivers (three gust-field samples) are computed only when the synth is due (30 Hz).
      this.windDue += dt;
      if (this.wind && this.windDue >= WIND_UPDATE_INTERVAL) { this.updateWind(f, s, this.windDue); this.windDue = 0; }
      if (prof) this.lap(4);
    } else if (s && (this.scene === 'pause' || this.scene === 'results')) {
      // Wrecks keep burning on the results screen; everything else is quiet.
      this.actors.update(s.tanks, s.tick, now);
    }
    this.m.update();
    if (prof) this.lap(5);
    if (prof) this.profiledFrames++;
  }

  /** The threat estimate and the cues read from the snapshot (EMP, searchlight alarm, low-health distress, boss phase). */
  private updateThreat(s: GameSnapshot, dt: number, now: number): void {
    const me = s.tanks[this.observer(s)], team = me?.team;
    const T = this.threat;
    T.fire = Math.max(0, T.fire - dt * 0.22);
    T.incoming = Math.max(0, T.incoming - dt * 0.33);
    let near = 0, projectiles = 0, boss: { id: string; phase: number } | null = null;
    const obs = s.observations?.[this.observer(s)];
    for (let i = 0; i < s.tanks.length; i++) {
      const t = s.tanks[i];
      if (t.retired || t.health <= 0 || team === undefined || t.team === team) continue;
      const d = me ? dist(t.position, me.position) : 30;
      const seen = obs?.[i]?.visible ? 1 : obs?.[i] ? 0.6 : 0.35;
      const weight = t.motionKind === 'swarm' ? 0.35 : t.components?.length ? 1.6 : 1;
      near += clamp01(1 - (d - 6) / 22) * seen * weight;
      if (t.components?.length) { const phase = componentStage(t); boss = { id: 'crawler', phase: Math.max(0, phase) }; }
      // EMP: a machine newly disabled crackles down (keyed by generation so a recycled slot never replays it).
      const key = this.keyOf(t);
      if (t.disabledUntil !== undefined && t.disabledUntil > s.tick) { if (!this.disabled.has(key)) { this.disabled.add(key); playEmp(this.m, this.bank, t.position, hash32(t.id, s.tick, 0xe)); } }
      else this.disabled.delete(key);
    }
    for (const p of s.projectiles) { const owner = s.tanks[p.owner]; if (owner && team !== undefined && owner.team !== team) projectiles++; }
    T.near = clamp01(near / 2.5);
    T.projectiles = clamp01(projectiles * 0.4);
    T.health = me && me.health > 0 ? clamp01(0.3 - me.health / Math.max(1, me.maxHealth ?? 100)) / 0.3 * 0.35 : 0;
    let value = clamp01(0.45 * T.near + 0.3 * T.fire + 0.25 * T.projectiles + 0.4 * T.incoming + T.health);
    if (boss) value = Math.max(value, 0.6);
    if (T.override) { if (now < T.override.until) value = T.override.value; else T.override = null; }
    T.value = value;
    this.music.setThreat(value);
    // The Crawler's phase is a fact of the snapshot (component stages); explicit cues override it.
    if (this.bossCue === undefined) {
      const next = boss ?? (this.derivedBoss && this.derivedBoss.id !== 'crawler' ? this.derivedBoss : null);
      if ((next?.id ?? null) !== (this.derivedBoss?.id ?? null) || (next?.phase ?? -1) !== (this.derivedBoss?.phase ?? -1)) { this.derivedBoss = next; this.music.setBoss(next); }
    }
    // EMP on our own machine, low-health distress, and the searchlight alarm.
    if (me) {
      if (me.disabledUntil !== undefined && me.disabledUntil > s.tick && !this.disabled.has(this.keyOf(me))) { this.disabled.add(this.keyOf(me)); playEmp(this.m, this.bank, me.position, hash32(me.id, s.tick, 0xe)); }
      else if (!(me.disabledUntil !== undefined && me.disabledUntil > s.tick)) this.disabled.delete(this.keyOf(me));
      const hp = me.health / Math.max(1, me.maxHealth ?? 100);
      if (me.health > 0 && hp < 0.3 && now - this.distressAt >= DISTRESS_GAP_S) { this.distressAt = now; playMetalCreak(this.m, this.bank, me.position, hash32(me.id, Math.round(now), 0xd)); if (hp < 0.15) playUi(this.m, 'overheat'); }
      if ((me.detection ?? 0) >= 1 && now - this.alarmAt >= ALARM_GAP_S) { this.alarmAt = now; playUi(this.m, 'alarm'); T.fire = Math.min(1, T.fire + 0.4); }
    }
  }

  private updateWind(f: FrameInfo, s: GameSnapshot, dt: number): void {
    const lis = this.m.listener, p = lis.position;
    const n = up(p);
    // The wind on the local tangent plane, minus half the observer's velocity (a moving tank feels a breeze).
    const w = this.windDir, dot = w[0] * n[0] + w[1] * n[1] + w[2] * n[2];
    const speed = this.windRule.mean;
    const obs = s.tanks[this.observer(s)];
    const v = obs?.velocity ?? [0, 0, 0];
    const ax = (w[0] - n[0] * dot) * speed - v[0] * 0.5, ay = (w[1] - n[1] * dot) * speed - v[1] * 0.5, az = (w[2] - n[2] * dot) * speed - v[2] * 0.5;
    const apparent = Math.hypot(ax, ay, az);
    const g = this.gustA;
    const t = this.clock;
    const centre = sampleWorldGust(p[0], p[1], p[2], w[0], w[1], w[2], t);
    g[0] = p[0] - lis.right[0] * EAR_SEPARATION; g[1] = p[1] - lis.right[1] * EAR_SEPARATION; g[2] = p[2] - lis.right[2] * EAR_SEPARATION;
    const left = sampleWorldGust(g[0], g[1], g[2], w[0], w[1], w[2], t);
    g[0] = p[0] + lis.right[0] * EAR_SEPARATION; g[1] = p[1] + lis.right[1] * EAR_SEPARATION; g[2] = p[2] + lis.right[2] * EAR_SEPARATION;
    const right = sampleWorldGust(g[0], g[1], g[2], w[0], w[1], w[2], t);
    const camAlt = Math.hypot(f.camera.position[0], f.camera.position[1], f.camera.position[2]) - (lis.planetRadius || 18);
    const lift = Math.max(0, Math.min(1, camAlt / 14));
    const wx = w[0] - n[0] * dot, wy = w[1] - n[1] * dot, wz = w[2] - n[2] * dot, wl = Math.hypot(wx, wy, wz) || 1;
    this.wind!.update({
      perceivedSpeed01: 1 - Math.exp(-apparent / 4), gust01: Math.max(0, Math.min(1, this.windRule.gust + 0.2)),
      gustFieldCentre: centre, gustFieldLeft: left, gustFieldRight: right,
      proximity01: 1 - lift * lift * (3 - 2 * lift), bias01: 0.35,
      pan: (wx * lis.right[0] + wy * lis.right[1] + wz * lis.right[2]) / wl, enabled: true,
    }, dt);
  }

  /** window.__tmtGame.audio (without the timing, which index.ts measures around the hooks). */
  telemetry(): Record<string, unknown> {
    const m = this.m, b = m.buses;
    const played: Record<string, number> = {};
    for (const bus of BUS_NAMES) played[bus] = m.played[bus];
    return {
      state: this.ctx.state,
      sampleRate: this.ctx.sampleRate,
      voices: m.voiceTelemetry(this.music.liveVoices),
      played,
      busPeaks: b.peaksDb(),
      peakDb: Math.round(toDb(b.peakMax) * 10) / 10,
      clipCount: b.clipCount,
      nan: m.nanRejected + b.nanCount,
      dropped: m.dropped,
      loops: { mode: this.loops.mode, active: this.loops.active, tanks: this.loops.tanks() },
      actors: { active: this.actors.active, kinds: this.actors.kinds(), started: this.actors.started },
      guns: { active: this.guns.active, started: this.guns.started, stopped: this.guns.stopped },
      whistles: { live: this.whistles.count, incoming: this.whistles.incomingCount, started: this.whistles.started },
      thumps: this.thumps.thumps,
      bank: { ready: this.bank.ready, played: this.bank.played, decodedBytes: this.bank.decodedBytes, lastError: this.bank.lastError },
      threat: { ...this.threat, override: this.threat.override ? this.threat.override.value : null },
      mission: this.mission, observer: this.observerId, missionState: this.missionState,
      music: this.music.snapshot(),
      soundscape: this.soundscape?.snapshot(),
      duck: Math.round(b.duck.gain.value * 1000) / 1000,
      volumes: b.volumes,
      events: { ...this.events },
      lastError: m.lastError ?? this.loops.error,
      ...(this.profiledFrames ? { sectionsMs: Object.fromEntries(["listener", "loops", "thumps", "whistles", "wind", "update"].map((k, i) => [k, Math.round(this.sections[i] / this.profiledFrames * 1e4) / 1e4])) } : {}),
    };
  }

  /** Main-thread ms the music scheduler spent since the last call (added to the frame cost by index.ts). */
  takeSchedulerMs(): number { const v = this.music.pendingMs; this.music.pendingMs = 0; return v; }

  dispose(): void {
    if (this.idleTimer !== null) { clearInterval(this.idleTimer); this.idleTimer = null; }
    this.music.dispose();
    this.whistles.dispose();
    this.loops.dispose();
    this.actors.dispose();
    this.guns.dispose();
    this.wind?.dispose();
    this.soundscape?.dispose();
    this.m.dispose();
    setUiBank(null);
  }
}
