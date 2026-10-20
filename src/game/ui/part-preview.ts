/** Small catalogue drawings are projected from the game's actual kit mesh and its rest instances. */
import { assembleKit, buildKitMesh, instanceMatrix, validateKitLoadout, type KitLoadoutIdsLike, type SlotId } from '../kit';

const colours = ['#a8b78b', '#4b5150', '#33393a', '#788383', '#bca16b', '#d2c79c', '#7cb6b2', '#b1b9b4'];
const cache = new Map<string, HTMLCanvasElement>();
const groups: Record<SlotId, readonly string[]> = {
  hull: ['hull'], runningGear: ['links', 'wheels', 'hubs', 'sprockets', 'idlers', 'rollers', 'arms', 'bogies', 'springs', 'tensioners'],
  turret: ['turret', 'hatch'], weapon: ['cradle', 'barrel'], utility: ['head', 'turret'],
};
type Point = [number, number, number];
interface Face { points: Point[]; depth: number; material: number; shade: number; selected: boolean }
const project = (x: number, y: number, z: number): Point => [x * .77 - z * .64, -y * .94 + (x * .64 + z * .77) * .34, x * .64 + z * .77 + y * .36];

export function partPreview(ids: KitLoadoutIdsLike, slot: SlotId): HTMLCanvasElement {
  const key = `${Object.values(ids).join('/')}/${slot}`;
  const cached = cache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 154; canvas.className = 'ws-part-preview'; canvas.setAttribute('aria-hidden', 'true');
  const draw = canvas.getContext('2d');
  if (!draw) return canvas;
  if (cached) { draw.drawImage(cached, 0, 0); return canvas; }
  try {
    const mesh = buildKitMesh(assembleKit(validateKitLoadout(ids)), 2);
    const faces: Face[] = [];
    for (const part of mesh.parts) {
      const selected = groups[slot].includes(part.part), source = part.instances ? part.positions : part.partLocal;
      const count = part.instances ? part.instances.length / 12 : 1;
      for (let instance = 0; instance < count; instance++) {
        const m = part.instances ? instanceMatrix(part.instances, instance) : null;
        const points: Point[] = [];
        for (let v = 0; v < source.length; v += 3) {
          const x = source[v], y = source[v + 1], z = source[v + 2];
          points.push(m ? project(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]) : project(x, y, z));
        }
        for (let i = 0; i < part.indices.length; i += 3) {
          const ia = part.indices[i], p = [points[ia], points[part.indices[i + 1]], points[part.indices[i + 2]]];
          const area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
          if (area >= 0) continue;
          const normal = part.normals;
          faces.push({ points: p, depth: (p[0][2] + p[1][2] + p[2][2]) / 3, material: (part.attrs[ia] >>> 16) & 255,
            shade: .42 + .58 * Math.max(0, normal[ia * 3] * .35 + normal[ia * 3 + 1] * .8 + normal[ia * 3 + 2] * .2), selected });
        }
      }
    }
    const all = faces.flatMap(f => f.points);
    const minX = Math.min(...all.map(p => p[0])), maxX = Math.max(...all.map(p => p[0]));
    const minY = Math.min(...all.map(p => p[1])), maxY = Math.max(...all.map(p => p[1]));
    const scale = Math.min(284 / (maxX - minX), 133 / (maxY - minY));
    draw.translate(160 - (minX + maxX) * .5 * scale, 76 - (minY + maxY) * .5 * scale);
    draw.scale(scale, scale);
    faces.sort((a, b) => a.depth - b.depth);
    for (const face of faces) {
      draw.beginPath(); face.points.forEach((p, i) => i ? draw.lineTo(p[0], p[1]) : draw.moveTo(p[0], p[1])); draw.closePath();
      draw.fillStyle = face.selected ? colours[face.material] ?? colours[0] : '#405055';
      draw.globalAlpha = face.selected ? .95 : .3; draw.fill();
      draw.fillStyle = '#060d10'; draw.globalAlpha = face.selected ? 1 - face.shade : .22; draw.fill();
    }
    draw.setTransform(1, 0, 0, 1, 0, 0); draw.globalAlpha = 1;
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
    cache.set(key, canvas);
  } catch { /* An incompatible kit has its compatibility message instead of a misleading mesh. */ }
  return canvas;
}
