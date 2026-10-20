import type { EngineServices } from '../../engine/contracts';
import type { GraphicsSettings } from '../meta/settings';
import { applyGraphicsSettings } from '../presentation/graphics-settings';

/** Share performance controls with matches while keeping inspection/painting projection exact. */
export function applyWorkshopGraphics(s: Pick<EngineServices, 'settings' | 'scene'>, graphics: GraphicsSettings): void {
  applyGraphicsSettings(s, { ...graphics, fisheye: 0, miniature: 0 });
  const room = s.scene.get('interior');
  if (room) {
    room.fogDensity = graphics.hazeQuality > 0 ? .0025 : 0;
    if (room.fan) room.fan.strength = graphics.hazeQuality > 0 && graphics.godRays ? 48 : 0;
  }
}
