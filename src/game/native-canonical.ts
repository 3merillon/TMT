import type { RustTerrainCore } from '../gpu/terrain/rust-core';
import type { MatchSetup } from './api/match';
import { canonicalJson } from './rules/hash';

/** Only setup admission and extension-owned JSON cross inward. The fixed-tick
 * checksum and its binary comparison image read the resident owners directly. */
export class NativeCanonical {
  constructor(private readonly core: RustTerrainCore, private readonly id: number, setup: MatchSetup) {
    core.matchCommand(id, 59, [1, ...this.text(canonicalJson(setup))]);
  }
  checkpoint(extensions: Record<string, unknown>): { hash: string; tick: number; bytes: number } {
    const w = this.core.matchCommand(this.id, 60, this.text(canonicalJson(extensions)));
    return { hash: w[0].toString(16).padStart(8, '0') + w[1].toString(16).padStart(8, '0'), tick: w[2], bytes: w[3] };
  }
  /** Diagnostic comparison image; not a resumable physics save. */
  snapshot(extensions: Record<string, unknown> = {}): Uint8Array {
    return Uint8Array.from(this.core.matchCommand(this.id, 61, this.text(canonicalJson(extensions))));
  }
  private text(value: string): number[] {
    if (value.length > 1_048_576) throw new Error('Canonical text exceeds the engine limit');
    const words = new Array<number>(value.length + 1); words[0] = value.length;
    for (let i = 0; i < value.length; i++) words[i + 1] = value.charCodeAt(i); return words;
  }
}
