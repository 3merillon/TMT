/** Content-addressed cosmetic exchange, independent of authoritative snapshots and recovery. */
import { sanitizeCosmetics, type TankAppearance } from '../meta/cosmetics';
import { clearOnlineAppearances, configureOnlineAppearances, publishOnlineAppearance } from '../presentation/online-appearance';
import { currentVehicleAppearance } from '../workshop/sandbox';
import type { PeerMessage, Room } from './protocol';

export const MAX_APPEARANCE_TEXT = 2 * 1024 * 1024;
export const MAX_APPEARANCE_WIRE = 2 * 1024 * 1024;
export const MAX_APPEARANCE_PIXELS = 32 * 1024 * 1024 / 4;
const CACHE_BYTES = 24 * 1024 * 1024, CACHE_ENTRIES = 8;
const MAX_DATA = MAX_APPEARANCE_WIRE - 64 * 1024; // reserve the existing wire fragment envelopes
const HASH = /^[a-f0-9]{64}$/;
interface Asset { id: string; data: string; appearance: TankAppearance; bytes: number; rawBytes: number }
interface Port { send(message: PeerMessage): boolean; pending: Map<string, PeerMessage>; announced: Map<number, string>; served: Set<string> }

function cleanAppearance(value: unknown): TankAppearance {
  const v = value as TankAppearance | null;
  let pixels = 0;
  if (Array.isArray(v?.paintTextures)) for (const layer of v.paintTextures) {
    if (!Array.isArray(layer?.tiles)) continue;
    for (const tile of layer.tiles) {
      if (!Number.isInteger(tile?.width) || !Number.isInteger(tile?.height) || tile.width < 1 || tile.height < 1
        || tile.width > 512 || tile.height > 512 || (pixels += tile.width * tile.height) > MAX_APPEARANCE_PIXELS) throw new Error('Tank paint exceeds the online texture limit (32 MiB decoded). Save a smaller design before joining again.');
    }
  }
  // Cosmetic entitlement ids are display data, never authority over gameplay unlocks.
  const owned = v ? [v.paintId, v.materialId, v.skinId, ...(Array.isArray(v.decalIds) ? v.decalIds : [])].filter(id => typeof id === 'string') : [];
  return sanitizeCosmetics({ appearance: value, owned }).appearance!;
}
async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
}
function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}
async function boundedBytes(stream: ReadableStream<Uint8Array>, maximum: number): Promise<Uint8Array> {
  const reader = stream.getReader(), parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length;
      if (length > maximum) { await reader.cancel(); throw new Error('Tank paint exceeds its online size limit.'); }
      parts.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
export async function encodeAppearance(value: TankAppearance): Promise<Asset> {
  const appearance = cleanAppearance(value), text = JSON.stringify(appearance);
  if (new TextEncoder().encode(text).length > MAX_APPEARANCE_TEXT) throw new Error('Tank paint is too large to share online (2 MiB). Save a smaller design before joining again.');
  const bytes = await boundedBytes(new Blob([text]).stream().pipeThrough(new CompressionStream('deflate')), Math.floor(MAX_DATA * .75));
  const data = base64(bytes);
  return { id: await digest(text), data, appearance, bytes: (text.length + data.length) * 2, rawBytes: text.length };
}
export async function decodeAppearance(id: string, data: unknown): Promise<Asset> {
  if (!HASH.test(id) || typeof data !== 'string' || data.length > MAX_DATA || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Invalid compressed tank paint.');
  const encoded = atob(data), bytes = Uint8Array.from(encoded, char => char.charCodeAt(0));
  const decoded = await boundedBytes(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')), MAX_APPEARANCE_TEXT);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  if (await digest(text) !== id) throw new Error('Tank paint checksum mismatch.');
  const appearance = cleanAppearance(JSON.parse(text));
  if (JSON.stringify(appearance) !== text) throw new Error('Invalid tank paint fields.');
  return { id, data, appearance, bytes: (text.length + data.length) * 2, rawBytes: text.length };
}

export class OnlineAppearanceSync {
  private room: Room | null = null;
  private members = new Map<number, number>();
  private ports = new Map<number, Port>();
  private manifests = new Map<number, string>();
  private cache = new Map<string, Asset>();
  private requested = new Map<string, number>();
  private decoding = new Set<string>();
  private invalid = new Set<string>();
  private generation = 0;
  private pumping = false;
  private localText = '';
  private localKit = '';
  private localPending = 0;
  private rejected = 0;
  private sentBytes = 0;
  private receivedBytes = 0;
  private cacheHits = 0;
  private error = '';
  constructor(private readonly report: (message: string) => void, private readonly local: () => TankAppearance = currentVehicleAppearance,
    private readonly publish: (seat: number, appearance: TankAppearance | null) => void = publishOnlineAppearance) {}

  updateRoom(room: Room): void {
    const previous = this.room;
    if (previous?.code !== room.code) { this.reset(); configureOnlineAppearances(room.code); }
    else if (previous.epoch !== room.epoch) { this.generation++; this.ports.clear(); this.requested.clear(); this.decoding.clear(); this.invalid.clear(); }
    this.room = room;
    for (const [seat, generation] of this.members) {
      if (!room.peers.some(p => p.seat === seat && p.generation === generation)) {
        this.manifests.delete(seat); this.publish(seat, null);
      }
    }
    this.members = new Map(room.peers.map(p => [p.seat, p.generation]));
    for (const seat of this.ports.keys()) if (!this.members.has(seat)) this.ports.delete(seat);
    for (const [id, source] of this.requested) if (!this.ports.has(source) || ![...this.manifests.values()].includes(id)) this.requested.delete(id);
    const kit = JSON.stringify(room.setup.tanks[room.seat]?.loadout);
    if (!previous || previous.code !== room.code || previous.epoch !== room.epoch || this.localKit !== kit) {
      this.localKit = kit; void this.refreshLocal();
    }
    this.requestMissing();
  }
  /** Successful local paint saves notify once; no profile polling or frame-rate serialization. */
  appearanceChanged(): void { void this.refreshLocal(); }
  attach(seat: number, send: (message: PeerMessage) => boolean): void {
    if (!this.room || !this.members.has(seat)) return;
    this.ports.set(seat, { send, pending: new Map(), announced: new Map(), served: new Set() });
    this.invalid.clear();
    for (const [id, source] of this.requested) if (source === seat) this.requested.delete(id);
    this.announce(seat); this.requestMissing();
    void this.refreshLocal();
  }
  private async refreshLocal(): Promise<void> {
    const room = this.room; if (!room) return;
    const original = this.local(), kit = room.setup.tanks[room.seat]?.loadout;
    const value = { ...original,
      ...(original.paint ? { paint: original.paint.filter(dab => kit?.[dab.slot] === dab.partId) } : {}),
      ...(original.paintTextures ? { paintTextures: original.paintTextures.filter(layer => kit?.[layer.slot] === layer.partId) } : {}) };
    const pending = ++this.localPending;
    this.publish(room.seat, value);
    try {
      const text = JSON.stringify(cleanAppearance(value));
      if (text === this.localText && this.manifests.has(room.seat)) { this.announceAll(); return; }
      const asset = await encodeAppearance(value);
      if (pending !== this.localPending || this.room?.code !== room.code || this.room.seat !== room.seat) return;
      this.localText = text; this.manifests.set(room.seat, asset.id); this.put(asset); this.error = ''; this.announceAll();
    } catch (error) {
      if (pending !== this.localPending || this.room?.code !== room.code) return;
      this.manifests.delete(room.seat); this.error = String(error instanceof Error ? error.message : error); this.report(this.error);
    }
  }
  /** Returns true for cosmetic messages, including invalid or obsolete ones; they never enter the simulation. */
  receive(source: number, message: PeerMessage): boolean {
    if (!message.kind.startsWith('appearance-')) return false;
    const room = this.room;
    if (!room || message.epoch !== room.epoch || !this.ports.has(source) || !this.members.has(source)) return true;
    if (!room.host && source !== room.hostSeat) return true;
    if (message.kind === 'appearance-manifest') {
      const seat = message.seat;
      if (!Number.isSafeInteger(seat) || !this.members.has(seat as number) || room.host && seat !== source || seat === room.seat || typeof message.id !== 'string' || !HASH.test(message.id)) { this.rejected++; return true; }
      const id = message.id;
      this.manifests.set(seat as number, id);
      for (const old of this.invalid) if (![...this.manifests.values()].includes(old)) this.invalid.delete(old);
      for (const [old, peer] of this.requested) if (![...this.manifests.values()].includes(old)) {
        this.requested.delete(old); this.ports.get(peer)?.pending.delete(`request:${old}`);
      }
      const asset = this.get(id);
      if (asset) { this.cacheHits++; this.publish(seat as number, asset.appearance); }
      else {
        this.publish(seat as number, null);
        this.requestMissing();
      }
      if (room.host) this.announceAll();
    } else if (message.kind === 'appearance-request') {
      if (typeof message.id !== 'string' || ![...this.manifests.values()].includes(message.id)) { this.rejected++; return true; }
      if (this.ports.get(source)!.served.has(message.id)) return true;
      const asset = this.get(message.id);
      if (asset) this.queue(source, `blob:${asset.id}`, { kind: 'appearance-blob', epoch: room.epoch, id: asset.id, data: asset.data });
    } else if (message.kind === 'appearance-blob') {
      const id = message.id;
      if (typeof id !== 'string' || this.requested.get(id) !== source || this.decoding.has(id)) { this.rejected++; return true; }
      const generation = this.generation;
      this.requested.delete(id);
      this.decoding.add(id);
      void decodeAppearance(id, message.data).then(asset => {
        if (generation !== this.generation || this.room?.code !== room.code) return;
        if (![...this.manifests.values()].includes(id)) return;
        this.put(asset); this.receivedBytes += asset.data.length;
        for (const [seat, current] of this.manifests) if (current === id) this.publish(seat, asset.appearance);
        this.announceAll();
      }).catch(() => { if (generation === this.generation) { this.rejected++; this.invalid.add(id); } }).finally(() => {
        if (generation !== this.generation) return;
        this.decoding.delete(id); this.requestMissing();
      });
    } else this.rejected++;
    return true;
  }
  private announceAll(): void { for (const seat of this.ports.keys()) this.announce(seat); }
  private announce(seat: number): void {
    const room = this.room, port = this.ports.get(seat); if (!room || !port) return;
    for (const [owner, id] of this.manifests) {
      if ((!room.host && owner !== room.seat) || owner === seat || !this.cache.has(id)) continue;
      if (port.announced.get(owner) === id) continue;
      port.announced.set(owner, id);
      this.queue(seat, `manifest:${owner}`, { kind: 'appearance-manifest', epoch: room.epoch, seat: owner, id });
    }
  }
  private requestMissing(): void {
    const room = this.room; if (!room) return;
    for (const [owner, id] of this.manifests) {
      if (owner === room.seat || this.cache.has(id) || this.requested.has(id) || this.decoding.has(id) || this.invalid.has(id)
        || this.requested.size + this.decoding.size >= 3) continue;
      const source = room.host ? owner : room.hostSeat;
      if (!this.ports.has(source)) continue;
      this.requested.set(id, source); this.queue(source, `request:${id}`, { kind: 'appearance-request', epoch: room.epoch, id });
    }
  }
  private queue(seat: number, key: string, message: PeerMessage): void { this.ports.get(seat)?.pending.set(key, message); this.pump(); }
  pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const port of this.ports.values()) for (const [key, message] of port.pending) {
        if (!port.send(message)) break;
        port.pending.delete(key);
        if (message.kind === 'appearance-blob') {
          this.sentBytes += (message.data as string).length;
          port.served.add(message.id as string);
          for (const id of port.served) if (![...this.manifests.values()].includes(id)) port.served.delete(id);
        }
      }
    } finally { this.pumping = false; }
  }
  private get(id: string): Asset | undefined { const value = this.cache.get(id); if (value) { this.cache.delete(id); this.cache.set(id, value); } return value; }
  private put(asset: Asset): void {
    this.cache.delete(asset.id); this.cache.set(asset.id, asset);
    const pinned = new Set(this.manifests.values());
    while (this.cache.size > CACHE_ENTRIES || [...this.cache.values()].reduce((sum, entry) => sum + entry.bytes, 0) > CACHE_BYTES) {
      const oldest = [...this.cache.keys()].find(id => !pinned.has(id)); if (!oldest) break;
      this.cache.delete(oldest);
    }
  }
  diagnostics() {
    return { seats: [...this.manifests].map(([seat, id]) => ({ seat, id, loaded: this.cache.has(id), rawBytes: this.cache.get(id)?.rawBytes ?? 0, wireBytes: this.cache.get(id)?.data.length ?? 0 })),
      cacheEntries: this.cache.size, cacheBytes: [...this.cache.values()].reduce((sum, asset) => sum + asset.bytes, 0),
      pending: this.requested.size + this.decoding.size + [...this.ports.values()].reduce((sum, port) => sum + port.pending.size, 0),
      sentBytes: this.sentBytes, receivedBytes: this.receivedBytes, cacheHits: this.cacheHits, rejected: this.rejected, error: this.error };
  }
  reset(): void {
    this.generation++;
    this.localPending++; this.room = null; this.members.clear(); this.ports.clear(); this.manifests.clear(); this.requested.clear(); this.decoding.clear(); this.invalid.clear(); this.localText = ''; this.localKit = '';
    clearOnlineAppearances();
  }
}
