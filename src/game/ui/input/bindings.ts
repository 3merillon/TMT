/**
 * Input bindings per context (pure). Keyboard codes are `KeyboardEvent.code`; gamepad buttons use the
 * standard mapping. Held actions are integrated every frame (aim rates, driving); press actions fire once.
 *
 *   aim:   Q/E, A/D or ←/→ bearing, W/S or ↑/↓ elevation, Tab target, 1–4 weapons, Space fire, R radar
 *   drive: W/A/S/D drive, Q/E or ←/→ bearing, ↑/↓ elevation (the drive test aims while moving), Space fire, Enter hold position
 *   watch: the opponent's turn; only pause and the camera
 *   menu:  Escape back, Enter confirm (native focus handles the rest)
 */
export type InputContext = 'menu' | 'aim' | 'drive' | 'watch';
export type HeldAction =
  | 'bearingLeft' | 'bearingRight' | 'elevationUp' | 'elevationDown' | 'powerDown' | 'powerUp'
  | 'driveForward' | 'driveBack' | 'driveLeft' | 'driveRight';
export type PressAction =
  | 'fire' | 'nextTarget' | WeaponAction | 'nextMunition' | 'prevMunition' | 'scan' | 'endMove' | 'pause' | 'back' | 'confirm' | 'focusTank' | 'overview' | 'navUp' | 'navDown';
export type WeaponAction = 'weapon1' | 'weapon2' | 'weapon3' | 'weapon4';
export const WEAPON_MUNITIONS = { weapon1: 'explosive', weapon2: 'heavy', weapon3: 'incendiary', weapon4: 'nuclear' } as const;

export interface AimState { yaw: number; pitch: number; power: number }
/** Radians per second for yaw and pitch, fraction per second for power. */
export interface AimRates { yaw: number; pitch: number; power: number }
export interface DriveAxes { throttle: number; steer: number }

const AIM_HELD: Readonly<Record<string, HeldAction>> = {
  KeyA: 'bearingLeft', ArrowLeft: 'bearingLeft', KeyD: 'bearingRight', ArrowRight: 'bearingRight',
  KeyW: 'elevationUp', ArrowUp: 'elevationUp', KeyS: 'elevationDown', ArrowDown: 'elevationDown',
  KeyQ: 'bearingLeft', KeyE: 'bearingRight',
};
const DRIVE_HELD: Readonly<Record<string, HeldAction>> = {
  KeyW: 'driveForward', KeyS: 'driveBack', KeyA: 'driveLeft', KeyD: 'driveRight',
  ArrowLeft: 'bearingLeft', ArrowRight: 'bearingRight', ArrowUp: 'elevationUp', ArrowDown: 'elevationDown',
  KeyQ: 'bearingLeft', KeyE: 'bearingRight',
};
const MATCH_PRESS: Readonly<Record<string, PressAction>> = { Escape: 'pause', KeyP: 'pause', KeyF: 'focusTank', KeyO: 'overview' };
const WEAPON_KEYS: Readonly<Record<string, PressAction>> = { Tab: 'nextTarget', Digit1: 'weapon1', Digit2: 'weapon2', Digit3: 'weapon3', Digit4: 'weapon4' };

export const KEY_BINDINGS: Readonly<Record<InputContext, { held: Readonly<Record<string, HeldAction>>; press: Readonly<Record<string, PressAction>> }>> = Object.freeze({
  aim: { held: AIM_HELD, press: { ...MATCH_PRESS, ...WEAPON_KEYS, Space: 'fire', KeyR: 'scan' } },
  drive: { held: DRIVE_HELD, press: { ...MATCH_PRESS, ...WEAPON_KEYS, Space: 'fire', Enter: 'endMove', NumpadEnter: 'endMove' } },
  watch: { held: {}, press: MATCH_PRESS },
  menu: { held: {}, press: { Escape: 'back', Enter: 'confirm', NumpadEnter: 'confirm' } },
});

export type BindingContext = Exclude<InputContext, 'menu'>;
export type BindableAction = HeldAction | Exclude<PressAction, 'back' | 'confirm' | 'navUp' | 'navDown'>;
export type KeyboardBindings = Record<BindingContext, Partial<Record<BindableAction, string[]>>>;
export const BINDING_CONTEXTS: readonly BindingContext[] = ['drive', 'aim', 'watch'];
export const ACTION_LABELS: Record<BindableAction, string> = {
  driveForward: 'Drive forward', driveBack: 'Reverse', driveLeft: 'Steer left', driveRight: 'Steer right',
  bearingLeft: 'Aim left', bearingRight: 'Aim right', elevationUp: 'Raise barrel', elevationDown: 'Lower barrel',
  powerUp: 'Increase power', powerDown: 'Decrease power', fire: 'Fire', nextMunition: 'Next munition',
  prevMunition: 'Previous munition', scan: 'Radar scan', endMove: 'Hold position', pause: 'Pause',
  focusTank: 'Focus tank', overview: 'Overview',
  nextTarget: 'Cycle visible targets', weapon1: 'Weapon 1 · High explosive', weapon2: 'Weapon 2 · Heavy demolition',
  weapon3: 'Weapon 3 · Incendiary', weapon4: 'Weapon 4 · Nuclear',
};
const HELD_ACTIONS = new Set<string>(['driveForward', 'driveBack', 'driveLeft', 'driveRight', 'bearingLeft', 'bearingRight', 'elevationUp', 'elevationDown', 'powerUp', 'powerDown']);
const MATCH_ACTIONS: BindableAction[] = ['pause', 'focusTank', 'overview'];
export function bindingActions(context: BindingContext): BindableAction[] {
  return context === 'watch' ? [...MATCH_ACTIONS] : [
    ...(context === 'drive' ? ['driveForward', 'driveBack', 'driveLeft', 'driveRight'] as const : []),
    'bearingLeft', 'bearingRight', 'elevationUp', 'elevationDown', 'powerUp', 'powerDown',
    'fire', 'nextTarget', 'weapon1', 'weapon2', 'weapon3', 'weapon4', 'nextMunition', 'prevMunition', context === 'aim' ? 'scan' : 'endMove', ...MATCH_ACTIONS,
  ];
}
/** Escape always pauses/goes back. It cannot be displaced by an imported binding. */
export function validBindingCode(code: unknown): code is string {
  return typeof code === 'string' && /^(Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|Arrow(?:Up|Down|Left|Right)|Space|Tab|Enter|Backspace|Home|End|PageUp|PageDown|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote|ShiftLeft|ShiftRight)$/.test(code);
}
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return ({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space',
    BracketLeft: '[', BracketRight: ']', Minus: '−', Equal: '=', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    Backslash: '\\', Backquote: '`', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift' } as Record<string, string>)[code] ?? code.replace('Numpad', 'Num ');
}
export function defaultKeyBindings(): KeyboardBindings {
  const result = {} as KeyboardBindings;
  for (const context of BINDING_CONTEXTS) {
    const table = { ...KEY_BINDINGS[context].held, ...KEY_BINDINGS[context].press };
    result[context] = Object.fromEntries(bindingActions(context).map(action => [action,
      Object.entries(table).filter(([code, value]) => value === action && code !== 'Escape').map(([code]) => code)]));
  }
  return result;
}
export function sanitizeKeyBindings(value: unknown): KeyboardBindings {
  const defaults = defaultKeyBindings(), result = defaultKeyBindings();
  const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const source = record(value);
  for (const context of BINDING_CONTEXTS) {
    const saved = { ...record(Object.hasOwn(source, context) ? source[context] : undefined) }, used = new Set<string>();
    // Upgrade the old default Tab-to-munition binding, preserving deliberate remaps and cleared slots.
    if (!Object.hasOwn(saved, 'nextTarget') && Array.isArray(saved.nextMunition) && saved.nextMunition.length === 1 && saved.nextMunition[0] === 'Tab') saved.nextMunition = [];
    // Explicit bindings win over default keys when an older/partial profile is imported.
    const actions = bindingActions(context).sort((a, b) => Number(Array.isArray(saved[b])) - Number(Array.isArray(saved[a])));
    for (const action of actions) {
      const codes = Object.hasOwn(saved, action) && Array.isArray(saved[action]) ? saved[action] as unknown[] : defaults[context][action]!;
      const accepted: string[] = [];
      for (const code of codes) {
        if (!validBindingCode(code) || used.has(code)) continue;
        used.add(code); accepted.push(code);
        if (accepted.length === 3) break;
      }
      result[context][action] = accepted;
    }
  }
  return result;
}
/** Reassign within one mode. A conflicting key swaps with this slot's previous key. */
export function rebindKey(bindings: KeyboardBindings, context: BindingContext, action: BindableAction, slot: number, code?: string): KeyboardBindings {
  const result = sanitizeKeyBindings(bindings), keys = result[context][action];
  if (!keys || slot < 0 || slot > keys.length || slot > 2 || (code !== undefined && !validBindingCode(code))) return result;
  const old = keys[slot];
  if (old === code) return result;
  if (code) for (const other of bindingActions(context)) {
    const list = result[context][other]!, index = list.indexOf(code);
    if (index >= 0) { if (old) list[index] = old; else list.splice(index, 1); }
  }
  if (code) keys[slot] = code; else keys.splice(slot, 1);
  return sanitizeKeyBindings(result);
}
function customAction(context: InputContext, code: string, bindings?: KeyboardBindings): BindableAction | undefined {
  if (context === 'menu' || !bindings || code === 'Escape') return undefined;
  return bindingActions(context).find(action => bindings[context][action]?.includes(code));
}

/** Standard-mapping gamepad button indices. */
export const PAD = Object.freeze({ A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 });
const PAD_MATCH: Readonly<Record<number, PressAction>> = { [PAD.START]: 'pause', [PAD.RS]: 'focusTank', [PAD.BACK]: 'overview' };
export const PAD_PRESS: Readonly<Record<InputContext, Readonly<Record<number, PressAction>>>> = Object.freeze({
  aim: { ...PAD_MATCH, [PAD.A]: 'fire', [PAD.X]: 'prevMunition', [PAD.Y]: 'nextMunition', [PAD.B]: 'scan' },
  drive: { ...PAD_MATCH, [PAD.A]: 'fire', [PAD.X]: 'prevMunition', [PAD.Y]: 'nextMunition', [PAD.B]: 'endMove' },
  watch: PAD_MATCH,
  menu: { [PAD.A]: 'confirm', [PAD.B]: 'back', [PAD.START]: 'back', [PAD.UP]: 'navUp', [PAD.DOWN]: 'navDown' },
});

/** On-screen thumb buttons → the press actions the keyboard and gamepad send (Space, Enter, Tab, R, Escape). */
export const TOUCH_PRESS = Object.freeze({ fire: 'fire', hold: 'endMove', target: 'nextTarget', munition: 'nextMunition', scan: 'scan', pause: 'pause' } as const satisfies Record<string, PressAction>);
export type TouchButton = keyof typeof TOUCH_PRESS;

export const AIM_SPEED = Object.freeze({ yaw: 50 * Math.PI / 180, pitch: 25 * Math.PI / 180, power: 0.35 });

export function heldActions(context: InputContext, codes: Iterable<string>, bindings?: KeyboardBindings): Set<HeldAction> {
  const table = KEY_BINDINGS[context].held, out = new Set<HeldAction>();
  for (const code of codes) {
    const action = bindings && context !== 'menu' ? customAction(context, code, bindings) : table[code];
    if (action && HELD_ACTIONS.has(action)) out.add(action as HeldAction);
  }
  return out;
}
export function pressAction(context: InputContext, code: string, bindings?: KeyboardBindings): PressAction | undefined {
  if (bindings && context !== 'menu' && code !== 'Escape') {
    const action = customAction(context, code, bindings);
    return action && !HELD_ACTIONS.has(action) ? action as PressAction : undefined;
  }
  const table = KEY_BINDINGS[context].press;
  return Object.hasOwn(table, code) ? table[code] : undefined;
}
/** Every context a code is bound in (the keyboard layer uses it to decide whether to swallow a key). */
export function isBound(context: InputContext, code: string, bindings?: KeyboardBindings): boolean {
  if (bindings && context !== 'menu') return code === 'Escape' || !!customAction(context, code, bindings);
  return Object.hasOwn(KEY_BINDINGS[context].held, code) || Object.hasOwn(KEY_BINDINGS[context].press, code);
}

/** Held keys → aim rates. Positive yaw turns the turret to the driver's left (turretYaw convention). */
export function ratesFromHeld(held: ReadonlySet<HeldAction>): AimRates {
  const axis = (plus: HeldAction, minus: HeldAction) => Number(held.has(plus)) - Number(held.has(minus));
  return {
    yaw: axis('bearingLeft', 'bearingRight') * AIM_SPEED.yaw,
    pitch: axis('elevationUp', 'elevationDown') * AIM_SPEED.pitch,
    power: axis('powerUp', 'powerDown') * AIM_SPEED.power,
  };
}
export function driveFromHeld(held: ReadonlySet<HeldAction>): DriveAxes {
  return { throttle: Number(held.has('driveForward')) - Number(held.has('driveBack')), steer: Number(held.has('driveRight')) - Number(held.has('driveLeft')) };
}
export function addRates(...rates: AimRates[]): AimRates {
  return rates.reduce((sum, r) => ({ yaw: sum.yaw + r.yaw, pitch: sum.pitch + r.pitch, power: sum.power + r.power }), { yaw: 0, pitch: 0, power: 0 });
}
export function combineDrive(...inputs: DriveAxes[]): DriveAxes {
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  return inputs.reduce((sum, d) => ({ throttle: clamp(sum.throttle + d.throttle), steer: clamp(sum.steer + d.steer) }), { throttle: 0, steer: 0 });
}
export const idleRates = (r: AimRates): boolean => r.yaw === 0 && r.pitch === 0 && r.power === 0;

/** One frame of rate aiming: yaw wraps to (-π, π], pitch and power clamp. */
export function stepAim(aim: AimState, rates: AimRates, dt: number, pitch: { min: number; max: number }): AimState {
  const yaw = aim.yaw + rates.yaw * dt;
  return {
    yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)),
    pitch: Math.max(pitch.min, Math.min(pitch.max, aim.pitch + rates.pitch * dt)),
    power: Math.max(0, Math.min(1, aim.power + rates.power * dt)),
  };
}
