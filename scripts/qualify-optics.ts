/** Real-game visual checks. Run alone on the GPU; this is not a production performance benchmark.
 * node node_modules/tsx/dist/cli.mjs scripts/qualify-optics.ts */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { acquireGpuLock } from './capture';
const args = process.argv.slice(2), root = resolve(import.meta.dirname, '..');
const out = resolve(root, args.includes('--out') ? args[args.indexOf('--out') + 1] : `artifacts/planetary-lighting/optics-${Date.now()}`);
assert.ok(!existsSync(out), 'Use a fresh output directory');
mkdirSync(out, { recursive: true });
let server: ViteDevServer | undefined, browser: Browser | undefined; const errors: string[] = [], shots: unknown[] = [];
const unlock = await acquireGpuLock();
try {
  server = await createServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', cacheDir: join(root, '.vite-capture/optics'), server: { host: '127.0.0.1', port: 0, open: false, hmr: false, watch: null } }); await server.listen();
  const store = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const executablePath = process.env.TMT_CHROME ?? readdirSync(store).filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])).map(n => join(store, n, 'chrome-win64/chrome.exe')).find(existsSync);
  assert.ok(executablePath);
  browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ['--headless'], args: ['--headless=new', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features', '--ignore-gpu-blocklist', '--enable-gpu', '--force-color-profile=srgb', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await context.route(/\/favicon\.ico/, route => route.fulfill({ status: 204, body: '' }));
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.stack ?? e.message)); page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  await page.addInitScript(`{const make=GPUDevice.prototype.createBuffer;GPUDevice.prototype.createBuffer=function(desc){const b=make.call(this,desc);if(desc.label==='optics:sources')window.__opticsSourceProbe={device:this,buffer:b};return b;};}`);
  const base = server.resolvedUrls!.local[0].replace(/\/$/, '');
  await page.goto(`${base}/play.html?mode=drive&seed=7&renderbench`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__tmtRenderBench?.ready', undefined, { timeout: 180000 });
  await page.addStyleTag({ content: '.game-shell,.toast,.finish-card,.world-label,.dev-panel,.tank-labels,.trajectory-readout,.aim-target-readout,.engine-fps{visibility:hidden!important}' });
  await page.evaluate('window.__tmtRenderBench.configure({epoch:100,skyTime:240,off:["autoExposure"],graphics:{tier:"high",clouds:true,volumetrics:true,lensFlare:true,godRays:true,grain:0}})');
  await page.evaluate('window.__tmtRenderBench.step(90)');
  await page.evaluate('window.__name=(fn)=>fn'); // tsx preserves function names in serialized callbacks.
  // Read-only GPU probes through the actual game's existing bindings. Prototype wrapper is restored immediately.
  const probe = await page.evaluate(async () => {
    const api = (window as any).__tmtRenderBench;
    const { Engine } = await import('/src/engine/engine.ts' as string); let engine: any;
    const frame = Engine.prototype.frame; Engine.prototype.frame = function (...args: any[]) { engine = this; return frame.apply(this, args); };
    try { await api.step(1); } finally { Engine.prototype.frame = frame; }
    const s = engine.services, d = s.ctx.device;
    const { link, makeModule } = await import('/src/engine/wgsl/module.ts' as string);
    const { sdfBindingsWgsl, sdfWgsl } = await import('/src/engine/passes/sdf/sdf.wgsl.ts' as string);
    const { sdfCastersWgsl } = await import('/src/engine/passes/sdf/sdf-casters.ts' as string);
    const { volumeTraceWgsl } = await import('/src/engine/passes/volumetrics/volumetrics.wgsl.ts' as string);
    const { punctualWorldVisibilityWgsl } = await import('/src/engine/passes/volumetrics/punctual.wgsl.ts' as string);
    const fn = volumeTraceWgsl.code.slice(volumeTraceWgsl.code.indexOf('fn volume_local_visible'), volumeTraceWgsl.code.indexOf('@compute'));
    const lights = api.state().shadowLights, distances = [0, .1, .3, .5, 1, 2, 3, 5];
    const records = lights.flatMap(({ light }: any) => {
      const up = light.position.map((v: number) => v / Math.hypot(...light.position)); const dot = up.reduce((s: number, v: number, i: number) => s + v * light.direction[i], 0);
      const vertical = up.map((v: number, i: number) => v - dot * light.direction[i]), vl = Math.hypot(...vertical);
      return ['side', 'down'].flatMap(axis => [0, .22, .45].flatMap(angle => distances.map(t => ({ owner: light.sourceCasterId ?? 0, axis, angle, source: light.position,
        q: light.position.map((v: number, i: number) => v + (light.direction[i] * Math.cos(angle) + (axis === 'side' ? (i === 2 ? 1 : 0) : -vertical[i] / vl) * Math.sin(angle)) * t), t }))));
    });
    const literal = (p: number[]) => `vec3f(${p.map(x => x.toFixed(9)).join(',')})`;
    const extra = `for(var k=0u;k<caster_count();k++){result[${records.length}u+k]=vec4f(caster_list.items[k*7u+3u].w,caster_distance(k,${literal(lights[0].light.position)}),caster_distance(k,${literal(lights[0].light.position.map((v: number, i: number) => v + lights[0].light.direction[i] * .3))}),length(1.0/caster_list.items[k*7u+4u].xyz)/32.0);}`;
    const shader = link(makeModule('optics-actual-path-probe', `struct Query{point:vec4f,source:vec4f}
      @group(0) @binding(5) var<storage,read_write> result:array<vec4f>;
      @group(0) @binding(6) var<storage,read> queries:array<Query>;
      ${fn}@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
        if(id.x==0u){${extra}}if(id.x>=${records.length}u){return;}
        let r=queries[id.x];let q=r.point.xyz;let source=r.source.xyz;var nearest=1e9;
        for(var k=0u;k<caster_count();k++){nearest=min(nearest,caster_distance(k,q));}
        result[id.x]=vec4f(sdf_sample(q),volume_local_visible(q,source),casters_vis_point_emitter(q,source,vec3f(.025,.015,.10),u32(r.source.w)),nearest);
      }`, [sdfBindingsWgsl(0, { volume: 0, params: 1, sampler: 2 }), sdfWgsl, sdfCastersWgsl(0, 3, 4), punctualWorldVisibilityWgsl]));
    const size = (records.length + 48) * 16, buffer = d.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }), read = d.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const input = d.createBuffer({ size: records.length * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(input, 0, new Float32Array(records.flatMap((r: any) => [...r.q, 0, ...r.source, r.owner])));
    try {
      const pipeline = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: d.createShaderModule({ code: shader.code }), entryPoint: 'main' } });
      const sdf = s.bindings.get('sdf'), casters = s.scene.get('sdfCasters');
      const resources = [sdf.volume, sdf.params, d.createSampler({ minFilter: 'linear', magFilter: 'linear' }), casters.atlasView, { buffer: casters.listBuffer }, { buffer }, { buffer: input }];
      const group = d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: resources.map((resource, binding) => ({ binding, resource })) });
      const encoder = d.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(records.length); pass.end(); encoder.copyBufferToBuffer(buffer, 0, read, 0, size); d.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ); const values = Array.from(new Float32Array(read.getMappedRange())); read.unmap();
      const actual = records.map((r: any, i: number) => ({ ...r, sdf: values[i * 4], worldVisibility: values[i * 4 + 1], casterVisibility: values[i * 4 + 2], casterDistance: values[i * 4 + 3] }));
      // Execute the production helper against analytic bricks: correct owner exit, wrong owner,
      // foreign obstruction, same-owner reentry and a deeply embedded emitter.
      const casterCode = sdfCastersWgsl(0, 3, 4).code;
      const helper = casterCode.slice(casterCode.indexOf('fn casters_vis_point_emitter'), casterCode.indexOf('fn casters_near'));
      const testCode = `struct CasterList{items:array<vec4f,14>} var<private> caster_list:CasterList;var<private> test:u32;
        @group(0) @binding(0) var<storage,read_write> out:array<f32>;
        fn caster_count()->u32{return 2u;}fn caster_interval(i:u32,p:vec3f,d:vec3f)->vec2f{return vec2f(0,2);}
        fn sdf_penumbra(v:f32)->f32{return smoothstep(-1.0,1.0,v);}
        fn caster_distance(i:u32,p:vec3f)->f32{
          if(i==1u){if(test==3u||test==7u){return abs(p.x-.55)-.04;}return 10.0;}
          if(test==6u||test==7u){return 1.0;}var d=p.x-select(.1,.4,test==5u);
          if(test==4u){d=min(d,abs(p.x-.65)-.04);}if(test==8u){d=min(d,abs(p.x-.13)-.008);}return d;
        }
        ${helper}
        @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){test=id.x;
          caster_list.items[3]=vec4f(0,0,0,1);caster_list.items[4]=vec4f(.3125);
          caster_list.items[10]=vec4f(0,0,0,2);caster_list.items[11]=vec4f(.3125);
          let owner=select(select(1u,0u,test==0u),2u,test==2u);
          out[test]=casters_vis_point_emitter(vec3f(1,0,0),vec3f(0),vec3f(.025,.015,.10),owner);
        }`;
      const fixture = d.createBuffer({ size: 36, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }), fixtureRead = d.createBuffer({ size: 36, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      let fixtureValues: number[] = [];
      try {
        const fp = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: d.createShaderModule({ code: testCode }), entryPoint: 'main' } });
        const fg = d.createBindGroup({ layout: fp.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: fixture } }] });
        const e = d.createCommandEncoder(), p = e.beginComputePass(); p.setPipeline(fp); p.setBindGroup(0, fg); p.dispatchWorkgroups(9); p.end(); e.copyBufferToBuffer(fixture, 0, fixtureRead, 0, 36); d.queue.submit([e.finish()]);
        await fixtureRead.mapAsync(GPUMapMode.READ); fixtureValues = Array.from(new Float32Array(fixtureRead.getMappedRange())); fixtureRead.unmap();
      } finally { fixture.destroy(); fixtureRead.destroy(); }
      return { actual, fixtures: fixtureValues, casters: Array.from({ length: 48 }, (_, i) => values.slice((records.length + i) * 4, (records.length + i + 1) * 4)).filter(v => v[0] > 0) };
    } finally { buffer.destroy(); read.destroy(); input.destroy(); }
  }); writeFileSync(join(out, 'actual-headlight-probe.json'), JSON.stringify(probe, null, 2));
  assert.deepEqual(probe.fixtures.map((v: number) => v > .5), [false, true, false, false, false, false, true, false, false], 'Emitter escape must preserve ownership, obstruction and reentry');
  assert.ok(probe.actual.some((r: any) => r.angle === 0 && r.t === 1 && r.worldVisibility * r.casterVisibility > .5), 'Real mounted headlight must clear its own source skin');
  assert.ok(probe.actual.some((r: any) => r.axis === 'down' && r.angle === .45 && r.t > 1 && r.worldVisibility * r.casterVisibility === 0), 'Downward cone must be blocked by actual tank/terrain');
  if (args.includes('--probe-only')) { assert.deepEqual(errors, []); process.exitCode = 0; } else {
  async function shot(name: string) {
    await page.evaluate('window.__tmtRenderBench.configure({epoch:100})');
    const samples = await page.evaluate('window.__tmtRenderBench.step(30)') as any[];
    assert.ok(samples.every(s => !s.cameraInsideTerrain), 'Visual camera must stay outside terrain');
    const state = await page.evaluate('window.__tmtRenderBench.state()');
    const opticalSources = await page.evaluate(async () => {
      const { device: d, buffer } = (window as any).__opticsSourceProbe;
      const output = d.createBuffer({ size: 96, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const read = d.createBuffer({ size: 96, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      try {
        const pipeline = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: d.createShaderModule({ code: '@group(0) @binding(0) var<storage,read> src:array<vec4f>;@group(0) @binding(1) var<storage,read_write> dst:array<vec4f>;@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){dst[id.x]=src[id.x];}' }), entryPoint: 'main' } });
        const group = d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }, { binding: 1, resource: { buffer: output } }] });
        const e = d.createCommandEncoder(), p = e.beginComputePass(); p.setPipeline(pipeline); p.setBindGroup(0, group); p.dispatchWorkgroups(6); p.end(); e.copyBufferToBuffer(output, 0, read, 0, 96); d.queue.submit([e.finish()]);
        await read.mapAsync(GPUMapMode.READ); const values = Array.from(new Float32Array(read.getMappedRange())); read.unmap(); return Array.from({ length: 3 }, (_, i) => ({ screen: values.slice(i * 8, i * 8 + 4), color: values.slice(i * 8 + 4, i * 8 + 8) }));
      } finally { output.destroy(); read.destroy(); }
    }); shots.push({ name, state, opticalSources });
    if (name === 'sun-below-horizon') assert.equal(opticalSources[0].screen[3], 0, 'Actual terrain must fully occlude the sun source');
    if (name === 'sun-facing-on') assert.ok(opticalSources[0].screen[3] > 0, 'A clear real sun must produce an optical source');
    if (name === 'night-front-on') assert.ok(opticalSources.slice(1).some(s => s.screen[3] > 0), 'A visible bright real lamp must produce a restrained optical source');
    assert.equal((state as any).engine.validationErrors, 0);
    assert.ok((state as any).shadowLights.some((entry: any) => entry.light.type === 'spot' && entry.light.castShadow && entry.light.intensity > 0), 'Real mounted headlights must be active');
    await page.screenshot({ path: join(out, `${name}.png`) }); console.log(JSON.stringify({ shot: name, performance: (state as any).engine.gpu, errors: errors.length }));
  }
  // Physical chassis quaternion determines the lamp-facing camera; no hard-coded world mount.
  await page.evaluate(() => {
    const api = (window as any).__tmtRenderBench, state = api.state(), tank = state.game.snapshot.tanks[0];
    const [x, y, z, w] = tank.rotation;
    const forward = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
    const up = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
    const right = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
    (window as any).__opticsBasis = { position: tank.position, forward, up, right };
    api.configure({ camera: { position: tank.position.map((v: number, i: number) => v + forward[i] * 4 + up[i] * .3), target: tank.position.map((v: number, i: number) => v + up[i] * .25), up, fovY: .72 } });
  });
  await shot('night-front-on');
  await page.evaluate('window.__tmtRenderBench.configure({graphics:{lensFlare:false}})'); await shot('night-front-flare-off');
  await page.evaluate(() => { const b = (window as any).__opticsBasis; (window as any).__tmtRenderBench.configure({ graphics: { lensFlare: true }, camera: { position: b.position.map((v: number, i: number) => v + b.forward[i] * 2 + b.right[i] * 5 + b.up[i] * 1.8), target: b.position.map((v: number, i: number) => v + b.forward[i] * 2.2), up: b.up, fovY: .72 } }); });
  await shot('night-beams-on');
  await page.evaluate('window.__tmtRenderBench.configure({graphics:{volumetrics:false}})'); await shot('night-beams-off');
  await page.evaluate('window.__tmtRenderBench.configure({skyTime:0,graphics:{volumetrics:true}});window.__tmtRenderBench.step(1)');
  await page.evaluate(() => { const api = (window as any).__tmtRenderBench, b = (window as any).__opticsBasis; const s = api.state().sun.dirToward; const eye = b.position.map((v: number, i: number) => v + b.up[i] * 2.2); api.configure({ camera: { position: eye, target: eye.map((v: number, i: number) => v + s[i] * 30), up: b.up, fovY: .95 } }); });
  await shot('sun-facing-on');
  await page.evaluate('window.__tmtRenderBench.configure({graphics:{lensFlare:false,godRays:false}})'); await shot('sun-facing-off');
  await page.evaluate('window.__tmtRenderBench.configure({skyTime:80,graphics:{lensFlare:false,godRays:true}});window.__tmtRenderBench.step(1)');
  await page.evaluate(() => { const api = (window as any).__tmtRenderBench, b = (window as any).__opticsBasis; const s = api.state().sun.dirToward; const eye = b.position.map((v: number, i: number) => v + b.up[i] * 2.2); api.configure({ camera: { position: eye, target: eye.map((v: number, i: number) => v + s[i] * 30), up: b.up, fovY: .95 } }); });
  await shot('sun-terrain-edge-rays');
  await page.evaluate('window.__tmtRenderBench.configure({graphics:{godRays:false},off:["autoExposure","volumeSun"]})'); await shot('sun-terrain-edge-no-rays');
  await page.evaluate('window.__tmtRenderBench.configure({skyTime:110,graphics:{lensFlare:true,godRays:true},off:["autoExposure"]});window.__tmtRenderBench.step(1)');
  await page.evaluate(() => { const api = (window as any).__tmtRenderBench, b = (window as any).__opticsBasis; const s = api.state().sun.dirToward; const eye = b.position.map((v: number, i: number) => v + b.up[i] * 2.2); api.configure({ camera: { position: eye, target: eye.map((v: number, i: number) => v + s[i] * 30), up: b.up, fovY: .95 } }); });
  await shot('sun-below-horizon');
  await page.evaluate('window.__tmtRenderBench.configure({graphics:{lensFlare:false,godRays:false}})'); await shot('sun-below-horizon-off');
  const shaders = await page.evaluate('window.__tmtRenderBench.shaders()'); writeFileSync(join(out, 'shaders.json'), JSON.stringify(shaders, null, 2));
  assert.equal((shaders as any).ok, true); assert.deepEqual(errors, []);
  }
} catch (e) { errors.push(e instanceof Error ? e.stack ?? e.message : String(e)); console.error(errors.at(-1)); process.exitCode = 1; }
finally { writeFileSync(join(out, 'report.json'), JSON.stringify({ resolution: [1280, 720], purpose: 'Visual qualification, dev server; not final production timing', shots, errors }, null, 2)); await browser?.close(); await server?.close(); unlock(); console.log(JSON.stringify({ out, shots: shots.length, errors: errors.length })); }
