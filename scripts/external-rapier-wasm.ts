/** Compatibility saves retain their original solver, but new native games must
 * not download its base64 WASM as JavaScript. Keep the exact package binary lazy. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import MagicString from 'magic-string';
import ts from 'typescript';
import type { Plugin } from 'vite';

export function externalRapierWasmPlugin(): Plugin {
  return { name: 'tmt-external-rapier-wasm', apply: 'build', enforce: 'pre',
    transform(source, id) {
      if (!/[/\\]@dimforge[/\\]rapier3d-compat[/\\]dist[/\\]rapier\.mjs$/.test(id)) return null;
      const ast = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const matches: ts.StringLiteral[] = [];
      const visit = (node: ts.Node): void => { if (ts.isStringLiteral(node) && node.text.startsWith('AGFzbQ') && node.text.length > 1e6) matches.push(node); ts.forEachChild(node, visit); };
      visit(ast);
      if (matches.length !== 1) throw new Error('Rapier compatibility WASM layout changed; review its packaging');
      const literal = matches[0], call = literal.parent, expression = call.parent;
      if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'toByteArray'
        || !ts.isPropertyAccessExpression(expression) || expression.name.text !== 'buffer') throw new Error('Unexpected Rapier compatibility initializer');
      const wasm = readFileSync(join(dirname(id), 'rapier_wasm3d_bg.wasm'));
      if (!wasm.equals(Buffer.from(literal.text, 'base64'))) throw new Error('Rapier embedded and packaged WASM differ');
      const reference = this.emitFile({ type: 'asset', name: 'rapier-compat.wasm', source: wasm }), output = new MagicString(source);
      output.overwrite(call.getStart(ast), expression.end, `import.meta.ROLLUP_FILE_URL_${reference}`);
      return { code: output.toString(), map: output.generateMap({ source: id, hires: true }) };
    },
  };
}
