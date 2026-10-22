/** Real detached resident geometry dropped into a natural basin. Local diagnostic only. */
import { session } from '../../src/game/api/session';
import { registerHooks } from '../../src/game/app/hooks';
import { cellDir } from '../../src/world/cube-grid';
import { add, mul, normalize, rotation, rotate } from '../../src/game/math';
import { structuralLiquidBox } from '../../src/game/structural-liquid';
import type { V3 } from '../../src/game/contracts';

export async function prepareChunkWater({ record = true } = {}) {
  const w = window as any, game = session() as any, world = game.world, physics = world.resident.physics;
  if (!physics.native) throw new Error('Chunk qualification requires native resident physics');
  let scale = 0, recording = false, reading = false;
  const samples: any[] = [], waves: any[] = [];
  let body: any, startTick = 0, probes: V3[] = [];
  registerHooks('chunk-water-qualification', { timeScale: () => scale, onFrame() {
    if (!record || !recording || !body) return;
    if (physics.tick !== samples.at(-1)?.tick) samples.push({ tick: physics.tick, position: { ...body.translation() }, velocity: { ...body.linvel() }, damping: body.linearDamping() });
    if (!reading && probes.length) {
      reading = true;
      void w.__tmtFluids.probe(probes).then((p: any[]) => waves.push({ tick: physics.tick, points: p })).finally(() => { reading = false; });
    }
  } });
  const basins = world.liquidBasins();
  let best: { up: V3; level: number; depth: number; rank: number } | undefined;
  for (let c = 0; c < basins.labels.length; c += 11) {
    const b = basins.basins[basins.labels[c] - 1]; if (b?.material !== 'water') continue;
    const up = cellDir(basins.n, c), hit = world.surface(up); if (!hit) continue;
    const depth = b.level - Math.hypot(...hit.point); if (depth < 2 || depth > 5) continue;
    const rank = Math.abs(depth - 3) + (1 - up[1]) * 2;
    if (!best || rank < best.rank) best = { up, level: b.level, depth, rank };
  }
  if (!best) throw new Error('No deep natural basin');
  // Cut a real building's lower support. Its retained top becomes a resident body.
  for (const structure of [...world.structures].sort((a: any, b: any) => b.halfSize[1] - a.halfSize[1]).slice(0, 8)) {
    const up = structure.axes?.[1] ?? [0,1,0], center = add(structure.center, mul(up, -structure.halfSize[1] * .65));
    game.view.setTerrain(await world.carve(center, Math.max(2, Math.hypot(structure.halfSize[0], structure.halfSize[2]) + .12)));
    if (physics.bodies.size) break;
  }
  const entries = [...physics.bodies.values()] as any[];
  const chosen = entries.filter(e => e.body.mass() > .1).sort((a, b) => b.body.mass() - a.body.mass())[0];
  if (!chosen) throw new Error('Support cuts did not detach a chunk');
  body = chosen.body;
  const lo: V3 = [Infinity,Infinity,Infinity], hi: V3 = [-Infinity,-Infinity,-Infinity];
  for (const shape of chosen.candidate.colliders) {
    const box = structuralLiquidBox(shape);
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], box.center[a] - box.half[a]); hi[a] = Math.max(hi[a], box.center[a] + box.half[a]); }
  }
  const localCenter = lo.map((v,a) => (v+hi[a])/2) as V3, half = lo.map((v,a) => (hi[a]-v)/2) as V3;
  const q = rotation(best.up, .3), offset = rotate(localCenter, q), start = add(mul(best.up, best.level + half[1] + 1.2), mul(offset,-1));
  body.setRotation({ x:q[0],y:q[1],z:q[2],w:q[3] }, false);
  body.setTranslation({ x:start[0],y:start[1],z:start[2] }, false);
  body.setLinvel({ x:-best.up[0]*2,y:-best.up[1]*2,z:-best.up[2]*2 }, false);
  body.setAngvel({ x:.3,y:.2,z:.4 }, false); body.wakeUp(); world.resident.syncPoses();
  const mid = mul(best.up,best.level), tangent = rotate([1,0,0],q), forward = rotate([0,0,1],q);
  probes = [mid];
  for (const radius of [1,2,3]) for (let i=0;i<8;i++) {
    const angle=i*Math.PI/4;
    probes.push(mul(normalize(add(mid,add(mul(tangent,radius*Math.cos(angle)),mul(forward,radius*Math.sin(angle))))),best.level));
  }
  w.__tmtFluids.lookAt(mid, 2.6, 6);
  const baseline = await w.__tmtFluids.probe(probes);
  w.__chunkWater = { samples, waves, site: best, chunkId: chosen.candidate.id, half, baseline,
    drop() { startTick=physics.tick; recording=true; scale=.35; },
    rise() { const up=best!.up; body.setLinvel({ x:up[0]*20,y:up[1]*20,z:up[2]*20 },true); },
    finish() {
      recording=false; scale=0;
      const speed=(p:any)=>Math.hypot(...p.velocity);
      const baseSpeed=Math.max(...baseline.map(speed)), peakSpeed=Math.max(0,...waves.flatMap(x=>x.points.map(speed)));
      const maxDamping=Math.max(...samples.map(s=>s.damping));
      const firstWet=samples.findIndex(s=>s.damping>.5), emerged=firstWet>=0 && samples.slice(firstWet+1).some(s=>s.damping<.16);
      const crossed=samples.some(s=>Math.hypot(s.position.x+offset[0],s.position.y+offset[1],s.position.z+offset[2])<best!.level);
      if (!crossed || maxDamping < .5) throw new Error(`Chunk did not enter water with drag: ${JSON.stringify({crossed,maxDamping})}`);
      if (peakSpeed < baseSpeed+.02) throw new Error(`No measurable chunk wake: ${baseSpeed} -> ${peakSpeed}`);
      if (!emerged) throw new Error('Chunk did not emerge and recover dry damping');
      return { chunkId:chosen.candidate.id, native:true, ticks:physics.tick-startTick, crossed, emerged, maxDamping, baselineSpeed:baseSpeed, peakWaterSpeed:peakSpeed, samples:samples.length, probes:waves.length,
        validationErrors:w.__tmtGame.performance.validationErrors, compileErrors:w.__tmtGame.performance.compileErrors };
    } };
  return { chunkId:chosen.candidate.id, colliders:chosen.candidate.colliders.length, half, site:best };
}
