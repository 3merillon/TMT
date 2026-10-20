/**
 * Combines the keyboard, the gamepad and the on-screen joystick into session commands. Held input is integrated
 * once per animation frame: aim rates become one `aim` command, and `driveInput()` gives the frame loop the drive
 * axes (the loop sends the `drive` command). Presses dispatch immediately. The joystick is a virtual gamepad left
 * stick (`stickFrame`), so touch produces exactly the drive axes and aim rates a gamepad would.
 */
import type { DriveInput } from '../../contracts';
import { assembleKit, tankKit } from '../../kit';
import type { MatchActions } from '../actions';
import { addRates, combineDrive, driveFromHeld, heldActions, idleRates, ratesFromHeld, stepAim, WEAPON_MUNITIONS, type DriveAxes, type PressAction } from './bindings';
import { canAim, canDrive, inputContext, type ContextInput } from './contexts';
import { padFrame, readGamepad, type PadSnapshot } from './gamepad';
import { cameraDrive, type DriveFrame } from './camera-drive';
import { stickFrame } from './joystick';
import { bindKeyboard, KeyState } from './keyboard';
import { rangeAdjustedPower } from './range-power';
import type { KeyboardBindings } from './bindings';

export interface InputControllerDeps {
  keyBindings?(): KeyboardBindings;
  context(): ContextInput;
  actions: MatchActions;
  pitch: { min: number; max: number };
  /** Presses that belong to the flow: pause, back, confirm, menu focus. */
  navigate(action: PressAction): void;
  /** World target picking and turret movement advance every frame. */
  pointerFrame?(now: number): void;
  beforeFire?(): void;
  nextTarget?(): void;
  /** How the joystick and the keyboard/gamepad drive ('camera' = point where you want to go). Default: tank for both. */
  driveSchemes?(): { touch: 'tank' | 'camera'; keys: 'tank' | 'camera' };
  /** The hull, local up and camera right for camera-relative driving; null when unavailable. */
  driveFrame?(): DriveFrame | null;
}

const ZERO_DRIVE: DriveAxes = { throttle: 0, steer: 0 };

export class InputController {
  readonly keys = new KeyState();
  private stick: readonly [number, number] | null = null;
  private padPrevious?: PadSnapshot;
  private padDrive: DriveAxes = ZERO_DRIVE;
  private stickDrive: DriveAxes = ZERO_DRIVE;
  /** Camera-relative reverse hysteresis, per source. */
  private stickReversing = false;
  private keysReversing = false;
  private last = 0;
  private frameId = 0;
  private unbind?: () => void;

  constructor(private readonly deps: InputControllerDeps) {}

  start(): void {
    this.unbind = bindKeyboard(window, { keys: this.keys, context: () => inputContext(this.deps.context()), bindings: this.deps.keyBindings, onPress: action => this.press(action) });
    const pump = (now: number) => { this.frame(now); this.frameId = requestAnimationFrame(pump); };
    this.frameId = requestAnimationFrame(pump);
  }
  stop(): void { cancelAnimationFrame(this.frameId); this.unbind?.(); this.clear(); }

  /** Releases every held key and the joystick (turn changes, pause, blur). */
  clear(): void { this.keys.clear(); this.stick = null; this.padDrive = this.stickDrive = ZERO_DRIVE; this.stickReversing = this.keysReversing = false; this.onClear?.(); }
  /** Called after `clear()`: the on-screen joystick drops its knob. */
  onClear?: () => void;
  /** The on-screen joystick in gamepad axis convention (x right, y down, unit disc). */
  setStick(x: number, y: number): void { this.stick = Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null; }
  releaseStick(): void { this.stick = null; this.stickDrive = ZERO_DRIVE; }

  /** Relative mouse aim changes turret angles while preserving the selected launch power. */
  adjustAim(yaw: number, pitch: number): boolean {
    const context = this.deps.context(), tank = context.snapshot?.tanks[context.observer];
    if (!canAim(context) || !tank || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return false;
    if (yaw === 0 && pitch === 0) return true;
    const next = stepAim({ yaw: tank.turretYaw, pitch: tank.barrelPitch, power: tank.power }, { yaw, pitch, power: 0 }, 1, this.deps.pitch);
    return this.deps.actions.aim(next.yaw, next.pitch, next.power);
  }

  /** Held-button wheel aiming scales approximate distance; a clamped gesture never falls through to camera zoom. */
  adjustRange(scale: number): boolean {
    const context = this.deps.context(), tank = context.snapshot?.tanks[context.observer];
    if (!canAim(context) || !tank || !Number.isFinite(scale) || scale <= 0) return false;
    const power = rangeAdjustedPower(assembleKit(tankKit(tank)), tank.power, scale, tank.munition);
    if (power !== tank.power) this.deps.actions.aim(tank.turretYaw, tank.barrelPitch, power);
    return true;
  }

  /** The drive axes for this frame; zero whenever the session would not accept driving. */
  driveInput(): DriveInput {
    const context = this.deps.context();
    if (!canDrive(context)) return { throttle: 0, steer: 0 };
    const schemes = this.deps.driveSchemes?.() ?? { touch: 'tank', keys: 'tank' };
    let keys = combineDrive(driveFromHeld(heldActions(inputContext(context), this.keys.codes, this.deps.keyBindings?.())), this.padDrive), stick = this.stickDrive;
    const frame = schemes.touch === 'camera' || schemes.keys === 'camera' ? this.deps.driveFrame?.() ?? null : null;
    // Camera-relative sources are read as screen vectors (x = steer, up = throttle) and turned into hull axes.
    if (frame && schemes.keys === 'camera') { const r = cameraDrive(keys, frame, this.keysReversing); keys = r.drive; this.keysReversing = r.reversing; }
    if (frame && schemes.touch === 'camera') { const r = cameraDrive(stick, frame, this.stickReversing); stick = r.drive; this.stickReversing = r.reversing; }
    return combineDrive(keys, stick);
  }

  press(action: PressAction): void {
    const { actions } = this.deps;
    switch (action) {
      case 'fire': this.deps.beforeFire?.(); actions.fire(); break;
      case 'nextTarget': if (canAim(this.deps.context())) this.deps.nextTarget?.(); break;
      case 'weapon1': case 'weapon2': case 'weapon3': case 'weapon4':
        if (canAim(this.deps.context())) actions.munition(WEAPON_MUNITIONS[action]);
        break;
      case 'nextMunition': actions.cycleMunition(1); break;
      case 'prevMunition': actions.cycleMunition(-1); break;
      case 'scan': actions.scan(); break;
      case 'endMove': if (actions.endMove()) this.clear(); break;
      case 'focusTank': actions.focusTank(); break;
      case 'overview': actions.overview(); break;
      default: this.deps.navigate(action);
    }
  }

  private frame(now: number): void {
    this.deps.pointerFrame?.(now);
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    const context = this.deps.context(), mode = inputContext(context);
    const pad = readGamepad();
    const padded = pad ? padFrame(mode, pad, this.padPrevious) : undefined;
    this.padPrevious = pad;
    this.padDrive = padded?.drive ?? ZERO_DRIVE;
    const stick = this.stick ? stickFrame(mode, this.stick[0], this.stick[1]) : undefined;
    this.stickDrive = stick?.drive ?? ZERO_DRIVE;
    for (const action of padded?.presses ?? []) this.press(action);
    if (!dt || !canAim(context)) return;
    const idle = { yaw: 0, pitch: 0, power: 0 };
    const rates = addRates(ratesFromHeld(heldActions(mode, this.keys.codes, this.deps.keyBindings?.())), padded?.rates ?? idle, stick?.rates ?? idle);
    const tank = context.snapshot?.tanks[context.observer];
    if (idleRates(rates) || !tank) return;
    const next = stepAim({ yaw: tank.turretYaw, pitch: tank.barrelPitch, power: tank.power }, rates, dt, this.deps.pitch);
    this.deps.actions.aim(next.yaw, next.pitch, next.power);
  }
}
