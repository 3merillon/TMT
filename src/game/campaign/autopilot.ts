/** A competent-new-player autopilot for campaign missions: follow the objective marker, shoot what you can see (leading
 * moving targets), lob at marked targets hidden behind cover, dig in when told to, and weave when an incoming ring
 * appears. Tests use it to prove each mission can be completed headless; `?mode=campaign&autopilot=1` runs it in the
 * real game through the same session commands a player sends, so a capture can verify a whole mission on the resident
 * terrain. Never part of normal play. It aims only when the gun is loaded (each aim solve is a set of ballistic traces). */
import type { DriveInput, GameEvent, GameSnapshot, V3 } from '../contracts';
import type { AimSelection, AimTargetAim, AimTargetResult } from '../rules/aim-target';
import { add, distance, frame, mul, normalize, rotate, sub } from '../math';
import { steerToward } from '../realtime/brains';
import { activeComponents, componentPoint } from '../realtime/components';
import { weaponOperational } from '../rules/vehicle-damage';

export interface AutopilotView {
  state: GameSnapshot;
  observer: number;
  beat: string | null;
  marker: V3 | null;
  canFire: boolean;
  /** Events since the previous decision. */
  events: readonly GameEvent[];
  solve(selection: V3 | AimSelection): AimTargetResult;
}
export interface AutopilotOrder { drive: DriveInput; aim?: AimTargetAim; fire: boolean; repair?: boolean; headlights?: boolean }

/** Rough shell speed for leading a target (u/s): flight time ≈ range / this. */
const LEAD_SPEED = 11;

export class Autopilot {
  private dodgeUntil = -1;
  /** The last aim at the current target was blocked or out of reach: keep closing in until the next solve. */
  private closeIn = false;
  /** Where each target was seen last (tick, position): its velocity is judged from what is seen, as a player would. */
  private readonly seen = new Map<number, { tick: number; position: V3; velocity: V3 }>();
  private observedVelocity(id: number, position: V3, tick: number): V3 {
    const last = this.seen.get(id);
    let velocity: V3 = [0, 0, 0];
    if (last && tick > last.tick) {
      const dt = (tick - last.tick) / 60, raw = mul(sub(position, last.position), 1 / dt);
      // Smoothed; a target that barely moves is treated as still.
      velocity = add(mul(last.velocity, 0.7), mul(raw, 0.3));
      if (Math.hypot(...velocity) < 0.4) velocity = [0, 0, 0];
    } else if (last) velocity = last.velocity;
    this.seen.set(id, { tick, position: [...position], velocity });
    return velocity;
  }
  decide(v: AutopilotView): AutopilotOrder {
    const { state, observer } = v, me = state.tanks[observer];
    if (!me || me.health <= 0) return { drive: { throttle: 0, steer: 0 }, fire: false };
    if (v.events.some(e => e.type === 'incoming' && e.tank === observer)) this.dodgeUntil = state.tick + 90;
    const disabled = me.machinery && [me.machinery.engine, me.machinery.weapon, me.machinery.leftTrack, me.machinery.rightTrack].some(h => h < .4);
    const order: AutopilotOrder = { drive: { throttle: 0, steer: 0 }, fire: false, repair: (me.health < (me.maxHealth ?? 1) * .65 || !!disabled) && me.charge >= 1 };
    if (v.beat === 'whiteout') order.headlights = false;
    const shoot = (selection: V3 | AimSelection, needReady: boolean) => {
      const result = v.solve(selection);
      if (result.aim) { order.aim = result.aim; order.fire = needReady ? result.status === 'ready' : result.status !== 'invalid'; }
      return result;
    };
    // The nearest enemy the Kestrel sees (or a marked one), within gun range.
    const defending = v.beat === 'relay' || v.beat === 'launch-defence' || v.beat === 'message';
    // Alone at Lantern Hill, remove artillery before it excavates the relay.
    // At the fleet defence our allied guns cover artillery; keep swarms off our own hull.
    const soloDefence = v.beat === 'relay';
    const relay = soloDefence ? state.tanks.find(t => t.name === 'Lantern relay' && t.health > 0) : undefined;
    const priority = (t: typeof me) => distance(t.position, relay?.position ?? me.position)
      - (soloDefence && t.name === 'Tosser' && weaponOperational(t) ? 20 : 0) + (!weaponOperational(t) ? 30 : 0);
    const enemies = state.tanks.filter(t => t.team !== me.team && t.health > 0 && !(v.beat === 'whiteout' && t.visualKind === 'watchtower') && state.observations?.[observer]?.[t.id]?.visible && distance(t.position, me.position) < 24)
      .sort((a, b) => priority(a) - priority(b));
    const boss = v.beat === 'crawler' ? state.tanks.find(t => t.components && t.health > 0 && state.observations?.[observer]?.[t.id]?.visible) : undefined;
    if (boss) {
      const component = activeComponents(boss).sort((a, b) => distance(componentPoint(boss, a), me.position) - distance(componentPoint(boss, b), me.position))[0];
      if (component) {
        const point = componentPoint(boss, component), up = normalize(boss.position), local = sub(point, boss.position);
        const radial = local[0] * up[0] + local[1] * up[1] + local[2] * up[2];
        const outside = normalize(sub(local, mul(up, radial))), goal = add(boss.position, mul(outside, 8));
        if (distance(me.position, goal) > 1.3) order.drive = steerToward(me, goal, false, rotate);
        const range = distance(me.position, point);
        if (v.canFire && range < 20) {
          const velocity = this.observedVelocity(boss.id, boss.position, state.tick), center = add(point, mul(velocity, range / LEAD_SPEED));
          shoot({ point: center, object: { id: `component:${boss.id}:${component.id}`, kind: 'tank', collider: { shape: 'sphere', center, radius: component.radius } } }, true);
        }
      }
    } else if (v.beat?.startsWith('undermine-') && v.marker) {
      const range = distance(me.position, v.marker);
      if (range > 12) order.drive = steerToward(me, v.marker, false, rotate);
      else if (range < 6) order.drive = steerToward(me, v.marker, true, rotate);
      if (v.canFire && range < 18) shoot(v.marker, false);
    } else if (v.beat === 'dig-in') {
      if (v.canFire) shoot(add(me.position, rotate([0, -0.4, 3], me.rotation)), false);
    } else if (enemies[0]) {
      const target = enemies[0], range = distance(target.position, me.position), velocity = this.observedVelocity(target.id, target.position, state.tick);
      if (v.canFire) {
        // Lead: aim where the target will be after the shell's flight.
        const center = add(target.position, mul(velocity, range / LEAD_SPEED));
        const result = shoot({ point: center, object: { id: `tank:${target.id}`, kind: 'tank', collider: { shape: 'sphere', center, radius: 0.7 } } }, true);
        this.closeIn = result.status !== 'ready';
      }
      if (range < 5 && !target.name?.includes("target")) { order.fire = false; order.drive = steerToward(me, target.position, true, rotate); }
      else if (this.closeIn || range > 16) order.drive = steerToward(me, target.position, false, rotate);
    } else if (v.marker) {
      // A marked enemy out of sight (behind a wall or the curve): shell the marker from range instead of driving into it.
      const hidden = state.tanks.some(t => t.team !== me.team && t.health > 0 && distance(t.position, v.marker!) < 2);
      const range = distance(me.position, v.marker);
      if (hidden && range < 18) {
        if (v.canFire) shoot(v.marker, false);
        if (range < 6) order.drive = steerToward(me, v.marker, true, rotate);
      } else order.drive = steerToward(me, v.marker, false, rotate);
    } else {
      // A disabled enemy may no longer chase us over the horizon. Search its last observed position.
      const known = state.tanks.filter(t => t.team !== me.team && t.health > 0)
        .map(t => state.observations?.[observer]?.[t.id]?.position).filter((p): p is V3 => !!p)
        .sort((a, b) => distance(a, me.position) - distance(b, me.position));
      if (known[0]) order.drive = steerToward(me, known[0], false, rotate);
    }
    if (defending && v.marker) {
      // Patrol the repair perimeter instead of camping one continuously deepening crater.
      // The mission refreshes the marker's height after terrain commits.
      const axes = frame(normalize(v.marker), 0), angle = state.time * .32;
      const offset = add(mul(axes.right, Math.cos(angle) * 2.5), mul(axes.forward, Math.sin(angle) * 2.5));
      const goal = mul(normalize(add(v.marker, offset)), Math.hypot(...v.marker));
      order.drive = steerToward(me, goal, false, rotate);
    }
    // The moving defence patrol already evades impacts. A blind dodge would abandon the service pad,
    // especially after one belt loses torque, and leave the relay without its promised repair support.
    if (state.tick < this.dodgeUntil && !defending) order.drive = { throttle: 1, steer: 0.6 };
    return order;
  }
}
