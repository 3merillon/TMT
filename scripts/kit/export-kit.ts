/**
 * Kit GLB export (W1-KIT, review only): the assembled TS geometry of kit v2 as binary glTF, with a node per joint
 * (hull → turret → cradle → barrel, hatch, utility head), one node per repeated running-gear instance (shared
 * meshes), and empty socket nodes carrying glTF extras (turret ring, trunnion, muzzle, sensor, exhausts,
 * utility). The game never loads these files; Blender renders them (scripts/blender/render-kit.py).
 *
 *   npx tsx scripts/kit/export-kit.ts [--out assets/kit/v2] [--all | hull.gear.turret.weapon.utility …]
 *
 * Default: the three hull / gear / turret / weapon showcase assemblies. No dependencies beyond the kit.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleKit, buildKitMesh, createKitPose, kitInstanceSource, legalKitLoadouts, validateKitLoadout, writeKitPose, type KitAssembly, type PartMesh } from '../../src/game/kit';
import { kitContext } from '../../src/game/kit/build';
import { createRigPose, poseRig, restState } from '../../src/game/kit/rig';
import { MAT_ID } from '../../src/game/kit/types';

/** Linear base colours per matId (paint is olive for review renders). */
const MATERIAL_COLORS: Record<number, [number, number, number, number]> = {
  [MAT_ID.paint]: [0.22, 0.28, 0.12, 1], [MAT_ID.darkSteel]: [0.05, 0.05, 0.055, 1], [MAT_ID.rubber]: [0.03, 0.03, 0.03, 1],
  [MAT_ID.gunmetal]: [0.22, 0.23, 0.25, 1], [MAT_ID.brass]: [0.7, 0.5, 0.2, 1], [MAT_ID.signal]: [0.9, 0.3, 0.05, 1],
  [MAT_ID.glass]: [0.3, 0.45, 0.55, 1], [MAT_ID.chrome]: [0.8, 0.8, 0.82, 1],
};
const METALLIC: Record<number, number> = { [MAT_ID.darkSteel]: 0.6, [MAT_ID.gunmetal]: 0.85, [MAT_ID.brass]: 1, [MAT_ID.chrome]: 1 };

interface GltfNode { name: string; mesh?: number; matrix?: number[]; children?: number[]; extras?: Record<string, unknown> }

/** Binary glTF of an assembly at rest (turret forward, gun level, nominal suspension). */
export function exportKitGlb(a: KitAssembly): Uint8Array {
  const ctx = kitContext(a.loadout), mesh = buildKitMesh(a, 0);
  const rig = createRigPose();
  poseRig(ctx, restState(ctx), rig);
  const pose = createKitPose(a);
  writeKitPose(a, rig, pose);
  const bin: Uint8Array[] = [];
  let binLength = 0;
  const bufferViews: Record<string, unknown>[] = [], accessors: Record<string, unknown>[] = [], meshes: Record<string, unknown>[] = [];
  const nodes: GltfNode[] = [];
  const push = (data: ArrayBufferView, target?: number): number => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const pad = (4 - (binLength % 4)) % 4;
    if (pad) { bin.push(new Uint8Array(pad)); binLength += pad; }
    bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    bin.push(bytes); binLength += bytes.byteLength;
    return bufferViews.length - 1;
  };
  const materials = Object.entries(MATERIAL_COLORS).map(([id, color]) => ({
    name: Object.entries(MAT_ID).find(([, v]) => v === Number(id))?.[0] ?? `mat${id}`,
    pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: METALLIC[Number(id)] ?? 0, roughnessFactor: Number(id) === MAT_ID.chrome ? 0.15 : 0.55 },
    ...(Number(id) === MAT_ID.signal ? { emissiveFactor: [0.9, 0.3, 0.05] } : {}),
  }));
  /** One glTF mesh per PartMesh, one primitive per matId (triangles split by their first vertex's matId). */
  const addMesh = (p: PartMesh): number => {
    const byMat = new Map<number, number[]>();
    for (let t = 0; t < p.indices.length; t += 3) {
      const mat = (p.attrs[p.indices[t]] >>> 16) & 255;
      let list = byMat.get(mat); if (!list) { list = []; byMat.set(mat, list); } list.push(p.indices[t], p.indices[t + 1], p.indices[t + 2]);
    }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p.positions[i + k]); max[k] = Math.max(max[k], p.positions[i + k]); }
    const count = p.positions.length / 3;
    const pos = accessors.push({ bufferView: push(p.positions, 34962), componentType: 5126, count, type: 'VEC3', min, max }) - 1;
    const nrm = accessors.push({ bufferView: push(p.normals, 34962), componentType: 5126, count, type: 'VEC3' }) - 1;
    // Baked AO as a vertex colour (review aid).
    const colors = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) { const ao = ((p.attrs[i] >>> 8) & 255) / 255; colors[i * 4] = colors[i * 4 + 1] = colors[i * 4 + 2] = ao; colors[i * 4 + 3] = 1; }
    const col = accessors.push({ bufferView: push(colors, 34962), componentType: 5126, count, type: 'VEC4' }) - 1;
    const primitives = [...byMat].map(([mat, idx]) => ({
      attributes: { POSITION: pos, NORMAL: nrm, COLOR_0: col },
      indices: accessors.push({ bufferView: push(Uint32Array.from(idx), 34963), componentType: 5125, count: idx.length, type: 'SCALAR' }) - 1,
      material: Math.max(0, materials.findIndex(m => m.name === (Object.entries(MAT_ID).find(([, v]) => v === mat)?.[0] ?? ''))),
    }));
    return meshes.push({ name: p.part, primitives }) - 1;
  };
  const node = (n: GltfNode): number => nodes.push(n) - 1;
  const toMatrix = (m: ArrayLike<number>) => Array.from(m, v => Math.fround(v));
  /** Local matrix of a child joint relative to its parent (both tank-local, rigid). */
  const relative = (parent: ArrayLike<number>, child: ArrayLike<number>): number[] => {
    // parent⁻¹ · child for rigid transforms.
    const r = [parent[0], parent[1], parent[2], parent[4], parent[5], parent[6], parent[8], parent[9], parent[10]];
    const t = [parent[12], parent[13], parent[14]];
    const out = new Array<number>(16).fill(0); out[15] = 1;
    for (let c = 0; c < 4; c++) {
      const v = [child[c * 4], child[c * 4 + 1], child[c * 4 + 2]];
      if (c === 3) { v[0] -= t[0]; v[1] -= t[1]; v[2] -= t[2]; }
      out[c * 4] = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
      out[c * 4 + 1] = r[3] * v[0] + r[4] * v[1] + r[5] * v[2];
      out[c * 4 + 2] = r[6] * v[0] + r[7] * v[1] + r[8] * v[2];
      out[c * 4 + 3] = c === 3 ? 1 : 0;
    }
    return out;
  };
  const joints = pose.joints;
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const jointNode = new Map<string, number>();
  const parentOf: Record<string, string> = { hull: '', turret: 'hull', hatch: 'turret', cradle: 'turret', barrel: 'cradle', antenna: 'turret', radar: 'turret', periscope: 'turret' };
  const root = node({ name: 'tank', children: [], extras: { kit: a.key, joints: a.joints } });
  for (const name of ['hull', 'turret', 'cradle', 'barrel', 'hatch', 'antenna', 'radar', 'periscope']) {
    const m = joints.get(name);
    if (!m) continue;
    const parent = parentOf[name], pm = parent ? joints.get(parent)! : I;
    const idx = node({ name, matrix: toMatrix(parent ? relative(pm, m) : m), children: [] });
    jointNode.set(name, idx);
    nodes[parent ? jointNode.get(parent)! : root].children!.push(idx);
  }
  for (const p of mesh.parts) {
    const meshIndex = addMesh(p);
    const src = kitInstanceSource(a, p);
    if (!src) { nodes[jointNode.get(p.joint)!].mesh = meshIndex; continue; }
    const buffer = pose[src.buffer];
    for (let i = 0; i < src.count; i++) {
      const o = (src.first + i) * 12;
      const m = [buffer[o], buffer[o + 4], buffer[o + 8], 0, buffer[o + 1], buffer[o + 5], buffer[o + 9], 0, buffer[o + 2], buffer[o + 6], buffer[o + 10], 0, buffer[o + 3], buffer[o + 7], buffer[o + 11], 1];
      nodes[jointNode.get('hull')!].children!.push(node({ name: `${p.part}_${i}`, mesh: meshIndex, matrix: m }));
    }
  }
  // Sockets (empty nodes with extras).
  const socket = (name: string, parent: string, position: readonly number[], rotation: readonly number[] = [0, 0, 0, 1], extras: Record<string, unknown> = {}) => {
    const [x, y, z, w] = rotation;
    const m = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0, 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0, 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, position[0], position[1], position[2], 1];
    nodes[parent === 'root' ? root : jointNode.get(parent)!].children!.push(node({ name, matrix: m, extras: { socket: name, ...extras } }));
  };
  const f = a.frames;
  socket('turret_ring', 'hull', f.turretRing.position, f.turretRing.rotation, { class: ctx.ringClass });
  socket('trunnion', 'turret', f.trunnion.position, f.trunnion.rotation, { class: ctx.weaponClass });
  socket('muzzle', 'cradle', f.muzzle.position, f.muzzle.rotation);
  socket('sensor', 'root', f.sensor.position, f.sensor.rotation);
  socket('utility', 'turret', f.utility.position, f.utility.rotation, { utility: a.loadout.utility });
  f.exhausts.forEach((e, i) => socket(`exhaust_${i}`, 'hull', e.position, e.rotation));
  const json = {
    asset: { version: '2.0', generator: 'TMT scripts/kit/export-kit.ts (kit v2)' },
    extras: { kit: a.key, stats: a.stats, massProps: a.massProps, note: 'Review export of the procedural kit; never loaded by the game.' },
    scene: 0, scenes: [{ name: a.key, nodes: [root] }], nodes, meshes, materials, accessors, bufferViews,
    buffers: [{ byteLength: binLength }],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPad) { const padded = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20); padded.set(jsonBytes); jsonBytes = padded; }
  const binPad = (4 - (binLength % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + 8 + binLength + binPad;
  const out = new Uint8Array(total), view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true); view.setUint32(16, 0x4e4f534a, true); out.set(jsonBytes, 20);
  let o = 20 + jsonBytes.length;
  view.setUint32(o, binLength + binPad, true); view.setUint32(o + 4, 0x004e4942, true); o += 8;
  for (const chunk of bin) { out.set(chunk, o); o += chunk.byteLength; }
  return out;
}

export const SHOWCASE = ['skiff.scout.cradle.mortar.antenna', 'warden.grip.dome.cannon.radar', 'bastion.crawler.wedge.rail.periscope', 'warden.scout.dome.mortar.smoke'];

function main(): void {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const out = resolve(root, outIndex >= 0 ? args[outIndex + 1] : 'assets/kit/v2');
  const keys = args.includes('--all') ? legalKitLoadouts().map(l => Object.values(l).join('.')) : args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  mkdirSync(out, { recursive: true });
  const manifest: { file: string; key: string; bytes: number; triangles: number }[] = [];
  for (const key of keys.length ? keys : SHOWCASE) {
    const [hull, runningGear, turret, weapon, utility] = key.split('.');
    const a = assembleKit(validateKitLoadout({ hull, runningGear, turret, weapon, utility }));
    const glb = exportKitGlb(a);
    const file = `kit-v2.${key}.glb`;
    writeFileSync(join(out, file), glb);
    const triangles = buildKitMesh(a, 0).parts.reduce((s, p) => s + p.indices.length / 3 * (p.instances ? p.instances.length / 12 : 1), 0);
    manifest.push({ file, key, bytes: glb.byteLength, triangles });
    console.log(`${file}  ${(glb.byteLength / 1024).toFixed(0)} KiB  ${triangles} tris`);
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ generator: 'scripts/kit/export-kit.ts', review: 'scripts/blender/render-kit.py', assets: manifest }, null, 2) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
