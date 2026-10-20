/** Every current simulation file must remain independent of wall-clock time and ambient randomness. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkSources, isSimFile, listFiles } from '../scripts/guards';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('N4 (no wall clock or Math.random in sim code)', () => {
  it("passes at 'error' for every simulation file", () => {
    const files = listFiles(root).filter(isSimFile);
    // Not vacuous: the simulation, the rules core, the brains, the munitions table and the weather are all covered.
    for (const expected of ['src/game/simulation.ts', 'src/game/rules/ballistics.ts', 'src/game/rules/tempo.ts', 'src/game/ai/brain.ts',
      'src/game/ai/random.ts', 'src/game/munitions.ts', 'src/world/weather.ts', 'src/game/structural-physics.ts',
      'src/game/realtime/core.ts', 'src/game/vehicle/chassis.ts']) expect(files).toContain(expected);
    const findings = checkSources({ files, read: file => readFileSync(resolve(root, file), 'utf8'), n4Mode: 'error' });
    expect(findings.filter(finding => finding.level === 'error')).toEqual([]);
  });
});
