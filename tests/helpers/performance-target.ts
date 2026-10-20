import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

interface PerformanceTarget {
  name: string;
  value: number;
  target: number;
  unit: string;
  comparison: '<' | '<=';
}

/** Always report machine-dependent measurements; enforce targets only in the explicit performance command. */
export function reportPerformanceTarget({ name, value, target, unit, comparison }: PerformanceTarget): void {
  assert(Number.isFinite(value) && value >= 0, `${name}: measurement must be finite and nonnegative`);
  assert(Number.isFinite(target) && target >= 0, `${name}: target must be finite and nonnegative`);
  assert(comparison === '<' || comparison === '<=', `${name}: unsupported comparison`);
  const strict = process.env.npm_lifecycle_event === 'verify:performance';
  const within = comparison === '<' ? value < target : value <= target;
  const status = within ? 'WITHIN TARGET' : value > target ? 'ABOVE TARGET' : 'AT TARGET (strict < not met)';
  const mode = strict ? 'strict' : 'advisory';
  const message = `${name}: ${value} ${unit}; target ${comparison} ${target} ${unit}; ${status} (${mode})`;
  console.info(`[performance target] ${message}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const cell = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
    appendFileSync(summary, `\n| Performance target | Measured | Target | Result | Mode |\n| --- | --- | --- | --- | --- |\n| ${cell(name)} | ${value} ${cell(unit)} | ${cell(comparison)} ${target} ${cell(unit)} | ${status} | ${mode} |\n`, 'utf8');
  }
  if (strict) assert(within, message);
}
