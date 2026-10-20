/** Session-only workshop experiments: no ownership, currency, rank or profile writes. */
import type { KitLoadoutIds } from '../api/match';
import { equippedAppearance, type TankAppearance } from '../meta/cosmetics';
import { activeKit, browserStorage, readProgress, type ProgressProfile } from '../meta/profile';
export const workshopSandbox: { active: boolean; testing: boolean; kit: KitLoadoutIds | null; appearance: TankAppearance | null } = { active: false, testing: false, kit: null, appearance: null };
export function enableWorkshopSandbox(profile: ProgressProfile): void {
  workshopSandbox.active = true; workshopSandbox.kit = activeKit(profile); workshopSandbox.appearance = equippedAppearance(profile.cosmetics);
}
export function disableWorkshopSandbox(): void { workshopSandbox.active = false; workshopSandbox.testing = false; workshopSandbox.kit = null; workshopSandbox.appearance = null; }
/** Read at vehicle creation / appearance refresh; state is deliberately outside the match simulation. */
export function currentVehicleAppearance(): TankAppearance {
  return workshopSandbox.active && workshopSandbox.testing && workshopSandbox.appearance ? structuredClone(workshopSandbox.appearance) : equippedAppearance(readProgress(browserStorage()).cosmetics);
}
