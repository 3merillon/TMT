/**
 * Mip-gen smoke (dev): once, generate the full chain of an rgba8unorm 2D checkerboard and an rgba16float 2D array with a
 * constant per layer, read the 1×1 mips back and check the averages. Result in telemetry().custom['debug.mipSmoke']:
 * 1 = pass, −1 = mismatch (with a console warning), absent = not finished.
 */
import type { EngineServices, RenderModule } from '../contracts';
import { BufferUsage, MapMode, TextureUsage } from '../gpu/flags';
import { MipGenerator, mipLevelCount } from '../gpu/mip-gen';

function f16ToF32(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}
function f32ToF16(v: number): number {
  const f = new Float32Array([v]); const x = new Uint32Array(f.buffer)[0];
  const e = ((x >> 23) & 0xff) - 127 + 15;
  return ((x >> 16) & 0x8000) | (Math.max(0, Math.min(31, e)) << 10) | ((x >> 13) & 0x3ff);
}

export function mipSmokeModule(): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'debug.mip-smoke',
    install(s: EngineServices) {
      const { device, queue } = s.ctx;
      const gen = MipGenerator.for(s.ctx);
      const usage = TextureUsage.TEXTURE_BINDING | TextureUsage.STORAGE_BINDING | TextureUsage.COPY_DST | TextureUsage.COPY_SRC;
      const size8 = 64, size16 = 32, layers = 3;
      const t8 = device.createTexture({ label: 'debug:mip-smoke-rgba8', size: [size8, size8], format: 'rgba8unorm', usage, mipLevelCount: mipLevelCount(size8, size8) });
      const t16 = device.createTexture({ label: 'debug:mip-smoke-rgba16f', size: [size16, size16, layers], format: 'rgba16float', usage, mipLevelCount: mipLevelCount(size16, size16) });
      const checker = new Uint8Array(size8 * size8 * 4);
      for (let y = 0; y < size8; y++) for (let x = 0; x < size8; x++) checker.set((x + y) & 1 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * size8 + x) * 4);
      queue.writeTexture({ texture: t8 }, checker, { bytesPerRow: size8 * 4 }, [size8, size8]);
      const flat = new Uint16Array(size16 * size16 * 4 * layers);
      for (let l = 0; l < layers; l++) flat.fill(f32ToF16((l + 1) * 0.25), l * size16 * size16 * 4, (l + 1) * size16 * size16 * 4);
      queue.writeTexture({ texture: t16 }, flat, { bytesPerRow: size16 * 8, rowsPerImage: size16 }, [size16, size16, layers]);
      const rb = device.createBuffer({ label: 'debug:mip-smoke-readback', size: 256 * (1 + layers), usage: BufferUsage.COPY_DST | BufferUsage.MAP_READ });
      let state: 'generate' | 'copy' | 'map' | 'done' = 'generate';
      disposers.push(s.graph.addPass({
        name: 'debug.mip-smoke', slot: 'compute.pre', order: 1000, reads: [], writes: [],
        enabled: () => state === 'generate' || state === 'copy',
        run(c) {
          if (state === 'generate') {
            if (gen.generate(c.encoder, t8) && gen.generate(c.encoder, t16, { dimension: '2d-array' })) state = 'copy';
            return;
          }
          c.encoder.copyTextureToBuffer({ texture: t8, mipLevel: t8.mipLevelCount - 1 }, { buffer: rb, bytesPerRow: 256 }, [1, 1]);
          for (let l = 0; l < layers; l++) {
            c.encoder.copyTextureToBuffer({ texture: t16, mipLevel: t16.mipLevelCount - 1, origin: [0, 0, l] }, { buffer: rb, offset: 256 * (1 + l), bytesPerRow: 256 }, [1, 1]);
          }
          state = 'map';
        },
      }));
      disposers.push(s.events.on('frameEnd', () => {
        if (state !== 'map') return;
        state = 'done';
        rb.mapAsync(MapMode.READ).then(() => {
          const bytes = new Uint8Array(rb.getMappedRange().slice(0));
          rb.unmap();
          const px = bytes.subarray(0, 4);
          let ok = Math.abs(px[0] - 127.5) <= 2 && px[1] <= 1 && Math.abs(px[2] - 127.5) <= 2 && px[3] >= 254;
          const got: number[] = [];
          for (let l = 0; l < layers; l++) {
            const h = new Uint16Array(bytes.buffer, 256 * (1 + l), 4);
            const v = f16ToF32(h[0]);
            got.push(v);
            ok &&= Math.abs(v - (l + 1) * 0.25) < 1e-3;
          }
          s.telemetry.gauge('debug.mipSmoke', ok ? 1 : -1);
          if (!ok) console.warn(`[engine] mip-gen smoke mismatch: rgba8 ${Array.from(px)}, rgba16f ${got}`);
        }).catch(() => undefined);
      }));
      disposers.push(() => { s.ctx.deferDestroy(t8); s.ctx.deferDestroy(t16); s.ctx.deferDestroy(rb); });
    },
    dispose() { for (const d of disposers.splice(0)) d(); },
  };
}
