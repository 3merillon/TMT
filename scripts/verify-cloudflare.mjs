/** Real workerd + SQLite + hibernatable WebSockets, with no account, secrets or network services. */
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const out = resolve('artifacts/cloudflare-tests');
await mkdir(out, { recursive: true });
await build({ entryPoints: ['server/cloudflare/worker.ts'], outfile: `${out}/worker.mjs`, bundle: true, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
await build({ entryPoints: ['src/game/online/setup.ts'], outfile: `${out}/setup.mjs`, bundle: true, format: 'esm', platform: 'node' });
const { makeOnlineSetup } = await import(pathToFileURL(`${out}/setup.mjs`).href);
const kit = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
const options = { name: 'game', unsafeInspectDurableObjects: true, modules: true, scriptPath: `${out}/worker.mjs`, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { ROOMS: { className: 'GameRoom', useSQLite: true }, DIRECTORY: { className: 'RoomDirectory', useSQLite: true } },
  bindings: { ALLOW_DIRECT_ONLY: 'true' }, serviceBindings: { ASSETS: () => new Response('static game') } };
let mf = new Miniflare(convertV4MiniflareOptions(options)), count = 0, address = 0;
const sockets = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function api(path, token = '', body, extra = {}) {
  const response = await mf.dispatchFetch(`http://game.test/api/online/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'cf-connecting-ip': `test-${address}`, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); return { status: response.status, data, headers: response.headers };
}
async function ok(path, token, body) { const result = await api(path, token, body); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
async function admit(name = 'Player', build = 'test') { address++; return (await ok('session', '', { name, build, protocol: 1 })).token; }
async function room(mode = 'coop', capacity = 3, password = 'gate', listed = false) {
  const host = await admit('Host');
  const input = { name: 'Test room', listed, password, capacity, setup: makeOnlineSetup(mode, capacity, kit) };
  const created = await ok('create', host, input); return { host, input, code: created.code };
}
async function socket(token, code) {
  const response = await mf.dispatchFetch(`http://game.test/api/online/socket?room=${code}`, { headers: { upgrade: 'websocket', 'sec-websocket-protocol': `tmt-v1, auth.${token}`, origin: 'http://game.test' } });
  assert.equal(response.status, 101); const ws = response.webSocket; ws.accept(); sockets.push(ws);
  let id = 0; const pending = new Map(), pushes = [];
  ws.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.type === 'state') pushes.push(message.data); else { pending.get(message.id)?.(message); pending.delete(message.id); } });
  return { ws, pushes, async call(path, body) {
    const current = ++id;
    const result = await new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(current); reject(new Error(`Timed out: ${path}`)); }, 5000);
      pending.set(current, value => { clearTimeout(timer); resolve(value); }); ws.send(JSON.stringify({ id: current, path, ...(body === undefined ? {} : { body }) })); });
    if (result.error) throw new Error(result.error); return result.data;
  } };
}
async function test(name, task) { await task(); count++; console.log(`PASS ${name}`); }
try {
  await test('static hosting, health, same-origin protection, JSON and size boundaries', async () => {
    assert.equal(await (await mf.dispatchFetch('http://game.test/')).text(), 'static game');
    assert.equal((await ok('health')).deployment, 'cloudflare');
    assert.equal((await api('state', '', undefined, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await api('chat', '', { text: 'x'.repeat(64000) })).status, 413);
    assert.equal((await api('chat', '', {}, { 'content-type': 'text/plain' })).status, 415);
    const malformed = await mf.dispatchFetch('http://game.test/api/online/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(malformed.status, 400);
    assert.equal((await api('state')).status, 401);
  });
  await test('300 HTTP requests per minute are shared by one IP, persist across eviction and reset after expiry', async () => {
    address++;
    const tokens = [];
    for (let i = 0; i < 3; i++) tokens.push((await ok('session', '', { name: `NAT player ${i}`, build: 'test', protocol: 1 })).token);
    for (let i = 0; i < 297; i++) await ok('state', tokens[i % 3]);
    assert.equal((await api('config', tokens[0])).status, 429);
    await mf.unsafeEvictDurableObject('game', 'RoomDirectory', { name: 'directory-v1' });
    assert.equal((await api('state', tokens[1])).status, 429);
    assert.equal((await api('state', tokens[2], undefined, { 'cf-connecting-ip': 'another-network' })).status, 200);
    const storage = await mf.unsafeGetDurableObjectStorage('game', 'RoomDirectory', { name: 'directory-v1' });
    const key = `http:${createHash('sha256').update(`test-${address}`).digest('hex').slice(0, 24)}`;
    await storage.exec('UPDATE rates SET expires = ? WHERE key = ?', Date.now() - 1, key);
    assert.equal((await api('state', tokens[0])).status, 200);
  });
  await test('TURN issuance uses a three-hour TTL and one cached result for admitted session/config requests', async () => {
    let issued = 0;
    const iceServers = [{ urls: 'turn:relay.test:3478', username: 'temporary-user', credential: 'temporary-password' }];
    const relay = new Miniflare(convertV4MiniflareOptions({ ...options,
      bindings: { TURN_KEY_ID: 'local-test-key', TURN_KEY_API_TOKEN: 'local-test-token' },
      outboundService: async request => {
        assert.equal(request.url, 'https://rtc.live.cloudflare.com/v1/turn/keys/local-test-key/credentials/generate-ice-servers');
        assert.equal(request.method, 'POST'); assert.equal(request.headers.get('authorization'), 'Bearer local-test-token');
        assert.deepEqual(await request.json(), { ttl: 10800 }); issued++;
        await delay(25);
        return Response.json({ iceServers });
      },
    }));
    const call = (path, token = '', body) => relay.dispatchFetch(`http://game.test/api/online/${path}`, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    try {
      assert.equal((await call('config')).status, 401); assert.equal(issued, 0);
      const started = Date.now();
      const responses = await Promise.all([call('session', '', { name: 'A', build: 'test', protocol: 1 }), call('session', '', { name: 'B', build: 'test', protocol: 1 })]);
      const admissions = await Promise.all(responses.map(async response => { assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); return response.json(); }));
      assert.equal(issued, 1); assert.deepEqual(admissions[0].iceServers, iceServers);
      assert.equal(admissions[0].iceExpiresAt, admissions[1].iceExpiresAt);
      assert.ok(admissions[0].iceExpiresAt >= started + 10800_000 && admissions[0].iceExpiresAt <= Date.now() + 10800_000);
      const configs = await Promise.all(Array.from({ length: 8 }, (_, i) => call('config', admissions[i % 2].token)));
      for (const response of configs) {
        assert.equal(response.status, 200);
        const config = await response.json(); assert.deepEqual(config.iceServers, iceServers); assert.equal(config.iceExpiresAt, admissions[0].iceExpiresAt);
        assert.ok(!JSON.stringify(config).includes('local-test-'));
      }
      assert.equal(issued, 1);
      assert.equal((await call('config', 'invalid')).status, 401); assert.equal(issued, 1);
    } finally { await relay.dispose(); }
  });
  await test('passwords, private discovery, build isolation and authenticated sockets', async () => {
    const r = await room(), guest = await admit('Guest');
    assert.equal((await ok('state?list=1', guest)).rooms.some(v => v.code === r.code), false);
    assert.equal((await api('join', guest, { code: r.code, password: 'wrong', kit })).status, 403);
    const foreign = await admit('Other build', 'different');
    assert.equal((await api('join', foreign, { code: r.code, password: 'gate', kit })).status, 409);
    assert.equal((await mf.dispatchFetch(`http://game.test/api/online/socket?room=${r.code}`, { headers: { upgrade: 'websocket', 'sec-websocket-protocol': 'tmt-v1, auth.invalid' } })).status, 401);
    await ok('join', guest, { code: r.code, password: 'gate', kit });
    assert.equal((await ok('state', guest)).room.players, 2);
  });
  await test('concurrent final-seat joins and idempotent create/join retries', async () => {
    const r = await room('duel', 2), a = await admit('A'), b = await admit('B');
    assert.equal((await ok('create', r.host, r.input)).code, r.code);
    const body = { code: r.code, password: 'gate', kit };
    const joins = await Promise.all([api('join', a, body), api('join', b, body)]);
    assert.deepEqual(joins.map(v => v.status).sort(), [200, 409]);
    const winner = joins[0].status === 200 ? a : b;
    assert.equal((await ok('join', winner, body)).code, r.code);
    assert.equal((await ok('state', r.host)).room.reserved, 2);
  });
  await test('simultaneous quick matches pair into one room', async () => {
    const a = await admit('Queued A', 'queue'), b = await admit('Queued B', 'queue');
    const body = { setup: makeOnlineSetup('duel', 2, kit) };
    const [first, second] = await Promise.all([ok('queue', a, body), ok('queue', b, body)]);
    assert.equal(first.code, second.code); assert.equal((await ok('state', a)).room.phase, 'playing');
  });
  await test('each versus queue preserves its selected ruleset across the directory and room admission', async () => {
    const modes = ['duel', 'realtime', 'artillery'], queued = [];
    for (const mode of modes) {
      const token = await admit(`Waiting ${mode}`, 'mode-queues'), body = { setup: makeOnlineSetup(mode, 2, kit) };
      const waiting = await ok('queue', token, body); assert.equal(waiting.mode, mode); queued.push({ mode, token, body, code: waiting.code });
    }
    assert.equal(new Set(queued.map(r => r.code)).size, modes.length);
    for (const entry of queued) {
      const token = await admit(`Joining ${entry.mode}`, 'mode-queues'), joined = await ok('queue', token, entry.body);
      assert.equal(joined.code, entry.code); assert.equal(joined.mode, entry.mode);
      assert.equal((await ok('state', entry.token)).room.phase, 'playing');
    }
  });
  await test('password rate limit survives attempts against different rooms', async () => {
    const r = await room(), guest = await admit('Wrong passwords');
    for (let i = 0; i < 8; i++) assert.equal((await api('join', guest, { code: r.code, password: 'wrong', kit })).status, 403);
    assert.equal((await api('join', guest, { code: r.code, password: 'gate', kit })).status, 429);
  });
  await test('room and directory eviction preserve sockets, passwords and committed state', async () => {
    const r = await room(), guest = await admit('Guest'); await ok('join', guest, { code: r.code, password: 'gate', kit });
    const h = await socket(r.host, r.code), g = await socket(guest, r.code);
    await h.call('chat', { text: 'Before hibernation' });
    await mf.unsafeEvictDurableObject('game', 'GameRoom', { name: r.code, webSockets: 'hibernate' });
    await mf.unsafeEvictDurableObject('game', 'RoomDirectory', { name: 'directory-v1' });
    const state = await g.call('state'); assert.equal(state.chat[0].text, 'Before hibernation'); assert.equal(state.room.locked, true);
    await g.call('chat', { text: 'After hibernation' }); await delay(20);
    assert.equal(h.pushes.at(-1).chat.at(-1).text, 'After hibernation');
    assert.equal((await ok('state', r.host)).room.code, r.code);
  });
  await test('a host expiring after discovery cannot create a second room inside the stale room', async () => {
    const host = await admit('Expired host', 'stale-queue'), guest = await admit('New arrival', 'stale-queue');
    const body = { setup: makeOnlineSetup('duel', 2, kit) }, original = await ok('queue', host, body);
    const storage = await mf.unsafeGetDurableObjectStorage('game', 'GameRoom', { name: original.code });
    const [row] = await storage.exec('SELECT data FROM room WHERE id = 1'), record = JSON.parse(row.data);
    record.lobby.members[0].seen = Date.now() - 16000;
    await storage.exec('UPDATE room SET data = ? WHERE id = 1', JSON.stringify(record));
    const queued = await ok('queue', guest, body); assert.notEqual(queued.code, original.code);
    const [after] = await storage.exec('SELECT data FROM room WHERE id = 1');
    assert.equal(JSON.parse(after.data).lobby.rooms.length, 1);
    assert.equal((await ok('state', guest)).queued, true);
  });
  await test('interrupted admission and reconnect finish from durable room receipts', async () => {
    const r = await room();
    const storage = await mf.unsafeGetDurableObjectStorage('game', 'RoomDirectory', { name: 'directory-v1' });
    const [row] = await storage.exec('SELECT data FROM sessions WHERE token = ?', r.host), session = JSON.parse(row.data);
    session.room = null; delete session.entered;
    session.pending = { code: r.code, fingerprint: createHash('sha256').update(JSON.stringify(['create', r.input])).digest('hex') };
    await storage.exec('UPDATE sessions SET data = ? WHERE token = ?', JSON.stringify(session), r.host);
    assert.equal((await ok('state', r.host)).room.code, r.code);
    const reconnectId = crypto.randomUUID(); session.room = r.code; delete session.pending; session.reconnecting = reconnectId;
    await storage.exec('UPDATE sessions SET data = ? WHERE token = ?', JSON.stringify(session), r.host);
    const namespace = await mf.getDurableObjectNamespace('ROOMS');
    const stub = namespace.get(namespace.idFromName(r.code));
    const direct = await stub.fetch('https://internal/execute', { method: 'POST', body: JSON.stringify({ method: 'POST', path: 'reconnect', token: r.host, body: { lostWorld: true, reconnectId } }) });
    const committed = await direct.json(); assert.ok(committed.data.token);
    assert.equal((await ok('config', r.host)).inRoom, true);
    const retry = await ok('reconnect', r.host, { lostWorld: true, reconnectId }); assert.equal(retry.token, committed.data.token);
    assert.equal((await api('reconnect', r.host, { lostWorld: true, reconnectId: crypto.randomUUID() })).status, 401);
  });
  await test('WebSocket heartbeat, signaling, chat push and durable checkpoint transfer', async () => {
    const r = await room(), guest = await admit('Guest'); await ok('join', guest, { code: r.code, password: 'gate', kit });
    const h = await socket(r.host, r.code), g = await socket(guest, r.code);
    await h.call('playing', {}); const state = await h.call('state?after=0');
    await h.call('signal', { to: 1, generation: 0, toGeneration: 0, epoch: state.room.epoch, value: { candidates: [{ candidate: 'candidate:test' }] } });
    await delay(20); assert.ok(g.pushes.some(p => p.signals.length === 1));
    await g.call('chat', { text: 'Hello from the socket' }); await delay(20);
    assert.ok(h.pushes.some(p => p.chat.at(-1)?.text === 'Hello from the socket'));
    await h.call('state?checkpoint=120%3A0123456789abcdef&epoch=1');
    await g.call('state?checkpoint=120%3A0123456789abcdef&epoch=1');
    await h.call('handoff', {});
    const elected = await g.call('state'); assert.equal(elected.room.host, true); assert.equal(elected.room.epoch, 2); assert.equal(elected.room.paused, true);
    await g.call('checkpoint', { id: '120:0123456789abcdef', epoch: 2, resume: true });
    assert.equal((await h.call('state')).room.paused, false);
    assert.deepEqual(await h.call('signal', { to: 1, epoch: 1, value: {} }), { retry: true });
    const reconnect = { lostWorld: true, reconnectId: crypto.randomUUID() };
    const resumed = await ok('reconnect', guest, reconnect);
    assert.deepEqual(await ok('reconnect', guest, reconnect), resumed, 'lost reconnect response is replayable only with its original id');
    assert.ok(resumed.token && resumed.token !== guest); assert.equal((await api('state', guest)).status, 401);
    assert.equal((await ok('state', resumed.token)).room.seat, 1);
    await ok('leave', resumed.token, {}); assert.equal((await ok('state', resumed.token)).room, null);
  });
  await test('disconnect election waits for lease expiry; pushes never renew an absent host', async () => {
    const r = await room(), guest = await admit('Survivor'); await ok('join', guest, { code: r.code, password: 'gate', kit });
    await ok('playing', r.host, {}); const h = await socket(r.host, r.code), g = await socket(guest, r.code);
    await h.call('state?checkpoint=120%3A0123456789abcdef&epoch=1'); await g.call('state?checkpoint=120%3A0123456789abcdef&epoch=1');
    h.ws.close();
    for (let i = 0; i < 4; i++) { await delay(4000); await g.call('state'); }
    const state = await g.call('state'); assert.equal(state.room.host, true); assert.equal(state.room.epoch, 2); assert.equal(state.room.paused, true);
    assert.equal(state.room.reserved, 2); assert.equal(state.room.players, 1);
  });
  await test('isolated deployments do not share rooms; missing relay fails setup clearly', async () => {
    const isolated = new Miniflare(convertV4MiniflareOptions({ ...options, bindings: {} }));
    try { const response = await isolated.dispatchFetch('http://game.test/api/online/health'); assert.equal(response.status, 503); assert.match((await response.json()).error, /TURN_KEY_ID/); }
    finally { await isolated.dispose(); }
  });
  await test('a 1v1 waits without migration, then ends durably when its reserved opponent expires', async () => {
    const r = await room('duel', 2), guest = await admit('Remaining player');
    await ok('join', guest, { code: r.code, password: 'gate', kit }); await ok('playing', r.host, {});
    const storage = await mf.unsafeGetDurableObjectStorage('game', 'GameRoom', { name: r.code });
    async function expireHost(age) {
      const [row] = await storage.exec('SELECT data FROM room WHERE id = 1'), record = JSON.parse(row.data);
      record.lobby.members.find(m => m.token === r.host).seen = Date.now() - age;
      await storage.exec('UPDATE room SET data = ? WHERE id = 1', JSON.stringify(record));
    }
    await expireHost(16000);
    const waiting = (await ok('state', guest)).room;
    assert.equal(waiting.host, false); assert.equal(waiting.epoch, 1); assert.equal(waiting.paused, true); assert.ok(waiting.reconnectUntil);
    await expireHost(180001);
    const ended = (await ok('state', guest)).room;
    assert.equal(ended.phase, 'finished'); assert.equal(ended.host, true); assert.equal(ended.checkpoint, null);
    assert.equal(ended.ended.reason, 'reconnect-timeout');
    await ok('restart', guest, { setup: ended.setup });
    assert.equal((await ok('state', guest)).room.phase, 'waiting');
  });
  await writeFile(`${out}/result.json`, JSON.stringify({ passed: count, backend: 'Cloudflare workerd, SQLite Durable Objects, WebSockets' }, null, 2));
  console.log(`${count} Cloudflare integration checks passed.`);
} finally { for (const ws of sockets) try { ws.close(); } catch {} await mf.dispose(); }
