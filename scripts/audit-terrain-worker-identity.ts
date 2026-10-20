/** Run the actual worker compile/pack/merge algorithm serially to isolate partition-dependent arithmetic.
 * This measures identity, not parallel performance. All evidence must go to an explicit external directory. */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { initialPartitions } from '../src/gpu/terrain/page-workers';
import { packPages, unpackPages } from '../src/gpu/terrain/page-packet';
import type { PlanetType } from '../src/game/planet-field';
import type { CompiledRegionPage } from '../src/gpu/terrain/contracts';

const flags = new Map(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return [arg.slice(0, at), arg.slice(at + 1)]; }));
if (!flags.get('--out')) throw new Error('Pass --out=G:/tmt-work/terrain-cpu-core/identity');
const out = resolve(flags.get('--out')!); mkdirSync(out, { recursive: true });
const seeds = (flags.get('--seeds') ?? '7').split(',').map(Number);
const counts = (flags.get('--workers') ?? '8,4,1').split(',').map(Number);
const kinds = (flags.get('--kinds') ?? 'temperate').split(',') as PlanetType[];
const word = Buffer.alloc(8);
const bits = (value: number) => { word.writeDoubleLE(value); return word.toString('hex'); };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const results: unknown[] = [];
for (const seed of seeds) for (const kind of kinds) {
  let oracle: { vertices: Map<string, string>; pages: Map<string, string>; regions: Map<string, string> } | undefined;
  for (const count of counts) {
    globalThis.gc?.();
    const start = performance.now(), input = residentPlanet(seed, undefined, 'resident-f32-game-v3', kind);
    const create = () => new ResidentArrangement(residentLattice(input.bounds), input.sources, 2048, true, true, true);
    const main = create(), requests = main.lattice.brickOrder.map(brick => ({ brick, tets: null }));
    const partitions = initialPartitions(requests, count), pages = new Map<string, CompiledRegionPage>();
    for (const partition of partitions) {
      const worker = create();
      for (const page of main.acceptCompiled(unpackPages(packPages(worker.compileTets(partition, 1, []))))) pages.set(page.brick, page);
    }
    const vertices = new Map<string, string>();
    for (const vertex of main.vertices) vertices.set(vertex.key, JSON.stringify(vertex.position.map(bits)));
    const regions = new Map<string, string>(), pageHashes = new Map<string, string>();
    const face = (f: { source: string; vertices: readonly number[] }) => [f.source, f.vertices.map(id => main.vertices[id].position.map(bits))];
    for (const request of requests) {
      const page = pages.get(request.brick)!;
      const rows = page.regions.map(r => {
        const row = [r.id, r.source, r.material, r.anchor, r.constraints, bits(r.volume), r.faces.map(face), r.sourceFaces?.map(face)];
        regions.set(r.id, hash(row)); return row;
      });
      pageHashes.set(page.brick, hash([bits(page.removedVolume), Array.from(page.tetRemoved ?? [], bits), rows]));
    }
    const diff = (a: Map<string, string>, b: Map<string, string>) => {
      let changed = 0, missing = 0; const examples: unknown[] = [];
      for (const [key, value] of a) if (b.get(key) !== value) { changed++; if (!b.has(key)) missing++; if (examples.length < 4) examples.push({ key, reference: value, actual: b.get(key) }); }
      let extra = 0; for (const key of b.keys()) if (!a.has(key)) extra++;
      return { changed, missing, extra, examples };
    };
    const result = { seed, kind, workers: count, referenceWorkers: counts[0], milliseconds: performance.now() - start,
      pages: pages.size, recipes: vertices.size, regions: regions.size, digest: hash([...pageHashes]),
      ...(oracle ? { difference: { vertices: diff(oracle.vertices, vertices), pages: diff(oracle.pages, pageHashes), regions: diff(oracle.regions, regions) } } : {}) };
    results.push(result); console.log(JSON.stringify(result));
    oracle ??= { vertices, pages: pageHashes, regions };
    writeFileSync(join(out, 'worker-identity.json'), JSON.stringify({ scope: 'Sequential execution of unmodified worker partition/packet/merge code; not a parallel timing', results }, null, 2));
  }
}
