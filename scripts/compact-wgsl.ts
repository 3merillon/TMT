/** Build-only WGSL whitespace removal. Source shaders and their module line numbers stay readable. */
import MagicString from 'magic-string';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { Plugin } from 'vite';

function scanWgsl(code: string, startsLine = true, endsLiteral = true): { code: string; openComment: boolean } {
  let out = '', blockDepth = 0, lineComment = false, lineStart = startsLine;
  for (let i = 0; i < code.length; i++) {
    const c = code[i], next = code[i + 1];
    if (c === '\r' || c === '\n') {
      out += c; lineComment = false; lineStart = true;
      continue;
    }
    if (lineComment) continue;
    if (blockDepth) {
      if (c === '/' && next === '*') { blockDepth++; i++; }
      else if (c === '*' && next === '/') { blockDepth--; i++; }
      continue;
    }
    if (c === '/' && (next === '/' || next === '*')) {
      // A comment is lexical whitespace: never join the tokens on its two sides.
      if (!lineStart) out += ' ';
      if (next === '/') lineComment = true; else blockDepth = 1;
      i++; continue;
    }
    if (lineStart && (c === ' ' || c === '\t')) continue;
    out += c; lineStart = false;
  }
  // makeModule trims blank lines at the two ends. Keep an empty block comment
  // when stripping an edge comment would otherwise change that trim boundary.
  const originalLines = code.split(/(\r\n|\r|\n)/), lines = out.split(/(\r\n|\r|\n)/);
  const nonempty = originalLines.map((line, i) => i % 2 === 0 && line.trim() ? i : -1).filter(i => i >= 0);
  for (const i of [nonempty[0], nonempty[nonempty.length - 1]]) if (i !== undefined && !lines[i].trim()) lines[i] = '/**/';
  // Horizontal whitespace between punctuation and a token is redundant. Keep
  // identifier/number boundaries and every possible compound operator boundary
  // (including comment openers); do not touch interpolation edges or newlines.
  const compact = lines.join('').replace(/([^\s])([ \t]+)(?=[^\s])/g, (_match, left: string, gap: string, offset: number, text: string) => {
    const right = text[offset + left.length + gap.length];
    const lexical = /[\w.]/.test(left) && /[\w.]/.test(right);
    const operators = /[<>=!&|+*\/%^~-]/.test(left) && /[<>=!&|+*\/%^~-]/.test(right);
    return left + (lexical || operators ? ' ' : '');
  }).replace(/[ \t]+(?=\r?\n)/g, '')
    // WGSL accepts a decimal point without fractional digits. Change only whole
    // unsuffixed decimal floats; exponent, hex and interpolation token edges stay intact.
    .replace(/(?<![\w.])(\d+)\.0+(?![\w.])/g, (match: string, whole: string, offset: number, text: string) =>
      (!startsLine && offset === 0) || (!endsLiteral && offset + match.length === text.length) ? match : `${whole}.`)
    .replace(/(?<![\w.])0\.(\d+)(?![\w.])/g, (match: string, fraction: string, offset: number, text: string) =>
      (!startsLine && offset === 0) || (!endsLiteral && offset + match.length === text.length) ? match : `.${fraction}`);
  return { code: compact, openComment: blockDepth > 0 || lineComment };
}

/** Preserve every newline so linked shader diagnostics keep their original module line maps. */
export function compactWgsl(code: string): string { return scanWgsl(code).code; }

/** Only edits raw chunks of explicitly marked literals; TypeScript interpolation expressions are untouched. */
export function compactMarkedWgsl(source: string, id: string): { code: string; map: ReturnType<MagicString['generateMap']> } | null {
  if (!/\/\*\s*wgsl\s*\*\//.test(source)) return null;
  const ast = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const output = new MagicString(source);
  let changed = false;
  const visit = (node: ts.Node): void => {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const start = node.getStart(ast);
      if (/\/\*\s*wgsl\s*\*\/\s*$/.test(source.slice(Math.max(0, start - 60), start))) {
        const ranges: [number, number][] = ts.isNoSubstitutionTemplateLiteral(node)
          ? [[start + 1, node.end - 1]]
          : [[node.head.getStart(ast) + 1, node.head.end - 2], ...node.templateSpans.map(span => [span.literal.getStart(ast) + 1, span.literal.end - (ts.isTemplateTail(span.literal) ? 1 : 2)] as [number, number])];
        const raw = ranges.map(([a, b]) => source.slice(a, b));
        // Escapes change cooked WGSL characters. Leave those unusual literals alone.
        // An interpolation inside a comment must also remain commented after JS runs.
        if (!raw.some(chunk => chunk.includes('\\'))) {
          const chunks = raw.map((chunk, i) => scanWgsl(chunk, i === 0, i === raw.length - 1));
          if (!chunks.slice(0, -1).some(chunk => chunk.openComment)) {
            for (let i = 0; i < ranges.length; i++) if (chunks[i].code !== raw[i]) {
              // Edit each line separately so the generated source map retains the
              // original line for every WGSL statement, not just the literal start.
              const before = raw[i].split(/(\r\n|\r|\n)/), after = chunks[i].code.split(/(\r\n|\r|\n)/);
              let offset = ranges[i][0];
              for (let line = 0; line < before.length; line++) {
                if (before[line] !== after[line]) output.overwrite(offset, offset + before[line].length, after[line]);
                offset += before[line].length;
              }
              changed = true;
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return changed ? { code: output.toString(), map: output.generateMap({ source: id, includeContent: true, hires: true }) } : null;
}

export function compactWgslPlugin(): Plugin {
  return {
    name: 'tmt-compact-wgsl', apply: 'build', enforce: 'pre',
    load(id) {
      // The terrain uploader imports standalone shaders through Vite's raw loader.
      // Compact only WGSL assets in our source tree, preserving their diagnostic lines.
      if (!/[/\\]src[/\\].*\.wgsl\?raw$/.test(id)) return null;
      const path = id.slice(0, -4); this.addWatchFile(path);
      return { code: `export default ${JSON.stringify(compactWgsl(readFileSync(path, 'utf8')))}`, map: null };
    },
    transform(source, id) {
      if (!/[/\\]src[/\\].*\.ts$/.test(id)) return null;
      return compactMarkedWgsl(source, id);
    },
  };
}
