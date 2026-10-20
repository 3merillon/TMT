import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactMarkedWgsl, compactWgsl, compactWgslPlugin } from '../scripts/compact-wgsl';

describe('build-only WGSL compaction', () => {
  it('removes nested comments and indentation while preserving tokens and every diagnostic line', () => {
    const source = '  let a/* outer /* nested */ still outer */=1u; // explanation\r\n  let b=a+/* operator boundary */+2u;\n /* multi\n line */ return b;\n';
    const result = compactWgsl(source);
    expect(result).toBe('let a=1u;\r\nlet b=a+ +2u;\n\nreturn b;\n');
    expect(result.match(/\r?\n/g)).toEqual(source.match(/\r?\n/g));
    expect(result.match(/[A-Za-z_]\w*|\d+u?|[^\s\w]/g)).toEqual(['let', 'a', '=', '1u', ';', 'let', 'b', '=', 'a', '+', '+', '2u', ';', 'return', 'b', ';']);
  });

  it('preserves interpolation expressions and unmarked templates byte-for-byte, with a source map', () => {
    const expr = '${({ text: `// JavaScript ${2}` }).text.length}';
    const source = 'const untouched = ` // keep JS text\n`; const shader = /* wgsl */ `\n  // shader comment\n  let value = ' + expr + ';\n`; return shader;';
    const result = compactMarkedWgsl(source, '/src/example.ts')!;
    expect(result.code).toContain('const untouched = ` // keep JS text\n`');
    expect(result.code).toContain(expr);
    expect(result.code).not.toContain('shader comment');
    expect(new Function(result.code)()).toBe('\n/**/\nlet value= 15;\n');
    expect(result.code.split('\n')).toHaveLength(source.split('\n').length);
    expect(result.map.sourcesContent).toEqual([source]);
    expect(result.map.mappings.length).toBeGreaterThan(0);
  });

  it('retains module trim boundaries when first or last code lines contain only comments', () => {
    const code = '\n  // header\n  let value = 1u;\n  // footer\n';
    expect(compactWgsl(code)).toBe('\n/**/\nlet value=1u;\n/**/\n');
    const template = 'return /* wgsl */ `/* header */ ${"let x = 1u;"}`';
    expect(new Function(compactMarkedWgsl(template, '/src/example.ts')!.code)()).toBe('/**/let x = 1u;');
  });

  it('leaves escaped templates and comments containing interpolations intact', () => {
    for (const source of ['const a = /* wgsl */ `// comment \\n let x=1;`;', 'const a = /* wgsl */ `/* ${name} */ let x=1;`;']) {
      expect(compactMarkedWgsl(source, '/src/example.ts')).toBeNull();
    }
    expect(compactWgslPlugin().apply).toBe('build');
  });

  it('preserves lexical boundaries while removing redundant horizontal spaces', () => {
    const source = 'let result : vec3f = vec3f(1.0, 2.0, 3.0);\n';
    expect(compactWgsl(source)).toBe('let result:vec3f=vec3f(1.,2.,3.);\n');
    for (const boundary of ['a b', '1 u', '1 .2', '. 2', '+ +', '- -', '/ /', '/ *', '< <', '> =', '& &', '| |']) {
      expect(compactWgsl(boundary)).toBe(boundary);
    }
    const template = 'return /* wgsl */ `let a = ${"1u"} + ${"2u"};`';
    expect(new Function(compactMarkedWgsl(template, '/src/example.ts')!.code)()).toBe('let a= 1u + 2u;');
  });

  it('shortens whole decimal floats without joining exponent, hex, identifier or interpolation tokens', () => {
    expect(compactWgsl('vec4f(0.0, -12.000, 0.125, 1.5)')).toBe('vec4f(0.,-12.,.125,1.5)');
    for (const value of ['0x1.0p0', '0X123.00P+1', '1.0e-3', '1.00E+2', '1.0f', '1.0h', 'identifier1.0', '1.0identifier', '1.0.0']) {
      expect(compactWgsl(value)).toBe(value);
    }
    const template = 'return /* wgsl */ `${"0x"}1.0${"p0"}; ${""} 2.0;`';
    expect(new Function(compactMarkedWgsl(template, '/src/example.ts')!.code)()).toBe('0x1.0p0;  2.;');
  });

  it('removes fractional leading zeroes only inside complete decimal float tokens', () => {
    expect(compactWgsl('vec3f(0.125, -0.5, 0.0001)')).toBe('vec3f(.125,-.5,.0001)');
    for (const value of ['0x0.125p0', '0X0.25P+1', '0.125e-3', '0.125E+2', '0.125f', '0.125h', 'identifier0.125', '00.125', '0.125.0']) {
      expect(compactWgsl(value)).toBe(value);
    }
    const template = 'return /* wgsl */ `${"0x"}0.125${"p0"}; 0.5;`';
    expect(new Function(compactMarkedWgsl(template, '/src/example.ts')!.code)()).toBe('0x0.125p0;.5;');
  });

  it('compacts standalone raw WGSL imports without claiming other raw assets', async () => {
    const file = resolve(import.meta.dirname, '../src/gpu/terrain/scan.wgsl'), source = readFileSync(file, 'utf8');
    const load = compactWgslPlugin().load as (this: unknown, id: string) => { code: string } | null;
    const watched: string[] = [], context = { addWatchFile: (path: string) => watched.push(path) };
    const result = load.call(context, `${file}?raw`)!;
    const transformed = JSON.parse(result.code.slice('export default '.length)) as string;
    expect(transformed).toBe(compactWgsl(source));
    expect(transformed.length).toBeLessThan(source.length);
    expect(transformed.split('\n')).toHaveLength(source.split('\n').length);
    expect(watched).toEqual([file]);
    expect(load.call(context, `${file}?url`)).toBeNull();
    expect(load.call(context, '/src/description.txt?raw')).toBeNull();
  });

  it('removes at least 10KB from marked engine shaders without editing the source files', () => {
    const root = resolve(import.meta.dirname, '../src/engine');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
    let saved = 0;
    for (const file of files(root)) {
      const source = readFileSync(file, 'utf8'), result = compactMarkedWgsl(source, file);
      if (result) saved += Buffer.byteLength(source) - Buffer.byteLength(result.code);
    }
    expect(saved).toBeGreaterThan(10_000);
  });
});
