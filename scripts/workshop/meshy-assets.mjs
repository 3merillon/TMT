/** Resume-safe image-to-3D workshop asset jobs. Never resubmits a recorded creation. */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { MeshyMcp, meshyKey } from './meshy-mcp.mjs';
const folder = resolve('assets/workshop/meshy'); mkdirSync(folder, { recursive: true });
const receiptFile = join(folder, 'receipts.json');
const receipts = existsSync(receiptFile) ? JSON.parse(readFileSync(receiptFile, 'utf8')) : { version: 1, budgetCredits: 450, jobs: {} };
const save = () => writeFileSync(receiptFile, JSON.stringify(receipts, (_key, value) => {
  // Download URLs contain short-lived signatures. Persist provenance, never signed access tokens.
  if (typeof value === 'string' && value.startsWith('https://assets.meshy.ai/')) { const url = new URL(value); return url.origin + url.pathname; }
  return value;
}, 2));
const redact = text => String(text).replaceAll(meshyKey() ?? '\0', '[redacted]').replace(/msy[A-Za-z0-9_-]+/g, '[redacted]');
const BASE = 'https://api.meshy.ai/openapi';
async function api(path, body) {
  const response = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${meshyKey()}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(redact(JSON.stringify({ status: response.status, data })));
  return data;
}
async function main() {
  const [command, id, image] = process.argv.slice(2);
  if (command === 'probe') {
    const mcp = new MeshyMcp();
    try {
      await mcp.connect();
      mkdirSync('artifacts/workshop-mcp', { recursive: true });
      writeFileSync('artifacts/workshop-mcp/tool-schemas.json', JSON.stringify(mcp.schemas, null, 2));
      const balances = mcp.schemas.filter(t => /balance/i.test(t.name) && t.annotations?.readOnlyHint);
      const imageTool = mcp.schemas.find(t => t.name === 'meshy_image_to_3d');
      console.log(JSON.stringify({ server: mcp.server.serverInfo, tools: mcp.schemas.map(t => t.name), models: imageTool?.inputSchema?.properties?.ai_model }, null, 2));
      for (const tool of balances) console.log(JSON.stringify({ tool: tool.name, result: await mcp.call(tool.name, { response_format: 'json' }) }));
    } finally { mcp.close(); }
    return;
  }
  if (command === 'balance') { const b = await api('/v1/balance'); console.log(JSON.stringify(b)); if (receipts.initialBalance === undefined) { receipts.initialBalance = b.balance; save(); } return; }
  if (command === 'status') {
    for (const [name, job] of Object.entries(receipts.jobs)) {
      if (!job.taskId) { console.log(name, 'ambiguous submission — reconcile before retry'); continue; }
      const status = await api('/v1/image-to-3d/' + job.taskId);
      job.status = status.status; job.progress = status.progress; job.task = status; save();
      console.log(JSON.stringify({ name, taskId: job.taskId, status: job.status, progress: job.progress, error: status.task_error }));
    }
    const b = await api('/v1/balance'); receipts.latestBalance = b.balance; save(); console.log(JSON.stringify({ balance: b })); return;
  }
  if (command === 'create') {
    if (!id || !image) throw new Error('create <id> <inspected-reference.png>');
    if (receipts.jobs[id]) throw new Error(`Job ${id} already recorded; use status/download (never resubmit)`);
    const before = await api('/v1/balance');
    if (receipts.initialBalance === undefined) receipts.initialBalance = before.balance;
    // Conservative reservation covers current 7.1 standard textured generation; refusal on unknown accounting.
    const reserved = Object.values(receipts.jobs).reduce((n, j) => n + (
      j.status === 'SUCCEEDED' && Number.isFinite(j.task?.consumed_credits) && j.task.consumed_credits >= 0
        ? j.task.consumed_credits : j.reservedCredits), 0);
    const reserve = 100;
    if (reserved + reserve > receipts.budgetCredits) throw new Error('Workshop generation credit reservation would exceed 450');
    if (!Number.isFinite(before.balance) || before.balance < reserve) throw new Error('Insufficient or unrecognized account balance');
    const imagePath = resolve(image);
    const texturePrompts = {
      'twin-cylinder-compressor': 'Preserve the reference compact twin-cylinder air compressor, finned black iron cylinders, bronze flywheel rim, aged sage enamel crankcase and receiver tank, copper piping and restrained brass fittings. Realistic maintained industrial patina and crisp CAD-like manufacturing. No additional objects, text, steam or glow.',
      'reinforced-parts-crate': 'Preserve the reference closed engineering parts crate: aged brown oak plank panels and lid with subtle timber grain, dark sage enamel riveted steel frame and corner guards, aged brass front latches and folding side handles. Maintain closed rectangular box proportions. No added objects, text, symbols or glow.',
      'rolling-tool-cabinet': 'Worn dark sage enamel, brushed steel flat deck, aged brass handles and corner guards, black rubber wheels and bronze hubs. Preserve the reference cabinet design and panel seams. Restrained patina, no glowing parts or text.',
      'inert-ordnance-cart': 'Preserve the reference: inert closed olive green enamel bomb casing with a small faded yellow radiation trefoil stencil, muted bronze bands, dark brown padded leather securing straps, aged brass fasteners, dark sage steel cart and black rubber wheels. Physically believable restrained wear. No glow and no added text.',
      'axial-fan-rotor': 'Preserve the seven green enamel cupped fan blades and precisely machined central satin brass hub of the reference. Sage enamel with restrained exposed steel edge wear, bronze blade-root clamps, dark steel bolts and axle socket. No added objects, frame, guard, glow or text.',
    };
    const payload = { image_url: 'data:image/png;base64,' + readFileSync(imagePath).toString('base64'), ai_model: 'meshy-7.1', model_type: 'standard',
      geometry_resolution: '4k', texture_resolution: '4k', target_formats: ['glb'], multi_view_thumbnails: true,
      topology: 'triangle', target_polycount: 24000, should_remesh: true, should_texture: true, enable_pbr: true, texture_prompt: texturePrompts[id] ?? 'Aged riveted black iron, worn dark sage enamel, oxidized copper pipes and muted polished brass. Physically believable Victorian industrial machinery. No text, no decals, no glowing parts.' };
    receipts.jobs[id] = { id, imagePath, reservedCredits: reserve, submittedAt: new Date().toISOString(), status: 'SUBMITTING', balanceBefore: before.balance, params: { ...payload, image_url: imagePath } }; save();
    const result = await api('/v1/image-to-3d', payload);
    const taskId = result.result;
    if (!taskId || typeof taskId !== 'string') throw new Error('Unrecognized creation result; receipt intentionally retained for reconciliation');
    Object.assign(receipts.jobs[id], { taskId, status: 'PENDING' }); save();
    console.log(JSON.stringify({ id, taskId, reservedCredits: reserve })); return;
  }
  if (command === 'download') {
    for (const [name, job] of Object.entries(receipts.jobs)) {
      if (id && name !== id) continue;
      const status = await api('/v1/image-to-3d/' + job.taskId); job.task = status; job.status = status.status;
      if (status.status !== 'SUCCEEDED') { save(); console.log(name, status.status); continue; }
      const output = join(folder, name); mkdirSync(output, { recursive: true });
      const glb = await fetch(status.model_urls.glb); if (!glb.ok) throw new Error('GLB download failed');
      writeFileSync(join(output, 'model.glb'), Buffer.from(await glb.arrayBuffer()));
      if (status.thumbnail_url) { const preview = await fetch(status.thumbnail_url); if (preview.ok) writeFileSync(join(output, 'preview.png'), Buffer.from(await preview.arrayBuffer())); }
      job.localFile = join(output, 'model.glb'); save(); console.log(JSON.stringify({ name, file: job.localFile }));
    }
    return;
  }
  throw new Error('Use probe | balance | create <id> <image> | status | download [id]');
}
main().catch(error => { console.error(redact(error.stack ?? error)); process.exitCode = 1; });
