// Visibility gates (docs/visibility-architecture.md), evaluated in the page through
// window.__tmtVisibility. Paste as an eval step: the file is one async expression returning a JSON-able report.
(async () => {
  const V = window.__tmtVisibility;
  const stats = V.stats();
  let seed = 12345;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = v => Math.hypot(v[0], v[1], v[2]);
  const sensors = V.sensors();
  if (!sensors.length || !stats.sdfValid) return { error: 'no sensors or SDF not built', stats };
  const sensor = sensors[0];
  const voxel = stats.sdf.size ? 49 / stats.sdf.size : 0.25;

  // S3: the SDF at exact collision-surface points (same triangles as the render pages) should be ~0.
  const surfacePts = [];
  for (let i = 0; i < 1500; i++) {
    const hit = V.surface(norm([rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1]));
    if (hit) surfacePts.push(hit.point);
  }
  const sdfAt = await V.sdf(surfacePts);
  const abs = sdfAt.map(Math.abs).sort((a, b) => a - b);
  const within = f => abs.filter(d => d < f * voxel).length / Math.max(1, abs.length);
  const s3 = { points: abs.length, voxel, within025: within(0.25), within05: within(0.5), within1: within(1), p99: abs[Math.floor(abs.length * 0.99)], max: abs.at(-1) };

  // S4: surface points around the sensor. Truth = the simulation's exact ray (and its neighbours ±band tangentially);
  // points whose truth flips inside the band are penumbra and excluded.
  const truth = p => {
    const d = sub(sensor, p), l = len(d);
    return V.raycast(p, norm(d), Math.max(0, l - 0.05)) ? 0 : 1;
  };
  const band = 0.35;
  const probes = [], meta = [];
  const up = norm(sensor);
  for (let i = 0; probes.length < 1200 && i < 6000; i++) {
    // Directions within ~40° of the sensor: the region the player sees.
    const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 0.7;
    const t1 = norm(cross(up, Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), t2 = cross(up, t1);
    const dir = norm(add(add(up, t1, Math.cos(a) * r), t2, Math.sin(a) * r));
    const hit = V.surface(dir);
    if (!hit) continue;
    const n = hit.normal;
    const p = add(hit.point, n, 0.02);
    const tt1 = norm(cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), tt2 = cross(n, tt1);
    const t0 = truth(p);
    const flips = [add(p, tt1, band), add(p, tt1, -band), add(p, tt2, band), add(p, tt2, -band)].some(q => truth(q) !== t0);
    // Back faces: the simulation's ray starts on the rock and reads hidden; the renderer hides them softly too.
    probes.push({ position: hit.point, normal: n });
    meta.push({ t0, flips, n, p: hit.point, t1: tt1 });
  }
  const vis = await V.probe(probes);
  let hidden = 0, visible = 0, leaks = 0, falseHides = 0, penumbra = 0;
  meta.forEach((m, i) => {
    if (m.flips) { penumbra++; return; }
    if (m.t0 === 0) { hidden++; if (vis[i] > 0.5) leaks++; } else { visible++; if (vis[i] < 0.5) falseHides++; }
  });
  const s4 = { points: meta.length, penumbra, hidden, visible, leaks, leakRate: hidden ? leaks / hidden : 0, falseHides, falseHideRate: visible ? falseHides / visible : 0 };

  // Edge width: through penumbra points, sample the GPU visibility along the tangent across the boundary.
  const lines = meta.filter(m => m.flips).slice(0, 60);
  const steps = 31, span = 1.5;
  const linePts = [];
  for (const m of lines) for (let k = 0; k < steps; k++) {
    const s = -span + (2 * span * k) / (steps - 1);
    linePts.push({ position: add(m.p, m.t1, s), normal: m.n });
  }
  const lv = linePts.length ? await V.probe(linePts) : [];
  const widths = [];
  for (let l = 0; l < lines.length; l++) {
    const row = lv.slice(l * steps, (l + 1) * steps);
    const lo = Math.min(...row), hi = Math.max(...row);
    if (hi - lo < 0.8) continue;
    const at = level => { for (let k = 1; k < steps; k++) { const a = row[k - 1], b = row[k]; if ((a - level) * (b - level) <= 0 && a !== b) return -span + (2 * span * (k - 1 + (level - a) / (b - a))) / (steps - 1); } return null; };
    const x10 = at(0.1), x90 = at(0.9);
    if (x10 !== null && x90 !== null) widths.push(Math.abs(x90 - x10));
  }
  widths.sort((a, b) => a - b);
  const width = { lines: widths.length, median: widths[Math.floor(widths.length / 2)] ?? null, p10: widths[Math.floor(widths.length * 0.1)] ?? null, p90: widths[Math.floor(widths.length * 0.9)] ?? null };
  return { stats, s3, s4, width };
})()
