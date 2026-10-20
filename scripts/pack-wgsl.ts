/** Reversible build-only storage of repeated WGSL text. Expansion precedes module linking. */
import MagicString from 'magic-string';
import ts from 'typescript';
import type { Plugin } from 'vite';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const WGSL_TOKENS = [
  'texture_storage_2d_array', 'texture_storage_2d', 'texture_storage_3d', 'textureSampleLevel', 'textureSampleCompareLevel',
  'textureDimensions', 'texture_depth_2d_array', 'texture_depth_2d', 'texture_2d_array', 'texture_cube', 'texture_3d', 'texture_2d',
  '@builtin(global_invocation_id)', '@builtin(vertex_index)', '@builtin(position)', '@workgroup_size', '@location', '@binding', '@group',
  'inverseSqrt', 'textureLoad', 'textureStore', 'rgba16float', 'rgba8unorm', 'workgroupBarrier', 'arrayLength', 'smoothstep',
  'position', 'direction', 'radiance', 'visibility', 'roughness', 'normalize', 'intensity', 'distance', 'params', 'frame.',
  'vec2f', 'vec3f', 'vec4f', 'vec2u', 'vec3u', 'vec4u', 'vec2i', 'vec3i', 'vec4i', 'mat4x4f', 'mat3x3f',
  'return', 'struct', 'sampler', 'uniform', 'storage', 'select', 'clamp', 'length', 'float', 'output', 'texture', 'world', 'normal', 'color',
] as const;
const matcher = new RegExp(['\\$', ...[...WGSL_TOKENS].sort((a, b) => b.length - a.length).map(token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))].join('|'), 'g');

export function packWgsl(code: string): string {
  return code.replace(matcher, token => token === '$' ? '$$' : `$${alphabet[WGSL_TOKENS.indexOf(token as typeof WGSL_TOKENS[number])]}`);
}
export function unpackWgsl(code: string): string {
  return code.replace(/\$([$A-Za-z0-9])/g, (_match, token: string) => token === '$' ? '$' : WGSL_TOKENS[alphabet.indexOf(token)]);
}
const virtualId = 'virtual:tmt-wgsl-dictionary', resolvedId = '\0tmt-wgsl-dictionary';
/** The emitted decoder is tested independently as well as the build-side inverse. */
export const decoderSource = `const words=${JSON.stringify(WGSL_TOKENS)},alphabet=${JSON.stringify(alphabet)};export function decodeWgsl(code){return code.replace(/\\$([$A-Za-z0-9])/g,(_,token)=>token==='$'?'$':words[alphabet.indexOf(token)])}`;

export function packMarkedWgsl(source: string, id: string) {
  const ast = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const output = new MagicString(source);
  let prefix = '__tmtWgsl'; while (source.includes(prefix)) prefix += '_';
  const helper = `${prefix}_decode`, constants: string[] = [], shared = new Map<string, string>();
  const constant = (packed: string) => {
    const previous = shared.get(packed); if (previous) return previous;
    const name = `${prefix}_${constants.length}`;
    shared.set(packed, name); constants.push(`const ${name}=${helper}(\`${packed}\`);\n`); return name;
  };
  let changed = false;
  const visit = (node: ts.Node): void => {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const start = node.getStart(ast);
      if (/\/\*\s*wgsl\s*\*\/\s*$/.test(source.slice(Math.max(0, start - 60), start))) {
        const ranges: [number, number][] = ts.isNoSubstitutionTemplateLiteral(node) ? [[start + 1, node.end - 1]]
          : [[node.head.getStart(ast) + 1, node.head.end - 2], ...node.templateSpans.map(span => [span.literal.getStart(ast) + 1,
            span.literal.end - (ts.isTemplateTail(span.literal) ? 1 : 2)] as [number, number])];
        for (const [a, b] of ranges) {
          const raw = source.slice(a, b);
          // Preserve JavaScript cooked-string escapes. Decode each raw chunk separately,
          // so arbitrary interpolated values containing dictionary markers stay unchanged.
          if (raw.includes('\\')) continue;
          const packed = packWgsl(raw);
          if (raw.length - packed.length < 24) continue;
          if (ts.isNoSubstitutionTemplateLiteral(node)) {
            output.overwrite(start, node.end, constant(packed));
          } else output.overwrite(a, b, '${' + constant(packed) + '}');
          changed = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!changed) return null;
  // Raw text is independent of interpolation values. Hoist its expansion so shader
  // factories and render callbacks never perform dictionary work again.
  output.prepend(`import {decodeWgsl as ${helper}} from '${virtualId}';\n${constants.join('')}`);
  return { code: output.toString(), map: output.generateMap({ source: id, includeContent: true, hires: true }) };
}

export function packWgslPlugin(): Plugin {
  return { name: 'tmt-pack-wgsl', apply: 'build', enforce: 'pre',
    resolveId: id => id === virtualId ? resolvedId : null,
    load: id => id === resolvedId ? decoderSource : null,
    transform(source, id) {
      if (/[/\\]src[/\\].*\.wgsl\?raw$/.test(id)) {
        // compact-wgsl's raw loader emits an exact JSON string, never executable shader code.
        if (!source.startsWith('export default ')) return null;
        const code = JSON.parse(source.slice('export default '.length)) as string, packed = packWgsl(code);
        if (code.length - packed.length < 24) return null;
        return { code: `import {decodeWgsl} from '${virtualId}';export default decodeWgsl(${JSON.stringify(packed)})`, map: null };
      }
      return /[/\\]src[/\\].*\.ts$/.test(id) && /\/\*\s*wgsl\s*\*\//.test(source) ? packMarkedWgsl(source, id) : null;
    },
  };
}
