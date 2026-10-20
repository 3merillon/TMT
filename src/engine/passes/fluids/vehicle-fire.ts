/** A sustained source in the existing volumetric solver. Position is the damaged machinery, in world space. */
export interface VehicleFireSource {
  key: string;
  position: readonly number[];
  intensity: number;
  burning: boolean;
}
export function validVehicleFire(s: VehicleFireSource): boolean {
  return !!s.key && s.position.length === 3 && s.position.every(Number.isFinite)
    && Number.isFinite(s.intensity) && s.intensity > 0 && s.intensity <= 1;
}
