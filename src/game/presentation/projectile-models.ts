/** Shared physical ammunition meshes. +Z is the nose; dimensions are world units. */
import type { MeshDesc } from '../../engine';
import type { MunitionId } from '../munitions';

type Color = readonly [number, number, number];
type Station = readonly [z: number, radius: number];
const linear = (c: number) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
const olive: Color = [.40, .44, .25], steel: Color = [.53, .56, .57], brass: Color = [.70, .56, .29];

class RoundBuilder {
  p: number[] = []; n: number[] = []; color: number[] = []; attrs: number[] = []; index: number[] = [];
  vertex(p: Color, n: Color, color: Color, material: number): number {
    const index = this.p.length / 3;
    this.p.push(...p); this.n.push(...n); this.color.push(...color.map(linear));
    this.attrs.push((material << 16) | (255 << 8) | 32);
    return index;
  }
  lathe(profile: readonly Station[], color: Color, material = 10, sides = 32): void {
    const base = this.p.length / 3;
    for (let k = 0; k < profile.length; k++) {
      const [z, r] = profile[k], a = profile[Math.max(0, k - 1)], b = profile[Math.min(profile.length - 1, k + 1)];
      const dz = b[0] - a[0], dr = b[1] - a[1], length = Math.hypot(dz, dr) || 1;
      for (let i = 0; i <= sides; i++) {
        const angle = i * Math.PI * 2 / sides, x = Math.cos(angle), y = Math.sin(angle);
        this.vertex([x * r, y * r, z], [x * dz / length, y * dz / length, -dr / length], color, material);
      }
    }
    for (let k = 0; k < profile.length - 1; k++) for (let i = 0; i < sides; i++) {
      const a = base + k * (sides + 1) + i, b = a + sides + 1;
      this.index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  fin(angle: number, color: Color): void {
    const points: Color[] = [[.018, -.003, -.245], [.080, -.003, -.255], [.080, -.003, -.195], [.035, -.003, -.132],
      [.018, .003, -.245], [.080, .003, -.255], [.080, .003, -.195], [.035, .003, -.132]];
    const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    const rotated = points.map(([x, y, z]) => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle), z] as Color);
    for (const face of faces) {
      const a = rotated[face[0]], b = rotated[face[1]], c = rotated[face[2]];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(...n) || 1, normal = n.map(q => q / l) as [number, number, number];
      const ids = face.map(i => this.vertex(rotated[i], normal, color, 10));
      this.index.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
    }
  }
  finish(label: string): MeshDesc {
    return { positions: new Float32Array(this.p), normals: new Float32Array(this.n), partLocal: new Float32Array(this.color),
      attrs: new Uint32Array(this.attrs), indices: new Uint32Array(this.index), label };
  }
}

export const WORKSHOP_BOMB_URL = '/game/workshop-bomb.pmb';
let bomb: Uint8Array | undefined;
/** The nuclear round is a 129 KB binary asset, not script text: fetched once while the renderer starts, never at a shot. */
export async function loadProjectileAssets(signal?: AbortSignal): Promise<void> {
  if (bomb) return;
  const response = await fetch(WORKSHOP_BOMB_URL, { signal });
  if (!response.ok) throw new Error(`Projectile models failed to load (${response.status})`);
  setWorkshopBomb(new Uint8Array(await response.arrayBuffer()));
}
/** Tests and tools hand the asset bytes over directly. Validates before any scene can share the models. */
export function setWorkshopBomb(bytes: Uint8Array): void {
  decodeWorkshopBomb(bytes);
  bomb = bytes; shared = undefined;
}

/** Bounded decode: no GLTF loader, room data or texture allocations. */
export function decodeWorkshopBomb(bytes: Uint8Array): MeshDesc {
  if (bytes.length > 300000) throw new Error('Oversized workshop bomb asset');
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 24 || data.getUint32(0, true) !== 0x32424d50) throw new Error('Invalid workshop bomb asset');
  const count = data.getUint32(4, true), elements = data.getUint32(8, true);
  const rings = data.getUint32(12, true), segments = data.getUint32(16, true), finElements = data.getUint32(20, true);
  const casingElements = rings * segments * 6;
  if (count < 3 || count > 12000 || elements < 3 || elements > 60000 || elements % 3
    || rings < 1 || rings > 512 || segments < 3 || segments > 128 || (rings + 1) * segments > count
    || finElements % 3 || casingElements + finElements !== elements
    || bytes.length !== 24 + count * 15 + finElements * 2) throw new Error('Invalid workshop bomb size');
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3), partLocal = new Float32Array(count * 3);
  const attrs = new Uint32Array(count), indices = new Uint32Array(elements);
  let at = 24;
  for (let i = 0; i < count; i++, at += 15) {
    for (let j = 0; j < 3; j++) {
      positions[i * 3 + j] = data.getInt16(at + j * 2, true) / 32767;
      normals[i * 3 + j] = data.getInt16(at + 6 + j * 2, true) / 32767;
      partLocal[i * 3 + j] = linear(data.getUint8(at + 12 + j) / 255);
    }
    // Olive enamel and faded yellow paint remain dielectric. Neutral exposed
    // seam/rivet texels retain aged steel; no full metallic coat over the paint.
    const r = data.getUint8(at + 12), g = data.getUint8(at + 13), b = data.getUint8(at + 14);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), material = max > 82 && max - min < 25 ? 10 : 9;
    attrs[i] = (material << 16) | (255 << 8);
  }
  // PMB2 omits the regular casing's redundant triangle indices. Reconstruct the
  // exact PMB1 winding and order; vertex bytes and original fin indices are unchanged.
  let element = 0;
  for (let ring = 0; ring < rings; ring++) for (let segment = 0; segment < segments; segment++) {
    const a = ring * segments + segment, b = ring * segments + (segment + 1) % segments;
    const c = a + segments, d = b + segments;
    indices[element++] = a; indices[element++] = b; indices[element++] = c;
    indices[element++] = b; indices[element++] = d; indices[element++] = c;
  }
  for (let i = 0; i < finElements; i++) {
    const index = data.getUint16(at + i * 2, true);
    if (index >= count) throw new Error('Invalid workshop bomb index');
    indices[element++] = index;
  }
  return { positions, normals, partLocal, attrs, indices, label: 'projectile:nuclear-workshop-extract' };
}

let shared: Readonly<Record<MunitionId, MeshDesc>> | undefined;
/** All models are immutable and shared between scene lifetimes. Only four GPU meshes per scene. */
export function projectileMeshes(): Readonly<Record<MunitionId, MeshDesc>> {
  if (shared) return shared;
  if (!bomb) throw new Error('Projectile models are not loaded');
  const he = new RoundBuilder();
  he.lathe([[-.19, 0], [-.19, .045], [-.16, .052], [.062, .052], [.13, .04], [.185, .018], [.20, 0]], olive, 9);
  he.lathe([[-.151, .052], [-.15, .057], [-.12, .057], [-.119, .052]], brass, 11);
  he.lathe([[.155, .030], [.174, .026], [.205, .010], [.214, 0]], steel);
  he.lathe([[.076, .0496], [.088, .0472]], [.76, .65, .27], 9);
  const heavy = new RoundBuilder();
  heavy.lathe([[-.255, 0], [-.255, .058], [-.232, .074], [.07, .074], [.15, .063], [.228, .039], [.25, 0]], [.25, .30, .29], 9);
  heavy.lathe([[.085, .073], [.10, .075], [.173, .062], [.237, .038], [.26, .014], [.26, 0]], steel);
  for (const z of [-.204, -.156]) heavy.lathe([[z, .074], [z + .004, .080], [z + .027, .080], [z + .031, .074]], [.65, .44, .24], 11);
  heavy.lathe([[.048, .0745], [.072, .0745]], [.82, .74, .48], 9);
  const incendiary = new RoundBuilder();
  incendiary.lathe([[-.25, 0], [-.25, .027], [-.13, .039], [-.11, .060], [.11, .060], [.17, .044], [.24, .018], [.247, 0]], [.50, .21, .12], 9);
  incendiary.lathe([[-.108, .061], [-.093, .063], [-.057, .063], [-.052, .061]], [.79, .76, .56], 9);
  incendiary.lathe([[.095, .0605], [.115, .061], [.134, .055]], steel);
  incendiary.lathe([[.206, .031], [.241, .023], [.259, 0]], [.37, .39, .38]);
  for (let i = 0; i < 4; i++) incendiary.fin(i * Math.PI / 2 + Math.PI / 4, [.31, .34, .28]);
  return shared = Object.freeze({ explosive: he.finish('projectile:high-explosive'), heavy: heavy.finish('projectile:heavy-demolition'),
    incendiary: incendiary.finish('projectile:incendiary-canister'), nuclear: decodeWorkshopBomb(bomb) });
}
