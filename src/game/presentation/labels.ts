/**
 * DOM tank labels for a dynamic list of N tanks, positioned with the engine's projection (`engine.project`, CSS px) of
 * the SAME frame that was just drawn (the facade updates them right after engine.frame), so a label sits within a pixel
 * of `view.worldToScreen(anchor)`. The anchor is 1.3 u above the tank's RENDERED position (the interpolated pose its mesh
 * is drawn at) along the local radial up; the label's bottom centre is placed on it (translate(-50%, -100%)), as before
 * the takeover.
 *
 * Each record also carries `ref`: the anchor projected by an independent model of the same camera (the facade's
 * math-only PerspectiveCamera), so the capture checks cross-validate engine.project instead of only the DOM placement.
 */
import type { GameSnapshot, TankState, V3 } from '../contracts';
import { vehicleDamageLabel } from '../rules/vehicle-damage';
import { setHidden, setStyle } from './dom-writes';
import { currentSettings } from '../meta/settings';
import { filterProfanity } from '../online/profanity';

export const LABEL_LIFT = 1.3;

export interface LabelRecord {
  tank: number; text: string; anchor: V3; x: number; y: number; hidden: boolean;
  /** Independent projection of `anchor` (CSS px), when the facade could compute one. */
  ref: [number, number] | null;
}

export interface LabelOptions {
  /** World position the label follows (default: the snapshot position). */
  positionOf?: (tank: TankState) => V3;
  /** True for the observer's team mates (labelled ALLY, drawn in the friendly style). */
  allyOf?: (tank: TankState) => boolean;
  /** Independent projection for the telemetry cross-check (CSS px, null when off screen or unavailable). */
  reference?: (p: V3) => [number, number] | null;
}

export class TankLabels {
  private readonly labels = new Map<number, HTMLElement>();
  private readonly records = new Map<number, LabelRecord>();

  constructor(private readonly host: HTMLElement) {}

  static anchor(tank: Pick<TankState, 'position'>): V3 {
    const p = tank.position, l = Math.hypot(p[0], p[1], p[2]) || 1;
    return [p[0] + p[0] / l * LABEL_LIFT, p[1] + p[1] / l * LABEL_LIFT, p[2] + p[2] / l * LABEL_LIFT];
  }

  /** Update every label; `project` returns CSS px or null when off screen; `visible(tank)` is the observation rule. */
  update(state: GameSnapshot, observer: number, visible: (t: TankState) => boolean, project: (p: V3) => [number, number] | null, options: LabelOptions = {}): void {
    const live = new Set<number>();
    for (const tank of state.tanks) {
      if (tank.retired) continue;
      live.add(tank.id);
      let el = this.labels.get(tank.id);
      if (!el) {
        el = document.createElement('div');
        el.dataset.tank = String(tank.id);
        this.host.append(el);
        this.labels.set(tank.id, el);
      }
      const own = tank.id === observer;
      const ally = !own && (options.allyOf?.(tank) ?? false);
      const health = tank.health / Math.max(1, tank.maxHealth ?? tank.health), dead = tank.health <= 0;
      const cls = `world-label${own ? '' : ally ? ' ally' : ' enemy'}${dead ? ' wreck' : health <= .25 ? ' critical damaged' : health < 1 ? ' damaged' : ''}`;
      if (el.className !== cls) el.className = cls;
      const fault = vehicleDamageLabel(tank);
      const name = tank.name && filterProfanity(tank.name, currentSettings().gameplay.profanityFilter);
      const text = dead ? 'WRECK' : fault ? `${own ? 'YOU' : name ?? 'CONTACT'} · ${fault}` : health <= .25 ? `${own ? 'YOU' : name ?? (ally ? 'ALLY' : 'CONTACT')} · CRITICAL` : own ? 'YOU' : ally ? 'ALLY' : 'CONTACT';
      if (el.textContent !== text) el.textContent = text;
      el.style.setProperty('--hull', `${Math.round(health * 100)}%`);
      el.setAttribute('aria-label', `${name ?? text}: ${dead ? 'destroyed' : `${Math.ceil(tank.health)} hull remaining`}`);
      const anchor = TankLabels.anchor({ position: options.positionOf?.(tank) ?? tank.position });
      const screen = visible(tank) ? project(anchor) : null;
      setHidden(el, !screen);
      if (screen) setStyle(el, 'transform', `translate(${screen[0]}px,${screen[1]}px) translate(-50%,-100%)`);
      const ref = screen ? options.reference?.(anchor) ?? null : null;
      this.records.set(tank.id, { tank: tank.id, text, anchor, x: screen?.[0] ?? NaN, y: screen?.[1] ?? NaN, hidden: !screen, ref });
    }
    for (const [id, el] of this.labels) if (!live.has(id)) { el.remove(); this.labels.delete(id); this.records.delete(id); }
  }

  /** The last placement of every label (telemetry: the capture checks labels against worldToScreen). */
  snapshot(): LabelRecord[] { return [...this.records.values()]; }

  hideAll(): void { for (const el of this.labels.values()) setHidden(el, true); }

  clear(): void {
    for (const el of this.labels.values()) el.remove();
    this.labels.clear(); this.records.clear();
  }
}
