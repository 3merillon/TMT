// Ported from Pinionfall src/gpu/bind-group-resource-cache.test.ts (MIT, same owner)
/**
 * The full-entry-list identity compare: a lookup hits ONLY when every pushed resource is the same object in the same
 * position — one changed ref (pool realloc, resize-recreated view, placeholder→real swap) must miss; alternating inputs
 * (history parity) must BOTH hit once stored; overflow clears so destroyed resources are not pinned.
 */
import { describe, expect, it } from 'vitest';
import { BindGroupResourceCache, pushBindingKey } from '../src/engine/gpu/bind-group-cache';

type Group = { id: number };
const A = { n: 'A' }, B = { n: 'B' }, C = { n: 'C' }, D = { n: 'D' };

describe('BindGroupResourceCache', () => {
  it('misses on empty and hits after store', () => {
    const cache = new BindGroupResourceCache<Group>();
    let k = cache.begin(); k.push(A, B, C);
    expect(cache.lookup()).toBeNull();
    const g0: Group = { id: 0 };
    cache.store(g0);
    k = cache.begin(); k.push(A, B, C);
    expect(cache.lookup()).toBe(g0);
    expect(cache.size).toBe(1);
  });

  it('misses when any single ref changes, or the list is shorter, longer or reordered', () => {
    const cache = new BindGroupResourceCache<Group>();
    let k = cache.begin(); k.push(A, B, C);
    cache.store({ id: 0 });
    for (let i = 0; i < 3; i++) {
      k = cache.begin();
      k.push(i === 0 ? D : A, i === 1 ? D : B, i === 2 ? D : C);
      expect(cache.lookup(), `changed slot ${i}`).toBeNull();
    }
    k = cache.begin(); k.push(A, B);
    expect(cache.lookup()).toBeNull();
    k = cache.begin(); k.push(A, B, C, D);
    expect(cache.lookup()).toBeNull();
    k = cache.begin(); k.push(B, A, C);
    expect(cache.lookup()).toBeNull();
  });

  it('hits both alternating inputs (ping-pong parity)', () => {
    const cache = new BindGroupResourceCache<Group>(4);
    const gA: Group = { id: 1 }, gB: Group = { id: 2 };
    let k = cache.begin(); k.push(A, C); cache.store(gA);
    k = cache.begin(); k.push(B, C); cache.store(gB);
    for (let f = 0; f < 6; f++) {
      k = cache.begin(); k.push(f & 1 ? B : A, C);
      expect(cache.lookup()).toBe(f & 1 ? gB : gA);
    }
    expect(cache.size).toBe(2);
  });

  it('clears on overflow so retired views are not pinned', () => {
    const cache = new BindGroupResourceCache<Group>(2);
    let k = cache.begin(); k.push(A); cache.store({ id: 1 });
    k = cache.begin(); k.push(B); cache.store({ id: 2 });
    expect(cache.size).toBe(2);
    k = cache.begin(); k.push(C); cache.store({ id: 3 });
    expect(cache.size).toBe(1);
    k = cache.begin(); k.push(A);
    expect(cache.lookup()).toBeNull();
    k = cache.begin(); k.push(C);
    expect(cache.lookup()).not.toBeNull();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('does not alias the scratch key with the stored key', () => {
    const cache = new BindGroupResourceCache<Group>();
    const k = cache.begin(); k.push(A, B);
    const g: Group = { id: 9 };
    cache.store(g);
    k.length = 0; k.push(C, D);
    expect(cache.lookup()).toBeNull();
    const k2 = cache.begin(); k2.push(A, B);
    expect(cache.lookup()).toBe(g);
  });

  it('get() builds once and reuses; buffer bindings key on buffer, offset and size', () => {
    const cache = new BindGroupResourceCache<Group>();
    let built = 0;
    const buf = { b: 1 } as unknown as GPUBuffer;
    for (let i = 0; i < 3; i++) {
      const k = cache.begin(); pushBindingKey(k, { buffer: buf, offset: 256, size: 64 });
      cache.get(() => ({ id: ++built }));
    }
    expect(built).toBe(1);
    const k = cache.begin(); pushBindingKey(k, { buffer: buf, offset: 512, size: 64 });
    cache.get(() => ({ id: ++built }));
    expect(built).toBe(2);
  });
});
