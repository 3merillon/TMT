/**
 * Match actions shared by the HUD buttons, the keyboard, the gamepad and drag aiming. Every gameplay action goes
 * through `session().command()` (plan §5.2); camera buttons talk to the view.
 */
import type { PlayerId } from '../contracts';
import type { MunitionId } from '../munitions';
import { session } from '../api/session';
import type { GameView } from '../view';
import { ammoChips, cycleMunition } from './hud-model';
import { canAim, type ContextInput } from './input/contexts';
import { toast } from './toast';
import { weaponOperational } from '../rules/vehicle-damage';

export interface MatchActions {
  aim(yaw: number, pitch: number, power: number): boolean;
  fire(): boolean;
  munition(id: MunitionId): boolean;
  cycleMunition(step: 1 | -1): boolean;
  scan(): boolean;
  endMove(): boolean;
  focusTank(): void;
  overview(): void;
}
export interface MatchActionDeps { view: GameView; context(): ContextInput; changed(): void }

export function createMatchActions(deps: MatchActionDeps): MatchActions {
  const live = () => { const s = session(); return s.snapshot ? s : undefined; };
  const done = (accepted: boolean) => { if (accepted) deps.changed(); return accepted; };
  return {
    aim(yaw, pitch, power) {
      const s = live();
      if (!s || !canAim(deps.context())) return false;
      return done(s.command(s.observer, { k: 'aim', yaw, pitch, power }));
    },
    fire() {
      const s = live(), context = deps.context();
      if (!s || context.screen !== 'match' || !context.ready) return false;
      if (!context.realtime && s.snapshot && !weaponOperational(s.snapshot.tanks[s.observer])) {
        const repaired = s.command(s.observer, { k: 'hold' });
        if (repaired) toast('Crew repaired disabled machinery. Turn spent on repairs.');
        return done(repaired);
      }
      const accepted = s.command(s.observer, { k: 'fire' });
      if (accepted && !context.driveTest && !context.realtime) toast('Shot away. Move into cover before the next turn.');
      return done(accepted);
    },
    munition(id) {
      const s = live();
      if (!s || !canAim(deps.context())) return false;
      const tank = s.snapshot?.tanks[s.observer];
      if (!tank || ammoChips(tank, s.setup?.rules).find(chip => chip.id === id)?.empty) return false;
      return done(s.command(s.observer, { k: 'munition', id }));
    },
    cycleMunition(step) {
      const s = live();
      const tank = s?.snapshot?.tanks[s.observer];
      if (!s || !tank) return false;
      const next = cycleMunition(ammoChips(tank, s.setup?.rules), step);
      return next !== undefined && this.munition(next);
    },
    scan() {
      const s = live(), context = deps.context();
      if (!s || !canAim(context) || context.driveTest) return false;
      const accepted = s.command(s.observer, { k: 'scan' });
      // Realtime scans are quiet when they work (the charge meter is the feedback); a refused one still explains itself.
      if (!accepted || !context.realtime) toast(accepted ? 'Radar report received. Movement can make it stale.' : 'Radar needs more charge.');
      return done(accepted);
    },
    endMove() {
      const s = live();
      return !!s && done(s.command(s.observer, { k: 'endMove' }));
    },
    focusTank() { const s = live(); if (s?.snapshot) deps.view.focus(s.snapshot, s.observer as PlayerId); },
    overview() { const s = live(); if (s?.snapshot) deps.view.focus(s.snapshot, s.observer as PlayerId, true); },
  };
}
