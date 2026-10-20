/**
 * Basic PBR for part meshes, chosen by matId (plan §5.3 MatIds). W2-MAT replaces it with `tank_surface()`.
 * Metals carry their F0 colour in base_color (metalness 1). The TS table is the single source; the WGSL switch is
 * generated from it.
 */
import { makeModule } from '../wgsl/module';
import { gbufferWgsl } from '../wgsl/common/gbuffer.wgsl';

export interface PartMaterial {
  name: string;
  /** null = the instance tint. */
  baseColor: [number, number, number] | null;
  roughness: number; metalness: number;
  /** Class parameter (METAL: clearcoat). */
  param: number;
  /** Emissive intensity (radiance = base colour × intensity). */
  emissive: number;
}

export const PART_MATERIALS: readonly PartMaterial[] = [
  { name: 'paint', baseColor: null, roughness: 0.45, metalness: 0, param: 0.35, emissive: 0 },
  { name: 'dark steel', baseColor: [0.30, 0.31, 0.33], roughness: 0.35, metalness: 1, param: 0, emissive: 0 },
  { name: 'rubber', baseColor: [0.035, 0.035, 0.037], roughness: 0.8, metalness: 0, param: 0, emissive: 0 },
  { name: 'gunmetal', baseColor: [0.46, 0.48, 0.52], roughness: 0.3, metalness: 1, param: 0, emissive: 0 },
  { name: 'brass', baseColor: [0.91, 0.72, 0.39], roughness: 0.35, metalness: 1, param: 0, emissive: 0 },
  { name: 'signal', baseColor: null, roughness: 0.4, metalness: 0, param: 0, emissive: 8 },
  { name: 'glass', baseColor: [0.02, 0.025, 0.03], roughness: 0.05, metalness: 0, param: 0, emissive: 0 },
  { name: 'chrome', baseColor: [0.92, 0.93, 0.95], roughness: 0.08, metalness: 1, param: 0, emissive: 0 },
  { name: 'rubble', baseColor: null, roughness: 0.95, metalness: 0, param: 0, emissive: 0 },
  // Interior art uses linear RGB albedo baked into MeshDesc.partLocal (9..12 only), multiplied by the instance tint.
  { name: 'baked stone', baseColor: null, roughness: 0.9, metalness: 0, param: 0, emissive: 0 },
  { name: 'baked aged iron', baseColor: null, roughness: 0.48, metalness: 0.65, param: 0, emissive: 0 },
  { name: 'baked aged brass', baseColor: null, roughness: 0.4, metalness: 0.9, param: 0, emissive: 0 },
  { name: 'baked copper', baseColor: null, roughness: 0.45, metalness: 0.85, param: 0, emissive: 0 },
  { name: 'authored UV PBR', baseColor: null, roughness: 0.5, metalness: 0, param: 0, emissive: 0 },
  { name: 'ivory gauge face', baseColor: null, roughness: 0.68, metalness: 0, param: 0, emissive: 0 },
  { name: 'rough red clay', baseColor: null, roughness: 0.97, metalness: 0, param: 0, emissive: 0 },
  { name: 'worn cold concrete', baseColor: null, roughness: 0.94, metalness: 0, param: 0, emissive: 0 },
  { name: 'matte limestone', baseColor: null, roughness: 0.98, metalness: 0, param: 0, emissive: 0 },
  { name: 'worn fixture paint', baseColor: null, roughness: 0.65, metalness: 0, param: 0, emissive: 0 },
  { name: 'aged fixture brass', baseColor: null, roughness: 0.48, metalness: 0.9, param: 0, emissive: 0 },
  { name: 'oxidized workshop track shoe', baseColor: [0.055, 0.057, 0.06], roughness: 0.9, metalness: 0.3, param: 0, emissive: 0 },
];

const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const cases = PART_MATERIALS.map((m, id) => `    case ${id}u: {
      s.base_color = ${m.baseColor ? `vec3f(${m.baseColor.map(f).join(', ')})` : 'tint'};
      s.roughness = ${f(m.roughness)}; s.metalness = ${f(m.metalness)}; s.param = ${f(m.param)}; s.emissive = ${f(m.emissive)};
    }`).join('\n');

export const partBasicWgsl = makeModule('part-basic', /* wgsl */ `
/** attrs: edge u8 | ao u8 | matId u8 | flags u8 (low → high). */
fn part_attr_edge(attrs: u32) -> f32 { return f32(attrs & 0xFFu) / 255.0; }
fn part_attr_ao(attrs: u32) -> f32 { return f32((attrs >> 8u) & 0xFFu) / 255.0; }
fn part_attr_mat(attrs: u32) -> u32 { return (attrs >> 16u) & 0xFFu; }
fn part_attr_flags(attrs: u32) -> u32 { return (attrs >> 24u) & 0xFFu; }

fn part_basic_surface(mat_id: u32, tint: vec3f, attrs: u32) -> SurfaceSample {
  var s = surface_default();
  s.ao = part_attr_ao(attrs);
  switch mat_id {
${cases}
    default: {
      s.base_color = tint; s.roughness = 0.5; s.metalness = 0.0;
    }
  }
  // Worn edges read slightly brighter and smoother (a hint of what tank_surface will do properly).
  let edge = part_attr_edge(attrs);
  s.roughness = mix(s.roughness, s.roughness * 0.75, edge * 0.5);
  return s;
}
`, [gbufferWgsl]);

/** attrs packing mirror: edge u8 | ao u8 | matId u8 | flags u8. */
export function packPartAttrs(edge: number, ao: number, matId: number, flags = 0): number {
  return ((edge & 0xff) | ((ao & 0xff) << 8) | ((matId & 0xff) << 16) | ((flags & 0xff) << 24)) >>> 0;
}
