import { expect, it } from 'vitest';
import type { EngineServices } from '../src/engine/contracts';
import { graphicsPreset } from '../src/game/meta/settings';
import { applyGraphicsSettings, PROTECTED_GRAPHICS_TIER } from '../src/game/presentation/graphics-settings';
import { applyWorkshopGraphics } from '../src/game/workshop/graphics';

it('changes optional passes live without changing liquid, terrain, explosions or fog state', () => {
  const facets: Record<string, any> = {
    grass: { density: 1 }, clouds: { enabled: true, shadows: true }, volumetrics: { enabled: true }, sunShadows: { enabled: true },
    lighting: { ao: true, toggles: { gi: true, veil: true, mist: true, casters: true } }, post: {},
    fluids: { state: 'existing liquid and gas' }, fogOfWar: { enabled: true, volume: 128 }, sdf: { detail: 256 }, shockwaves: { active: 6 },
  };
  const protectedState = JSON.stringify([facets.fluids, facets.fogOfWar, facets.sdf, facets.shockwaves]);
  const services = { settings: { tier: PROTECTED_GRAPHICS_TIER }, scene: { get: (key: string) => facets[key] } } as unknown as Pick<EngineServices, 'settings' | 'scene'>;
  applyGraphicsSettings(services, graphicsPreset('low'));
  expect(services.settings).toMatchObject({ tier: 'high', renderScale: 0.5, shadowTier: 'low', cloudTier: 'low' });
  expect(facets.lighting.toggles).toMatchObject({ sunShadows: false, moonShadows: false, localShadows: false, gi: false, veil: true, mist: true, casters: true });
  expect(facets.clouds.enabled).toBe(false); expect(facets.volumetrics.enabled).toBe(false); expect(facets.grass.density).toBe(0);
  applyGraphicsSettings(services, graphicsPreset('high'));
  expect(services.settings.renderScale).toBe(1);
  expect(facets.post).toMatchObject({ fisheye: 0.15, miniature: 0 });
  expect(facets.lighting.toggles.gi).toBe(true);
  expect(JSON.stringify([facets.fluids, facets.fogOfWar, facets.sdf, facets.shockwaves])).toBe(protectedState);
});

it('applies Low and High to an existing workshop without leaving costly room effects enabled', () => {
  const room = { fogDensity: .0025, fan: { strength: 48 } }, lighting = { ao: true, toggles: {} }, post = {};
  const services = { settings: {}, scene: { get: (key: string) => ({ interior: room, lighting, post } as Record<string, unknown>)[key] } } as unknown as Pick<EngineServices, 'settings' | 'scene'>;
  applyWorkshopGraphics(services, graphicsPreset('low'));
  expect(services.settings.renderScale).toBe(.5);
  expect(lighting.ao).toBe(false); expect(lighting.toggles).toMatchObject({ localShadows: false });
  expect(room).toMatchObject({ fogDensity: 0, fan: { strength: 0 } });
  applyWorkshopGraphics(services, graphicsPreset('high'));
  expect(services.settings.renderScale).toBe(1);
  expect(lighting.ao).toBe(true); expect(lighting.toggles).toMatchObject({ localShadows: true });
  expect(room).toMatchObject({ fogDensity: .0025, fan: { strength: 48 } });
  expect(post).toMatchObject({ fisheye: 0, miniature: 0 });
});
