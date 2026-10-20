/**
 * Equi-angular cube-sphere mapping, WGSL side. The single source is `src/world/cube-sphere.ts` (face convention, TS
 * functions and the WGSL text generated from its constants); this file only registers it as an engine WGSL module so
 * shaders can depend on it (`cs_face_of`, `cs_uv`, `cs_dir`, `cs_locate`, `cs_uv01`, `cs_site_hash`, ...).
 */
import { CUBE_SPHERE_WGSL } from '../../../world/cube-sphere';
import { makeModule } from '../module';

export const cubeSphereWgsl = makeModule('cube-sphere', CUBE_SPHERE_WGSL);
