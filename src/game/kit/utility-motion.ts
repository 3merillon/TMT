/** Cosmetic actuator motion, sampled from presentation time in both workshop and match. */
export function radarScanAngle(time: number): number {
  const phase = Math.max(0, time) * .88;
  // A lightly loaded reduction drive: continuous rotation, no hard wrap or frame-rate integration.
  return phase + Math.sin(phase * 3) * .018;
}

export function defenseScanPitch(time: number): number {
  const phase = ((Math.max(0, time) % 8.2) / 4.1);
  const leg = phase <= 1 ? phase : 2 - phase;
  // Dwell at each end, then a quintic acceleration/deceleration curve through the search arc.
  const t = Math.max(0, Math.min(1, (leg - .12) / .76));
  const eased = t * t * t * (t * (t * 6 - 15) + 10);
  return .04 + .36 * eased;
}

/** Low-amplitude elastic mast vibration, bounded well inside the mechanical spring envelope. */
export function antennaIdle(time: number, short = false, directional = false): [number, number] {
  const amplitude = directional ? .012 : short ? .022 : .038;
  const t = Math.max(0, time);
  return [amplitude * (Math.sin(t * 1.9) + .27 * Math.sin(t * 4.7)), amplitude * .7 * (Math.sin(t * 1.4 + .8) + .2 * Math.sin(t * 5.2))];
}
export function utilityIdle(id: string, time: number): [number, number] {
  if (id === 'radar') return [radarScanAngle(time), 0];
  if (id === 'aether_vane') return [radarScanAngle(time) * 1.65, 0];
  if (id === 'point_defense' || id === 'steam_sentinel') return [defenseScanPitch(time + (id === 'steam_sentinel' ? 1.6 : 0)), 0];
  if (id === 'periscope') return [defenseScanPitch(time + 2) * .65, 0];
  if (id === 'antenna' || id === 'whip_short' || id === 'yagi') return antennaIdle(time, id === 'whip_short', id === 'yagi');
  return [0, 0];
}
