/** TelemetrySink implementation + render-pass draw counting. */
import type { TelemetrySink } from './contracts';

export class Telemetry implements TelemetrySink {
  private readonly counts = new Map<string, number>();
  private readonly lastCounts = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly times = new Map<string, number>();
  draws = 0;
  triangles = 0;
  lastDraws = 0;
  lastTriangles = 0;

  count(name: string, n = 1): void { this.counts.set(name, (this.counts.get(name) ?? 0) + n); }
  gauge(name: string, value: number): void { this.gauges.set(name, value); }
  time(name: string, ms: number): void {
    const prev = this.times.get(name);
    this.times.set(name, prev === undefined ? ms : prev * 0.9 + ms * 0.1);
  }

  /** Close the frame: counters become last frame's values; draws and triangles only from a frame that counted them. */
  endFrame(counted = true): void {
    this.lastCounts.clear();
    for (const [k, v] of this.counts) this.lastCounts.set(k, v);
    this.counts.clear();
    if (counted) { this.lastDraws = this.draws; this.lastTriangles = this.triangles; }
    this.draws = 0; this.triangles = 0;
  }

  custom(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.lastCounts) out[k] = v;
    for (const [k, v] of this.gauges) out[k] = v;
    for (const [k, v] of this.times) out[`${k}Ms`] = Math.round(v * 1000) / 1000;
    return out;
  }

  /**
   * Patch `beginRenderPass` on this frame's encoder so every draw in every render pass is counted (draws; triangles for
   * direct draws). Own-property patches on one encoder instance: no prototype changes.
   */
  instrument(encoder: GPUCommandEncoder): GPUCommandEncoder {
    const begin = encoder.beginRenderPass.bind(encoder);
    const self = this;
    Object.defineProperty(encoder, 'beginRenderPass', {
      configurable: true, writable: true,
      value(desc: GPURenderPassDescriptor): GPURenderPassEncoder {
        const pass = begin(desc);
        const draw = pass.draw.bind(pass);
        const drawIndexed = pass.drawIndexed.bind(pass);
        const drawIndirect = pass.drawIndirect.bind(pass);
        const drawIndexedIndirect = pass.drawIndexedIndirect.bind(pass);
        Object.defineProperties(pass, {
          draw: { configurable: true, writable: true, value(vertexCount: number, instanceCount = 1, firstVertex?: number, firstInstance?: number) {
            self.draws++; self.triangles += Math.floor(vertexCount / 3) * instanceCount; draw(vertexCount, instanceCount, firstVertex, firstInstance);
          } },
          drawIndexed: { configurable: true, writable: true, value(indexCount: number, instanceCount = 1, firstIndex?: number, baseVertex?: number, firstInstance?: number) {
            self.draws++; self.triangles += Math.floor(indexCount / 3) * instanceCount; drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
          } },
          drawIndirect: { configurable: true, writable: true, value(buffer: GPUBuffer, offset: number) { self.draws++; drawIndirect(buffer, offset); } },
          drawIndexedIndirect: { configurable: true, writable: true, value(buffer: GPUBuffer, offset: number) { self.draws++; drawIndexedIndirect(buffer, offset); } },
        });
        return pass;
      },
    });
    return encoder;
  }
}
