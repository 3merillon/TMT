import { describe, expect, it } from 'vitest';
import { encodeWire, WireDecoder, WIRE_CHUNK } from '../src/game/online/wire';
import { networkCommand } from '../src/game/online/validation';
import { filterProfanity } from '../src/game/online/profanity';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/game/meta/settings';

describe('online transport boundaries', () => {
  it('reassembles large Unicode checkpoints exactly', () => {
    const message = { kind: 'recovery', epoch: 4, text: '🎉 hello '.repeat(WIRE_CHUNK) }, decoder = new WireDecoder();
    const parts = encodeWire(message, 1); expect(parts.length).toBeGreaterThan(1);
    for (const part of parts.slice(0, -1)) expect(decoder.decode(part)).toBeNull();
    expect(decoder.decode(parts.at(-1)!)).toEqual(message);
  });
  it('rejects gaps, duplicate fragments, oversized messages, and unbounded partial transfers', () => {
    const parts = encodeWire({ text: 'x'.repeat(WIRE_CHUNK * 3) }, 1);
    expect(() => new WireDecoder().decode(parts[1])).toThrow(/Missing/);
    const duplicate = new WireDecoder(); duplicate.decode(parts[0]); expect(() => duplicate.decode(parts[0])).toThrow(/order/);
    const interleaved = new WireDecoder();
    for (let id = 1; id <= 4; id++) interleaved.decode(encodeWire({ text: 'x'.repeat(WIRE_CHUNK * 3) }, id)[0]);
    expect(() => interleaved.decode(encodeWire({ text: 'x'.repeat(WIRE_CHUNK * 3) }, 5)[0])).toThrow(/concurrent/);
    expect(() => new WireDecoder().decode(' '.repeat(64_001))).toThrow(/size/);
  });
  it('delivers gameplay during a bulk world transfer and reassembles both interleaved worlds', () => {
    const recovery = { kind: 'recovery', world: 'x'.repeat(WIRE_CHUNK * 3) }, snapshot = { kind: 'snapshot', world: 'y'.repeat(WIRE_CHUNK * 2) };
    const bulk = encodeWire(recovery, 1), live = encodeWire(snapshot, 2), decoder = new WireDecoder();
    expect(decoder.decode(bulk[0])).toBeNull();
    expect(decoder.decode(JSON.stringify({ kind: 'input', seq: 3 }))).toEqual({ kind: 'input', seq: 3 });
    expect(decoder.decode(live[0])).toBeNull();
    for (const part of bulk.slice(1, -1)) expect(decoder.decode(part)).toBeNull();
    for (const part of live.slice(1, -1)) expect(decoder.decode(part)).toBeNull();
    expect(decoder.decode(live.at(-1)!)).toEqual(snapshot);
    expect(decoder.decode(bulk.at(-1)!)).toEqual(recovery);
  });
  it('only admits gameplay commands with bounded finite inputs', () => {
    expect(networkCommand({ k: 'drive', throttle: 5, steer: -9 })).toEqual({ k: 'drive', throttle: 1, steer: -1 });
    expect(() => networkCommand({ k: 'aim', yaw: Infinity, pitch: 0, power: 1 })).toThrow();
    expect(() => networkCommand({ k: 'utility', id: 'spawn' })).toThrow();
    expect(() => networkCommand({ k: 'damage', target: 0 })).toThrow();
  });
});
describe('default-on chat filtering', () => {
  it.each(['fuck', 'FUUUCK', 'f.u.c.k', 'f\u200buck', 'sh1t', '$hit', 'аsshole', 'Scheiße'])('masks %s', word => {
    expect(filterProfanity(`hello ${word}!`)).not.toContain(word);
    expect(filterProfanity(`hello ${word}!`)).toContain('•');
  });
  it('preserves innocent words, Unicode neighbours and the explicit opt-out', () => {
    const innocent = 'class, Scunthorpe, assistant, cockpit, assessment'; expect(filterProfanity(innocent)).toBe(innocent);
    expect(filterProfanity('🎉 fuck!')).toBe('🎉 ••••!');
    expect(filterProfanity('fuck', false)).toBe('fuck');
    expect(DEFAULT_SETTINGS.gameplay.profanityFilter).toBe(true);
    expect(sanitizeSettings({ gameplay: {} }).gameplay.profanityFilter).toBe(true);
    expect(sanitizeSettings({ gameplay: { profanityFilter: false } }).gameplay.profanityFilter).toBe(false);
  });
});
