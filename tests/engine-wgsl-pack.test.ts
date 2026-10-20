import { describe, expect, it } from 'vitest';
import { decoderSource, packMarkedWgsl, packWgsl, unpackWgsl, WGSL_TOKENS } from '../scripts/pack-wgsl';
import { compactWgsl } from '../scripts/compact-wgsl';

const decode = new Function(decoderSource.replace('export function', 'function') + ';return decodeWgsl;')() as typeof unpackWgsl;
function evaluate(source: string, variables: Record<string, unknown> = {}) {
  const packed = packMarkedWgsl(source, '/src/example.ts')!;
  const executable = packed.code.replace(/import \{decodeWgsl as (\w+)\} from '[^']+';/, 'const $1 = decode;');
  return new Function('decode', ...Object.keys(variables), executable)(decode, ...Object.values(variables));
}
describe('reversible build WGSL dictionary', () => {
  it('round trips every dictionary entry, markers, token substrings, CRLF and Unicode exactly', () => {
    expect(WGSL_TOKENS.length).toBeLessThanOrEqual(62);
    const source = [...WGSL_TOKENS, '$A $z $0 $$ $$$ $?', 'prefixtextureSampleLevelSuffix', '\r\n\n', 'λ ☀ 中文'].join(' ');
    expect(unpackWgsl(packWgsl(source))).toBe(source);
    expect(decode(packWgsl(source))).toBe(source);
  });
  it('expands a literal before its consumer and preserves every diagnostic newline', () => {
    const shader = compactWgsl('@group(1) @binding(0) var tex: texture_2d<f32>;\r\nfn f() -> vec4f { return textureLoad(tex, vec2i(0), 0); }\n');
    const value = evaluate('return /* wgsl */ `' + shader + '`;');
    // JavaScript normalizes template CRLF to LF before either packed or ordinary execution.
    expect(value).toBe(new Function('return `' + shader + '`')());
    expect(value.split('\n')).toHaveLength(shader.split('\n').length);
  });
  it('leaves arbitrary interpolated marker text and JavaScript evaluation order intact', () => {
    const fragment = 'textureSampleLevel textureDimensions textureLoad textureStore return vec4f ';
    const source = 'return /* wgsl */ `' + fragment + '${next()}' + fragment + '${"$A $$"}' + fragment + '`;';
    const calls: number[] = [], value = evaluate(source, { next: () => { calls.push(1); return '$B'; } });
    expect(value).toBe(fragment + '$B' + fragment + '$A $$' + fragment);
    expect(calls).toEqual([1]);
  });
  it('does not pack ordinary templates or change cooked-string escapes', () => {
    expect(packMarkedWgsl('return `textureDimensions textureSampleLevel textureLoad`;', '/src/example.ts')).toBeNull();
    expect(packMarkedWgsl('return /*wgsl*/ `textureDimensions textureSampleLevel \\n textureLoad`;', '/src/example.ts')).toBeNull();
  });
  it('expands factory text only once when the module loads', () => {
    const source = 'return () => /*wgsl*/ `textureDimensions textureSampleLevel textureLoad textureStore texture_storage_2d`;';
    const packed = packMarkedWgsl(source, '/src/example.ts')!;
    const executable = packed.code.replace(/import \{decodeWgsl as (\w+)\} from '[^']+';/, 'const $1 = decode;');
    let calls = 0;
    const factory = new Function('decode', executable)((value: string) => { calls++; return decode(value); });
    expect(calls).toBe(1); expect(factory()).toBe(factory()); expect(calls).toBe(1);
  });
});
