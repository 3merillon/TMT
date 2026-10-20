/**
 * `Math.hypot` without the call: the builtin is variadic, is never inlined and allocates its argument buffer on every
 * call (a third of a belt solve's garbage). These are the same max-scaled Kahan summation, operation for operation, so
 * the results are bit-identical to the builtin (tests/kit-hypot.test.ts pins that on the running engine). The special
 * results come from computed values (max, x + y), not constants: a constant would box every inlined result.
 */
export function hypot2(x: number, y: number): number {
  const ax = Math.abs(x), ay = Math.abs(y);
  let max = 0;
  if (ax > max) max = ax;
  if (ay > max) max = ay;
  let result: number;
  if (max === Infinity) result = max;
  else if (x !== x || y !== y) result = x + y;
  else if (max === 0) result = max;
  else {
    let sum = 0, compensation = 0;
    let n = ax / max, summand = n * n - compensation, preliminary = sum + summand;
    compensation = (preliminary - sum) - summand; sum = preliminary;
    n = ay / max; summand = n * n - compensation; preliminary = sum + summand;
    compensation = (preliminary - sum) - summand; sum = preliminary;
    result = Math.sqrt(sum) * max;
  }
  return result;
}

export function hypot3(x: number, y: number, z: number): number {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let max = 0;
  if (ax > max) max = ax;
  if (ay > max) max = ay;
  if (az > max) max = az;
  let result: number;
  if (max === Infinity) result = max;
  else if (x !== x || y !== y || z !== z) result = x + y + z;
  else if (max === 0) result = max;
  else {
    let sum = 0, compensation = 0;
    let n = ax / max, summand = n * n - compensation, preliminary = sum + summand;
    compensation = (preliminary - sum) - summand; sum = preliminary;
    n = ay / max; summand = n * n - compensation; preliminary = sum + summand;
    compensation = (preliminary - sum) - summand; sum = preliminary;
    n = az / max; summand = n * n - compensation; preliminary = sum + summand;
    compensation = (preliminary - sum) - summand; sum = preliminary;
    result = Math.sqrt(sum) * max;
  }
  return result;
}

export function hypot4(x: number, y: number, z: number, w: number): number {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z), aw = Math.abs(w);
  let max = 0;
  if (ax > max) max = ax;
  if (ay > max) max = ay;
  if (az > max) max = az;
  if (aw > max) max = aw;
  let result: number;
  if (max === Infinity) result = max;
  else if (x !== x || y !== y || z !== z || w !== w) result = x + y + z + w;
  else if (max === 0) result = max;
  else {
    let sum = 0, compensation = 0;
    let n = ax / max, summand = n * n - compensation, preliminary = sum + summand;
    compensation = (preliminary - sum) - summand; sum = preliminary;
    n = ay / max; summand = n * n - compensation; preliminary = sum + summand;
    compensation = (preliminary - sum) - summand; sum = preliminary;
    n = az / max; summand = n * n - compensation; preliminary = sum + summand;
    compensation = (preliminary - sum) - summand; sum = preliminary;
    n = aw / max; summand = n * n - compensation; preliminary = sum + summand;
    compensation = (preliminary - sum) - summand; sum = preliminary;
    result = Math.sqrt(sum) * max;
  }
  return result;
}
