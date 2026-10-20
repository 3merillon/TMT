import { attribute, faceDirection, Fn, If, normalLocal, positionLocal, transformNormalToView, vec3 } from 'three/tsl';
import type { FieldDefinition } from '../core/types';
import { gradientDefinition } from './normals';

/** Evaluate at the fragment's position, not by interpolating normalized gradients
 * at the centroid fan's vertices. The latter creates radial lighting spokes on hills.
 */
export function sourceNormalNode(definitions: readonly FieldDefinition[]) {
  return Fn(() => {
    const normal = normalLocal.toVar();
    const sourceIndex = attribute('normalSource', 'float').toVarying().setInterpolation('flat');
    const orientation = attribute('normalOrientation', 'float').toVarying().setInterpolation('flat');
    definitions.forEach((definition, index) => {
      If(sourceIndex.equal(index), () => {
        const source = gradientDefinition(definition);
        const gradient = vec3(0).toVar();
        if (source.kind === 'affine') gradient.assign(vec3(...source.normal));
        else {
          const delta = positionLocal.sub(vec3(...source.center));
          gradient.assign(delta.mul(2));
          if (source.kind === 'terrain') for (const wave of source.waves) {
            const k = vec3(...wave.k);
            gradient.addAssign(k.mul(delta.dot(k).add(wave.phase).cos().mul(wave.amplitude)));
          }
        }
        // A stationary point has no analytic normal; retain the mesh fallback there.
        If(gradient.dot(gradient).greaterThan(0), () => {
          normal.assign(gradient.normalize().mul(orientation));
        });
      });
    });
    return transformNormalToView(normal).normalize().mul(faceDirection);
  })();
}
