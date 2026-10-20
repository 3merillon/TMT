/** Hardware WebGPU regression: full match arcs and lingering ammunition smoke. */
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..'), out = join(root, 'artifacts/shot-trails');
mkdirSync(out, { recursive: true });
const server = await createServer({ root, logLevel: 'warn', cacheDir: join(root, '.vite-capture/trails'), server: { host: '127.0.0.1', port: 0, open: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.TMT_CHROME ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgpu-developer-features', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [], report: Record<string, unknown> = {};
const detail = process.argv.includes('--detail');
page.on('pageerror', e => errors.push(String(e)));
page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
const run = <T = any>(code: string) => page.evaluate<T>(`(async()=>{const b=window.__tmtRenderBench, g=window.testSession; ${code}})()`);
try {
  for (const mode of detail ? ['drive'] : ['local', 'bot', 'drive']) {
    await page.goto(`${server.resolvedUrls!.local[0]}?mode=${mode}&seed=7&renderbench&engineDev`);
    await page.waitForFunction('window.__tmtGame?.ready', undefined, { timeout: 240000 });
    await page.evaluate(`import('/src/game/api/session.ts').then(m=>window.testSession=m.session())`);
    await run('await b.step(12)');
    await run(`const rig=b.state().camera,d=rig.position.map((v,i)=>v-rig.target[i]),u=rig.up;
      const cross=[u[1]*d[2]-u[2]*d[1],u[2]*d[0]-u[0]*d[2],u[0]*d[1]-u[1]*d[0]],dot=u.reduce((s,v,i)=>s+v*d[i],0),a=.9;
      b.configure({camera:{...rig,position:d.map((v,i)=>rig.target[i]+v*Math.cos(a)+cross[i]*Math.sin(a)+u[i]*dot*(1-Math.cos(a)))}});await b.step(4);`);
    const arc = await run(`const perf=window.__tmtGame.performance, path=g.preview(g.observer,true); return {trajectory:perf.trajectory,readout:perf.trajectoryReadout,path,phase:g.snapshot.phase,settings:JSON.parse(localStorage.getItem('tmt.progress.v2'))?.settings.gameplay};`);
    report[mode] = arc;
    console.log(mode, JSON.stringify({ trajectory: arc.trajectory, phase: arc.phase, readout: arc.readout }));
    assert.ok(arc.trajectory.anchored && arc.trajectory.points > 2, `${mode}: full arc`);
    assert.deepEqual(arc.trajectory.target, arc.path.at(-1));
    await page.screenshot({ path: join(out, `${mode}-arc.png`) });
  }
  for (const ammo of detail ? ['explosive', 'heavy'] : ['explosive', 'heavy', 'incendiary', 'nuclear']) {
    if (ammo !== 'explosive') { await run('await g.restart();'); await page.waitForFunction('window.__tmtGame?.ready', undefined, { timeout: 240000 }); }
    if (detail && ammo === 'heavy') await page.setViewportSize({ width: 390, height: 844 });
    await run(`b.configure({simulationScale:1,graphics:{tier:'${detail && ammo === 'heavy' ? 'low' : 'high'}',fisheye:0,miniature:0,grain:0}}); await b.step(5);
      const t=g.snapshot.tanks[0]; if(!g.command(0,{k:'munition',id:'${ammo}'})||!g.command(0,{k:'aim',yaw:t.turretYaw,pitch:.95,power:.65}))throw Error('Aim rejected');
      if(!g.command(0,{k:'fire'}))throw Error('Fire rejected'); await b.step(24);`);
    const flight = await run('return {trail:window.__tmtGame.performance.projectileTrails,projectiles:g.snapshot.projectiles,engine:b.state().engine};');
    assert.ok(flight.trail.particles > 10 && flight.trail.emitters > 0, `${ammo}: trail in flight`);
    await page.screenshot({ path: join(out, `${ammo}-flight.png`) });
    let remaining = 900;
    while (await run('return g.snapshot.projectiles.length') && remaining-- > 0) await run('await b.step(1)');
    const linger = await run('return window.__tmtGame.performance.projectileTrails;');
    assert.ok(remaining > 0 && linger.particles > 0 && linger.emitters === 0, `${ammo}: lingering smoke after impact`);
    await page.screenshot({ path: join(out, `${ammo}-linger.png`) });
    await run('b.configure({simulationScale:0}); await b.step(110);');
    assert.equal(await run('return window.__tmtGame.performance.projectileTrails.particles;'), 0);
    assert.equal(flight.engine.validationErrors, 0); assert.equal(flight.engine.compile.errors, 0);
    report[ammo] = { flight: flight.trail, linger }; console.log(ammo, JSON.stringify(report[ammo]));
  }
  if (detail) {
    const liquid = await run(`const {cellDir}=await import('/src/world/cube-grid.ts'),{liquidResistance}=await import('/src/game/vehicle/liquid-motion.ts');
      const s=g.world.liquidBasins(), f=g.view.fluidsDebug(); let selected;
      for(let c=0;c<s.labels.length;c+=7){const label=s.labels[c];if(!label)continue;const basin=s.basins[label-1],hit=g.world.footprintSurface.surface(cellDir(s.n,c));
        if(hit&&basin.level-Math.hypot(...hit.point)>1.7){selected={point:hit.point,level:basin.level,material:basin.material};break;}}
      if(!selected)throw Error('No deep basin');const {rotation,normalize,add,mul}=await import('/src/game/math.ts');
      const t=g.snapshot.tanks[0],up=normalize(selected.point);t.position=add(selected.point,mul(up,.6));t.rotation=rotation(up,0);t.velocity=[0,0,0];g.world.relocateTank(t);
      b.configure({simulationScale:1});await b.step(90);const sample=(p)=>g.world.liquids.sample(p), resistance=liquidResistance(g.snapshot.tanks[0],sample);
      const visual=await f.probe([selected.point]);return {selected,resistance,visual,engine:b.state().engine};`);
    assert.equal(liquid.resistance.speed, .6); assert.ok(liquid.visual[0].water > 1);
    assert.ok(Math.abs(liquid.visual[0].surface - liquid.selected.level) < .4, 'Canonical and displayed water agree');
    assert.equal(liquid.engine.validationErrors, 0); report.liquid = liquid; console.log('liquid', JSON.stringify({ resistance: liquid.resistance, visual: liquid.visual }));
  }
  assert.deepEqual(errors, []);
} finally {
  report.errors = errors; writeFileSync(join(out, detail ? 'report-detail.json' : 'report.json'), JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
