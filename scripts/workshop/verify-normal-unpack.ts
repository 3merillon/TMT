/** Browser-only diagnostic: verify the shipping normal decoder against actual WebGPU texels. */
let capture: { device?: GPUDevice; normals?: GPUTexture };

export function instrumentNormalUpload(): void {
  capture = {};
  const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = async options => {
    const adapter = await requestAdapter(options);
    if (!adapter) return adapter;
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async descriptor => {
      const device = await requestDevice(descriptor), createTexture = device.createTexture.bind(device);
      device.createTexture = descriptor => {
        const target = descriptor.label === 'workshop:authored-1';
        const texture = createTexture(target ? { ...descriptor, usage: descriptor.usage | GPUTextureUsage.COPY_SRC } : descriptor);
        if (target) { capture.device = device; capture.normals = texture; }
        return texture;
      };
      return device;
    };
    return adapter;
  };
}

export async function verifyNormalUpload(): Promise<{ layers: number; sampledTexels: number; negativeZTexels: number; maxByteError: number }> {
  const { device, normals } = capture;
  if (!device || !normals) throw new Error('Normal upload was not instrumented.');
  const manifest = await fetch('/workshop/manifest.json').then(response => response.json());
  const samples: { layer: number; x: number; y: number; expected: number[] }[] = [];
  let negatives = 0;
  for (const [layer, spec] of manifest.textures.entries()) {
    if (spec.normalEncoding !== 'xy-gray') throw new Error(`Layer ${layer} does not exercise packed normal decoding.`);
    const bitmap = await createImageBitmap(await fetch(`/workshop/${spec.normal}`).then(response => response.blob()), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height), width = canvas.width / 2, height = canvas.height;
    if (width !== normals.width || height !== normals.height) throw new Error('Packed normal target has the wrong dimensions.');
    const points: [number, number][] = [[0, 0], [width - 1, height - 1], [width >> 1, height >> 1]];
    let random = 731 + layer;
    for (let i = 0; i < 20; i++) {
      random = Math.imul(random, 1664525) + 1013904223 | 0;
      const x = (random >>> 0) % width;
      random = Math.imul(random, 1664525) + 1013904223 | 0;
      points.push([x, (random >>> 0) % height]);
    }
    // Include an actual rare back-facing tangent normal, so the sign channel is exercised.
    outer: for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (data[(y * canvas.width + x) * 4 + 3] < 255) { points.push([x, y]); negatives++; break outer; }
    }
    for (const [x, y] of points) {
      const left = (y * canvas.width + x) * 4, right = left + width * 4;
      const nx = data[left] / 127.5 - 1, ny = data[right] / 127.5 - 1;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) * (data[left + 3] < 255 ? -1 : 1);
      const length = Math.hypot(nx, ny, nz);
      samples.push({ layer, x, y, expected: [nx, ny, nz].map(n => Math.round((n / length * .5 + .5) * 255)) });
    }
  }
  const readback = device.createBuffer({ label: 'verification:normal-readback', size: samples.length * 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder({ label: 'verification:normal-readback' });
    samples.forEach((sample, i) => encoder.copyTextureToBuffer({ texture: normals, origin: [sample.x, sample.y, sample.layer] }, { buffer: readback, offset: i * 256, bytesPerRow: 256 }, [1, 1, 1]));
    device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(readback.getMappedRange());
    let maxByteError = 0;
    samples.forEach((sample, i) => {
      sample.expected.forEach((value, channel) => { maxByteError = Math.max(maxByteError, Math.abs(value - bytes[i * 256 + channel])); });
      if (bytes[i * 256 + 3] !== 255) throw new Error(`Normal layer ${sample.layer} retained packed alpha.`);
    });
    // Canvas conversion of alpha254 can round a source grayscale value by one level.
    if (maxByteError > 2) throw new Error(`GPU normal unpack differs by ${maxByteError} byte levels.`);
    return { layers: manifest.textures.length, sampledTexels: samples.length, negativeZTexels: negatives, maxByteError };
  } finally {
    const context = window.__tmtWorkshop?.engine.services.ctx;
    if (context) context.deferDestroy(readback); else readback.destroy();
  }
}
