/** Bounded fragmentation for reliable data channels. Checkpoints exceed SCTP's portable message size. */
export const MAX_WIRE_TEXT = 16 * 1024 * 1024, WIRE_CHUNK = 12_000;
export function encodeWire(value: unknown, id: number): string[] {
  const text = JSON.stringify(value);
  if (text.length > MAX_WIRE_TEXT) throw new Error('Network checkpoint exceeds 16 MiB.');
  if (text.length <= WIRE_CHUNK) return [text];
  const count = Math.ceil(text.length / WIRE_CHUNK);
  return Array.from({ length: count }, (_, index) => JSON.stringify({ fragment: id, index, count, text: text.slice(index * WIRE_CHUNK, (index + 1) * WIRE_CHUNK) }));
}
export class WireDecoder {
  private partial = new Map<number, { count: number; next: number; size: number; parts: string[] }>();
  private size = 0;
  decode(raw: unknown): unknown | null {
    if (typeof raw !== 'string' || raw.length > 64_000) throw new Error('Invalid network message size.');
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') throw new Error('Invalid network message.');
    // Control and snapshots may overtake a bulk checkpoint at fragment boundaries.
    if (!Object.hasOwn(value, 'fragment')) return value;
    const { fragment, index, count, text } = value;
    if (!Number.isSafeInteger(fragment) || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count < 1 || count > Math.ceil(MAX_WIRE_TEXT / WIRE_CHUNK)
      || index < 0 || index >= count || typeof text !== 'string' || text.length > WIRE_CHUNK) throw new Error('Invalid network fragment.');
    let p = this.partial.get(fragment);
    if (!p) {
      if (index !== 0) throw new Error('Missing network fragment.');
      if (this.partial.size >= 4) throw new Error('Too many concurrent network transfers.');
      p = { count, next: 0, size: 0, parts: [] }; this.partial.set(fragment, p);
    }
    if (p.count !== count || p.next++ !== index || (p.size += text.length) > MAX_WIRE_TEXT) throw new Error('Out-of-order network fragment.');
    this.size += text.length;
    if (this.size > 20 * 1024 * 1024) throw new Error('Network transfer memory limit exceeded.');
    p.parts.push(text);
    if (p.next < count) return null;
    this.partial.delete(fragment); this.size -= p.size; return JSON.parse(p.parts.join(''));
  }
}
