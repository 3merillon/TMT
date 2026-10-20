/**
 * Reserved bindings (plan §5.4): every name resolves to 1×1 placeholders (zeroed buffers, 1×1 textures, default
 * samplers) until a module calls provide(). Consumers bind whatever get() returns and key their bind-group caches on the
 * resolved resources, so a placeholder → real swap rebuilds the group (plan §13 rule 8). A placeholder can never
 * overwrite a real resource.
 */
import { RESERVED_BINDING_LAYOUT, RESERVED_BINDING_NAMES } from './contracts';
import type { BindingResources, ReservedBindingName, ReservedBindings, ReservedSlotDecl, ReservedSlotType } from './contracts';
import { BufferUsage, TextureUsage } from './gpu/flags';

type PlaceholderDevice = Pick<GPUDevice, 'createBuffer' | 'createTexture' | 'createSampler'> & { queue: Pick<GPUQueue, 'writeTexture'> };

/** Placeholder texel values (rgba16float halves) per reserved binding: AO defaults to 1 (unoccluded), the rest to 0. */
const WHITE_PLACEHOLDERS = new Set<ReservedBindingName>(['ao']);

function bindingObject(r: GPUBindingResource): object {
  const b = r as GPUBufferBinding;
  return b && typeof b === 'object' && 'buffer' in b ? b.buffer : r as object;
}

export class ReservedBindingRegistry implements ReservedBindings {
  private readonly placeholders = new Map<ReservedBindingName, BindingResources>();
  private readonly current = new Map<ReservedBindingName, BindingResources>();
  private readonly placeholderObjects = new WeakSet<object>();
  private readonly owned: { destroy(): void }[] = [];
  /** Bumps on every provide(); cheap change detection for consumers. */
  version = 0;

  constructor(device: PlaceholderDevice) {
    const samplers = {
      filtering: device.createSampler({ label: 'reserved:sampler', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
      comparison: device.createSampler({ label: 'reserved:compare', compare: 'greater', magFilter: 'linear', minFilter: 'linear' }),
    };
    this.placeholderObjects.add(samplers.filtering);
    this.placeholderObjects.add(samplers.comparison);
    for (const name of RESERVED_BINDING_NAMES) {
      const res: Record<string, GPUBindingResource> = {};
      for (const slot of RESERVED_BINDING_LAYOUT[name]) {
        const r = this.makePlaceholder(device, name, slot, samplers);
        res[slot.key] = r;
        this.placeholderObjects.add(bindingObject(r));
      }
      this.placeholders.set(name, Object.freeze(res));
    }
  }

  private makePlaceholder(device: PlaceholderDevice, name: ReservedBindingName, slot: ReservedSlotDecl,
    samplers: { filtering: GPUSampler; comparison: GPUSampler }): GPUBindingResource {
    const label = `reserved:${name}.${slot.key}`;
    switch (slot.type) {
      case 'uniform': case 'storage': {
        const buffer = device.createBuffer({ label, size: Math.max(16, slot.size ?? 256), usage: (slot.type === 'uniform' ? BufferUsage.UNIFORM : BufferUsage.STORAGE) | BufferUsage.COPY_DST });
        this.owned.push(buffer);
        return { buffer };
      }
      case 'sampler': return samplers.filtering;
      case 'sampler-comparison': return samplers.comparison;
      case 'depth-2d': {
        // Zero-initialised: reversed-Z far plane, so a 'greater' compare reads as fully lit.
        const texture = device.createTexture({ label, size: [1, 1, 1], format: 'depth32float', usage: TextureUsage.TEXTURE_BINDING | TextureUsage.RENDER_ATTACHMENT });
        this.owned.push(texture);
        return texture.createView();
      }
      default: {
        const layers = slot.type === 'texture-cube' ? 6 : 1;
        const texture = device.createTexture({
          label, size: [1, 1, layers], format: 'rgba16float', dimension: slot.type === 'texture-3d' ? '3d' : '2d',
          usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
        });
        this.owned.push(texture);
        const one = 0x3c00; // half 1.0
        const v = WHITE_PLACEHOLDERS.has(name) ? one : 0;
        const texels = new Uint16Array(4 * layers).fill(v);
        device.queue.writeTexture({ texture }, texels, { bytesPerRow: 8, rowsPerImage: 1 }, [1, 1, layers]);
        return texture.createView({ dimension: viewDimension(slot.type) });
      }
    }
  }

  provide(name: ReservedBindingName, r: BindingResources): void {
    const layout = RESERVED_BINDING_LAYOUT[name];
    if (!layout) throw new Error(`reserved binding: unknown name "${name}"`);
    const keys = Object.keys(r).sort().join(',');
    const want = layout.map(s => s.key).sort().join(',');
    if (keys !== want) throw new Error(`reserved binding "${name}": expected keys [${want}], got [${keys}]`);
    const placeholder = Object.values(r).every(v => this.placeholderObjects.has(bindingObject(v)));
    if (placeholder && this.isProvided(name)) throw new Error(`reserved binding "${name}": a placeholder would overwrite a real resource`);
    if (placeholder) { this.current.delete(name); this.version++; return; }
    this.current.set(name, Object.freeze({ ...r }));
    this.version++;
  }

  get(name: ReservedBindingName): BindingResources {
    return this.current.get(name) ?? this.placeholders.get(name)!;
  }

  isProvided(name: ReservedBindingName): boolean { return this.current.has(name); }

  placeholder(name: ReservedBindingName): BindingResources { return this.placeholders.get(name)!; }

  destroy(deferDestroy: (r: GPUBuffer | GPUTexture) => void): void {
    for (const o of this.owned) deferDestroy(o as GPUBuffer | GPUTexture);
    this.owned.length = 0;
  }
}

function viewDimension(t: ReservedSlotType): GPUTextureViewDimension {
  if (t === 'texture-2d-array') return '2d-array';
  if (t === 'texture-cube') return 'cube';
  if (t === 'texture-3d') return '3d';
  return '2d';
}

export function reservedLayoutEntry(binding: number, slot: ReservedSlotDecl, visibility: GPUShaderStageFlags): GPUBindGroupLayoutEntry {
  switch (slot.type) {
    case 'uniform': return { binding, visibility, buffer: { type: 'uniform' } };
    case 'storage': return { binding, visibility, buffer: { type: 'read-only-storage' } };
    case 'sampler': return { binding, visibility, sampler: { type: 'filtering' } };
    case 'sampler-comparison': return { binding, visibility, sampler: { type: 'comparison' } };
    case 'depth-2d': return { binding, visibility, texture: { sampleType: 'depth', viewDimension: '2d' } };
    default: return { binding, visibility, texture: { sampleType: 'float', viewDimension: viewDimension(slot.type) } };
  }
}

/** Binding numbers assigned consecutively from `first`, in RESERVED_BINDING_LAYOUT order, for the given names. */
export function reservedBindingSlots(names: readonly ReservedBindingName[] = RESERVED_BINDING_NAMES, first = 0): { name: ReservedBindingName; slot: ReservedSlotDecl; binding: number }[] {
  const out: { name: ReservedBindingName; slot: ReservedSlotDecl; binding: number }[] = [];
  let b = first;
  for (const name of names) for (const slot of RESERVED_BINDING_LAYOUT[name]) out.push({ name, slot, binding: b++ });
  return out;
}

export function reservedLayoutEntries(visibility: GPUShaderStageFlags, names?: readonly ReservedBindingName[], first = 0): GPUBindGroupLayoutEntry[] {
  return reservedBindingSlots(names, first).map(s => reservedLayoutEntry(s.binding, s.slot, visibility));
}

export function reservedBindGroupEntries(bindings: ReservedBindings, names?: readonly ReservedBindingName[], first = 0): GPUBindGroupEntry[] {
  return reservedBindingSlots(names, first).map(s => ({ binding: s.binding, resource: bindings.get(s.name)[s.slot.key] }));
}

export function reservedBinding(name: ReservedBindingName, key: string, names?: readonly ReservedBindingName[], first = 0): number {
  const s = reservedBindingSlots(names, first).find(e => e.name === name && e.slot.key === key);
  if (!s) throw new Error(`reserved binding ${name}.${key} not in the layout`);
  return s.binding;
}
