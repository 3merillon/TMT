/**
 * `pending-crater` terrain modifier (plan §4.7 "Pending-cut cosmetic crater"). Reads the reserved binding `pendingCuts`
 * (≤ 8 spheres: centre, radius, t0; uploaded by the engine core from FrameInput.pendingCuts).
 *
 * Only color and roughness change before commit. Moving shared corners according to per-face normals or material
 * masks splits seams (especially at the protected core), and makes camera collision disagree with the rendered mesh.
 * The closed crater geometry, normals, collision and page bounds change together at the accepted terrain commit.
 * A material crater (rust-engine-v22) gives one sphere per shell with a material mask for the soil darkening.
 * Detached body pages are never modified.
 */
import { PENDING_CUTS, pendingCutsWgsl } from '../../../frame/pending-cuts';
import { makeModule } from '../../../wgsl/module';
import { terrainCtxWgsl, type TerrainModifier } from '../modifier-types';

/** Fresh crater soil (linear albedo) and its darkening inside the bowl. */
export const PENDING_CRATER = { soil: [0.11, 0.084, 0.062], bowlEdge: [1.02, 1.06], scorch: 0.72 } as const;

export const pendingCraterModifier: TerrainModifier = {
  name: 'pending_crater',
  reserved: ['pendingCuts'],
  wgsl: () => makeModule('tmod-pending-crater', /* wgsl */ `
const PENDING_SOIL: vec3f = vec3f(${PENDING_CRATER.soil.join(', ')});

fn tmod_pending_crater(s: ptr<function, SurfaceSample>, t: TerrainCtx) {
  if (t.is_body != 0u) { return; }
  let n = min(rb_pendingCuts_cuts.count.x, 8u);
  for (var i = 0u; i < n; i++) {
    let sphere = rb_pendingCuts_cuts.spheres[i];
    if (!pending_cut_carves(rb_pendingCuts_cuts, i, u32(max(round(t.material), 0.0)))) { continue; }
    let r = max(sphere.w, 1e-3);
    let d = distance(t.world, sphere.xyz);
    // Tint reaches just beyond the planned excavation while its geometry is prepared.
    let bowl = 1.0 - smoothstep(r * ${PENDING_CRATER.bowlEdge[0]}, r * ${PENDING_CRATER.bowlEdge[1]}, d);
    if (bowl <= 0.0) { continue; }
    (*s).base_color = mix((*s).base_color, PENDING_SOIL, bowl);
    (*s).base_color = (*s).base_color * (1.0 - ${PENDING_CRATER.scorch} * 0.5 * bowl);
    (*s).roughness = mix((*s).roughness, 1.0, bowl);
  }
}
`, [terrainCtxWgsl, PENDING_CUTS.module, pendingCutsWgsl]),
};
