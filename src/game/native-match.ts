/** Resident lifecycle ABI 1 in the terrain/physics WASM instance. Snapshot fields
 * are output mirrors; tick/phase/timers/tempo are never copied back into Rust. */
import type { RustTerrainCore } from '../gpu/terrain/rust-core';
import type { MatchSetup } from './api/match';
import type { DriveInput, GameSnapshot, ProjectileState, TankState, V3 } from './contracts';
import { assembleKit, tankKit, type KitAssembly } from './kit';
import { assembleKit as canonicalKit, kitContextOf, kitTrunnionPivot } from './kit/assembly';
import { pitchTable, PITCH_TABLE_STEP } from './kit/pitch';
import { GRAVITY_BALLISTIC, LAUNCH_SPEED_SCALE } from './world-constants';
import { MUNITIONS, munitionStats, type MunitionId } from './munitions';
import { brainOf, MAX_CHARGE } from './rules/setup';
import { NativeLegacyBrain } from './ai/native-legacy';
import { NativeProfileBrain } from './ai/native-profile';
import { resolveProfile, type W1Profile } from './ai/profiles';
import type { Difficulty } from './api/match';
import { NativeObservations } from './native-observations';
import { NativeJournal } from './native-journal';
import { NativeMotion } from './native-motion';
import { NativeShots } from './native-shots';
import { NativeCanonical } from './native-canonical';

const AMMO: readonly MunitionId[] = ['explosive', 'heavy', 'incendiary', 'nuclear'];
const botKit = (kit: KitAssembly): number[] => AMMO.flatMap(id => { const s = munitionStats(kit, id); return [s.radius, s.damage]; });
function armamentKit(k: KitAssembly): number[] {
  const t = pitchTable(kitContextOf(k)), pivot = kitTrunnionPivot(k), s = k.stats;
  const samples = k.pitchLimits === canonicalKit(k.loadout).pitchLimits ? t.min : [];
  return [s.fuel, s.recoil, s.mass, s.minSpeed, s.maxSpeed, ...pivot.axisPoint, pivot.forward, k.weapon.barrelLength,
    t.turretMin, t.turretMax, PITCH_TABLE_STEP, samples.length, ...samples];
}

/** v16 match-owned bot query meter; resident controllers charge it directly. */
export class NativeMeter {
  constructor(private readonly core: RustTerrainCore, private readonly id: number, limit: number) { core.matchCommand(id, 62, [1, limit]); }
  read(): { used: number; limit: number; peak: number } { const w = this.core.matchCommand(this.id, 63); return { used: w[0], limit: w[1], peak: w[2] }; }
  charge(cost: number, unmetered: boolean): boolean { return !!this.core.matchCommand(this.id, 64, [cost, +unmetered])[0]; }
}

export class NativeMatch {
  private id: number;
  private words: Float64Array;
  private combat = false;
  observations?: NativeObservations;
  journal?: NativeJournal;
  motion?: NativeMotion;
  shots?: NativeShots;
  canonical?: NativeCanonical;
  meter?: NativeMeter;
  private readonly kits: KitAssembly[];
  private readonly bots = new Map<number, NativeLegacyBrain | NativeProfileBrain>();
  constructor(private readonly core: RustTerrainCore, private readonly setup: MatchSetup, private readonly state: GameSnapshot, readonly nativeAI = false, readonly nativeProfiles = false, readonly nativeActions = false, readonly nativeObservations = false, readonly nativeJournal = false, readonly nativeMotion = false, readonly nativeBotInputs = false, readonly nativeShots = false, readonly nativeCanonical = false, readonly nativeQueries = false, readonly nativeTick = false, readonly nativeChassisLeg = false, readonly nativeSolverLeg = false, readonly nativeTail = false, readonly nativeTreads = false) {
    this.kits = state.tanks.map(t => assembleKit(tankKit(t)));
    const players = new Set(setup.teams.filter(t => !t.ai).map(t => t.id)), r = setup.rules;
    this.id = core.createMatch([1, +(setup.mode === 'drive'), r.moveSeconds, r.aimSeconds ?? -1, r.maxTurns ?? -1, r.suddenDeathTurn ?? -1, MAX_CHARGE,
      state.tanks.length, ...state.tanks.flatMap(t => [t.team!, +players.has(t.team!), +(t.health > 0)])]);
    this.words = core.matchCommand(this.id, 0); this.publish();
    if (nativeAI) this.call(7, [setup.seed >>> 0]);
  }
  legacyBrain(player = 0): NativeLegacyBrain | undefined {
    if (!this.nativeAI) return undefined;
    const brain = new NativeLegacyBrain(this.core, this.id, this.nativeBotInputs ? player : undefined); this.bots.set(player, brain); return brain;
  }
  profileBrain(profile: W1Profile, difficulty: Difficulty, seed: number, player = 0): NativeProfileBrain | undefined {
    if (!this.nativeProfiles) return undefined;
    const brain = new NativeProfileBrain(this.core, this.id, resolveProfile(profile, difficulty), seed, this.nativeBotInputs ? { unit: player, kit: () => this.kits[player] } : undefined);
    this.bots.set(player, brain); return brain;
  }
  residentBrain(player: number): NativeLegacyBrain | NativeProfileBrain | undefined { return this.nativeBotInputs ? this.bots.get(player) : undefined; }
  random(): number {
    if (!this.id || !this.nativeAI) throw new Error('Resident match random stream is unavailable');
    return this.core.matchCommand(this.id, 8)[0];
  }
  /** Immutable kit data is admitted once; current aim/fuel are output thereafter. */
  admitActions(radius: number): void {
    this.call(9, [1, radius, LAUNCH_SPEED_SCALE, ...AMMO.map(id => MUNITIONS[id].speed), this.state.tanks.length,
      ...this.state.tanks.flatMap(t => [t.turretYaw, t.barrelPitch, t.power, t.munition ? AMMO.indexOf(t.munition) : -1, t.movement, ...armamentKit(assembleKit(tankKit(t)))])]);
    if (this.nativeObservations) this.observations = new NativeObservations(this.core, this.id, this.state, this.setup, radius, () => this.journal ? +this.journal.recording : undefined, () => !!this.motion);
    if (this.nativeJournal) this.journal = new NativeJournal(this.core, this.id, this.state.tanks.map((_, id) => this.setup.mode === 'drive' || brainOf(this.setup, id) === null));
    if (this.nativeMotion) this.motion = new NativeMotion(this.core, this.id, this.state);
    if (this.nativeBotInputs) this.core.matchCommand(this.id, 46, [1, GRAVITY_BALLISTIC * this.setup.rules.gravityScale, ...this.kits.flatMap(botKit)]);
  }
  actionAllowed(kind: 'aim' | 'fire' | 'kit' | 'move', player: number, serial = false, projectiles = 0, pending = 0): boolean {
    if (!Number.isFinite(player)) return false;
    return !!this.core.matchCommand(this.id, 11, [['aim', 'fire', 'kit', 'move'].indexOf(kind), player, +serial, ...(this.shots ? [] : [projectiles]), pending])[0];
  }
  admitShots(core: RustTerrainCore, context: number): void {
    if (core !== this.core) throw new Error('Ballistics belongs to another engine');
    this.shots = new NativeShots(core, this.id, context, this.state, this.kits, !!this.setup.rules.wind);
  }
  admitCanonical(): void { this.canonical = new NativeCanonical(this.core, this.id, this.setup); }
  admitMeter(limit: number): void { this.meter = new NativeMeter(this.core, this.id, limit); }
  admitAction(kind: 'aim' | 'munition' | 'scan' | 'hold' | 'endMove' | 'reposition', player: number, serial: boolean, data: number[] = []): boolean {
    const code = { aim: 0, munition: 2, scan: 3, hold: 4, endMove: 5, reposition: 6 }[kind];
    // A custom kit may implement an arbitrary pure pitchLimits callback. Keep
    // that public contract; shipped canonical kits evaluate their table in Rust.
    const tank = this.state.tanks[player];
    if (kind === 'aim' && tank && data.every(Number.isFinite)) {
      const k = assembleKit(tankKit(tank));
      if (k.pitchLimits !== canonicalKit(k.loadout).pitchLimits) {
        if (!this.actionAllowed('aim', player, serial)) return false;
        const limits = k.pitchLimits(Math.atan2(Math.sin(data[0]), Math.cos(data[0]))); data = [...data, limits.min, limits.max];
      }
    }
    this.call(10, [code, player, +serial, ...data, ...this.actionOrigin()]); return !!this.words[13];
  }
  fireAction(player: number, serial: boolean, pending: number): ProjectileState | null {
    const t = this.state.tanks[player]; if (!t) return null;
    this.call(10, [1, player, +serial, ...(this.shots ? [] : [this.state.projectiles.length]), pending, ...(this.motion ? [] : [...t.position, ...t.rotation, ...t.velocity]), ...this.actionOrigin()]);
    if (!this.words[13]) return null;
    const p = 19 + this.state.tanks.length * 6, w = this.words;
    const shot = this.readProjectile(w, p + 2, w[p], w[p + 1]);
    t.recoil = w[p + 14]; t.velocity = [w[p + 15], w[p + 16], w[p + 17]]; return shot;
  }
  actionMotion(movable: boolean, before: readonly { position: V3; rotation: import('./contracts').Q4 }[]): void {
    this.call(12, this.motion ? [] : [+movable, ...this.state.tanks.flatMap((t, i) => [...before[i].position, ...before[i].rotation, ...t.position, ...t.rotation])]);
  }
  private actionOrigin(): number[] { return this.journal ? [+this.journal.recording] : []; }
  projectile(player: number, candidate?: { yaw: number; pitch: number; power: number; munition?: MunitionId }): ProjectileState {
    return this.readProjectile(this.projectileWords(player, candidate), 0, -1, player);
  }
  socket(player: number, candidate?: { yaw: number; pitch: number; power: number; munition?: MunitionId }): { position: V3; direction: V3 } {
    const w = this.projectileWords(player, candidate); return { position: [w[0], w[1], w[2]], direction: [w[3], w[4], w[5]] };
  }
  private projectileWords(player: number, candidate?: { yaw: number; pitch: number; power: number; munition?: MunitionId }): Float64Array {
    const t = this.state.tanks[player];
    return this.core.matchCommand(this.id, 13, [player, +!!candidate, candidate?.yaw ?? 0, candidate?.pitch ?? 0, candidate?.power ?? 0,
      candidate?.munition ? AMMO.indexOf(candidate.munition) : -1, ...(this.motion ? [] : [...t.position, ...t.rotation])]);
  }
  restoreActions(player: number, changes: Partial<TankState>): void {
    const t = { ...this.state.tanks[player], ...changes };
    this.call(14, [player, t.turretYaw, t.barrelPitch, t.power, t.munition ? AMMO.indexOf(t.munition) : -1, t.movement]);
  }
  setActionKit(tank: TankState): void {
    const kit = assembleKit(tankKit(tank)); this.call(15, [tank.id, ...armamentKit(kit)]); this.observations?.setKit(tank);
    if (this.nativeBotInputs) this.core.matchCommand(this.id, 47, [tank.id, ...botKit(kit)]); this.shots?.setKit(tank.id, kit); this.kits[tank.id] = kit;
  }
  private readProjectile(w: Float64Array, p: number, id: number, owner: number): ProjectileState {
    const position: V3 = [w[p], w[p + 1], w[p + 2]];
    return { id, owner, position, velocity: [w[p + 6], w[p + 7], w[p + 8]], age: 0, munition: AMMO[w[p + 9]],
      launchTick: w[p + 10], origin: [...position], peakAltitude: w[p + 11] };
  }
  get accumulator(): number { return this.words[6]; }
  bindCombat(core: RustTerrainCore, id: number): void {
    if (core !== this.core) throw new Error('Combat belongs to another engine');
    this.call(6, [id]); this.combat = true;
  }
  get moveTime(): number { return this.words[7]; }
  get aimExpired(): boolean { return !!this.words[11]; }
  get canTick(): boolean { return !!this.words[12]; }
  frame(dt: number, discard = false): void { this.call(1, [dt, +discard]); }
  /** v17: the pre-physics part of a fixed tick in one engine call (motion refresh, move permission, journal drive,
   * tick start, wind and a bound controller's drive). Mode 2 inputs are engine-computed; mode 1 leaves the
   * active input to the host; mode 0 drives nothing. */
  tickHead(drive: DriveInput, controller?: NativeLegacyBrain | NativeProfileBrain): { movable: boolean; mode: 0 | 1 | 2; input: DriveInput; wind: Float64Array } {
    if (!this.id) throw new Error('Resident match is disposed');
    const w = this.core.matchCommand(this.id, 65, [drive.throttle, drive.steer, controller ? controller.profile === 'legacy' ? 1 : 2 : 0, controller?.handle ?? 0]);
    const windEnd = 5 + w[4], snapshotEnd = windEnd + 1 + w[windEnd];
    this.words = w.slice(windEnd + 1, snapshotEnd); this.publish(); this.motion!.publishHead(w.subarray(snapshotEnd));
    return { movable: !!w[0], mode: w[1] as 0 | 1 | 2, input: { throttle: w[2], steer: w[3] }, wind: w.slice(5, windEnd) };
  }
  beginTick(): void { this.call(2); }
  /** v20 tick tail: start (full parameters; v21 op 70 adds the tread section) or resume ([stage, blocked, serial]) the post-solver part of a tick. The
   * records are the outputs of the engine operations it ran, in order, for the host to replay. */
  tail(op: 67 | 68 | 70, data: number[]): { status: 0 | 1 | 2 | 3 | 4; records: { tag: number; words: Float64Array }[] } {
    if (!this.id) throw new Error('Resident match is disposed');
    const w = this.core.matchCommand(this.id, op, data), records: { tag: number; words: Float64Array }[] = [];
    for (let i = 0, p = 2; i < w[1]; i++) { records.push({ tag: w[p], words: w.subarray(p + 2, p + 2 + w[p + 1]) }); p += 2 + w[p + 1]; }
    return { status: w[0] as 0 | 1 | 2 | 3 | 4, records };
  }
  /** Publish match words a tick-tail record carries (what the original call published). */
  published(w: Float64Array): void { this.words = w; this.publish(); }
  owns(query: { core: RustTerrainCore }): boolean { return query.core === this.core; }
  action(kind: 'fire' | 'hold' | 'endMove' | 'reposition', player: number): void {
    this.call(3, [{ fire: 0, hold: 1, endMove: 2, reposition: 3 }[kind], player]);
  }
  afterMotion(movable: boolean, brain: boolean, input: DriveInput, before: V3): void {
    this.call(4, [+movable, +brain, input.throttle, input.steer, ...(this.motion ? [] : [...before, ...this.state.tanks[this.state.active].position])]);
  }
  /** Returns a handover/finish event; presentation and extension notifications run
   * after the entire resident transition is published. No event can precede terrain. */
  settle(tempo: (id: number) => number): 'turn' | 'finish' | null {
    this.call(5, [...(this.shots ? [] : [this.state.projectiles.length]), ...this.state.tanks.flatMap(t => this.nativeActions ? [tempo(t.id)] : this.combat ? [t.movement, tempo(t.id)] : [t.health, t.charge, t.movement, tempo(t.id)])]);
    return this.words[13] === 1 ? 'turn' : this.words[13] === 2 ? 'finish' : null;
  }
  dispose(): void { if (this.id) { this.core.disposeMatch(this.id); this.id = 0; this.shots = undefined; } }
  private call(op: number, data: ArrayLike<number> = []): void {
    if (!this.id) throw new Error('Resident match is disposed');
    this.words = this.core.matchCommand(this.id, op, data); this.publish();
  }
  private publish(): void {
    const s = this.state, w = this.words;
    s.tick = w[0]; s.time = w[1]; s.phase = (['aim', 'resolving', 'terrain', 'finished'] as const)[w[2]];
    s.active = w[3]; s.turn = w[4]; s.phaseTime = w[5]; s.winner = w[8] < 0 ? null : w[8];
    if (s.phase === 'finished') s.winnerTeam = w[9] < 0 ? null : w[9];
    if (w[10]) s.suddenDeath = true;
    for (let i = 0; i < s.tanks.length; i++) s.tanks[i].readyAt = w[17 + i];
    if (w[14] >= 0) s.tanks[w[14]].charge = w[15];
    if (w[16]) s.tanks[s.active].movement = 0;
    const start = 19 + s.tanks.length;
    if (this.nativeActions && w.length >= start + s.tanks.length * 5) for (let i = 0; i < s.tanks.length; i++) {
      const t = s.tanks[i], p = start + i * 5;
      t.turretYaw = w[p]; t.barrelPitch = w[p + 1]; t.power = w[p + 2]; t.movement = w[p + 4];
      if (w[p + 3] < 0) delete t.munition; else t.munition = AMMO[w[p + 3]];
    }
  }
}
