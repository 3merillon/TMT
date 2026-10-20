/** CPU-only storage/decode report; run outside GPU timing windows. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { compactMarkedWgsl, compactWgsl } from './compact-wgsl';
import { decoderSource, packWgsl } from './pack-wgsl';
const root = resolve(import.meta.dirname, '..');
const decode = new Function(decoderSource.replace('export function', 'function') + ';return decodeWgsl;')() as (code: string) => string;
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const corpus: string[] = [];
for (const file of walk(join(root, 'src'))) {
  if (file.endsWith('.wgsl')) { corpus.push(compactWgsl(readFileSync(file, 'utf8'))); continue; }
  if (!file.endsWith('.ts')) continue;
  const source = readFileSync(file, 'utf8'), code = compactMarkedWgsl(source, file)?.code ?? source;
  const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (n: ts.Node): void => {
    if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
      const start = n.getStart(ast);
      if (/\/\*\s*wgsl\s*\*\/\s*$/.test(code.slice(Math.max(0, start - 60), start))) {
        const raw = ts.isNoSubstitutionTemplateLiteral(n) ? [n.text] : [n.head.text, ...n.templateSpans.map(s => s.literal.text)];
        corpus.push(...raw.filter(s => s.length - packWgsl(s).length >= 24));
      }
    }
    ts.forEachChild(n, visit);
  }; visit(ast);
}
const unique = [...new Set(corpus)];
const packed = unique.map(source => { const code = packWgsl(source); if (decode(code) !== source) throw new Error('Decode changed shader text'); return code; });
let checksum = 0;
const once = () => { const start = performance.now(); for (const code of packed) checksum += decode(code).length; return performance.now() - start; };
for (let i = 0; i < 20; i++) once();
const rawMilliseconds = Array.from({ length: 100 }, once), ordered = [...rawMilliseconds].sort((a, b) => a - b);
const report = { environment: { node: process.version, platform: process.platform, arch: process.arch }, corpusChunks: packed.length,
  compactBytes: unique.reduce((sum, code) => sum + Buffer.byteLength(code), 0), packedBytes: packed.reduce((sum, code) => sum + Buffer.byteLength(code), 0),
  medianMilliseconds: ordered[50], p95Milliseconds: ordered[95], rawMilliseconds, checksum,
  note: 'CPU decode of the entire source shader corpus, including lazy/unused variants, after 20 warmups. Runtime expands each selected static chunk once at module initialization, never per frame. Not a browser startup or shader-compile timing.' };
if (process.argv[2]) writeFileSync(resolve(process.argv[2]), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, rawMilliseconds: undefined }));
