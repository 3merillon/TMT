import { describe, expect, it, vi } from 'vitest';
import { decodeAppearance, encodeAppearance, MAX_APPEARANCE_PIXELS, MAX_APPEARANCE_TEXT, OnlineAppearanceSync } from '../src/game/online/appearance';
import { defaultAppearance, type TankAppearance } from '../src/game/meta/cosmetics';
import { encodePaintPixels } from '../src/game/meta/paint-texture';
import { makeOnlineSetup } from '../src/game/online/setup';
import type { PeerMessage, Room } from '../src/game/online/protocol';

const kit = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
function paint(index: number): TankAppearance {
  const pixels = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([20 + index * 70, i % 255, 40, 255], i);
  return { ...defaultAppearance(), paintTextures: [{ version: 1, slot: 'hull', partId: 'warden', group: 'hull', lod: 0,
    tiles: [{ key: 'p1-0000000000000001', width: 8, height: 8, data: encodePaintPixels(pixels) }] }] };
}
function room(seat: number, count: 2 | 3, hostSeat = 0, epoch = 1): Room {
  return { code: 'PAINT', name: 'Paint', locked: false, players: count, reserved: 0, capacity: count, phase: 'playing', mode: 'artillery', created: 0,
    latency: null, host: seat === hostSeat, seat, hostSeat, epoch, setup: makeOnlineSetup('artillery', count, kit),
    peers: Array.from({ length: count }, (_, id) => ({ seat: id, name: `Player ${id}`, generation: epoch, connected: true })),
    checkpoint: null, paused: false, canTransfer: false };
}
function network() {
  const locals = new Map<number, TankAppearance>();
  const nodes = new Map<number, { sync: OnlineAppearanceSync; values: Map<number, TankAppearance | null>; errors: string[] }>();
  const messages: { from: number; to: number; value: PeerMessage }[] = [], sent: typeof messages = [];
  const add = (seat: number, count: 2 | 3, host = 0, epoch = 1) => {
    const values = new Map<number, TankAppearance | null>(), errors: string[] = [];
    locals.set(seat, paint(seat));
    const sync = new OnlineAppearanceSync(error => errors.push(error), () => locals.get(seat)!, (id, appearance) => values.set(id, appearance));
    nodes.set(seat, { sync, values, errors }); sync.updateRoom(room(seat, count, host, epoch)); return sync;
  };
  const connect = (a: number, b: number) => {
    for (const [from, to] of [[a, b], [b, a]]) nodes.get(from)!.sync.attach(to, value => {
      const message = { from, to, value: JSON.parse(JSON.stringify(value)) as PeerMessage }; messages.push(message); sent.push(message); return true;
    });
  };
  const settle = async (ready: () => boolean) => {
    for (let attempt = 0; attempt < 500; attempt++) {
      while (messages.length) { const { from, to, value } = messages.shift()!; nodes.get(to)!.sync.receive(from, value); }
      for (const node of nodes.values()) node.sync.pump();
      if (ready() && !messages.length) return;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error(`Cosmetic exchange did not settle: ${JSON.stringify([...nodes].map(([seat, node]) => [seat, node.sync.diagnostics()]))}`);
  };
  return { add, connect, settle, nodes, sent, messages, locals };
}

describe('compressed online tank paint', () => {
  it('round-trips sanitized lossless pixels and checks the actual SHA-256 content', async () => {
    const source = paint(1), encoded = await encodeAppearance(source);
    expect(encoded.id).toMatch(/^[a-f0-9]{64}$/);
    expect((await decodeAppearance(encoded.id, encoded.data)).appearance).toEqual(source);
    expect(encoded.data.length).toBeLessThan(JSON.stringify(source).length);
    await expect(decodeAppearance('0'.repeat(64), encoded.data)).rejects.toThrow(/checksum/);
    await expect(decodeAppearance(encoded.id, 'not base64')).rejects.toThrow(/compressed/);
  });

  it('rejects aggregate decompression work before decoding tiles instead of cropping the design', async () => {
    const source = paint(0), layer = source.paintTextures![0];
    layer.tiles = Array.from({ length: MAX_APPEARANCE_PIXELS / (512 * 512) + 1 }, (_, index) => ({
      key: `p1-${index.toString(16).padStart(16, '0')}`, width: 512, height: 512, data: '' }));
    await expect(encodeAppearance(source)).rejects.toThrow(/32 MiB decoded/);
  });

  it('stops compressed data whose expanded text exceeds the byte budget', async () => {
    const bytes = new Uint8Array(await new Response(new Blob(['x'.repeat(MAX_APPEARANCE_TEXT + 1)]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    const data = btoa(String.fromCharCode(...bytes));
    await expect(decodeAppearance('0'.repeat(64), data)).rejects.toThrow(/size limit/);
  });

  it('relays the actual guest seat to a late joiner and sends each content only once per peer cache', async () => {
    const net = network(); net.add(0, 3); net.add(1, 3); net.connect(0, 1);
    await net.settle(() => net.nodes.get(0)!.values.get(1)?.paintTextures?.length === 1 && net.nodes.get(1)!.values.has(0));
    expect(net.nodes.get(0)!.values.get(1)).toEqual(paint(1));
    expect(net.nodes.get(1)!.values.get(0)).toEqual(paint(0));
    net.add(2, 3); net.connect(0, 2);
    await net.settle(() => [...net.nodes.values()].every(node => node.sync.diagnostics().seats.length === 3 && node.sync.diagnostics().pending === 0));
    expect(net.nodes.get(2)!.values.get(1)).toEqual(paint(1));
    expect(net.nodes.get(1)!.values.get(2)).toEqual(paint(2));
    const transfers = net.sent.filter(message => message.value.kind === 'appearance-blob').length;
    for (let i = 0; i < 100; i++) for (const node of net.nodes.values()) node.sync.pump();
    expect(net.sent.filter(message => message.value.kind === 'appearance-blob')).toHaveLength(transfers);
    const id = net.nodes.get(0)!.sync.diagnostics().seats.find(entry => entry.seat === 1)!.id;
    for (let i = 0; i < 100; i++) net.nodes.get(0)!.sync.receive(2, { kind: 'appearance-request', epoch: 1, id });
    expect(net.sent.filter(message => message.value.kind === 'appearance-blob')).toHaveLength(transfers);
    expect(net.sent.every(message => message.value.kind.startsWith('appearance-'))).toBe(true);
    expect([...net.nodes.values()].flatMap(node => node.errors)).toEqual([]);
  });

  it('reuses verified cached textures on reconnect and after host transfer', async () => {
    const net = network(); net.add(0, 3); net.add(1, 3); net.add(2, 3); net.connect(0, 1); net.connect(0, 2);
    await net.settle(() => [...net.nodes.values()].every(node => node.sync.diagnostics().seats.length === 3 && node.sync.diagnostics().pending === 0));
    const bytes = [...net.nodes.values()].map(node => node.sync.diagnostics().receivedBytes);
    for (const [seat, node] of net.nodes) { const next = room(seat, 3); next.peers[1].generation++; node.sync.updateRoom(next); }
    net.connect(0, 1);
    await net.settle(() => [...net.nodes.values()].every(node => node.sync.diagnostics().pending === 0));
    for (const [seat, node] of net.nodes) node.sync.updateRoom(room(seat, 3, 1, 2));
    net.connect(1, 0); net.connect(1, 2);
    await net.settle(() => [...net.nodes.values()].every(node => node.sync.diagnostics().seats.length === 3 && node.sync.diagnostics().pending === 0));
    expect([...net.nodes.values()].map(node => node.sync.diagnostics().receivedBytes)).toEqual(bytes);
    expect(net.nodes.get(2)!.values.get(0)).toEqual(paint(0));
  });

  it('restores a refreshed guest through the surviving host with a new empty browser cache', async () => {
    const net = network(); net.add(0, 2); net.add(1, 2); net.connect(0, 1);
    await net.settle(() => [...net.nodes.values()].every(node => node.sync.diagnostics().seats.length === 2 && node.sync.diagnostics().pending === 0));
    const restored = net.add(1, 2); net.connect(0, 1);
    await net.settle(() => restored.diagnostics().seats.length === 2 && restored.diagnostics().pending === 0);
    expect(restored.diagnostics().receivedBytes).toBeGreaterThan(0);
    expect(net.nodes.get(1)!.values.get(0)).toEqual(paint(0));
  });

  it('shares a paint save in the same lobby epoch without reattaching or uploading unchanged content again', async () => {
    const net = network(), host = net.add(0, 2), guest = net.add(1, 2); net.connect(0, 1);
    await net.settle(() => host.diagnostics().seats.length === 2 && guest.diagnostics().pending === 0 && host.diagnostics().pending === 0);
    const changed = paint(2), id = (await encodeAppearance(changed)).id;
    net.locals.set(1, changed); guest.appearanceChanged();
    await net.settle(() => host.diagnostics().seats.find(entry => entry.seat === 1)?.id === id && host.diagnostics().pending === 0);
    expect(net.nodes.get(0)!.values.get(1)).toEqual(changed);
    const sent = guest.diagnostics().sentBytes;
    guest.appearanceChanged();
    await net.settle(() => guest.diagnostics().pending === 0);
    expect(guest.diagnostics().sentBytes).toBe(sent);
  });

  it('binds guest announcements to their authenticated seat and ignores unknown optional kinds', async () => {
    const net = network(); const host = net.add(0, 2); net.add(1, 2); net.connect(0, 1);
    await net.settle(() => host.diagnostics().seats.length === 2 && host.diagnostics().pending === 0);
    const before = host.diagnostics().seats;
    expect(host.receive(1, { kind: 'appearance-manifest', epoch: 1, seat: 0, id: '0'.repeat(64) })).toBe(true);
    expect(host.diagnostics().seats).toEqual(before);
    expect(host.diagnostics().rejected).toBe(1);
    expect(host.receive(1, { kind: 'appearance-future-optional', epoch: 1 })).toBe(true);
    expect(host.receive(1, { kind: 'input', epoch: 1 })).toBe(false);
  });

  it('publishes the changed paint when two reconnecting peers attach while compression is pending', async () => {
    let value = paint(0);
    const sync = new OnlineAppearanceSync(() => {}, () => value, () => {});
    sync.updateRoom(room(0, 3));
    const waitForId = async (id: string) => {
      for (let i = 0; i < 500; i++) {
        if (sync.diagnostics().seats.find(entry => entry.seat === 0)?.id === id) return;
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      throw Error('Changed local appearance was not published.');
    };
    await waitForId((await encodeAppearance(value)).id);
    value = paint(1);
    sync.attach(1, () => true); sync.attach(2, () => true);
    await waitForId((await encodeAppearance(value)).id);
    expect(sync.diagnostics().error).toBe('');
  });

  it('ignores an obsolete decode completion instead of pinning unused cache data', async () => {
    const net = network(), host = net.add(0, 2); net.add(1, 2); net.connect(0, 1);
    await net.settle(() => host.diagnostics().seats.length === 2 && host.diagnostics().pending === 0);
    const old = await encodeAppearance(paint(2)), replacement = await encodeAppearance(paint(3));
    const before = host.diagnostics().cacheEntries;
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => Promise<void>, started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce((algorithm, data) => new Promise(resolve => {
      release = async () => resolve(await originalDigest(algorithm, data)); started();
    }));
    try {
      host.receive(1, { kind: 'appearance-manifest', epoch: 1, seat: 1, id: old.id });
      host.receive(1, { kind: 'appearance-blob', epoch: 1, id: old.id, data: old.data });
      await waiting;
      host.receive(1, { kind: 'appearance-manifest', epoch: 1, seat: 1, id: replacement.id });
      await release();
      await vi.waitFor(() => expect(host.diagnostics().pending).toBe(1));
      expect(host.diagnostics().cacheEntries).toBe(before);
    } finally { spy.mockRestore(); }
  });
});
