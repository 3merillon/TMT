/** Exact rational arithmetic over the actual IEEE-754 samples, used as a reference oracle. */
export interface Rational { readonly n: bigint; readonly d: bigint }
export type Exact3 = [Rational, Rational, Rational];
const abs = (x: bigint) => x < 0n ? -x : x;
export const gcd = (a: bigint, b: bigint): bigint => { a = abs(a); b = abs(b); while (b) { const t = a % b; a = b; b = t; } return a; };
export const ZERO: Rational = { n: 0n, d: 1n };
export const ONE: Rational = { n: 1n, d: 1n };
const numberView = new DataView(new ArrayBuffer(8));
export function rational(n: bigint, d = 1n): Rational {
  if (!d) throw new Error('Zero rational denominator');
  if (!n) return ZERO;
  if (d < 0n) { n = -n; d = -d; }
  if (d === 1n) return { n, d };
  const g = gcd(n, d); return { n: n / g, d: d / g };
}
export function fromNumber(x: number): Rational {
  if (!Number.isFinite(x)) throw new Error(`Non-finite exact input: ${x}`);
  if (x === 0) return ZERO;
  if (Number.isSafeInteger(x)) return { n: BigInt(x), d: 1n };
  numberView.setFloat64(0, x, false);
  const bits = numberView.getBigUint64(0, false), exponent = Number((bits >> 52n) & 2047n);
  let significand = bits & ((1n << 52n) - 1n);
  if (exponent !== 0) significand |= 1n << 52n;
  if (bits >> 63n) significand = -significand;
  const power = (exponent === 0 ? -1022 : exponent - 1023) - 52;
  return power >= 0 ? rational(significand << BigInt(power)) : rational(significand, 1n << BigInt(-power));
}
export const neg = (a: Rational): Rational => a.n ? { n: -a.n, d: a.d } : ZERO;
export function add(a: Rational, b: Rational): Rational {
  if (!a.n) return b; if (!b.n) return a;
  if (a.d === b.d) return rational(a.n + b.n, a.d);
  const g = gcd(a.d, b.d), ad = a.d / g, bd = b.d / g;
  const n = a.n * bd + b.n * ad;
  if (!n) return ZERO;
  // Reduced operands imply n is coprime to ad and bd; only their shared g can cancel.
  const h = g === 1n ? 1n : gcd(n, g);
  return { n: n / h, d: ad * (b.d / h) };
}
export const sub = (a: Rational, b: Rational): Rational => add(a, neg(b));
export function mul(a: Rational, b: Rational): Rational {
  if (!a.n || !b.n) return ZERO;
  if (a.n === a.d) return b; if (b.n === b.d) return a;
  const g = b.d === 1n ? 1n : gcd(a.n, b.d), h = a.d === 1n ? 1n : gcd(b.n, a.d);
  return { n: (a.n / g) * (b.n / h), d: (a.d / h) * (b.d / g) };
}
export function div(a: Rational, b: Rational): Rational {
  if (!b.n) throw new Error('Exact division by zero');
  return mul(a, b.n < 0n ? { n: -b.d, d: -b.n } : { n: b.d, d: b.n });
}
export const sign = (a: Rational): number => a.n < 0n ? -1 : a.n > 0n ? 1 : 0;
export const compare = (a: Rational, b: Rational): number => {
  const delta = a.d === b.d ? a.n - b.n : a.n * b.d - b.n * a.d;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
};
export const key = (a: Rational): string => `${a.n}/${a.d}`;
export function toNumber(a: Rational): number {
  if (!a.n) return 0;
  // Convert the numerator and denominator separately after scaling; Number(bigint)
  // alone can overflow even when their quotient is a perfectly ordinary number.
  const n = abs(a.n), nb = n.toString(2).length, db = a.d.toString(2).length;
  const ns = Math.max(0, nb - 53), ds = Math.max(0, db - 53);
  return (a.n < 0n ? -1 : 1) * (Number(n >> BigInt(ns)) / Number(a.d >> BigInt(ds))) * 2 ** (ns - ds);
}
export const pointKey = (p: Exact3): string => p.map(key).join(',');
export const exact3 = (p: readonly number[]): Exact3 => [fromNumber(p[0]), fromNumber(p[1]), fromNumber(p[2])];
export const number3 = (p: Exact3): [number, number, number] => [toNumber(p[0]), toNumber(p[1]), toNumber(p[2])];
export const vadd = (a: Exact3, b: Exact3): Exact3 => [add(a[0], b[0]), add(a[1], b[1]), add(a[2], b[2])];
export const vsub = (a: Exact3, b: Exact3): Exact3 => [sub(a[0], b[0]), sub(a[1], b[1]), sub(a[2], b[2])];
export const scale = (a: Exact3, t: Rational): Exact3 => [mul(a[0], t), mul(a[1], t), mul(a[2], t)];
export const dot = (a: Exact3, b: Exact3): Rational => add(add(mul(a[0], b[0]), mul(a[1], b[1])), mul(a[2], b[2]));
export const cross = (a: Exact3, b: Exact3): Exact3 => [sub(mul(a[1], b[2]), mul(a[2], b[1])), sub(mul(a[2], b[0]), mul(a[0], b[2])), sub(mul(a[0], b[1]), mul(a[1], b[0]))];
