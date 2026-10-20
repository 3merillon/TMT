/** SIM_EXTENSIONS (plan §5.5, APPEND-ONLY per §7.3): how W2+ simulation features (trees, coarse water, objectives,
 * hazards) plug into the frozen GameSimulation without editing it. Each stream appends ONE factory line to the array,
 * tagged `// <STREAM-ID>`; conflicts resolve by union.
 *
 * Contract for every extension (checked by buildExtensions):
 * - `id` is unique; hooks run in registration order (plan §4.3: trees, then coarse water, then objectives);
 * - it implements `snapshot()` and `restore()`: its whole state, as plain JSON, goes into checkpoints and the match hash;
 * - it is deterministic: randomness only from `SimContext.rng(stream)`, time only from `SimContext.tick` (N4);
 * - `traceSegment` is a pure query (previews and brains trace too), and presentation never feeds it (N5).
 * A factory returns null when the setup does not use the feature. */
import type { MatchSetup } from '../api/match';
import type { SimExtension } from '../api/extensions';

export type SimExtensionFactory = (setup: MatchSetup) => SimExtension | null;

export const SIM_EXTENSIONS: SimExtensionFactory[] = [
];

/** The extensions of a match, in registration order. Throws for a duplicate id or a missing snapshot/restore (I3). */
export function buildExtensions(setup: MatchSetup, registry: readonly SimExtensionFactory[] = SIM_EXTENSIONS): SimExtension[] {
  const extensions: SimExtension[] = [];
  for (const factory of registry) {
    const extension = factory(setup);
    if (!extension) continue;
    validateExtension(extension, extensions);
    extensions.push(extension);
  }
  return extensions;
}

export function validateExtension(extension: SimExtension, existing: readonly SimExtension[] = []): void {
  if (typeof extension.id !== 'string' || !extension.id) throw new Error('A sim extension needs a non-empty id');
  if (existing.some(other => other.id === extension.id)) throw new Error(`Sim extension '${extension.id}' is registered twice`);
  if (typeof extension.snapshot !== 'function' || typeof extension.restore !== 'function')
    throw new Error(`Sim extension '${extension.id}' must implement snapshot() and restore() (plan §5.5)`);
}
