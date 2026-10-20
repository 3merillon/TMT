/**
 * WGSL modules as tagged templates.
 *
 *   export const depthWgsl = wgsl('depth', [frameWgsl])`fn linear_depth(d: f32) -> f32 { ... }`;
 *
 * - A module is `{ name, deps, code }`. Interpolating another module (`${packingWgsl}`) adds it as a dependency and
 *   inserts nothing; strings, numbers and booleans are inserted verbatim.
 * - `link(...roots)` emits dependencies before dependents (DFS post-order, first-seen order among siblings), each module
 *   once (deduplicated by name; the same name with different code throws, which catches TS/WGSL drift), and returns a
 *   line map so compiler messages can be reported as `module:line`.
 * - `tsConst({...})` generates typed WGSL constants from TS values (N3: WGSL constants that mirror TS come from TS).
 * - `wgslStruct(name, fields)` computes the WGSL host-shareable layout (offsets, size) and emits both the WGSL struct
 *   declaration and a TS packer from the same field list, so the two cannot drift.
 */
import type { LinkedWgsl, WgslLineMapEntry, WgslModule } from '../contracts';

export type WgslValue = string | number | boolean | WgslModule;

export function isWgslModule(v: unknown): v is WgslModule {
  return !!v && typeof v === 'object' && typeof (v as WgslModule).name === 'string' && typeof (v as WgslModule).code === 'string'
    && Array.isArray((v as WgslModule).deps);
}

/** Tagged-template module factory. */
export function wgsl(name: string, deps: readonly WgslModule[] = []) {
  return (strings: TemplateStringsArray, ...values: WgslValue[]): WgslModule => {
    const all: WgslModule[] = [...deps];
    let code = strings[0];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (isWgslModule(v)) { if (!all.includes(v)) all.push(v); }
      else code += String(v);
      code += strings[i + 1];
    }
    return makeModule(name, code, all);
  };
}

/** A module from a plain string (e.g. generated code). */
export function makeModule(name: string, code: string, deps: readonly WgslModule[] = []): WgslModule {
  if (!name) throw new Error('WGSL module needs a name');
  return Object.freeze({ name, deps: Object.freeze([...deps]), code: trimBlock(code) });
}

function trimBlock(code: string): string {
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.map(l => l.replace(/\s+$/, '')).join('\n');
}

/** Dependency order: every dependency before its first dependent; each name once. */
export function linkOrder(roots: readonly WgslModule[]): WgslModule[] {
  const order: WgslModule[] = [];
  const byName = new Map<string, WgslModule>();
  const visiting = new Set<string>();
  const visit = (m: WgslModule, path: string[]) => {
    const seen = byName.get(m.name);
    if (seen) {
      if (seen !== m && seen.code !== m.code) throw new Error(`WGSL link: two different modules named "${m.name}" (${path.join(' → ')})`);
      return;
    }
    if (visiting.has(m.name)) throw new Error(`WGSL link: dependency cycle ${[...path, m.name].join(' → ')}`);
    visiting.add(m.name);
    for (const d of m.deps) visit(d, [...path, m.name]);
    visiting.delete(m.name);
    // A diamond may have registered this name while visiting deps.
    const again = byName.get(m.name);
    if (again) { if (again.code !== m.code) throw new Error(`WGSL link: two different modules named "${m.name}"`); return; }
    byName.set(m.name, m);
    order.push(m);
  };
  for (const r of roots) visit(r, []);
  return order;
}

export function link(...roots: WgslModule[]): LinkedWgsl {
  const order = linkOrder(roots);
  const lines: string[] = [];
  const lineMap: WgslLineMapEntry[] = [];
  for (const m of order) {
    lines.push(`// ── ${m.name} ──`);
    const start = lines.length + 1;
    const body = m.code.length ? m.code.split('\n') : [];
    lines.push(...body);
    lineMap.push({ module: m.name, start, end: start + body.length - 1 });
  }
  const code = lines.join('\n') + '\n';
  return {
    code, lineMap, modules: order.map(m => m.name),
    mapLine(line: number) {
      for (const e of lineMap) if (line >= e.start && line <= e.end) return { module: e.module, line: line - e.start + 1 };
      return { module: '(link)', line };
    },
  };
}

// ───────────────────────────── TS → WGSL constants ─────────────────────────────
export type WgslConstType = 'u32' | 'i32' | 'f32' | 'bool';
export type ConstSpec = number | boolean | { value: number | boolean; type: WgslConstType };

export function formatConst(value: number | boolean, type: WgslConstType): string {
  if (type === 'bool') return value ? 'true' : 'false';
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`tsConst: non-finite value ${value}`);
  if (type === 'u32') {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`tsConst: ${n} is not a u32`);
    return `${n}u`;
  }
  if (type === 'i32') {
    if (!Number.isInteger(n) || n < -0x80000000 || n > 0x7fffffff) throw new Error(`tsConst: ${n} is not an i32`);
    return `${n}i`;
  }
  // f32: shortest round-trip decimal; an integer still reads as a float literal ('3.0'); '1e-7' is a valid WGSL float.
  return Number.isInteger(n) && Math.abs(n) < 1e21 ? n.toFixed(1) : String(n);
}

export function inferConstType(v: number | boolean): WgslConstType {
  if (typeof v === 'boolean') return 'bool';
  if (Number.isInteger(v)) return v < 0 ? 'i32' : 'u32';
  return 'f32';
}

/** Typed WGSL `const` declarations from TS values. Non-negative integers → u32, negative → i32, others → f32. */
export function tsConstCode(values: Readonly<Record<string, ConstSpec>>): string {
  return Object.entries(values).map(([name, spec]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`tsConst: bad identifier ${name}`);
    const { value, type } = typeof spec === 'object' ? spec : { value: spec, type: inferConstType(spec) };
    return `const ${name}: ${type} = ${formatConst(value, type)};`;
  }).join('\n');
}

/** A module of generated constants. The default name derives from the keys, so identical tables dedupe on link. */
export function tsConst(values: Readonly<Record<string, ConstSpec>>, name = `const:${Object.keys(values).join(',')}`): WgslModule {
  return makeModule(name, tsConstCode(values));
}

// ───────────────────────────── Structs: WGSL + TS packer from one field list ─────────────────────────────
export type WgslPrimitive = 'f32' | 'u32' | 'i32' | 'vec2f' | 'vec3f' | 'vec4f' | 'vec2u' | 'vec3u' | 'vec4u' | 'vec2i' | 'vec3i' | 'vec4i'
  | 'mat2x2f' | 'mat3x3f' | 'mat4x4f';
export type WgslFieldType = WgslPrimitive | { array: WgslPrimitive; count: number };

interface PrimInfo { align: number; size: number; scalar: 'f32' | 'u32' | 'i32'; /** components, column padding described by cols/rows */ cols: number; rows: number }
const PRIM: Record<WgslPrimitive, PrimInfo> = {
  f32: { align: 4, size: 4, scalar: 'f32', cols: 1, rows: 1 },
  u32: { align: 4, size: 4, scalar: 'u32', cols: 1, rows: 1 },
  i32: { align: 4, size: 4, scalar: 'i32', cols: 1, rows: 1 },
  vec2f: { align: 8, size: 8, scalar: 'f32', cols: 1, rows: 2 }, vec2u: { align: 8, size: 8, scalar: 'u32', cols: 1, rows: 2 }, vec2i: { align: 8, size: 8, scalar: 'i32', cols: 1, rows: 2 },
  vec3f: { align: 16, size: 12, scalar: 'f32', cols: 1, rows: 3 }, vec3u: { align: 16, size: 12, scalar: 'u32', cols: 1, rows: 3 }, vec3i: { align: 16, size: 12, scalar: 'i32', cols: 1, rows: 3 },
  vec4f: { align: 16, size: 16, scalar: 'f32', cols: 1, rows: 4 }, vec4u: { align: 16, size: 16, scalar: 'u32', cols: 1, rows: 4 }, vec4i: { align: 16, size: 16, scalar: 'i32', cols: 1, rows: 4 },
  mat2x2f: { align: 8, size: 16, scalar: 'f32', cols: 2, rows: 2 },
  mat3x3f: { align: 16, size: 48, scalar: 'f32', cols: 3, rows: 3 },
  mat4x4f: { align: 16, size: 64, scalar: 'f32', cols: 4, rows: 4 },
};
const roundUp = (a: number, n: number) => Math.ceil(n / a) * a;

export interface WgslStructField { readonly name: string; readonly type: WgslFieldType; readonly offset: number; readonly size: number }
export interface WgslStruct {
  readonly name: string;
  readonly module: WgslModule;
  readonly size: number;
  readonly align: number;
  readonly fields: readonly WgslStructField[];
  readonly offsets: Readonly<Record<string, number>>;
  /** Write values (flat, column-major for matrices) into `out` at `baseOffset`; returns `out`. Missing fields are left as-is. */
  pack(values: Readonly<Record<string, number | ArrayLike<number>>>, out?: ArrayBuffer, baseOffset?: number): ArrayBuffer;
}

function typeName(t: WgslFieldType): string {
  return typeof t === 'string' ? t : `array<${t.array}, ${t.count}>`;
}

/**
 * Layout per the WGSL spec. `uniform: true` (default) applies the uniform address-space rules: array strides and the
 * struct alignment round up to 16.
 */
export function wgslStruct(name: string, fields: readonly (readonly [string, WgslFieldType])[], options: { uniform?: boolean } = {}): WgslStruct {
  const uniform = options.uniform ?? true;
  let offset = 0;
  let maxAlign = 4;
  const out: WgslStructField[] = [];
  const offsets: Record<string, number> = {};
  for (const [fname, ftype] of fields) {
    let align: number; let size: number;
    if (typeof ftype === 'string') { align = PRIM[ftype].align; size = PRIM[ftype].size; }
    else {
      const p = PRIM[ftype.array];
      align = uniform ? roundUp(16, p.align) : p.align;
      const stride = uniform ? roundUp(16, roundUp(p.align, p.size)) : roundUp(p.align, p.size);
      size = stride * ftype.count;
    }
    offset = roundUp(align, offset);
    out.push({ name: fname, type: ftype, offset, size });
    offsets[fname] = offset;
    offset += size;
    maxAlign = Math.max(maxAlign, align);
  }
  const structAlign = maxAlign;
  const size = roundUp(structAlign, offset);
  const code = `struct ${name} {\n${out.map(f => `  ${f.name}: ${typeName(f.type)},`).join('\n')}\n}`;
  const module = makeModule(`struct:${name}`, code);

  const writePrim = (view: DataView, at: number, p: PrimInfo, src: ArrayLike<number>, srcAt: number) => {
    // Matrices: columns padded to vec2/vec4 alignment; vec3 columns (mat3x3f) are padded to 16 B.
    const colStride = p.cols > 1 ? (p.rows === 2 ? 8 : 16) : 0;
    let k = srcAt;
    for (let c = 0; c < p.cols; c++) {
      for (let r = 0; r < p.rows; r++) {
        const byte = at + c * colStride + r * 4;
        const v = src[k++] ?? 0;
        if (p.scalar === 'f32') view.setFloat32(byte, v, true);
        else if (p.scalar === 'u32') view.setUint32(byte, v >>> 0, true);
        else view.setInt32(byte, v | 0, true);
      }
    }
    return k;
  };

  return {
    name, module, size, align: structAlign, fields: out, offsets,
    pack(values, target = new ArrayBuffer(size), baseOffset = 0) {
      const view = new DataView(target);
      for (const f of out) {
        const v = values[f.name];
        if (v === undefined) continue;
        const src: ArrayLike<number> = typeof v === 'number' ? [v] : v;
        if (typeof f.type === 'string') writePrim(view, baseOffset + f.offset, PRIM[f.type], src, 0);
        else {
          const p = PRIM[f.type.array];
          const stride = f.size / f.type.count;
          const per = p.cols * p.rows;
          for (let i = 0; i < f.type.count && i * per < src.length; i++) writePrim(view, baseOffset + f.offset + i * stride, p, src, i * per);
        }
      }
      return target;
    },
  };
}
