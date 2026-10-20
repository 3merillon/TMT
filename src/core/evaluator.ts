import type { Expr, Scene } from './types';

/** Resolve field IDs once and short-circuit immutable material expressions per region. */
export function compileMaterialEvaluator(scene: Scene): (signs: readonly number[]) => number {
  type Evaluate = (signs: readonly number[]) => number;
  const indices = new Map(scene.fields.map((field, i) => [field.id, i]));
  function compile(expression: Expr): Evaluate {
    if (expression.op === 'leaf') {
      const index = indices.get(expression.id);
      if (index === undefined) throw new Error(`Unknown field: ${expression.id}`);
      const material = scene.fields[index].material;
      return signs => signs[index] <= 0 ? material : 0;
    }
    if (expression.op === 'material') {
      const child = compile(expression.child), material = expression.material;
      return signs => child(signs) ? material : 0;
    }
    const left = compile(expression.left), right = compile(expression.right);
    if (expression.op === 'difference') return signs => { const a = left(signs); return a && !right(signs) ? a : 0; };
    const first = expression.materialPreference === 'right' ? right : left;
    const second = expression.materialPreference === 'right' ? left : right;
    if (expression.op === 'union') return signs => first(signs) || second(signs);
    return signs => { const a = first(signs); return a && second(signs) ? a : 0; };
  }
  return compile(scene.expression);
}
